#!/usr/bin/env node
/**
 * DeepSeek Search / Fetch (opened 2026-10-17) against the channels grok-search already uses.
 *
 *   DEEPSEEK_API_KEY=... node benchmarks/deepseek-compare.mjs --part search|fetch|answer|all [--only id,id]
 *                                                            [--providers a,b] [--repeat N] [--out DIR]
 *
 * - search: the same query to DeepSeek Search, Tavily Search and Firecrawl Search, 10 results each.
 *   Scored by the rank of the first URL on the page a careful human would cite.
 * - fetch: the same URL to DeepSeek Fetch, Tavily Extract, Firecrawl Scrape and Direct. Scored by
 *   whether a phrase from the real page body is in the text.
 * - answer: the same question to grok-search (search.js, Grok Responses + web_search) and to
 *   deepseek-v4-pro on DeepSeek's Responses API with its server-side web_search, both with
 *   grok-search's system prompt. Scored with regexes against gold taken from official sources
 *   on 2026-10-19 (Beijing), which go stale as projects release.
 *
 * Sends real, billed requests. Writes one JSON per case and summary-<part>.json into DIR; a rerun
 * with --only replaces those rows in the summary. --part search-rescore / fetch-rescore / answer-rescore re-judge
 * the saved responses.
 * Run the parts one after another: Firecrawl's per-minute limit (429) is shared by search and fetch.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../scripts/lib/config.js";
import { searchPrompt, ANSWER_MARKER_PATTERN } from "../scripts/lib/prompts.js";
import { fetchUrl } from "../scripts/lib/providers.js";
import { configureProxy } from "../scripts/lib/proxy.js";
import { firecrawlSearch, tavilySearch } from "./lib/search-apis.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEEPSEEK_URL = "https://api.deepseek.com";
const KEY = process.env.DEEPSEEK_API_KEY;
const SEARCH_COUNT = 10;

// --- cases -----------------------------------------------------------------------------------

// `target`: host/path of the page a careful human would cite. `site`: domain scope, sent to
// DeepSeek as a site: operator and to Tavily/Firecrawl as their domain filter.
const SEARCH_CASES = [
  // the web cases of provider-compare.mjs (2026-09-08)
  { id: "s01-node-lts", query: "Node.js 24 LTS release date", target: /nodejs\.org|github\.com\/nodejs\/Release|raw\.githubusercontent\.com\/nodejs\/Release/i },
  { id: "s02-xai-pricing", query: "xAI grok-4-fast pricing per million tokens", target: /docs\.x\.ai|x\.ai\/(api|news)/i },
  { id: "s03-firecrawl-docs", query: "Firecrawl v2 search API includeDomains parameter", target: /docs\.firecrawl\.dev/i },
  { id: "s04-tavily-docs", query: "Tavily search API include_domains_mode", target: /docs\.tavily\.com/i },
  { id: "s05-openai-responses", query: "OpenAI Responses API max_tool_calls", target: /platform\.openai\.com|developers\.openai\.com/i },
  { id: "s06-github-scoped", query: "pi coding agent skills", site: "github.com", target: /github\.com\/(earendil-works\/pi|badlogic\/pi)/i },
  { id: "s07-rust-release", query: "latest Rust stable release announcement", target: /blog\.rust-lang\.org\/(2026\/10\/(01|15)|releases\/)/i },
  { id: "s08-vite-zh", query: "Vite 最新版本 迁移指南 破坏性变更", target: /vite\.dev|vitejs\.dev/i },
  { id: "s09-k8s-deprecations", query: "Kubernetes latest release deprecated APIs removed", target: /kubernetes\.io/i },
  // freshness: released in the last week
  { id: "s10-rust-1991", query: "Rust 1.99.1 release", target: /blog\.rust-lang\.org\/(2026\/10\/15|releases\/latest)|github\.com\/rust-lang\/rust\/releases/i },
  { id: "s11-node-2612", query: "Node.js 26.12.0 release notes", target: /nodejs\.org\/[a-z-]*\/?blog\/release\/v26\.12\.0|github\.com\/nodejs\/node\/releases\/tag\/v26\.12\.0/i },
  { id: "s12-uv-013", query: "uv 0.13.0 release notes astral", target: /github\.com\/astral-sh\/uv\/(releases|blob\/main\/CHANGELOG)|raw\.githubusercontent\.com\/astral-sh\/uv\/[^/]+\/CHANGELOG|astral\.sh\/blog/i },
  // Chinese web
  { id: "c01-ruanyf-weekly", query: "科技爱好者周刊 最新一期", target: /ruanyifeng\.com\/blog\/2026\/10\/weekly-issue-41[45]/i },
  { id: "c02-deepseek-search-price", query: "DeepSeek Search API 价格 QPS", target: /api-docs\.deepseek\.com/i },
  { id: "c03-qwen-latest", query: "通义千问 Qwen 最新模型 发布", target: /qwen\.ai|qwenlm\.github\.io|github\.com\/QwenLM|alibabacloud\.com|aliyun\.com|modelscope\.cn|huggingface\.co\/Qwen/i },
  { id: "c04-python-315", query: "Python 3.15 新特性 官方文档", target: /docs\.python\.org/i },
  { id: "c05-k8s-137-zh", query: "Kubernetes v1.37 发布 弃用 移除", target: /kubernetes\.io/i },
  { id: "c06-weixin-scoped", query: "DeepSeek V4 发布", site: "mp.weixin.qq.com", target: /^https?:\/\/mp\.weixin\.qq\.com\//i },
];

// `expect`: a phrase from the real page body. `min`: below this many characters the text is a
// shell (login wall, player chrome) even when the phrase (often the title) is in it.
const FETCH_CASES = [
  // the cases of provider-compare.mjs (2026-09-08)
  { id: "f01-github-readme", url: "https://github.com/nodejs/Release", expect: /release schedule/i, min: 2000, kind: "github" },
  { id: "f02-mintlify-spa", url: "https://docs.firecrawl.dev/api-reference/endpoint/search", expect: /includeDomains/i, min: 2000, kind: "spa-docs" },
  { id: "f03-tavily-docs", url: "https://docs.tavily.com/documentation/api-reference/endpoint/search", expect: /include_domains_mode/i, min: 2000, kind: "spa-docs" },
  { id: "f04-x-post", url: "https://x.com/kunchenguid/status/2087942296721559607", expect: /unbiased review/i, min: 200, kind: "x-post" },
  { id: "f05-hn-front", url: "https://news.ycombinator.com/", expect: /points by/i, min: 2000, kind: "static" },
  { id: "f06-reddit", url: "https://www.reddit.com/r/rust/", expect: /r\/rust/i, min: 2000, kind: "anti-bot" },
  { id: "f07-arxiv-pdf", url: "https://arxiv.org/pdf/1706.03762", expect: /attention is all you need/i, min: 5000, kind: "pdf" },
  { id: "f08-rust-blog", url: "https://blog.rust-lang.org/", expect: /Announcing Rust 1\./i, min: 2000, kind: "static" },
  { id: "f09-ruanyifeng", url: "https://www.ruanyifeng.com/blog/", expect: /科技爱好者周刊/, min: 800, kind: "static-zh" },
  { id: "f10-wikipedia", url: "https://en.wikipedia.org/wiki/Node.js", expect: /JavaScript runtime/i, min: 5000, kind: "static" },
  { id: "f11-xai-docs", url: "https://docs.x.ai/docs/models", expect: /grok-4/i, min: 1000, kind: "spa-docs" },
  { id: "f12-youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", expect: /Rick Astley/i, min: 300, kind: "video" },
  // added 2026-10-19
  { id: "f13-github-issue", url: "https://github.com/astral-sh/uv/issues/1495", expect: /opinionated workflow for environment management/i, min: 2000, kind: "github-issue" },
  { id: "f14-arxiv-abs", url: "https://arxiv.org/abs/1706.03762", expect: /dominant sequence transduction models/i, min: 800, kind: "static" },
  { id: "f15-zhihu-zhuanlan", url: "https://zhuanlan.zhihu.com/p/2030970112153490502", expect: /V4/, min: 800, kind: "zh-anti-bot" },
  { id: "f16-weixin", url: "http://mp.weixin.qq.com/s?__biz=MzY5NzQxMDUxNw==&mid=2247484159&idx=1&sn=dc3910c55596cf0e8ac56bfa12cf38f5", expect: /DeepSeek/i, min: 800, kind: "zh-weixin" },
  { id: "f17-juejin", url: "https://juejin.cn/post/7555498288524591104", expect: /所有权/, min: 800, kind: "zh-spa" },
  { id: "f18-csdn", url: "https://pharaoh.blog.csdn.net/article/details/168135674", expect: /Rolldown/i, min: 800, kind: "zh-static" },
  { id: "f19-bilibili", url: "https://www.bilibili.com/video/BV1XtNVefEsR/", expect: /DeepSeek/i, min: 300, kind: "zh-video" },
  { id: "f20-sspai", url: "https://sspai.com/post/96566", expect: /Rust/, min: 1500, kind: "zh-spa" },
  { id: "f21-36kr", url: "https://36kr.com/p/3780724652339714", expect: /黄仁勋/, min: 800, kind: "zh-static" },
];
const FETCH_PROVIDERS = ["deepseek", "tavily", "firecrawl", "direct"];

// Accepts 2026-09-01, 2026/9/1, 2026 年 9 月 1 日, 9 月 1 日, Sep 1, 2026, 1 September 2026.
function date(...days) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const alts = days.map((day) => {
    const [y, m, d] = day.split("-").map(Number);
    const mon = `${months[m - 1]}[a-z]*\\.?`;
    return `${y}\\s*[-/.年]\\s*0?${m}\\s*[-/.月]\\s*0?${d}(?!\\d)|(?<!\\d)0?${m}\\s*月\\s*0?${d}\\s*日|${mon}\\s+0?${d}(?:st|nd|rd|th)?,?\\s+${y}|0?${d}\\s+${mon}\\s+${y}`;
  });
  return new RegExp(alts.join("|"), "i");
}

// npm 11.19.1: the changelog heading says 2026-08-25, the registry and GitHub release 2026-08-26 UTC.
// Gold from official sources on 2026-10-19 Beijing: GitHub releases API, go.dev release history,
// nodejs.org/dist/index.json, registry.npmjs.org, endoflife.date, ruanyifeng.com, docs.tavily.com,
// api-docs.deepseek.com/quick_start/pricing. Each criterion is one field the answer must state.
const ANSWER_CASES = [
  { id: "go", q: "Go 当前最新的稳定版是哪个完整版本号？哪天发布的？", criteria: [/1\.27\.2/, date("2026-10-08")] },
  { id: "gh", q: "GitHub CLI（gh）最新正式版的版本号和发布日期是什么？", criteria: [/2\.102\.0/, date("2026-09-29", "2026-09-30")] },
  { id: "rust", q: "Rust 最新稳定版的版本号和发布日期是什么？", criteria: [/1\.99\.1/, date("2026-10-15", "2026-10-16")] },
  { id: "codex", q: "OpenAI Codex CLI（GitHub openai/codex）最新的正式 release 版本号和发布日期是什么？", criteria: [/0\.163\.0/, date("2026-10-15", "2026-10-16")] },
  { id: "node", q: "Node.js 当前最新的 LTS 版本和最新的 Current 版本分别是哪个完整版本号？各自哪天发布？", criteria: [/24\.22\.0/, /26\.12\.0/, date("2026-10-14", "2026-10-15")] },
  { id: "k8s-uv", q: "两个问题：Kubernetes 最新的稳定版本号是多少？uv（astral-sh/uv）最新版本号和发布日期是什么？", criteria: [/1\.37\.1/, /0\.13\.1/, date("2026-10-14")] },
  { id: "node-npm", q: "Node.js 当前最新 LTS 版本自带的 npm 是哪个版本？这个 npm 版本是哪天发布的？", criteria: [/11\.19\.1/, date("2026-08-25", "2026-08-26", "2026-08-27")] },
  { id: "pi", q: "pi coding agent（GitHub earendil-works/pi，npm 包 @earendil-works/pi-coding-agent）最新版本号是多少？哪天发布的？", criteria: [/1\.3\.0/, date("2026-10-15", "2026-10-16")] },
  { id: "vite", q: "Vite 最新的正式版本号是多少？哪天发布的？", criteria: [/8\.3\.4/, date("2026-10-08")] },
  { id: "python", q: "Python 最新的稳定版本号是多少？哪天发布的？", criteria: [/3\.15\.0/, date("2026-10-09")] },
  { id: "ruanyf", q: "阮一峰的《科技爱好者周刊》最新一期是第几期？标题是什么？哪天发布的？", criteria: [/415/, /看不见的城市/, date("2026-10-16")] },
  { id: "tavily", q: "Tavily Search API 的 include_domains 和 exclude_domains 参数分别最多能传多少个域名？", criteria: [/300/, /150/] },
  { id: "deepseek-flash", q: "DeepSeek API 里 deepseek-flash 这个模型名当前对应的是哪个模型版本？", criteria: [/V4\.1[-\s]?Flash[-\s]?1017/i] },
];

// --- helpers ---------------------------------------------------------------------------------

function pad(value, width) {
  const s = String(value ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.floor(v.length / 2)];
}

function shortLineRatio(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  return Number((lines.filter((line) => line.length < 20).length / lines.length).toFixed(2));
}

async function deepseek(pathname, body, timeoutMs = 120_000) {
  const started = performance.now();
  try {
    const res = await fetch(`${DEEPSEEK_URL}${pathname}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    return { status: res.status, ok: res.ok, data, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { status: null, ok: false, data: { error: { message: error.message } }, ms: Math.round(performance.now() - started) };
  }
}

async function timed(promise) {
  const started = performance.now();
  const result = await promise;
  return { result, ms: Math.round(performance.now() - started) };
}

// --- search ----------------------------------------------------------------------------------

// DeepSeek appends "#1" (sometimes "#1#1") to result URLs; drop fragments before comparing.
const bare = (url) => String(url || "").replace(/#.*$/, "");

function searchStats(c, provider, items, { ok, error, ms, extra = {} }) {
  const urls = items.map((item) => bare(item.url));
  const rank = urls.findIndex((url) => c.target.test(url)) + 1;
  return {
    provider,
    ok,
    error: error ?? null,
    ms,
    count: items.length,
    rank: rank || null,
    hit3: rank > 0 && rank <= 3,
    hit10: rank > 0,
    dated: items.filter((item) => item.date).length,
    hosts: new Set(urls.map(hostOf)).size,
    text_chars: median(items.map((item) => (item.text || "").length)),
    top3: urls.slice(0, 3),
    ...extra,
  };
}

const SEARCH_PROVIDERS = ["deepseek", "tavily", "firecrawl"];

/** The provider's raw response as { url, title, text, date } items, in rank order. */
function searchItems(provider, raw) {
  if (provider === "deepseek") {
    return (raw?.results || []).map((r) => ({ url: r.url, title: r.title, text: r.summary || r.snippet, date: r.date, rerank: r.rerank_score, authority: r.authority }));
  }
  if (provider === "tavily") return (raw?.results || []).map((r) => ({ url: r.url, title: r.title, text: r.content, date: r.published_date }));
  const list = raw?.data?.web || raw?.data || [];
  return (Array.isArray(list) ? list : []).map((r) => ({ url: r.url, title: r.title, text: r.description, date: r.publishedDate || r.date }));
}

function searchStatsFor(c, provider, raw, { ok, error, ms, credits_used }) {
  const items = searchItems(provider, raw);
  const extra =
    provider === "deepseek"
      ? {
          high_quality: items.filter((i) => i.rerank >= 1.5).length,
          authoritative: items.filter((i) => i.authority >= 3).length,
          url_fragments: items.filter((i) => /#/.test(i.url)).length,
        }
      : provider === "firecrawl"
        ? { credits_used: credits_used ?? null }
        : {};
  return searchStats(c, provider, items, { ok, error, ms, extra });
}

async function searchOne(c, provider) {
  const filters = c.site ? { allowedDomains: [c.site] } : {};
  if (provider === "deepseek") {
    const ds = await deepseek("/v1/tools/search", { query: c.site ? `${c.query} site:${c.site}` : c.query, count: SEARCH_COUNT }, 60_000);
    const error = ds.ok ? null : ds.data?.error?.message || `HTTP ${ds.status}`;
    return { stats: searchStatsFor(c, provider, ds.data, { ok: ds.ok, error, ms: ds.ms }), raw: ds.data };
  }
  const search = provider === "tavily" ? tavilySearch : firecrawlSearch;
  const { result, ms } = await timed(search(c.query, SEARCH_COUNT, config, filters));
  const raw = result.raw ?? result;
  return { stats: searchStatsFor(c, provider, raw, { ok: result.ok, error: result.error, ms, credits_used: result.credits_used }), raw };
}

/** Recompute search stats from the saved raw responses, after a change to a case's target. */
async function rescoreSearch() {
  const rows = [];
  for (const c of SEARCH_CASES) {
    const saved = JSON.parse(await readFile(path.join(outDir, `${c.id}.json`), "utf8").catch(() => "null"));
    if (!saved) continue;
    const row = saved.row;
    for (const provider of SEARCH_PROVIDERS) {
      const old = row[provider];
      if (old) row[provider] = searchStatsFor(c, provider, saved.raw[provider], old);
    }
    await writeFile(path.join(outDir, `${c.id}.json`), JSON.stringify({ ...saved, case: { ...c, target: String(c.target) }, row }, null, 2));
    rows.push(row);
  }
  return rows;
}

/** Runs `providers` on the case; with a subset, the other providers' results of an earlier run are kept. */
async function searchCase(c, providers) {
  const file = path.join(outDir, `${c.id}.json`);
  const old = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
  const row = { id: c.id, query: c.query, site: c.site ?? null, ...(old?.row ?? {}) };
  const raw = { ...(old?.raw ?? {}) };
  const results = await Promise.all(providers.map((provider) => searchOne(c, provider)));
  providers.forEach((provider, i) => {
    row[provider] = results[i].stats;
    raw[provider] = results[i].raw;
  });
  await writeFile(file, JSON.stringify({ case: { ...c, target: String(c.target) }, row, raw }, null, 2));
  return row;
}

function printSearch(rows) {
  console.log(`\n== search: rank of the first target URL in ${SEARCH_COUNT} results (- = none), ms, results with a date ==`);
  console.log([pad("case", 26), pad("deepseek", 22), pad("tavily", 22), pad("firecrawl", 22)].join(" "));
  const cell = (s) => (s.ok ? `${s.rank ?? "-"} ${s.ms}ms d${s.dated}/${s.count}` : `ERR ${String(s.error).slice(0, 14)}`);
  for (const r of rows) console.log([pad(r.id, 26), pad(cell(r.deepseek), 22), pad(cell(r.tavily), 22), pad(cell(r.firecrawl), 22)].join(" "));
  for (const p of ["deepseek", "tavily", "firecrawl"]) {
    const s = rows.map((r) => r[p]);
    console.log(
      `${pad(p, 10)} hit@1 ${s.filter((x) => x.rank === 1).length}  hit@3 ${s.filter((x) => x.hit3).length}  hit@10 ${s.filter((x) => x.hit10).length} / ${s.length}` +
        `  median ${median(s.map((x) => x.ms))}ms  dated ${s.reduce((a, x) => a + x.dated, 0)}/${s.reduce((a, x) => a + x.count, 0)}` +
        `  median text ${median(s.map((x) => x.text_chars))}c  errors ${s.filter((x) => !x.ok).length}`
    );
  }
}

// --- fetch -----------------------------------------------------------------------------------

async function fetchOne(c, provider) {
  let ok;
  let content = "";
  let title = "";
  let error = null;
  let ms;
  let extra = {};
  if (provider === "deepseek") {
    const res = await deepseek("/v1/tools/fetch", { url: c.url }, 120_000);
    ms = res.ms;
    ok = res.ok && Boolean(res.data?.content);
    content = res.data?.content || "";
    title = res.data?.title || "";
    if (!ok) error = `${res.status ?? "net"} ${res.data?.error?.message || res.data?.raw || ""}`.trim();
  } else {
    const { result, ms: took } = await timed(fetchUrl(c.url, config, { provider }));
    ms = took;
    ok = Boolean(result.ok);
    content = result.content || "";
    title = result.metadata?.title || "";
    if (!ok) error = String(result.error || "failed");
    const credits = (result.tried || []).reduce((sum, a) => sum + (Number.isFinite(a.credits_used) ? a.credits_used : 0), 0);
    if (credits) extra.credits_used = credits;
  }
  await writeFile(path.join(outDir, "pages", `${c.id}--${provider}.md`), content);
  return { provider, ok, error: error ? error.slice(0, 200) : null, ms, title: Boolean(title), ...judge(c, ok, content), ...extra };
}

// DeepSeek Fetch backslash-escapes Markdown punctuation ("Rust 1\.99", "include\_domains\_mode",
// "\#\# Posts"), so the phrase check runs on the text with those escapes removed.
const unescapeMarkdown = (text) => text.replace(/\\(?=[^\sA-Za-z0-9\u0080-\uffff])/g, "");

function judge(c, ok, content) {
  const plain = unescapeMarkdown(content);
  const expect = c.expect.test(plain);
  return {
    verdict: !ok ? "ERR" : expect && plain.length >= c.min ? "ok" : "SHELL",
    chars: content.length,
    expect,
    escapes_per_1k: content.length ? Number((((content.length - plain.length) / content.length) * 1000).toFixed(1)) : null,
    short_line_ratio: shortLineRatio(plain),
    head: content.slice(0, 200),
  };
}

/** Recompute fetch verdicts from the saved pages, after a change to judge() or the cases. */
async function rescoreFetch() {
  const rows = JSON.parse(await readFile(path.join(outDir, "summary-fetch.json"), "utf8"));
  for (const row of rows) {
    const c = FETCH_CASES.find((x) => x.id === row.id);
    for (const [provider, r] of Object.entries(row.providers)) {
      const content = await readFile(path.join(outDir, "pages", `${row.id}--${provider}.md`), "utf8").catch(() => "");
      Object.assign(r, judge(c, r.ok, content));
    }
  }
  return rows;
}

/** Rows of this run replace same-id rows of an earlier run in the summary; the rest are kept. */
async function saveSummary(name, rows, key = (r) => r.id) {
  const file = path.join(outDir, name);
  const old = JSON.parse(await readFile(file, "utf8").catch(() => "[]"));
  const fresh = new Set(rows.map(key));
  const merged = [...old.filter((r) => !fresh.has(key(r))), ...rows];
  await writeFile(file, JSON.stringify(merged, null, 2));
  return merged;
}

async function fetchCase(c, providers) {
  const file = path.join(outDir, `${c.id}.json`);
  const old = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
  const results = await Promise.all(providers.map((provider) => fetchOne(c, provider)));
  const row = { id: c.id, url: c.url, kind: c.kind, providers: { ...(old?.row?.providers ?? {}), ...Object.fromEntries(results.map((r) => [r.provider, r])) } };
  await writeFile(file, JSON.stringify({ case: { ...c, expect: String(c.expect) }, row }, null, 2));
  return row;
}

function printFetch(rows) {
  console.log("\n== fetch: ok = body phrase found and long enough, SHELL = text without it, noise = share of lines under 20 chars ==");
  console.log([pad("case", 20), pad("kind", 13), ...FETCH_PROVIDERS.map((p) => pad(p, 26))].join(" "));
  const cell = (r) => (r.verdict === "ERR" ? `ERR ${r.ms}ms` : `${r.verdict} ${r.chars}c ${r.ms}ms n${r.short_line_ratio ?? "-"}`);
  for (const r of rows) console.log([pad(r.id, 20), pad(r.kind, 13), ...FETCH_PROVIDERS.map((p) => pad(cell(r.providers[p]), 26))].join(" "));
  for (const p of FETCH_PROVIDERS) {
    const s = rows.map((r) => r.providers[p]);
    console.log(
      `${pad(p, 10)} ok ${s.filter((x) => x.verdict === "ok").length}  shell ${s.filter((x) => x.verdict === "SHELL").length}  err ${s.filter((x) => x.verdict === "ERR").length} / ${s.length}` +
        `  median ${median(s.map((x) => x.ms))}ms  median noise ${median(s.filter((x) => x.ok).map((x) => x.short_line_ratio))}`
    );
  }
}

// --- answer ----------------------------------------------------------------------------------

function score(c, answer) {
  const passed = c.criteria.map((re) => re.test(answer));
  return { fields: passed.filter(Boolean).length, total: c.criteria.length, passed };
}

// deepseek-v4-pro per 1M tokens, USD (api-docs.deepseek.com/quick_start/pricing, 2026-10-19).
// Peak: 01:00-04:00 and 06:00-10:00 UTC on weekdays; off-peak is half.
function deepseekCostUsd(usage, at = new Date()) {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  const peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const k = peak ? 1 : 0.5;
  const cached = usage?.input_tokens_details?.cached_tokens || 0;
  const miss = (usage?.input_tokens || 0) - cached;
  return ((cached * 0.044 + miss * 1.32 + (usage?.output_tokens || 0) * 3.96) * k) / 1e6;
}

async function grokAnswer(c) {
  const started = performance.now();
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("node", [path.join(ROOT, "scripts", "search.js"), "--no-extra", c.q], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 }));
  } catch (error) {
    stdout = error.stdout || "";
  }
  const ms = Math.round(performance.now() - started);
  let out = {};
  try {
    out = JSON.parse(stdout);
  } catch {
    out = { error: { message: `non-JSON stdout: ${stdout.slice(0, 200)}` } };
  }
  const answer = out.answer?.text || "";
  return {
    provider: "grok",
    model: out.diagnostics?.responses_model ?? out.model ?? null,
    ok: !out.error,
    error: out.error?.message ?? null,
    ms,
    cost_usd: out.diagnostics?.cost_usd ?? null,
    tool_calls: out.diagnostics?.responses_tool_calls?.by_action ?? out.diagnostics?.responses_tool_calls?.total ?? null,
    citations: (out.sources?.items || []).filter((s) => s.source_type === "citation").map((s) => s.url).slice(0, 6),
    answer,
    ...score(c, answer),
  };
}

async function deepseekAnswer(c) {
  const res = await deepseek(
    "/responses",
    { model: "deepseek-v4-pro", instructions: searchPrompt, input: c.q, tools: [{ type: "web_search" }], reasoning: { effort: "low" } },
    300_000
  );
  const output = res.data?.output || [];
  const message = output.filter((o) => o.type === "message").pop();
  const answer = (message?.content || [])
    .map((part) => part.text || "")
    .join("\n")
    .replace(ANSWER_MARKER_PATTERN, "")
    .trim();
  const calls = output.filter((o) => o.type === "web_search_call");
  const byAction = {};
  for (const call of calls) {
    const key = `${call.action?.type || "?"}${call.status === "failed" ? "(failed)" : ""}`;
    byAction[key] = (byAction[key] || 0) + 1;
  }
  return {
    provider: "deepseek",
    model: res.data?.model ?? "deepseek-v4-pro",
    ok: res.ok && Boolean(answer),
    error: res.ok ? null : res.data?.error?.message || `HTTP ${res.status}`,
    ms: res.ms,
    cost_usd: res.data?.usage ? Number(deepseekCostUsd(res.data.usage).toFixed(5)) : null,
    usage: res.data?.usage ?? null,
    tool_calls: byAction,
    queries: calls.map((call) => call.action?.queries?.filter((q) => !q.startsWith("ws_call_id=")) ?? call.action?.url).flat(),
    answer,
    ...score(c, answer),
  };
}

async function answerCase(c, rep) {
  const [grok, ds] = await Promise.all([grokAnswer(c), deepseekAnswer(c)]);
  const row = { id: c.id, rep, q: c.q, grok, deepseek: ds };
  await writeFile(path.join(outDir, `${c.id}--${rep}.json`), JSON.stringify({ case: { ...c, criteria: c.criteria.map(String) }, row }, null, 2));
  return row;
}

function printAnswer(rows) {
  console.log("\n== answer: fields right / fields asked, seconds, USD ==");
  console.log([pad("case", 16), pad("grok", 24), pad("deepseek-v4-pro", 24)].join(" "));
  const cell = (r) => (r.ok ? `${r.fields}/${r.total} ${(r.ms / 1000).toFixed(0)}s $${r.cost_usd?.toFixed(4) ?? "?"}` : `ERR ${String(r.error).slice(0, 18)}`);
  for (const r of rows) console.log([pad(`${r.id}#${r.rep}`, 16), pad(cell(r.grok), 24), pad(cell(r.deepseek), 24)].join(" "));
  for (const p of ["grok", "deepseek"]) {
    const s = rows.map((r) => r[p]);
    console.log(
      `${pad(p, 10)} fields ${s.reduce((a, x) => a + x.fields, 0)}/${s.reduce((a, x) => a + x.total, 0)}  all-right ${s.filter((x) => x.fields === x.total).length}/${s.length}` +
        `  median ${median(s.map((x) => x.ms))}ms  total $${s.reduce((a, x) => a + (x.cost_usd || 0), 0).toFixed(4)}  errors ${s.filter((x) => !x.ok).length}`
    );
  }
}

// --- main ------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const part = flag("--part", "all");
const only = flag("--only", "") ? new Set(flag("--only", "").split(",")) : null;
const outDir = path.resolve(flag("--out", path.join(ROOT, "benchmarks", "results", "deepseek-compare")));
const pick = (cases) => cases.filter((c) => !only || only.has(c.id));
// --providers a,b reruns only those providers (e.g. after a Firecrawl 429) and keeps the rest.
const providersFor = (all) => (flag("--providers", "") ? all.filter((p) => flag("--providers", "").split(",").includes(p)) : all);

if (!KEY) {
  console.error("DEEPSEEK_API_KEY is not set");
  process.exit(2);
}
configureProxy();
const config = await loadConfig();
await mkdir(path.join(outDir, "pages"), { recursive: true });

if (part === "search" || part === "all") {
  const rows = [];
  for (const c of pick(SEARCH_CASES)) {
    process.stderr.write(`search ${c.id}...\n`);
    rows.push(await searchCase(c, providersFor(SEARCH_PROVIDERS)));
  }
  printSearch(await saveSummary("summary-search.json", rows));
}
if (part === "fetch" || part === "all") {
  const rows = [];
  for (const c of pick(FETCH_CASES)) {
    process.stderr.write(`fetch ${c.id}...\n`);
    rows.push(await fetchCase(c, providersFor(FETCH_PROVIDERS)));
  }
  printFetch(await saveSummary("summary-fetch.json", rows));
}
if (part === "search-rescore") {
  const rows = await rescoreSearch();
  await writeFile(path.join(outDir, "summary-search.json"), JSON.stringify(rows, null, 2));
  printSearch(rows);
}
if (part === "answer-rescore") {
  const rows = JSON.parse(await readFile(path.join(outDir, "summary-answer.json"), "utf8"));
  for (const row of rows) {
    const c = ANSWER_CASES.find((x) => x.id === row.id);
    for (const p of ["grok", "deepseek"]) Object.assign(row[p], score(c, row[p].answer));
  }
  await writeFile(path.join(outDir, "summary-answer.json"), JSON.stringify(rows, null, 2));
  printAnswer(rows);
}
if (part === "fetch-rescore") {
  const rows = await rescoreFetch();
  await writeFile(path.join(outDir, "summary-fetch.json"), JSON.stringify(rows, null, 2));
  printFetch(rows);
}
if (part === "answer" || part === "all") {
  const rows = [];
  const repeat = Math.max(1, Number(flag("--repeat", "1")) || 1);
  for (let rep = 1; rep <= repeat; rep += 1) {
    for (const c of pick(ANSWER_CASES)) {
      process.stderr.write(`answer ${c.id} #${rep}...\n`);
      rows.push(await answerCase(c, rep));
    }
  }
  printAnswer(await saveSummary("summary-answer.json", rows, (r) => `${r.id}#${r.rep}`));
}
