#!/usr/bin/env node
/**
 * Where does DeepSeek Fetch go in fetch.js's auto chain, after Firecrawl? On HTML pages from the
 * run records (the pages auto hands to an extractor), DeepSeek Fetch, Tavily Extract and Direct
 * are each run once, and each copy is scored against the others plus the copy on record
 * (Firecrawl's or Tavily's from the original fetch).
 *
 *   DEEPSEEK_API_KEY=... node benchmarks/fetch-fallback-compare.mjs [--limit 60] [--per-host 3] [--out DIR]
 *   node benchmarks/fetch-fallback-compare.mjs --report [--out DIR]
 *
 * Score: "body lines" are lines of 40+ characters (after stripping Markdown and links) that at
 * least two copies share; a copy's coverage is the share of them it has. Coverage under 0.2, or
 * under 300 characters of text, is a shell. Chains are then replayed: each takes the first
 * provider that returned any text, as fetch.js does, so a shell that comes first is what the
 * agent gets.
 *
 * Costs: DeepSeek $0.00075 per page it returns, Tavily 0.2 credits per page, Direct nothing.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/lib/config.js";
import { deepseekFetch } from "../scripts/lib/deepseek.js";
import { directFetch } from "../scripts/lib/direct-fetch.js";
import { configureProxy } from "../scripts/lib/proxy.js";
import { tavilyExtract } from "../scripts/lib/tavily.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUTS = path.join(process.env.HOME, ".cache", "grok-search", "outputs");
const PROVIDERS = ["deepseek", "tavily", "direct"];

const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const outDir = path.resolve(flag("--out", path.join(ROOT, "benchmarks", "results", "fetch-fallback-compare")));
const limit = Number(flag("--limit", "60"));
const perHost = Number(flag("--per-host", "3"));

// --- scoring ---------------------------------------------------------------------------------

function bodyLines(text) {
  return new Set(
    String(text || "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .split(/\n+/)
      .map((line) =>
        line
          .replace(/[#>*_`|~\\-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
      )
      .filter((line) => line.length >= 40)
  );
}

function score(copies) {
  const sets = Object.fromEntries(Object.entries(copies).map(([k, v]) => [k, bodyLines(v)]));
  const counts = new Map();
  for (const set of Object.values(sets)) for (const line of set) counts.set(line, (counts.get(line) || 0) + 1);
  const consensus = [...counts].filter(([, n]) => n >= 2).map(([line]) => line);
  const out = {};
  for (const [k, set] of Object.entries(sets)) {
    out[k] = consensus.length >= 5 ? Number((consensus.filter((line) => set.has(line)).length / consensus.length).toFixed(2)) : null;
  }
  return { consensus: consensus.length, coverage: out };
}

const shortLineRatio = (text) => {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? Number((lines.filter((l) => l.length < 20).length / lines.length).toFixed(2)) : null;
};

function verdict(r, coverage) {
  if (!r?.ok) return "ERR";
  const plain = String(r.content || "").replace(/\s+/g, " ");
  if (plain.length < 300) return "SHELL";
  if (coverage == null) return "ok?";
  if (coverage < 0.2) return "SHELL";
  if (coverage < 0.6) return "PART";
  return "ok";
}

// --- sampling --------------------------------------------------------------------------------

const servedHtml = (r) => /html/i.test(r.metadata?.content_type || "") || /^\s*<(?:!doctype\s+html|html[\s>])/i.test(r.content || "");

async function candidates() {
  const files = (await readdir(OUTPUTS)).filter((f) => /-run-fetch-.*\.json$/.test(f)).sort().reverse();
  const seen = new Set();
  const byHost = new Map();
  const list = [];
  for (const f of files) {
    const rec = JSON.parse(await readFile(path.join(OUTPUTS, f), "utf8"));
    if (rec.error || !rec.url || !["firecrawl", "tavily"].includes(rec.provider)) continue;
    let host;
    try {
      host = new URL(rec.url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (/(^|\.)(x|twitter)\.com$/.test(host)) continue;
    const key = rec.url.replace(/#.*$/, "").replace(/\/+$/, "");
    if (seen.has(key) || (byHost.get(host) || 0) >= perHost) continue;
    seen.add(key);
    byHost.set(host, (byHost.get(host) || 0) + 1);
    list.push({ url: rec.url, host, record: f, record_provider: rec.provider, record_content: rec.content || "" });
  }
  return list;
}

// --- run -------------------------------------------------------------------------------------

async function timed(fn) {
  const started = performance.now();
  const result = await fn();
  return { ...result, ms: Math.round(performance.now() - started) };
}

async function runOne(c) {
  // auto's first step: Direct asks for Markdown; a non-HTML answer never reaches the extractors.
  const direct = await timed(() => directFetch(c.url, { timeoutMs: 15_000 }));
  if (direct.ok && !servedHtml(direct)) return { ...c, skipped: "not HTML now", direct_type: direct.metadata?.content_type || "" };
  const [deepseek, tavily] = await Promise.all([timed(() => deepseekFetch(c.url, config)), timed(() => tavilyExtract(c.url, config))]);
  return { ...c, results: { deepseek, tavily, direct } };
}

function analyze(row) {
  const copies = { record: row.record_content };
  for (const p of PROVIDERS) if (row.results[p]?.ok) copies[p] = row.results[p].content;
  const { consensus, coverage } = score(copies);
  const per = {};
  for (const p of PROVIDERS) {
    const r = row.results[p];
    per[p] = {
      verdict: verdict(r, coverage[p]),
      coverage: coverage[p] ?? null,
      chars: r?.ok ? r.content.length : 0,
      noise: r?.ok ? shortLineRatio(r.content) : null,
      ms: r?.ms ?? null,
      error: r?.ok ? null : String(r?.error || "").slice(0, 100),
    };
  }
  return { url: row.url, host: row.host, consensus, record_coverage: coverage.record ?? null, per };
}

/** The copy a chain serves: the first provider with any text, as fetch.js takes it. */
function replay(a, chain) {
  let ms = 0;
  for (const p of chain) {
    const r = a.per[p];
    ms += r.ms || 0;
    if (r.verdict !== "ERR") return { provider: p, verdict: r.verdict, coverage: r.coverage, ms };
  }
  return { provider: null, verdict: "ERR", coverage: null, ms };
}

function report(rows) {
  const analyzed = rows.filter((r) => r.results).map(analyze);
  const pad = (v, w) => (String(v ?? "").length >= w ? String(v ?? "") : String(v ?? "") + " ".repeat(w - String(v ?? "").length));
  const median = (a) => {
    const v = a.filter(Number.isFinite).sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  console.log(`\n${analyzed.length} HTML pages (${rows.filter((r) => r.skipped).length} candidates now answered by Direct as non-HTML)\n`);
  console.log([pad("host", 26), ...PROVIDERS.map((p) => pad(p, 22))].join(" "));
  for (const a of analyzed) {
    const cell = (r) => (r.verdict === "ERR" ? `ERR ${(r.ms / 1000).toFixed(1)}s` : `${r.verdict} ${r.coverage ?? "-"} ${(r.ms / 1000).toFixed(1)}s`);
    console.log([pad(a.host, 26), ...PROVIDERS.map((p) => pad(cell(a.per[p]), 22))].join(" "));
  }
  console.log("\n== per provider ==");
  for (const p of PROVIDERS) {
    const r = analyzed.map((a) => a.per[p]);
    const n = (v) => r.filter((x) => x.verdict === v).length;
    console.log(
      `${pad(p, 9)} ok ${n("ok") + n("ok?")}  part ${n("PART")}  shell ${n("SHELL")}  err ${n("ERR")} / ${r.length}` +
        `  median coverage ${median(r.filter((x) => x.coverage != null).map((x) => x.coverage))}  median ${median(r.map((x) => x.ms))}ms  p90 ${r.map((x) => x.ms).sort((x, y) => x - y)[Math.floor(r.length * 0.9)]}ms  median noise ${median(r.map((x) => x.noise))}`
    );
  }
  console.log("\n== chains while Firecrawl is unavailable (first provider with text is served) ==");
  for (const chain of [["tavily", "direct"], ["tavily", "deepseek", "direct"], ["deepseek", "tavily", "direct"], ["deepseek", "direct"]]) {
    const served = analyzed.map((a) => replay(a, chain));
    const n = (v) => served.filter((x) => x.verdict === v).length;
    console.log(
      `${pad(chain.join(" > "), 28)} ok ${n("ok") + n("ok?")}  part ${n("PART")}  shell ${n("SHELL")}  err ${n("ERR")}` +
        `  median ${median(served.map((x) => x.ms))}ms  p90 ${served.map((x) => x.ms).sort((x, y) => x - y)[Math.floor(served.length * 0.9)]}ms  served by ${JSON.stringify(served.reduce((m, x) => ((m[x.provider] = (m[x.provider] || 0) + 1), m), {}))}`
    );
  }
  console.log("\n== where one extractor fails and the other does not ==");
  for (const [a, b] of [["tavily", "deepseek"], ["deepseek", "tavily"]]) {
    const rescued = analyzed.filter((x) => !["ok", "ok?"].includes(x.per[a].verdict) && ["ok", "ok?"].includes(x.per[b].verdict));
    console.log(`${a} not ok, ${b} ok: ${rescued.length}  ${rescued.map((x) => x.host).join(", ")}`);
  }
  return analyzed;
}

configureProxy();
const config = await loadConfig();
await mkdir(outDir, { recursive: true });
const resultsFile = path.join(outDir, "results.json");

if (!argv.includes("--report")) {
  if (!config.deepseekApiKey) throw new Error("DEEPSEEK_API_KEY is not set");
  const list = (await candidates()).slice(0, limit * 2);
  const rows = [];
  let html = 0;
  for (const c of list) {
    if (html >= limit) break;
    process.stderr.write(`${c.host} ${c.url}\n`);
    const row = await runOne(c);
    rows.push(row);
    if (row.results) html += 1;
  }
  // The copy on record is kept too: --report rescores from this file alone.
  await writeFile(resultsFile, JSON.stringify(rows.map(({ record_content, ...r }) => ({ ...r, record_chars: record_content.length, record_content })), null, 1));
}
const rows = JSON.parse(await readFile(resultsFile, "utf8"));
const analyzed = report(rows);
await writeFile(path.join(outDir, "summary.json"), JSON.stringify(analyzed, null, 1));
