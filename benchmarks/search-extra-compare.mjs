#!/usr/bin/env node
/**
 * Which search API should fill search.js's extra slot (3 results each next to Grok)? DeepSeek
 * Search against Tavily (advanced, as configured; and basic) and Firecrawl on 62 queries in seven
 * kinds: English docs, releases of the past two weeks, Chinese, code, error messages, papers, X.
 * deepseek-lang is DeepSeek with `lang:en` added to queries without CJK characters.
 *
 *   DEEPSEEK_API_KEY=... node benchmarks/search-extra-compare.mjs [--only id,id] [--providers a,b] [--out DIR]
 *   node benchmarks/search-extra-compare.mjs --rescore [--out DIR]
 *
 * Per query and provider, from 10 results:
 * - rank of the first URL matching `target` (the page a careful human would cite);
 * - fact@3: `fact` (the current version, issue number, price) in the title or the first 400
 *   characters of a top-3 result, i.e. on the card search.js would show (sourceChars 400);
 * - slot: target / fact in the union of two providers' top 3, the shape of the extra slot.
 * Facts were taken from official sources on 2026-10-19 and go stale.
 *
 * Firecrawl's per-minute limit is about 10 requests on this key, so its calls are spaced 7s apart.
 * Sends real, billed requests: about 124 Tavily credits (advanced 2 + basic 1 per query), 124
 * Firecrawl credits, 62 DeepSeek requests ($0.75 per 1000).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/lib/config.js";
import { authHeaders, requestJson } from "../scripts/lib/http.js";
import { configureProxy } from "../scripts/lib/proxy.js";
import { firecrawlSearch, tavilySearch } from "./lib/search-apis.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.DEEPSEEK_API_KEY;
const COUNT = 10;
const CARD_CHARS = 400;
const FIRECRAWL_GAP_MS = 7_000;
const PROVIDERS = ["deepseek", "deepseek-lang", "tavily", "tavily-basic", "firecrawl"];
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const X_POST = /^https?:\/\/(www\.)?(x|twitter)\.com\/[^/]+\/status\//i;

// prettier-ignore
const CASES = [
  // English docs: the answer is on one official page
  { id: "d01", cat: "docs", query: "Firecrawl v2 search API includeDomains parameter", target: /docs\.firecrawl\.dev/i },
  { id: "d02", cat: "docs", query: "Tavily search API include_domains_mode", target: /docs\.tavily\.com/i },
  { id: "d03", cat: "docs", query: "OpenAI Responses API max_tool_calls", target: /(platform|developers)\.openai\.com/i },
  { id: "d04", cat: "docs", query: "xAI grok-4-fast pricing per million tokens", target: /docs\.x\.ai|^https?:\/\/x\.ai\//i },
  { id: "d05", cat: "docs", query: "Anthropic prompt caching cache_control ttl 1 hour", target: /docs\.anthropic\.com|docs\.claude\.com|platform\.claude\.com/i },
  { id: "d06", cat: "docs", query: "undici ProxyAgent setGlobalDispatcher", target: /undici\.nodejs\.org|nodejs\.org|github\.com\/nodejs\/undici/i },
  { id: "d07", cat: "docs", query: "Python asyncio TaskGroup exception handling", target: /docs\.python\.org/i },
  { id: "d08", cat: "docs", query: "Kubernetes HPA behavior scaleDown stabilizationWindowSeconds", target: /kubernetes\.io/i },
  { id: "d09", cat: "docs", query: "PostgreSQL 18 asynchronous I/O io_method", target: /postgresql\.org/i },
  { id: "d10", cat: "docs", query: "Vite rolldown migration guide", target: /vite\.dev|vitejs\.dev|rolldown\.rs/i },
  { id: "d11", cat: "docs", query: "Cloudflare Workers cron triggers limits", target: /developers\.cloudflare\.com/i },
  { id: "d12", cat: "docs", query: "GitHub Actions concurrency cancel-in-progress", target: /docs\.github\.com/i },
  { id: "d13", cat: "docs", query: "docker compose watch develop section", target: /docs\.docker\.com/i },
  { id: "d14", cat: "docs", query: "Next.js use cache directive cacheLife", target: /nextjs\.org/i },
  { id: "d15", cat: "docs", query: "Rust async fn in traits stabilization", target: /blog\.rust-lang\.org|doc\.rust-lang\.org|rust-lang\.github\.io/i },
  // released in the past two weeks; `fact` is the version
  { id: "r01", cat: "fresh", query: "Rust 1.99.1 release", target: /blog\.rust-lang\.org|github\.com\/rust-lang\/rust\/releases/i, fact: /1\.99\.1/ },
  { id: "r02", cat: "fresh", query: "Node.js 26.12.0 release notes", target: /nodejs\.org|github\.com\/nodejs\/node\/releases/i, fact: /26\.12\.0/ },
  { id: "r03", cat: "fresh", query: "uv 0.13 release notes", target: /github\.com\/astral-sh\/uv|astral\.sh|raw\.githubusercontent\.com\/astral-sh\/uv/i, fact: /0\.13\.[01]/ },
  { id: "r04", cat: "fresh", query: "Python 3.15.0 released", target: /python\.org/i, fact: /3\.15\.0/ },
  { id: "r05", cat: "fresh", query: "Go 1.27.2 released", target: /go\.dev|golang\.org|github\.com\/golang\/go|groups\.google\.com\/g\/golang-announce/i, fact: /1\.27\.2/ },
  { id: "r06", cat: "fresh", query: "OpenAI Codex CLI 0.163.0", target: /github\.com\/openai\/codex|developers\.openai\.com/i, fact: /0\.163\.0/ },
  { id: "r07", cat: "fresh", query: "GitHub CLI 2.102.0 release", target: /github\.com\/cli\/cli/i, fact: /2\.102\.0/ },
  { id: "r08", cat: "fresh", query: "Vite 8.3.4", target: /vite\.dev|github\.com\/vitejs|npmjs\.com\/package\/vite/i, fact: /8\.3\.4/ },
  { id: "r09", cat: "fresh", query: "Kubernetes v1.37.1 release", target: /kubernetes\.io|github\.com\/kubernetes\/kubernetes/i, fact: /1\.37\.1/ },
  { id: "r10", cat: "fresh", query: "pi coding agent 1.3.0 release", target: /github\.com\/earendil-works\/pi|npmjs\.com\/package\/@earendil-works/i, fact: /1\.3\.0/ },
  { id: "r11", cat: "fresh", query: "DeepSeek V4.1 Flash 1017", target: /api-docs\.deepseek\.com|deepseek\.com/i, fact: /1017/ },
  { id: "r12", cat: "fresh", query: "Node.js 24.22.0 LTS", target: /nodejs\.org|github\.com\/nodejs\/node/i, fact: /24\.22\.0/ },
  // Chinese queries, mostly Chinese platforms
  { id: "z01", cat: "zh", query: "科技爱好者周刊 最新一期", target: /ruanyifeng\.com\/blog\/2026\/10\/weekly-issue-415/i, fact: /415/ },
  { id: "z02", cat: "zh", query: "DeepSeek Search API 价格 QPS", target: /api-docs\.deepseek\.com/i, fact: /0\.75|5\s*元|5\s*QPS/i },
  { id: "z03", cat: "zh", query: "Python 3.15 新特性 官方文档", target: /docs\.python\.org/i },
  { id: "z04", cat: "zh", query: "Kubernetes v1.37 发布 弃用 移除", target: /kubernetes\.io/i },
  { id: "z05", cat: "zh", query: "Vue 组合式 API 生命周期钩子", target: /vuejs\.org/i },
  { id: "z06", cat: "zh", query: "微信小程序 wx.request 超时时间 设置", target: /developers\.weixin\.qq\.com/i },
  { id: "z07", cat: "zh", query: "飞书开放平台 发送消息 API", target: /open\.feishu\.cn|open\.larksuite\.com/i },
  { id: "z08", cat: "zh", query: "阿里云 OSS 签名 URL 有效期", target: /help\.aliyun\.com|alibabacloud\.com/i },
  { id: "z09", cat: "zh", query: "支付宝 alipay.trade.page.pay 接口文档", target: /opendocs\.alipay\.com/i },
  { id: "z10", cat: "zh", query: "腾讯云 COS 预签名 URL", target: /cloud\.tencent\.com/i },
  { id: "z11", cat: "zh", query: "HarmonyOS ArkTS 状态管理 V2 装饰器", target: /developer\.huawei\.com/i },
  { id: "z12", cat: "zh", query: "火山引擎 豆包大模型 API 价格", target: /volcengine\.com/i },
  { id: "z13", cat: "zh", query: "通义千问 最新 旗舰模型 发布", target: /qwen\.ai|qwenlm\.github\.io|github\.com\/QwenLM|alibabacloud\.com|aliyun\.com|modelscope\.cn|huggingface\.co\/Qwen/i },
  { id: "z14", cat: "zh", query: "DeepSeek V4 发布", site: "mp.weixin.qq.com", target: /^https?:\/\/mp\.weixin\.qq\.com\//i },
  { id: "z15", cat: "zh", query: "uv 0.13 发布 更新内容", target: /github\.com\/astral-sh\/uv|astral\.sh|raw\.githubusercontent\.com\/astral-sh\/uv/i, fact: /0\.13/ },
  // code and repositories
  { id: "g01", cat: "code", query: "pi coding agent skills", site: "github.com", target: /github\.com\/(earendil-works\/pi|badlogic\/pi)/i },
  { id: "g02", cat: "code", query: "undici ProxyAgent example", site: "github.com", target: /github\.com\/nodejs\/undici/i },
  { id: "g03", cat: "code", query: "codex config.toml model_providers", target: /github\.com\/openai\/codex|developers\.openai\.com/i },
  { id: "g04", cat: "code", query: "ripgrep .rgignore", target: /github\.com\/BurntSushi\/ripgrep/i },
  { id: "g05", cat: "code", query: "uv workspace members", target: /docs\.astral\.sh/i },
  { id: "g06", cat: "code", query: "tokio select cancellation safety", target: /docs\.rs\/tokio|tokio\.rs/i },
  // error messages pasted as the query
  { id: "t01", cat: "error", query: "npm ERR! code ERESOLVE unable to resolve dependency tree", target: /stackoverflow\.com|docs\.npmjs\.com|github\.com\/npm/i },
  { id: "t02", cat: "error", query: "pip error: externally-managed-environment", target: /peps\.python\.org|stackoverflow\.com|packaging\.python\.org|pip\.pypa\.io/i },
  { id: "t03", cat: "error", query: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", target: /docs\.docker\.com|stackoverflow\.com|github\.com\/docker/i },
  { id: "t04", cat: "error", query: "fatal: refusing to merge unrelated histories", target: /stackoverflow\.com|git-scm\.com/i },
  { id: "t05", cat: "error", query: "error[E0502]: cannot borrow as mutable because it is also borrowed as immutable", target: /doc\.rust-lang\.org|stackoverflow\.com/i },
  { id: "t06", cat: "error", query: "kubectl pod CrashLoopBackOff debug", target: /kubernetes\.io|stackoverflow\.com/i },
  // papers
  { id: "p01", cat: "paper", query: "Attention Is All You Need", target: /arxiv\.org\/(abs|pdf)\/1706\.03762|papers\.nips\.cc|proceedings\.neurips\.cc/i },
  { id: "p02", cat: "paper", query: "DeepSeek-R1 incentivizing reasoning capability reinforcement learning", target: /arxiv\.org|nature\.com|github\.com\/deepseek-ai/i },
  { id: "p03", cat: "paper", query: "reciprocal rank fusion Cormack Clarke Buettcher", target: /dl\.acm\.org|plg\.uwaterloo\.ca|cormack\.uwaterloo\.ca/i },
  // X posts, scoped to x.com
  { id: "x01", cat: "x", query: "grok 4.7", site: "x.com", target: X_POST },
  { id: "x02", cat: "x", query: "DeepSeek search API", site: "x.com", target: X_POST },
  { id: "x03", cat: "x", query: "karpathy", site: "x.com", target: X_POST },
  { id: "x04", cat: "x", query: "pi coding agent", site: "x.com", target: X_POST },
  { id: "x05", cat: "x", query: "Claude Code", site: "x.com", target: X_POST },
];
const CATS = ["docs", "fresh", "zh", "code", "error", "paper", "x"];

// --- providers -------------------------------------------------------------------------------

let lastFirecrawlAt = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function timed(fn) {
  const started = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - started) };
}

// deepseek-lang: `lang:en` on a query without CJK characters. Plain DeepSeek answers English
// queries with Chinese copies (cloud.tencent.com for npm errors) and localized Microsoft Learn pages.
async function deepseekSearch(c, { lang = false } = {}) {
  const query = [c.query, c.site ? `site:${c.site}` : "", lang && !CJK.test(c.query) ? "lang:en" : ""].filter(Boolean).join(" ");
  try {
    const res = await fetch("https://api.deepseek.com/v1/tools/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, count: COUNT }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, raw: data } : { ok: false, error: data?.error?.message || `HTTP ${res.status}`, raw: data };
  } catch (error) {
    return { ok: false, error: error.message, raw: null };
  }
}

// search.js always asks Tavily for "advanced" (2 credits); "basic" (1 credit) is the cheaper option.
async function tavilyBasic(c) {
  try {
    const raw = await requestJson(`${config.tavilyApiUrl.replace(/\/+$/, "")}/search`, {
      headers: authHeaders(config.tavilyApiKey),
      body: {
        query: c.query,
        max_results: COUNT,
        search_depth: "basic",
        include_raw_content: false,
        include_answer: false,
        ...(c.site ? { include_domains: [c.site], include_domains_mode: "restrict" } : {}),
      },
      timeoutMs: 90_000,
      config,
      retry: true,
    });
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, error: error.message, raw: null };
  }
}

async function firecrawl(c) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wait = lastFirecrawlAt + FIRECRAWL_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastFirecrawlAt = Date.now();
    const result = await firecrawlSearch(c.query, COUNT, config, c.site ? { allowedDomains: [c.site] } : {});
    if (result.ok || !/429/.test(result.error || "") || attempt === 1) return { ok: result.ok, error: result.error, raw: result.raw ?? null, credits_used: result.credits_used };
    await sleep(20_000);
  }
}

async function runProvider(c, provider) {
  if (provider === "deepseek") return timed(() => deepseekSearch(c));
  if (provider === "deepseek-lang") return timed(() => deepseekSearch(c, { lang: true }));
  if (provider === "tavily-basic") return timed(() => tavilyBasic(c));
  if (provider === "firecrawl") return timed(() => firecrawl(c));
  return timed(async () => {
    const r = await tavilySearch(c.query, COUNT, config, c.site ? { allowedDomains: [c.site] } : {});
    return { ok: r.ok, error: r.error, raw: r.raw ?? null };
  });
}

/** Raw response → [{ url, title, text, date }] in rank order. */
function items(provider, raw) {
  if (provider.startsWith("deepseek")) return (raw?.results || []).map((r) => ({ url: r.url, title: r.title, text: r.summary || r.snippet, date: r.date }));
  if (provider.startsWith("tavily")) return (raw?.results || []).map((r) => ({ url: r.url, title: r.title, text: r.content, date: r.published_date }));
  const list = raw?.data?.web || raw?.data || [];
  return (Array.isArray(list) ? list : []).map((r) => ({ url: r.url, title: r.title, text: r.description, date: r.publishedDate || r.date }));
}

// --- scoring ---------------------------------------------------------------------------------

// DeepSeek appends "#1" or "#1#1" to URLs; raw.githubusercontent.com copies are the GitHub file;
// tracking parameters (YouTube's xstg, utm_*, Tencent's policyId) do not make another page.
const TRACKING = /^(utm_|xstg$|ref$|source$|policyId$|fromPaywallRec$|trk$|_p_lc$|ajs_aid$|f$|in$|commTag$|lang$)/i;
function pageKey(url) {
  const bare = String(url || "").replace(/#.*$/, "");
  try {
    const u = new URL(bare);
    let host = u.hostname.replace(/^www\./, "");
    let p = u.pathname.replace(/\/+$/, "");
    if (host === "raw.githubusercontent.com") {
      const [, owner, repo, ...rest] = p.split("/");
      host = "github.com";
      p = `/${owner}/${repo}/${rest.slice(rest[0] === "refs" ? 3 : 1).join("/")}`.replace(/\/+$/, "");
    }
    const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    return `${host}${p}${params.length ? `?${new URLSearchParams(params)}` : ""}`;
  } catch {
    return bare;
  }
}

const card = (item) => `${item.title || ""}\n${String(item.text || "").slice(0, CARD_CHARS)}`;

function stats(c, list, { ok, error, ms, credits_used }) {
  const urls = list.map((i) => String(i.url || "").replace(/#.*$/, ""));
  const rank = urls.findIndex((u) => c.target.test(u)) + 1 || null;
  const top3 = list.slice(0, 3);
  return {
    ok,
    error: error ? String(error).slice(0, 160) : null,
    ms,
    count: list.length,
    rank,
    hit3: rank !== null && rank <= 3,
    hit10: rank !== null,
    fact3: c.fact ? top3.some((i) => c.fact.test(card(i))) : null,
    fact3_full: c.fact ? top3.some((i) => c.fact.test(`${i.title}\n${i.text}`)) : null,
    fact10: c.fact ? list.some((i) => c.fact.test(card(i))) : null,
    dup3: top3.length - new Set(top3.map((i) => pageKey(i.url))).size,
    // an English query answered in another script: the title or the card's opening is CJK
    foreign3: CJK.test(c.query) ? null : top3.filter((i) => CJK.test(`${i.title || ""} ${String(i.text || "").slice(0, 120)}`)).length,
    dated: list.filter((i) => i.date).length,
    x_posts: urls.filter((u) => X_POST.test(u)).length,
    newest: list.map((i) => i.date).filter(Boolean).sort().pop()?.slice(0, 10) ?? null,
    card_chars: median(top3.map((i) => Math.min(CARD_CHARS, String(i.text || "").length))),
    top3: urls.slice(0, 3),
    ...(credits_used != null ? { credits_used } : {}),
  };
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

/** The extra slot shown as the union of two providers' top 3. */
function slot(c, saved, a, b) {
  const top = [...items(a, saved.raw[a]).slice(0, 3), ...items(b, saved.raw[b]).slice(0, 3)];
  return {
    hit: top.some((i) => c.target.test(String(i.url || "").replace(/#.*$/, ""))),
    fact: c.fact ? top.some((i) => c.fact.test(card(i))) : null,
    pages: new Set(top.map((i) => pageKey(i.url))).size,
  };
}

// --- output ----------------------------------------------------------------------------------

const pad = (v, w) => (String(v ?? "").length >= w ? String(v ?? "") : String(v ?? "") + " ".repeat(w - String(v ?? "").length));
const pct = (n, d) => (d ? `${n}/${d}` : "-");

function report(saved) {
  const present = PROVIDERS.filter((p) => saved.some((s) => s.row[p]));
  console.log("\n== per query: rank of the first target URL (- none), F = fact on a top-3 card ==");
  console.log([pad("id", 5), pad("cat", 6), ...present.map((p) => pad(p, 14))].join(" "));
  for (const s of saved) {
    const cell = (r) => (!r ? "" : !r.ok ? `ERR` : `${r.rank ?? "-"}${r.fact3 ? " F" : ""} ${(r.ms / 1000).toFixed(1)}s`);
    console.log([pad(s.case.id, 5), pad(s.case.cat, 6), ...present.map((p) => pad(cell(s.row[p]), 14))].join(" "));
  }

  console.log("\n== hit@3 by kind (target URL in the top 3) ==");
  console.log([pad("kind", 7), pad("n", 3), ...present.map((p) => pad(p, 13))].join(" "));
  for (const cat of [...CATS, "all"]) {
    const group = saved.filter((s) => cat === "all" || s.case.cat === cat);
    console.log([pad(cat, 7), pad(group.length, 3), ...present.map((p) => pad(pct(group.filter((s) => s.row[p]?.hit3).length, group.length), 13))].join(" "));
  }

  console.log("\n== overall ==");
  for (const p of present) {
    const r = saved.map((s) => s.row[p]).filter(Boolean);
    const facts = r.filter((x) => x.fact3 !== null);
    const nonX = saved.filter((s) => s.case.cat !== "x").map((s) => s.row[p]).filter(Boolean);
    console.log(
      `${pad(p, 13)} hit@1 ${pct(r.filter((x) => x.rank === 1).length, r.length)}  hit@3 ${pct(r.filter((x) => x.hit3).length, r.length)}  hit@10 ${pct(r.filter((x) => x.hit10).length, r.length)}` +
        `  fact@3 ${pct(facts.filter((x) => x.fact3).length, facts.length)} (full text ${facts.filter((x) => x.fact3_full).length})` +
        `  dup@3 ${r.reduce((a, x) => a + x.dup3, 0)}  foreign@3 ${r.reduce((a, x) => a + (x.foreign3 || 0), 0)}  empty ${r.filter((x) => x.ok && !x.count).length}  err ${r.filter((x) => !x.ok).length}` +
        `  median ${median(r.map((x) => x.ms))}ms  dated ${nonX.reduce((a, x) => a + x.dated, 0)}/${nonX.reduce((a, x) => a + x.count, 0)}  card ${median(r.map((x) => x.card_chars))}c`
    );
  }

  console.log("\n== extra slot: union of two providers' top 3 (target hit / fact / distinct pages) ==");
  const pairs = [["tavily", "firecrawl"], ["tavily-basic", "firecrawl"], ["deepseek", "firecrawl"], ["deepseek-lang", "firecrawl"], ["deepseek", "tavily"], ["deepseek-lang", "tavily"]].filter(([a, b]) => present.includes(a) && present.includes(b));
  for (const [a, b] of pairs) {
    const rows = saved.filter((s) => s.raw[a] && s.raw[b]).map((s) => ({ cat: s.case.cat, ...slot(s.case, s, a, b) }));
    const facts = rows.filter((x) => x.fact !== null);
    const byCat = CATS.map((cat) => `${cat} ${rows.filter((x) => x.cat === cat && x.hit).length}/${rows.filter((x) => x.cat === cat).length}`).join("  ");
    console.log(`${pad(`${a}+${b}`, 24)} hit ${pct(rows.filter((x) => x.hit).length, rows.length)}  fact ${pct(facts.filter((x) => x.fact).length, facts.length)}  pages ${median(rows.map((x) => x.pages))}   ${byCat}`);
  }

  console.log("\n== X (site x.com): status URLs in 10 results, newest date ==");
  for (const s of saved.filter((s) => s.case.cat === "x")) {
    console.log([pad(s.case.id, 5), pad(s.case.query, 22), ...present.map((p) => pad(s.row[p] ? `${s.row[p].x_posts}/${s.row[p].count} ${s.row[p].newest ?? ""}` : "", 16))].join(" "));
  }
}

// --- main ------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const only = flag("--only", "") ? new Set(flag("--only", "").split(",")) : null;
const providers = flag("--providers", "") ? PROVIDERS.filter((p) => flag("--providers", "").split(",").includes(p)) : PROVIDERS;
const outDir = path.resolve(flag("--out", path.join(ROOT, "benchmarks", "results", "search-extra-compare")));
const rescore = argv.includes("--rescore");

configureProxy();
const config = await loadConfig();
await mkdir(outDir, { recursive: true });
if (!rescore && providers.includes("deepseek") && !KEY) {
  console.error("DEEPSEEK_API_KEY is not set");
  process.exit(2);
}

const saved = [];
for (const c of CASES) {
  const file = path.join(outDir, `${c.id}.json`);
  const old = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
  const raw = { ...(old?.raw ?? {}) };
  const meta = { ...(old?.meta ?? {}) };
  if (!rescore && (!only || only.has(c.id))) {
    process.stderr.write(`${c.id} ${c.query}\n`);
    const results = await Promise.all(providers.map((p) => runProvider(c, p)));
    providers.forEach((p, i) => {
      const { result, ms } = results[i];
      raw[p] = result.raw;
      meta[p] = { ok: result.ok, error: result.error ?? null, ms, credits_used: result.credits_used ?? null, at: new Date().toISOString() };
    });
  }
  if (!Object.keys(meta).length) continue;
  const row = Object.fromEntries(Object.keys(meta).map((p) => [p, stats(c, items(p, raw[p]), meta[p])]));
  const entry = { case: { ...c, target: String(c.target), fact: c.fact ? String(c.fact) : null }, row, raw, meta };
  await writeFile(file, JSON.stringify(entry, null, 2));
  saved.push({ ...entry, case: c });
}
await writeFile(path.join(outDir, "summary.json"), JSON.stringify(saved.map((s) => ({ id: s.case.id, cat: s.case.cat, query: s.case.query, ...s.row })), null, 2));
report(saved);
