#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyConfigDefaults } from "../scripts/lib/cli.js";
import { grokSearchResult } from "../scripts/lib/grok-responses.js";
import { runSearch, SEARCH_OPTIONS } from "../scripts/lib/search.js";

// runSearch through its own interface: parsed args with their config defaults applied, a config,
// and the Grok channel as a fake. The fake runs the real parser over a fixture body, so the result
// has the shape searchGrokResponses returns; only the HTTP request is left out.

const outputDir = await mkdtemp(path.join(tmpdir(), "grok-search-test-output-"));
const stateDir = await mkdtemp(path.join(tmpdir(), "grok-search-test-state-"));

const config = {
  grokApiUrl: "http://127.0.0.1:9/v1",
  grokApiKey: "k",
  apiProvider: "xai",
  grokModel: "grok-4.3",
  responsesMaxTurns: 3,
  responsesReasoningEffort: "low",
  responsesParallelToolCalls: null,
  responsesAllowedDomains: [],
  responsesExcludedDomains: [],
  responsesSearchSource: "",
  responsesAllowedXHandles: [],
  responsesExcludedXHandles: [],
  responsesXImageUnderstanding: false,
  responsesXVideoUnderstanding: false,
  responsesOpenRouterEngine: "auto",
  sourceChars: 400,
  maxSources: 12,
  deadlineSeconds: 240,
  outputDir,
  stateDir,
  outputRetentionDays: 30,
  runLog: true,
  debugRaw: false,
  debug: false,
};

const baseArgs = applyConfigDefaults({
  query: "node release",
  platform: "",
  model: "",
  sourceChars: null,
  maxSources: null,
  fullSources: false,
  maxChars: 30000,
  deadline: null,
  responsesMaxTurns: null,
  responsesReasoningEffort: "",
  responsesParallelToolCalls: null,
  responsesAllowedDomains: null,
  responsesExcludedDomains: null,
  searchSource: "",
  responsesAllowedXHandles: null,
  responsesExcludedXHandles: null,
  xFromDate: "",
  xToDate: "",
  xImageUnderstanding: null,
  xVideoUnderstanding: null,
  responsesOpenRouterEngine: "",
  instructions: "",
}, SEARCH_OPTIONS, config);

const responsesBody = {
  model: "grok-4.3",
  output: [
    { type: "web_search_call", status: "completed", action: { type: "search", query: "node release" } },
    { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://nodejs.org/en/blog/release/v24.0.0" } },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "<!-- answer -->\nNode 24 is current, per [the release post](https://nodejs.org/en/blog/release/v24.0.0).",
          annotations: [
            { type: "url_citation", url: "https://nodejs.org/en/blog/release/v24.0.0", title: "1", start_index: 20, end_index: 40 },
            { type: "url_citation", url: "https://github.com/nodejs/node/releases", title: "https://github.com/nodejs/node/releases", start_index: 0, end_index: 0 },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 20, cost_in_usd_ticks: 50_000_000, server_side_tool_usage_details: { web_search_calls: 2 } },
};

const grokFromFixture = (body) => async (query, options, cfg) => grokSearchResult(body, options, cfg, { requests: 1 });
// The ordinary path: Grok's answer, its cards, the run record.
{
  const output = await runSearch(baseArgs, config, { grok: grokFromFixture(responsesBody) });
  assert.equal(output.query, "node release");
  assert.equal(output.model, "grok-4.3");
  assert.match(output.answer.text, /^Node 24 is current/);
  assert.equal(output.answer.truncated, false);

  const urls = output.sources.items.map((item) => item.url);
  assert.deepEqual(urls, ["https://nodejs.org/en/blog/release/v24.0.0", "https://github.com/nodejs/node/releases"]);
  const release = output.sources.items[0];
  assert.equal(release.source_type, "citation");
  assert.equal(release.opened, true);
  assert.equal(release.title, "the release post");
  // The GitHub listing was only listed by Grok, with the URL for a title: a bare card.
  const releases = output.sources.items[1];
  assert.equal(releases.source_type, "searched");
  assert.equal(releases.title, undefined);
  assert.deepEqual({ returned: output.sources.returned, total: output.sources.total, omitted: output.sources.omitted }, { returned: 2, total: 2, omitted: 0 });

  const diagnostics = output.diagnostics;
  assert.equal(diagnostics.grok_endpoint, "responses");
  assert.equal(diagnostics.cost_usd, 0.005);
  assert.equal(diagnostics.responses_web_search_calls, 2);
  assert.deepEqual(diagnostics.responses_tool_calls, { total: 2, upstream: { web: 2, x: 0 }, trace: { web: 2, x: 0 }, by_action: { search: 1, open_page: 1 } });
  assert.deepEqual(diagnostics.search_budget, {
    prompt_total: 6,
    prompt_x: 0,
    used_web: 2,
    used_x: 0,
    used_total: 2,
    used_searches: 1,
    used_x_searches: 0,
    exceeded: false,
    enforced: false,
  });
  assert.deepEqual(
    diagnostics.provider_attempts.map((attempt) => [attempt.provider, attempt.ok, attempt.count]),
    [["grok-responses:xai", true, 2]]
  );
  assert.equal(diagnostics.options.search_source, "web");
  assert.equal(Object.hasOwn(diagnostics.options, "extra"), false);
  assert.deepEqual(diagnostics.warnings, []);

  const record = JSON.parse(await readFile(output.sources.raw_path, "utf8"));
  assert.equal(record.kind, "search");
  assert.equal(record.schema_version, 3);
  assert.equal(record.answer, output.answer.text);
  assert.equal(record.sources.grok.length, 2);
  assert.equal(record.sources.items.length, 2);
  assert.equal(Object.hasOwn(record.sources, "extra"), false);
  assert.equal(record.grok_tool_calls.length, 2);
  assert.deepEqual(record.printed_answer, { chars: output.answer.chars, truncated: false, full_path: null });
  assert.equal(record.error, null);
}

// A rate limit and an exhausted quota are errors named as what they are, with the options that
// were in force.
{
  const failing = (status, message) => async () => {
    const error = new Error(message);
    error.status = status;
    throw error;
  };
  await assert.rejects(runSearch(baseArgs, config, { grok: failing(429, "HTTP 429: slow down") }), (error) => {
    assert.equal(error.code, "GROK_RATE_LIMITED");
    assert.equal(error.message, "Grok Responses 触发限流: HTTP 429: slow down");
    assert.deepEqual(error.diagnostics.grok_error, { code: "RATE_LIMITED", message: "HTTP 429: slow down" });
    assert.match(error.diagnostics.warnings[0], /rate limited/);
    return true;
  });
  await assert.rejects(runSearch(baseArgs, config, { grok: failing(402, "HTTP 402: insufficient credits") }), (error) => {
    assert.equal(error.code, "GROK_QUOTA_EXHAUSTED");
    assert.deepEqual(error.diagnostics.grok_error, { code: "QUOTA_EXHAUSTED", message: "HTTP 402: insufficient credits" });
    assert.equal(error.diagnostics.options.search_source, "web");
    assert.deepEqual(error.diagnostics.provider_attempts.map((attempt) => [attempt.provider, attempt.ok]), [["grok-responses:xai", false]]);
    return true;
  });
  // Any other failure is reported unchanged, with the diagnostics attached.
  await assert.rejects(runSearch(baseArgs, config, { grok: failing(524, "HTTP 524: timeout") }), (error) => {
    assert.equal(error.message, "HTTP 524: timeout");
    assert.match(error.diagnostics.warnings[0], /Responses search failed: HTTP 524/);
    return true;
  });
}

// An empty answer is an error that keeps what the call measured: usage, cost, the served model.
{
  const empty = { ...responsesBody, output: responsesBody.output.slice(0, 2) };
  await assert.rejects(runSearch(baseArgs, config, { grok: grokFromFixture(empty) }), (error) => {
    assert.equal(error.code, "GROK_RESPONSES_EMPTY");
    assert.equal(error.diagnostics.cost_usd, 0.005);
    assert.equal(error.diagnostics.responses_model, "grok-4.3");
    assert.equal(error.diagnostics.responses_tool_calls.total, 2);
    assert.ok(error.diagnostics.warnings.includes("Responses returned no output text."));
    assert.ok(error.diagnostics.warnings.some((warning) => /Responses search failed/.test(warning)));
    return true;
  });
}

// The X prompt budget shows in the diagnostics of an X search.
{
  const output = await runSearch({ ...baseArgs, searchSource: "x" }, config, { grok: grokFromFixture(responsesBody) });
  assert.equal(output.diagnostics.search_budget.prompt_x, 4);
}

// An X search that read no posts under a date window or a handle list says so: the filter, not
// the search, is the likely reason (@nodejs's last post was 2026-08-27; --x-from-date 2026-09-01
// read nothing on 2026-10-11).
{
  const xUsage = (fetched) => ({ ...responsesBody, usage: { ...responsesBody.usage, server_side_tool_usage_details: { x_search_calls: 3, x_posts_fetched: fetched } } });
  const run = (args, body) => runSearch({ ...baseArgs, searchSource: "x", ...args }, config, { grok: grokFromFixture(body) });
  const filterWarnings = (output) => output.diagnostics.warnings.filter((line) => line.startsWith("X search read no posts"));

  assert.deepEqual(filterWarnings(await run({ xFromDate: "2026-09-01" }, xUsage(0))), [
    "X search read no posts under --x-from-date 2026-09-01; the accounts may have nothing there. Widen the dates or drop the handle filter and retry.",
  ]);
  assert.match(filterWarnings(await run({ xToDate: "2026-09-30", responsesAllowedXHandles: ["nodejs"] }, xUsage(0)))[0], /--x-to-date 2026-09-30 --responses-allowed-x-handles nodejs;/);
  // Posts were read, no filter was set, or the relay reports no usage details: nothing to say.
  assert.deepEqual(filterWarnings(await run({ xFromDate: "2026-09-01" }, xUsage(4))), []);
  assert.deepEqual(filterWarnings(await run({}, xUsage(0))), []);
  assert.deepEqual(filterWarnings(await run({ xFromDate: "2026-09-01" }, responsesBody)), []);
}

await rm(outputDir, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
console.log("search fixtures ok");
