#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fitTextToStdoutBudget,
  previewText,
  runRecordBase,
  STDOUT_BUDGET_BYTES,
  stdoutBytes,
  withNotices,
  writeFullOutput,
  writeRunRecord,
  writeRunRecordSync,
} from "../scripts/lib/output.js";

const outputDir = await mkdtemp(path.join(tmpdir(), "grok-search-output-test-"));
const config = { outputDir, outputRetentionDays: 30 };

// CJK labels all slug to the same fallback; parallel writes in the same second
// must still land in distinct files.
const [first, second] = await Promise.all([
  writeFullOutput(config, { kind: "sources", provider: "search", label: "中文查询一", content: "one" }),
  writeFullOutput(config, { kind: "sources", provider: "search", label: "中文查询二", content: "two" }),
]);
assert.notEqual(first, second);
assert.equal(await readFile(first, "utf8"), "one");
assert.equal(await readFile(second, "utf8"), "two");

assert.equal((await stat(first)).mode & 0o777, 0o600);
assert.equal((await stat(second)).mode & 0o777, 0o600);

// Run records: one JSON per command, named by kind, private, with the schema header.
const base = runRecordBase("search", { grokApiKey: "" }, "2026-09-08T00:00:00.000Z");
assert.equal(base.schema_version, 2);
assert.equal(base.kind, "search");
assert.equal(base.created_at, "2026-09-08T00:00:00.000Z");
assert.equal(Array.isArray(base.argv), true);

const runPath = await writeRunRecord(config, {
  kind: "search",
  label: "run record query",
  record: { ...base, query: "run record query", answer: "full answer", error: null },
});
assert.match(path.basename(runPath), /^grok-search-\d{8}-\d{6}-run-search-run-record-query-[0-9a-f]{6}\.json$/);
assert.equal((await stat(runPath)).mode & 0o777, 0o600);
const stored = JSON.parse(await readFile(runPath, "utf8"));
assert.equal(stored.schema_version, 2);
assert.equal(stored.answer, "full answer");
assert.equal(stored.error, null);

// The synchronous variant (used on the deadline exit path) writes the same shape.
const syncPath = writeRunRecordSync(config, { kind: "fetch", label: "https://example.com/x", record: { ...base, kind: "fetch" } });
assert.match(path.basename(syncPath), /-run-fetch-example-com-x-/);
assert.equal(JSON.parse(await readFile(syncPath, "utf8")).kind, "fetch");

// runLog: false disables both variants without touching the disk.
assert.equal(await writeRunRecord({ ...config, runLog: false }, { kind: "search", label: "off", record: base }), null);
assert.equal(writeRunRecordSync({ ...config, runLog: false }, { kind: "search", label: "off", record: base }), null);

// Secrets pasted into argv are masked in the record header.
const originalArgv = process.argv;
process.argv = ["node", "search.js", "--model", "m", "leak sk-secret-value here"];
try {
  const redacted = runRecordBase("search", { grokApiKey: "sk-secret-value" });
  assert.deepEqual(redacted.argv, ["--model", "m", "leak *** here"]);
} finally {
  process.argv = originalArgv;
}

// stdout budget: pi's bash keeps the last 50KB in whole lines, so one oversized text line takes
// everything above it along. CJK is 3 bytes per char and JSON escapes grow quotes and newlines.
{
  const text = "中文正文，带\"引号\"和换行\n".repeat(4000);
  const output = { content: { text, truncated: false }, diagnostics: { warnings: [] } };
  let calls = 0;
  const cut = await fitTextToStdoutBudget(output, output.content, "text", async () => {
    calls += 1;
    output.content.truncated = true;
    output.diagnostics.warnings.push("cut");
  });
  assert.equal(cut, output.content.text);
  assert.equal(calls, 1);
  assert.equal(output.content.truncated, true);
  assert.ok(stdoutBytes(output) <= STDOUT_BUDGET_BYTES);
  assert.ok(stdoutBytes(output) > STDOUT_BUDGET_BYTES - 64, "keeps as much text as fits");
  assert.ok(text.startsWith(output.content.text));
}

// compose wraps the text in notices that survive the cut; it sees the state onCut leaves and
// the kept text, so a tail can say where the cut fell.
{
  const text = "z".repeat(60_000);
  const output = { content: { text, truncated: false }, diagnostics: { warnings: [] } };
  const compose = (shown) =>
    withNotices(shown, { lead: ["lead notice"], tail: output.content.truncated ? [`cut at ${shown.length}`] : [] });
  const kept = await fitTextToStdoutBudget(output, output.content, "text", async () => {
    output.content.truncated = true;
  }, { compose });
  assert.ok(kept.length < 60_000);
  assert.equal(output.content.text, `[grok-search] lead notice\n\n${kept}\n\n[grok-search] cut at ${kept.length}`);
  assert.ok(stdoutBytes(output) <= STDOUT_BUDGET_BYTES);

  // Within budget, compose still applies.
  const small = { content: { text: "body" } };
  assert.equal(await fitTextToStdoutBudget(small, small.content, "text", async () => assert.fail("onCut"), { compose: (shown) => withNotices(shown, { tail: ["end"] }) }), null);
  assert.equal(small.content.text, "body\n\n[grok-search] end");
}

// previewText: --max-chars characters from --offset; anything short of the whole text is saved.
{
  const whole = await previewText(config, { kind: "fetch", provider: "direct", label: "p", content: "abcdef", maxChars: 10 });
  assert.deepEqual({ ...whole }, { preview: "abcdef", truncated: false, offset: 0, original_length: 6, full_output_path: null });
  const middle = await previewText(config, { kind: "fetch", provider: "direct", label: "p", content: "abcdef", maxChars: 2, offset: 2 });
  assert.equal(middle.preview, "cd");
  assert.equal(middle.offset, 2);
  assert.equal(middle.truncated, true);
  assert.equal(await readFile(middle.full_output_path, "utf8"), "abcdef");
  const rest = await previewText(config, { kind: "fetch", provider: "direct", label: "p", content: "abcdef", maxChars: 100, offset: 4 });
  assert.equal(rest.preview, "ef");
  assert.equal(rest.truncated, true);
  const past = await previewText(config, { kind: "fetch", provider: "direct", label: "p", content: "abcdef", maxChars: 100, offset: 99 });
  assert.equal(past.preview, "");
  assert.equal(past.offset, 6);
}

// Already within budget: untouched, onCut not called.
{
  const output = { answer: { text: "short" } };
  const cut = await fitTextToStdoutBudget(output, output.answer, "text", async () => assert.fail("onCut"));
  assert.equal(cut, null);
  assert.equal(output.answer.text, "short");
}

// The rest alone exceeds the budget (e.g. --full-sources): cutting would not help, so keep the text.
{
  const output = { answer: { text: "x".repeat(500) }, raw: "y".repeat(5000) };
  const cut = await fitTextToStdoutBudget(output, output.answer, "text", async () => assert.fail("onCut"), { budget: 2000 });
  assert.equal(cut, null);
  assert.equal(output.answer.text.length, 500);
}

console.log("output fixtures ok");
