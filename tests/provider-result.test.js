#!/usr/bin/env node
import assert from "node:assert/strict";
import { attemptFrom, skippedResult, timed } from "../scripts/lib/provider-result.js";

// An attempt names the provider, whether it answered, and what the call cost; nothing else.
assert.deepEqual(attemptFrom({ ok: true, provider: "tavily", content: "page text", raw: { results: [] } }), { provider: "tavily", ok: true });
assert.deepEqual(
  attemptFrom({ ok: false, provider: "firecrawl", error: "HTTP 429", auth_mode: "keyless", requests: 1, duration_ms: 42, credits_used: 0, quota_exhausted: true, raw: {} }),
  { provider: "firecrawl", ok: false, error: "HTTP 429", auth_mode: "keyless", requests: 1, duration_ms: 42, credits_used: 0, quota_exhausted: true }
);
// `skipped` and `quota_exhausted` appear only when true; a skipped provider has no cost to report.
assert.deepEqual(attemptFrom({ ok: true, provider: "direct", skipped: false, quota_exhausted: false, duration_ms: 3 }), { provider: "direct", ok: true, duration_ms: 3 });
assert.deepEqual(attemptFrom(skippedResult("tavily", "TAVILY_API_KEY 未配置")), { provider: "tavily", ok: false, skipped: true, error: "TAVILY_API_KEY 未配置" });
assert.deepEqual(
  attemptFrom(skippedResult("firecrawl", "cooldown until 2026-10-11T00:00:00.000Z (credits)", { auth_mode: "keyless" }), { count: 0 }),
  { provider: "firecrawl", ok: false, skipped: true, error: "cooldown until 2026-10-11T00:00:00.000Z (credits)", auth_mode: "keyless", count: 0 }
);
// What only the orchestration knows rides along as `extra`.
assert.deepEqual(attemptFrom({ ok: true, provider: "direct" }, { content_type: "text/plain", used: false }), { provider: "direct", ok: true, content_type: "text/plain", used: false });
// A null cost field is left out, a zero one is kept.
assert.deepEqual(attemptFrom({ ok: true, provider: "grok-responses:xai", requests: null }, { count: 2 }), { provider: "grok-responses:xai", ok: true, count: 2 });
assert.deepEqual(attemptFrom({ ok: true, provider: "firecrawl", credits_used: 0 }), { provider: "firecrawl", ok: true, credits_used: 0 });

// timed adds how long the awaited call took.
const slow = await timed(new Promise((resolve) => setTimeout(() => resolve({ ok: true, provider: "direct" }), 20)));
assert.equal(slow.ok, true);
assert.equal(typeof slow.duration_ms, "number");
assert.equal(slow.duration_ms >= 15, true);

console.log("provider-result fixtures ok");
