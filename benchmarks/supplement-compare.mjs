#!/usr/bin/env node
/**
 * Does a search API help a search model when its results are handed to the model as reference?
 * Six arms, same system prompt (grok-search's searchPrompt), same user message (time context +
 * the question in plain language, plus the reference block when the arm has one):
 *
 *   grok         Grok Responses + web_search (grok-search's model and settings), the question as asked
 *   grok-kw      grok, but the way SKILL.md has agents call it: short keywords as the query and the
 *                question's requirements in --instructions (`kw` + `instr` below)
 *   grok+ds      grok, plus DeepSeek Search top 5 for a short keyword query as reference
 *   grok+tv      grok, plus Tavily Search (advanced) top 5 as reference
 *   pro          deepseek-v4-pro on DeepSeek's Responses API with its server-side web_search
 *   pro+tv       pro, plus the same Tavily reference
 *   flash+tools  deepseek-flash with DeepSeek Search and Fetch as function tools (our own loop);
 *                deepseek-flash ignores the server-side web_search tool
 *
 *   DEEPSEEK_API_KEY=... node benchmarks/supplement-compare.mjs [--only id,id] [--arms a,b] [--repeat N] [--out DIR]
 *   node benchmarks/supplement-compare.mjs --report [--out DIR]
 *
 * Fact questions are scored with regexes against gold taken from official sources on 2026-10-19
 * (the same gold as deepseek-compare.mjs). Research questions have no gold; their answers are
 * written to research-<id>.md for a blind judge. The reference results are fetched once per
 * question and reused by every arm and round.
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, normalizeOpenRouterSearchEngine } from "../scripts/lib/config.js";
import { getLocalTimeContext } from "../scripts/lib/context.js";
import { searchGrokResponses } from "../scripts/lib/grok-responses.js";
import { ANSWER_MARKER_PATTERN, searchPrompt } from "../scripts/lib/prompts.js";
import { configureProxy } from "../scripts/lib/proxy.js";
import { tavilySearch } from "./lib/search-apis.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.DEEPSEEK_API_KEY;
const DS = "https://api.deepseek.com";
const ARMS = ["grok", "grok-kw", "grok+ds", "grok+tv", "pro", "pro+tv", "flash+tools"];
const REF_COUNT = 5;
const REF_CHARS = 600;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

function date(...days) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const alts = days.map((day) => {
    const [y, m, d] = day.split("-").map(Number);
    const mon = `${months[m - 1]}[a-z]*\\.?`;
    return `${y}\\s*[-/.年]\\s*0?${m}\\s*[-/.月]\\s*0?${d}(?!\\d)|(?<!\\d)0?${m}\\s*月\\s*0?${d}\\s*日|${mon}\\s+0?${d}(?:st|nd|rd|th)?,?\\s+${y}|0?${d}\\s+${mon}\\s+${y}`;
  });
  return new RegExp(alts.join("|"), "i");
}

// `q` goes to the models, `kw` to the search API that builds the reference block.
// prettier-ignore
const CASES = [
  { id: "go", q: "Go 当前最新的稳定版是哪个完整版本号？哪天发布的？", kw: "Go latest stable release", instr: "给出 Go 当前最新稳定版的完整版本号（1.x.y）和该版本的发布日期，中文，附官方出处链接。", criteria: [/1\.27\.2/, date("2026-10-08")] },
  { id: "gh", q: "GitHub CLI（gh）最新正式版的版本号和发布日期是什么？", kw: "GitHub CLI latest release", instr: "给出 GitHub CLI（gh）最新正式版的版本号和发布日期，中文，附出处链接。", criteria: [/2\.102\.0/, date("2026-09-29", "2026-09-30")] },
  { id: "rust", q: "Rust 最新稳定版的版本号和发布日期是什么？", kw: "Rust latest stable release", instr: "给出 Rust 最新稳定版的完整版本号和发布日期，中文，附官方出处链接。", criteria: [/1\.99\.1/, date("2026-10-15", "2026-10-16")] },
  { id: "codex", q: "OpenAI Codex CLI（GitHub openai/codex）最新的正式 release 版本号和发布日期是什么？", kw: "openai codex cli latest release", instr: "给出 OpenAI Codex CLI（GitHub openai/codex）最新正式 release（不含 alpha 等预发布）的版本号和发布日期，中文，附出处链接。", criteria: [/0\.163\.0/, date("2026-10-15", "2026-10-16")] },
  { id: "node", q: "Node.js 当前最新的 LTS 版本和最新的 Current 版本分别是哪个完整版本号？各自哪天发布？", kw: "Node.js latest LTS Current release", instr: "给出 Node.js 当前最新 LTS 和最新 Current 的完整版本号及各自的发布日期，中文，附官方出处链接。", criteria: [/24\.22\.0/, /26\.12\.0/, date("2026-10-14", "2026-10-15")] },
  { id: "k8s-uv", q: "两个问题：Kubernetes 最新的稳定版本号是多少？uv（astral-sh/uv）最新版本号和发布日期是什么？", kw: "Kubernetes uv latest release", instr: "回答两个问题：Kubernetes 最新稳定版本号；uv（astral-sh/uv）最新版本号和发布日期。中文，附出处链接。", criteria: [/1\.37\.1/, /0\.13\.1/, date("2026-10-14")] },
  { id: "node-npm", q: "Node.js 当前最新 LTS 版本自带的 npm 是哪个版本？这个 npm 版本是哪天发布的？", kw: "Node.js LTS bundled npm version", instr: "找出 Node.js 当前最新 LTS 版本自带的 npm 版本号，以及这个 npm 版本的发布日期。中文，附出处链接。", criteria: [/11\.19\.1/, date("2026-08-25", "2026-08-26", "2026-08-27")] },
  { id: "pi", q: "pi coding agent（GitHub earendil-works/pi，npm 包 @earendil-works/pi-coding-agent）最新版本号是多少？哪天发布的？", kw: "pi coding agent latest release", instr: "pi coding agent 指 GitHub earendil-works/pi、npm 包 @earendil-works/pi-coding-agent。给出最新版本号和发布日期，中文，附出处链接。", criteria: [/1\.3\.0/, date("2026-10-15", "2026-10-16")] },
  { id: "vite", q: "Vite 最新的正式版本号是多少？哪天发布的？", kw: "Vite latest release", instr: "给出 Vite 最新正式版本号和发布日期，中文，附出处链接。", criteria: [/8\.3\.4/, date("2026-10-08")] },
  { id: "python", q: "Python 最新的稳定版本号是多少？哪天发布的？", kw: "Python latest stable release", instr: "给出 Python 最新稳定版本号和发布日期，中文，附官方出处链接。", criteria: [/3\.15\.0/, date("2026-10-09")] },
  { id: "ruanyf", q: "阮一峰的《科技爱好者周刊》最新一期是第几期？标题是什么？哪天发布的？", kw: "科技爱好者周刊 最新一期", instr: "阮一峰《科技爱好者周刊》最新一期的期数、标题和发布日期，中文，附出处链接。", criteria: [/415/, /看不见的城市/, date("2026-10-16")] },
  { id: "tavily", q: "Tavily Search API 的 include_domains 和 exclude_domains 参数分别最多能传多少个域名？", kw: "Tavily search API include_domains exclude_domains limit", instr: "Tavily Search API 中 include_domains 和 exclude_domains 各自最多能传多少个域名，引用官方文档，中文。", criteria: [/300/, /150/] },
  { id: "deepseek-flash", q: "DeepSeek API 里 deepseek-flash 这个模型名当前对应的是哪个模型版本？", kw: "DeepSeek deepseek-flash model version", instr: "DeepSeek API 中模型名 deepseek-flash 当前对应的模型版本标识，引用官方文档，中文。", criteria: [/V4\.1[-\s]?Flash[-\s]?1017/i] },
  // research: taken from real sessions (2026-09-28 – 10-13) where a Tavily/Firecrawl card was used
  { id: "r-tooldesc", q: "有没有研究或基准测试衡量工具描述的长度、可用工具的数量对 LLM 选择工具准确率的影响？列出主要论文或基准、各自的结论和链接。", kw: "tool description length number of tools selection accuracy benchmark", instr: "找研究或基准测试：工具描述长度、可用工具数量对 LLM 工具选择准确率的影响。列出论文或基准、各自结论和链接，中文。" },
  { id: "r-casemap", q: "法律事实年表工具（如 CaseMap、Relativity）是怎么设计事实条目的？争议/无争议状态、证据出处这些字段怎么建模？给出处。", kw: "CaseMap fact chronology disputed undisputed source field", instr: "法律事实年表工具（如 CaseMap、Relativity）的事实条目怎么设计：争议/无争议状态、证据出处等字段怎么建模。中文，给出处。" },
  { id: "r-quote", q: "怎么校验 LLM 从文档里摘录的引文确实出自原文？有哪些开源实现用模糊子串匹配，能处理分页、页眉页脚、断行？列出项目和做法。", kw: "verify LLM quote in source document fuzzy substring match", instr: "怎么校验 LLM 摘录的引文出自原文；列出用模糊子串匹配、能处理分页、页眉页脚、断行的开源实现及做法。中文，给出处。" },
  { id: "r-interest", q: "有没有开源的“迟延履行期间加倍部分债务利息”计算器？计算公式是什么，计息基数等有哪些争议点？给出处。", kw: "迟延履行 加倍利息 计算器 开源", instr: "找开源的迟延履行期间加倍部分债务利息计算器；说明计算公式，以及计息基数等争议点。中文，给出处。" },
  { id: "r-pimcp", q: "pi coding agent（earendil-works/pi）对 MCP 的官方态度是什么？作者怎么说的？codemode 是什么、哪个版本引入的？给出处。", kw: "pi coding agent MCP codemode", instr: "pi coding agent（earendil-works/pi）对 MCP 的官方态度和作者原话；codemode 是什么、哪个版本引入。中文，给出处。" },
  { id: "r-artex", q: "CrowdStrike 关于“ARTEX”和韩国金融机构遭攻击的说法是什么？攻击者身份是否确认？官方博客、新闻、LinkedIn、Reddit 上分别怎么讨论的？", kw: "CrowdStrike ARTEX South Korea finance", instr: "CrowdStrike 对 ARTEX 与韩国金融机构遭攻击的说法；攻击者身份是否确认；官方博客、新闻、LinkedIn、Reddit 上的讨论。中文，给出处。" },
];

// --- helpers ---------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const pad = (v, w) => (String(v ?? "").length >= w ? String(v ?? "") : String(v ?? "") + " ".repeat(w - String(v ?? "").length));
const stripMarker = (t) => String(t || "").replace(ANSWER_MARKER_PATTERN, "").trim();
const unescapeMd = (t) => String(t || "").replace(/\\(?=[^\sA-Za-z0-9\u0080-\uffff])/g, "");

async function dsPost(pathname, body, timeoutMs = 300_000) {
  const started = performance.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${DS}${pathname}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return { ok: res.ok, status: res.status, data, ms: Math.round(performance.now() - started) };
    } catch (error) {
      if (attempt < 2) continue;
      return { ok: false, status: null, data: { error: { message: error.message } }, ms: Math.round(performance.now() - started) };
    }
  }
}

// DeepSeek per 1M tokens, USD (2026-10-19). Peak: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri.
const PRICES = { "deepseek-v4-pro": [0.044, 1.32, 3.96], "deepseek-flash": [0.006, 0.3, 1.2] };
function dsTokenCost(model, usage, at = new Date()) {
  if (!usage) return 0;
  const day = at.getUTCDay();
  const h = at.getUTCHours();
  const k = day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10)) ? 1 : 0.5;
  const [hit, miss, out] = PRICES[model];
  const inTok = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const outTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return ((cached * hit + (inTok - cached) * miss + outTok * out) * k) / 1e6;
}
const SEARCH_API_USD = 0.00075;
const TAVILY_ADVANCED_USD = 2 * 0.008;

// --- reference block -------------------------------------------------------------------------

async function reference(c, provider) {
  const file = path.join(outDir, "refs", `${c.id}--${provider}.json`);
  const cached = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
  if (cached) return cached;
  let items = [];
  let error = null;
  if (provider === "ds") {
    const query = CJK.test(c.kw) ? c.kw : `${c.kw} lang:en`;
    const res = await dsPost("/v1/tools/search", { query, count: REF_COUNT }, 60_000);
    if (!res.ok) error = res.data?.error?.message || `HTTP ${res.status}`;
    items = (res.data?.results || []).map((r) => ({ title: r.title, url: String(r.url).replace(/#.*$/, ""), date: r.date?.slice(0, 10) || null, text: r.summary || r.snippet || "" }));
  } else {
    const r = await tavilySearch(c.kw, REF_COUNT, config, {});
    if (!r.ok) error = r.error;
    items = (r.raw?.results || []).map((x) => ({ title: x.title, url: x.url, date: x.published_date || null, text: x.content || "" }));
  }
  const block = items.length
    ? [
        "",
        "",
        "# Pre-retrieved search results",
        `A search API returned these results for the keywords "${c.kw}". They may be incomplete, outdated or off-topic: use what helps, verify current facts with your own search, and cite only pages you rely on.`,
        "",
        ...items.map((x, i) => `[${i + 1}] ${x.title || "(no title)"}\n${x.url}${x.date ? ` (${x.date})` : ""}\n${String(x.text).replace(/\s+/g, " ").slice(0, REF_CHARS)}`),
      ].join("\n")
    : "";
  const ref = { provider, kw: c.kw, items, block, error, cost_usd: provider === "ds" ? (items.length ? SEARCH_API_USD : 0) : TAVILY_ADVANCED_USD };
  await writeFile(file, JSON.stringify(ref, null, 2));
  return ref;
}

const userMessage = (c, ref) => getLocalTimeContext() + c.q + (ref?.block || "");

// --- arms ------------------------------------------------------------------------------------

async function grokArm(c, ref, { keywords = false } = {}) {
  const started = performance.now();
  try {
    const r = await searchGrokResponses(
      keywords ? c.kw : c.q + (ref?.block || ""),
      {
        platform: "",
        instructions: keywords ? c.instr : "",
        model: config.grokModel,
        maxTurns: config.responsesMaxTurns,
        reasoningEffort: config.responsesReasoningEffort,
        allowedDomains: [],
        excludedDomains: [],
        searchSource: "web",
        allowedXHandles: [],
        excludedXHandles: [],
        xFromDate: "",
        xToDate: "",
        xImageUnderstanding: false,
        xVideoUnderstanding: false,
        openRouterEngine: normalizeOpenRouterSearchEngine(config.responsesOpenRouterEngine),
      },
      config
    );
    const d = r.diagnostics || {};
    return {
      ok: true,
      model: d.responses_model || config.grokModel,
      answer: r.content,
      ms: Math.round(performance.now() - started),
      cost_usd: (d.cost_usd ?? 0) + (ref?.cost_usd ?? 0),
      model_cost_usd: d.cost_usd ?? null,
      input_tokens: d.usage?.input_tokens ?? null,
      tool_calls: d.responses_tool_calls?.by_action ?? null,
    };
  } catch (error) {
    return { ok: false, error: error.message?.slice(0, 200), ms: Math.round(performance.now() - started), cost_usd: ref?.cost_usd ?? 0 };
  }
}

async function proArm(c, ref) {
  const res = await dsPost("/responses", {
    model: "deepseek-v4-pro",
    instructions: searchPrompt,
    input: userMessage(c, ref),
    tools: [{ type: "web_search" }],
    reasoning: { effort: "low" },
  });
  const output = res.data?.output || [];
  const answer = stripMarker(
    (output.filter((o) => o.type === "message").pop()?.content || [])
      .map((p) => p.text || "")
      .join("\n")
  );
  const calls = output.filter((o) => o.type === "web_search_call");
  const byAction = {};
  for (const call of calls) {
    const k = `${call.action?.type || "?"}${call.status === "failed" ? "(failed)" : ""}`;
    byAction[k] = (byAction[k] || 0) + 1;
  }
  const modelCost = dsTokenCost("deepseek-v4-pro", res.data?.usage);
  // Server-side tool calls hit the Search/Fetch APIs; counted at list price, billed or not.
  const toolCost = calls.filter((x) => x.status !== "failed").length * SEARCH_API_USD;
  return {
    ok: res.ok && Boolean(answer),
    error: res.ok ? (answer ? null : "empty answer") : res.data?.error?.message || `HTTP ${res.status}`,
    model: "deepseek-v4-pro",
    answer,
    ms: res.ms,
    cost_usd: modelCost + toolCost + (ref?.cost_usd ?? 0),
    model_cost_usd: modelCost,
    tool_cost_usd: toolCost,
    input_tokens: res.data?.usage?.input_tokens ?? null,
    tool_calls: byAction,
  };
}

const FLASH_TOOLS = [
  {
    type: "function",
    name: "web_search",
    description:
      "Search the web with DeepSeek's search engine. Returns up to `count` results with title, URL, publication date and a long summary. Supports operators in the query: site:example.com, -site:, \"exact phrase\", lang:en / lang:zh, after:2026-01-01, before:.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query, 1-128 characters" }, count: { type: "integer", description: "1-10, default 5" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "open_page",
    description: "Fetch one web page and return its text as Markdown (first 8000 characters). Some sites (Wikipedia, X, Reddit, Zhihu, arXiv PDFs) are refused.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];

async function flashTool(name, args) {
  if (name === "web_search") {
    const res = await dsPost("/v1/tools/search", { query: String(args.query || "").slice(0, 128), count: Math.min(10, Math.max(1, args.count || 5)) }, 60_000);
    const results = res.data?.results || [];
    return {
      billed: res.ok && results.length > 0,
      text: res.ok
        ? JSON.stringify(results.map((r) => ({ title: r.title, url: String(r.url).replace(/#.*$/, ""), date: r.date?.slice(0, 10) || null, summary: String(r.summary || r.snippet || "").slice(0, 1200) })))
        : `error: ${res.data?.error?.message || res.status}`,
    };
  }
  const res = await dsPost("/v1/tools/fetch", { url: String(args.url || "") }, 120_000);
  return {
    billed: res.ok && Boolean(res.data?.content),
    text: res.ok ? `# ${res.data.title || ""}\n\n${unescapeMd(res.data.content).slice(0, 8000)}` : `error: HTTP ${res.status} ${res.data?.error?.message || ""}`,
  };
}

async function flashArm(c) {
  const started = performance.now();
  const input = [{ role: "user", content: userMessage(c, null) }];
  const tally = {};
  let modelCost = 0;
  let toolCost = 0;
  let inputTokens = 0;
  for (let turn = 0; turn < 10; turn += 1) {
    const res = await dsPost("/responses", {
      model: "deepseek-flash",
      instructions: searchPrompt,
      input,
      tools: FLASH_TOOLS,
      reasoning: { effort: "low" },
      ...(turn === 9 ? { tool_choice: "none" } : {}),
    });
    if (!res.ok) return { ok: false, error: res.data?.error?.message || `HTTP ${res.status}`, ms: Math.round(performance.now() - started), cost_usd: modelCost + toolCost, tool_calls: tally };
    modelCost += dsTokenCost("deepseek-flash", res.data.usage);
    inputTokens += res.data.usage?.input_tokens || 0;
    const output = res.data.output || [];
    const calls = output.filter((o) => o.type === "function_call");
    if (!calls.length) {
      const answer = stripMarker(
        (output.filter((o) => o.type === "message").pop()?.content || [])
          .map((p) => p.text || "")
          .join("\n")
      );
      return {
        ok: Boolean(answer),
        error: answer ? null : "empty answer",
        model: "deepseek-flash",
        answer,
        ms: Math.round(performance.now() - started),
        cost_usd: modelCost + toolCost,
        model_cost_usd: modelCost,
        tool_cost_usd: toolCost,
        input_tokens: inputTokens,
        tool_calls: tally,
      };
    }
    input.push(...output);
    const results = await Promise.all(
      calls.map(async (call) => {
        let args = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {}
        const r = await flashTool(call.name, args);
        tally[call.name] = (tally[call.name] || 0) + 1;
        if (r.billed) toolCost += SEARCH_API_USD;
        return { type: "function_call_output", call_id: call.call_id, output: r.text };
      })
    );
    input.push(...results);
  }
  return { ok: false, error: "no answer after 10 turns", ms: Math.round(performance.now() - started), cost_usd: modelCost + toolCost, tool_calls: tally };
}

async function runArm(arm, c) {
  if (arm === "grok") return grokArm(c, null);
  if (arm === "grok-kw") return grokArm(c, null, { keywords: true });
  if (arm === "grok+ds") return grokArm(c, await reference(c, "ds"));
  if (arm === "grok+tv") return grokArm(c, await reference(c, "tv"));
  if (arm === "pro") return proArm(c, null);
  if (arm === "pro+tv") return proArm(c, await reference(c, "tv"));
  return flashArm(c);
}

function score(c, answer) {
  if (!c.criteria) return null;
  const passed = c.criteria.map((re) => re.test(answer || ""));
  return { fields: passed.filter(Boolean).length, total: passed.length };
}

// --- report ----------------------------------------------------------------------------------

async function loadRuns() {
  const files = (await readdir(path.join(outDir, "runs"))).filter((f) => f.endsWith(".json"));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(outDir, "runs", f), "utf8"))));
}

async function report() {
  const runs = await loadRuns();
  const arms = ARMS.filter((a) => runs.some((r) => r.arm === a));
  const facts = runs.filter((r) => CASES.find((c) => c.id === r.id)?.criteria);
  for (const r of facts) Object.assign(r, score(CASES.find((c) => c.id === r.id), r.answer));
  console.log("\n== fact questions: fields right / asked per round ==");
  console.log([pad("case", 16), ...arms.map((a) => pad(a, 12))].join(" "));
  for (const c of CASES.filter((c) => c.criteria)) {
    const cell = (a) =>
      runs
        .filter((r) => r.id === c.id && r.arm === a)
        .sort((x, y) => x.rep - y.rep)
        .map((r) => (r.ok ? `${r.fields}/${r.total}` : "ERR"))
        .join(" ");
    console.log([pad(c.id, 16), ...arms.map((a) => pad(cell(a), 12))].join(" "));
  }
  console.log("\n== per arm ==");
  for (const a of arms) {
    const f = facts.filter((r) => r.arm === a);
    const all = runs.filter((r) => r.arm === a);
    const research = all.filter((r) => !CASES.find((c) => c.id === r.id)?.criteria);
    console.log(
      `${pad(a, 12)} facts ${sum(f.map((r) => r.fields))}/${sum(f.map((r) => r.total))} fields, all right ${f.filter((r) => r.ok && r.fields === r.total).length}/${f.length}, errors ${all.filter((r) => !r.ok).length}` +
        ` | median ${(median(all.map((r) => r.ms)) / 1000).toFixed(1)}s, p90 ${(all.map((r) => r.ms).sort((x, y) => x - y)[Math.floor(all.length * 0.9)] / 1000).toFixed(1)}s` +
        ` | cost per fact q $${(sum(f.map((r) => r.cost_usd)) / f.length).toFixed(4)}, per research q $${research.length ? (sum(research.map((r) => r.cost_usd)) / research.length).toFixed(4) : "-"}, total $${sum(all.map((r) => r.cost_usd)).toFixed(3)}` +
        ` | median input tokens ${median(all.map((r) => r.input_tokens))}`
    );
  }
}

// --- main ------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const outDir = path.resolve(flag("--out", path.join(ROOT, "benchmarks", "results", "supplement-compare")));
configureProxy();
const config = await loadConfig({ requireGrok: !argv.includes("--report") });
await mkdir(path.join(outDir, "runs"), { recursive: true });
await mkdir(path.join(outDir, "refs"), { recursive: true });

if (argv.includes("--report")) {
  await report();
  process.exit(0);
}
if (!KEY) {
  console.error("DEEPSEEK_API_KEY is not set");
  process.exit(2);
}
const only = flag("--only", "") ? new Set(flag("--only", "").split(",")) : null;
const arms = flag("--arms", "") ? ARMS.filter((a) => flag("--arms", "").split(",").includes(a)) : ARMS;
const repeat = Math.max(1, Number(flag("--repeat", "1")) || 1);
// Research questions run once: they are judged, not scored, and judging costs more than running.
const researchRepeat = Math.max(1, Number(flag("--research-repeat", "1")) || 1);

for (let rep = 1; rep <= repeat; rep += 1) {
  for (const c of CASES.filter((c) => !only || only.has(c.id))) {
    if (!c.criteria && rep > researchRepeat) continue;
    const todo = [];
    for (const arm of arms) {
      const file = path.join(outDir, "runs", `${c.id}--${arm.replace("+", "_")}--${rep}.json`);
      const done = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
      if (done?.ok) continue;
      todo.push({ arm, file });
    }
    if (!todo.length) continue;
    process.stderr.write(`${c.id} #${rep}: ${todo.map((t) => t.arm).join(", ")}\n`);
    await Promise.all(
      todo.map(async ({ arm, file }) => {
        const r = await runArm(arm, c);
        const row = { id: c.id, arm, rep, at: new Date().toISOString(), ...r, ...(score(c, r.answer) || {}) };
        await writeFile(file, JSON.stringify(row, null, 2));
      })
    );
  }
}
await report();
