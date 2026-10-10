/**
 * What a provider adapter returns and what the orchestration records about it.
 *
 * Every adapter (Tavily, Firecrawl, Direct, Grok Responses) answers with `{ ok, provider, ... }`:
 * its payload (`content`, `sources` or `results`), `error` when it failed, `skipped: true` when it
 * did not run (no key, a quota cooldown), and whatever it knows about cost (`auth_mode`,
 * `requests`, `credits_used`, `quota_exhausted`). The orchestration times each call with `timed`
 * and derives the `provider_attempts` entry with `attemptFrom`, so the attempt's shape is decided
 * here and nowhere else.
 */

/** The result of an adapter that did not run; `reason` says why. */
export function skippedResult(provider, reason, fields = {}) {
  return { ok: false, provider, skipped: true, error: reason, ...fields };
}

/** The awaited result with `duration_ms` set to how long the call took. */
export async function timed(job) {
  const started = performance.now();
  const result = await job;
  return { ...result, duration_ms: Math.round(performance.now() - started) };
}

// Result fields an attempt carries over, in this order; the rest of the result is payload.
const ATTEMPT_FIELDS = ["auth_mode", "requests", "duration_ms", "credits_used", "quota_exhausted"];

/**
 * The `provider_attempts` entry for a result: which provider, whether it answered, `skipped` only
 * when it did not run, `error` only when there is one, then what the call cost. `extra` adds what
 * only the orchestration knows (`count`, `reused`, `x_validated`, ...).
 */
export function attemptFrom(result, extra = {}) {
  const attempt = { provider: result.provider, ok: Boolean(result.ok) };
  if (result.skipped) attempt.skipped = true;
  if (result.error) attempt.error = result.error;
  for (const key of ATTEMPT_FIELDS) {
    if (result[key] != null && result[key] !== false) attempt[key] = result[key];
  }
  return { ...attempt, ...extra };
}
