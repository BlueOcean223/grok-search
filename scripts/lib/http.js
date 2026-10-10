const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function trimBody(text, max = 500) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseErrorBody(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Firecrawl puts the wait in the body (`retry_after_seconds`) rather than in a header.
// Firecrawl's per-minute limiter (paid and free keys alike) sends no Retry-After header and no
// retry_after_seconds field, only prose: "... please retry after 15s, resets at ...". Reading it
// turns three wasted requests in four seconds into one honest stop.
const RETRY_AFTER_TEXT = /retry after\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)\b/i;

function bodyRetryAfterMs(body) {
  const seconds = Number(body?.retry_after_seconds ?? body?.retry_after ?? body?.retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const match = upstreamMessage(body)?.match(RETRY_AFTER_TEXT);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "ms") return value;
  if (unit.startsWith("m")) return value * 60_000;
  return value * 1000;
}

function upstreamCode(body) {
  const code = body?.reason ?? body?.error?.code ?? body?.code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

export function upstreamMessage(body) {
  const message = typeof body?.error === "string" ? body.error : (body?.error?.message ?? body?.message);
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

export function redactSecrets(text, config) {
  let out = String(text || "");
  for (const secret of [config?.grokApiKey, config?.tavilyApiKey, config?.firecrawlApiKey]) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

export function retryAfterMs(headers) {
  const value = headers.get("retry-after");
  if (!value) return null;

  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export function backoffMs(config, attemptIndex) {
  const maxWaitMs = config.retryMaxWait * 1000;
  const computed = config.retryMultiplier * 1000 * 2 ** attemptIndex;
  return Math.min(maxWaitMs, computed);
}

export function debugLog(config, message) {
  if (config?.debug) console.error(`[grok-search] ${message}`);
}

/**
 * POST JSON and parse the JSON reply.
 *
 * `stats.requests` (when a `stats` object is passed) counts the HTTP attempts actually made, so
 * callers can report real request counts instead of configured maximums.
 */
export async function requestJson(url, { headers, body, timeoutMs, config, retry = false, retryOnTimeout = true, stats = null }) {
  const maxAttempts = retry ? config.retryMaxAttempts : 1;
  const waitBudgetMs = config.retryMaxWait * 1000;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (stats) stats.requests = (stats.requests || 0) + 1;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      clearTimeout(timer);

      if (!response.ok) {
        const errorBody = parseErrorBody(text);
        const error = new Error(`HTTP ${response.status}: ${redactSecrets(trimBody(text), config)}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs(response.headers) ?? bodyRetryAfterMs(errorBody);
        error.upstreamCode = upstreamCode(errorBody);
        error.upstreamMessage = upstreamMessage(errorBody);
        throw error;
      }

      try {
        return text ? JSON.parse(text) : {};
      } catch (cause) {
        const error = new Error(`响应不是有效 JSON: ${redactSecrets(trimBody(text), config)}`);
        error.cause = cause;
        // A stable but malformed response will not improve on retry.
        error.retryable = false;
        throw error;
      }
    } catch (error) {
      clearTimeout(timer);
      if (error.name === "AbortError") {
        lastError = new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
        // Timed-out POSTs may still be executing (and billing) server-side.
        lastError.retryable = retryOnTimeout;
        lastError.timedOut = true;
      } else {
        lastError = error;
      }

      // A Retry-After beyond the wait budget means "not now" (quota exhausted for the day,
      // hours-long ban). Clamping it and retrying anyway only burns requests, and for a
      // quota it can extend the lockout, so stop instead of waiting a truncated interval.
      if (lastError.retryAfterMs != null && lastError.retryAfterMs > waitBudgetMs) {
        lastError.retryable = false;
        lastError.retryAfterExceeded = true;
      }

      const canRetry =
        attempt < maxAttempts - 1 &&
        lastError.retryable !== false &&
        (lastError.retryable === true || !lastError.status || RETRYABLE_STATUS.has(lastError.status));
      if (!canRetry) break;

      const waitMs = lastError.retryAfterMs ?? backoffMs(config, attempt);
      debugLog(config, `retry ${attempt + 1}/${maxAttempts - 1} after ${Math.round(waitMs)}ms: ${lastError.message}`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

export function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}
