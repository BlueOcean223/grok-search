#!/usr/bin/env node
/**
 * Does anything cap Grok's server-side tool calls? The prompts ask for ~6 searches and get
 * 10–23. xAI's request schema documents `parallel_tool_calls`; `max_tool_calls` appears only in
 * the response schema. This posts the same query with each knob and compares billed calls.
 *
 *   node benchmarks/tool-call-cap-experiment.mjs --out DIR [--only web|x] [--ids a,b] [--repeat N]
 *
 * Goes straight to the Responses endpoint with the production body builder, bypassing search.js,
 * so nothing ships until a knob is shown to work. Costs real money: ~6 Grok searches.
 *
 * Findings (2026-09-08, .agent/tool-call-cap-2026-09-08.md): `max_tool_calls` is ignored by
 * api.x.ai and by both relays tried (a cap of 1 still ran 4 calls); `parallel_tool_calls: false`
 * works on api.x.ai and pass-through relays (one call per turn, so max_turns caps the count).
 * The model matters more than either knob: on the same relay grok-4.6 made 3–5 calls where
 * grok-4.5 made 7–14, so the flag only pays when responses_tool_calls.total exceeds ~6.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/lib/config.js";
import { buildResponsesBody, parseGrokResponses } from "../scripts/lib/grok-responses.js";
import { authHeaders, requestJson } from "../scripts/lib/http.js";
import { configureProxy } from "../scripts/lib/proxy.js";

configureProxy();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : path.join(ROOT, "benchmarks", "results", "tool-call-cap");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : "all";
const ids = argv.includes("--ids") ? argv[argv.indexOf("--ids") + 1].split(",") : null;
// Same query varies 11–17 calls run to run, so a knob needs repeats before it means anything.
const repeat = argv.includes("--repeat") ? Number(argv[argv.indexOf("--repeat") + 1]) || 1 : 1;
await mkdir(outDir, { recursive: true });

const config = await loadConfig({ requireGrok: true });

function options(overrides) {
  return {
    platform: "",
    model: config.grokModel,
    maxTurns: config.responsesMaxTurns ?? 3,
    reasoningEffort: config.responsesReasoningEffort || "low",
    allowedDomains: [],
    excludedDomains: [],
    searchSource: "web",
    allowedXHandles: [],
    excludedXHandles: [],
    xFromDate: "",
    xToDate: "",
    xImageUnderstanding: false,
    xVideoUnderstanding: false,
    openRouterEngine: "auto",
    instructions: "",
    ...overrides,
  };
}

// Baselines: the web query ran 13 calls ($0.21) in the 2026-09-08 provider comparison; the X
// query with these exact instructions ran 15 calls ($0.13) in the pi session the same day.
const WEB = { query: "Kubernetes latest release deprecated APIs removed", options: options({}) };
const X = {
  query: "Grok 4.6 coding agent",
  options: options({
    searchSource: "x",
    xFromDate: "2026-08-16",
    xToDate: "2026-09-08",
    instructions:
      "Find firsthand developer experiences actually using Grok 4.6 in a coding agent: pi, Codex, Claude Code, Cursor, OpenCode, Grok Build or similar. Return up to 3 positive and 3 negative original posts, each with @handle, exact YYYY-MM-DD, status URL, exact client, short verbatim quote and concrete task/result. Require evidence author personally tried it and model is Grok 4.6. Exclude news, reposts, launch announcements, affiliate/marketing accounts and benchmarks without firsthand agent use. Do not fill quotas with weak matches. Separate mixed experiences and state missing client/version explicitly.",
  }),
};

const CASES = [
  { id: "web-baseline", base: WEB, extra: {} },
  { id: "web-max-tool-calls-6", base: WEB, extra: { max_tool_calls: 6 } },
  { id: "web-parallel-false", base: WEB, extra: { parallel_tool_calls: false } },
  { id: "x-baseline", base: X, extra: {} },
  { id: "x-max-tool-calls-6", base: X, extra: { max_tool_calls: 6 } },
  // A cap well below the usual 7–14 makes enforcement unambiguous in one run.
  { id: "x-max-tool-calls-4", base: X, extra: { max_tool_calls: 4 } },
  // Grok opens with 2 parallel X calls; exactly 1 here can only mean the cap is enforced.
  { id: "x-max-tool-calls-1", base: X, extra: { max_tool_calls: 1 } },
  { id: "x-parallel-false", base: X, extra: { parallel_tool_calls: false } },
  // max_turns is the one knob the relay is known to pass through; is 2 a usable cost lever?
  { id: "web-max-turns-2", base: WEB, extra: { max_turns: 2 } },
  { id: "x-max-turns-2", base: X, extra: { max_turns: 2 } },
  // Does max_turns count every tool call or only search? A cap of 1 with serial turns tells them apart.
  { id: "web-max-turns-1-serial", base: WEB, extra: { max_turns: 1, parallel_tool_calls: false } },
  { id: "x-max-turns-1-serial", base: X, extra: { max_turns: 1, parallel_tool_calls: false } },
]
  .filter((c) => (only === "all" || c.id.startsWith(only)) && (!ids || ids.includes(c.id)))
  .flatMap((c) => Array.from({ length: repeat }, (_, i) => (repeat > 1 ? { ...c, id: `${c.id}#${i + 1}` } : c)));

const endpoint = `${config.grokApiUrl.replace(/\/+$/, "")}/responses`;
const rows = [];
for (const c of CASES) {
  process.stderr.write(`${c.id}...\n`);
  const body = { ...buildResponsesBody(c.base.query, c.base.options, config), ...c.extra };
  const started = performance.now();
  let data = null;
  let error = null;
  try {
    data = await requestJson(endpoint, {
      headers: authHeaders(config.grokApiKey),
      body,
      timeoutMs: 180_000,
      config,
      retry: true,
      retryOnTimeout: false,
    });
  } catch (err) {
    error = { message: err.message, status: err.status ?? null, upstream: err.upstreamMessage ?? null };
  }
  const wallMs = Math.round(performance.now() - started);
  const parsed = data ? parseGrokResponses(data, { defaultTool: c.base.options.searchSource === "x" ? "x_search" : "web_search", xEnabled: c.base.options.searchSource === "x" }) : null;
  const d = parsed?.diagnostics || {};
  const usage = data?.usage || {};
  const row = {
    id: c.id,
    sent: c.extra,
    error,
    wall_ms: wallMs,
    // Does the response mention the knob at all? xAI documents max_tool_calls on the response.
    echoed: {
      max_tool_calls: data?.max_tool_calls ?? null,
      parallel_tool_calls: data?.parallel_tool_calls ?? null,
      max_turns: data?.max_turns ?? null,
      status: data?.status ?? null,
      incomplete: data?.incomplete_details ?? null,
    },
    calls: {
      total: d.responses_tool_call_total ?? null,
      upstream: d.responses_tool_call_counts?.upstream ?? null,
      trace: d.responses_tool_call_counts?.trace ?? null,
      by_action: (Array.isArray(d.responses_tool_calls) ? d.responses_tool_calls : []).reduce((acc, call) => {
        const key = call.action_type || "other";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      server_side_tools_used: usage.num_server_side_tools_used ?? null,
    },
    tokens: { input: usage.input_tokens ?? null, cached: usage.input_tokens_details?.cached_tokens ?? null, output: usage.output_tokens ?? null },
    cost_usd: d.cost_usd ?? (usage.cost_in_usd_ticks ? usage.cost_in_usd_ticks / 1e10 : null),
    answer_chars: parsed?.text?.length ?? 0,
    sources: parsed?.sources?.length ?? 0,
    warnings: d.warnings || [],
  };
  rows.push(row);
  await writeFile(path.join(outDir, `${c.id}.json`), JSON.stringify({ case: { id: c.id, query: c.base.query, extra: c.extra }, body, row, response: data }, null, 2));
}
await writeFile(path.join(outDir, "summary.json"), JSON.stringify(rows, null, 2));

console.log("\n== tool-call cap experiment ==");
console.log(["case".padEnd(24), "sent".padEnd(28), "calls".padEnd(7), "by_action".padEnd(40), "cost".padEnd(7), "in tok".padEnd(8), "echoed", "status"].join(" "));
for (const r of rows) {
  if (r.error) {
    console.log(`${r.id.padEnd(24)} ${JSON.stringify(r.sent).padEnd(28)} ERROR ${r.error.status ?? ""} ${r.error.message.slice(0, 160)}`);
    continue;
  }
  console.log(
    [
      r.id.padEnd(24),
      JSON.stringify(r.sent).padEnd(28),
      String(r.calls.total).padEnd(7),
      JSON.stringify(r.calls.by_action).padEnd(40),
      (r.cost_usd?.toFixed?.(3) ?? "-").padEnd(7),
      String(r.tokens.input).padEnd(8),
      `mtc=${r.echoed.max_tool_calls} ptc=${r.echoed.parallel_tool_calls}`,
      `${r.echoed.status}${r.echoed.incomplete ? " " + JSON.stringify(r.echoed.incomplete) : ""}`,
    ].join(" ")
  );
}
