const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const USER_AGENT = "grok-search-skill/0.1";

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

/**
 * Replace every configured credential in `text` with `***`. A credential is any config field
 * whose name ends in `ApiKey`, so a provider added later is covered without editing this.
 */
export function redactSecrets(text, config) {
  let out = String(text || "");
  for (const [key, secret] of Object.entries(config || {})) {
    if (!key.endsWith("ApiKey") || typeof secret !== "string" || secret.length < 4) continue;
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
        // Redact before parsing, so upstreamMessage and upstreamCode are clean too, and before
        // trimming, so a key cut at the 500-character mark cannot leave its first half behind.
        const safeText = redactSecrets(text, config);
        const errorBody = parseErrorBody(safeText);
        const error = new Error(`HTTP ${response.status}: ${trimBody(safeText)}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs(response.headers) ?? bodyRetryAfterMs(errorBody);
        error.upstreamCode = upstreamCode(errorBody);
        error.upstreamMessage = upstreamMessage(errorBody);
        throw error;
      }

      try {
        return text ? JSON.parse(text) : {};
      } catch (cause) {
        const error = new Error(`响应不是有效 JSON: ${trimBody(redactSecrets(text, config))}`);
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

function headerNumber(headers, name) {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isLikelyAttachment(headers) {
  const disposition = headers.get("content-disposition") || "";
  return /attachment/i.test(disposition);
}

function isTextualContentType(contentType) {
  const type = (contentType || "").toLowerCase().split(";")[0].trim();
  if (!type) return true;
  if (type.startsWith("text/")) return true;
  return [
    "application/json",
    "application/ld+json",
    "application/javascript",
    "application/x-javascript",
    "application/xml",
    "application/xhtml+xml",
    "application/rss+xml",
    "application/atom+xml",
    "image/svg+xml",
  ].includes(type);
}

/**
 * The charset a response declares: the Content-Type parameter, else, for markup, a <meta> tag or
 * the XML declaration within the first 1024 bytes (the window of the HTML prescan). Null if none.
 */
function declaredCharset(contentType, bytes) {
  const header = /;\s*charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || "");
  if (header) return header[1];
  if (contentType && !/html|xml/i.test(contentType)) return null;
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const markup = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) || /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([\w.:-]+)/i.exec(head);
  return markup ? markup[1] : null;
}

/**
 * Text decoded by its declared charset; UTF-8 when none is declared or the label is unknown. A GBK
 * text file decoded as UTF-8 came back as U+FFFD for every character.
 */
function decodeText(bytes, contentType) {
  const charset = declaredCharset(contentType, bytes);
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // A label TextDecoder does not know; fall back to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function readTextWithLimit(response, limitBytes) {
  const contentType = response.headers.get("content-type") || "";
  const reader = response.body?.getReader();
  if (!reader) return { text: decodeText(new Uint8Array(await response.arrayBuffer()), contentType), exceeded: false };

  const chunks = [];
  let total = 0;
  let exceeded = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limitBytes) {
      const used = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const remaining = Math.max(0, limitBytes - used);
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      exceeded = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: decodeText(bytes, contentType), exceeded };
}

/**
 * GET a URL as text: redirects followed, the body read up to `maxBytes` and decoded by its declared
 * charset. Both Direct adapters make their requests through this.
 *
 * Returns `{ ok: true, status, final_url, redirected, content_type, content_length,
 * content_disposition, text }`, or `{ ok: false, reason, error }` plus the same response fields
 * when a response arrived, with `reason` one of:
 * - "http": a non-2xx status; `text` holds up to `previewBytes` of the body (the error page)
 * - "binary": an attachment (Content-Disposition) or a non-text content type; body not read
 * - "too_large": Content-Length over `maxBytes` (body not read), or the body passed it while
 *   being read (`cut: true`)
 * - "timeout": no response within `timeoutMs`
 * - "network": any other failure (DNS, connection, TLS)
 */
export async function getText(url, { accept, timeoutMs, maxBytes, previewBytes = 0 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: accept, "User-Agent": USER_AGENT },
    });
    const finalUrl = response.url || url;
    const contentType = response.headers.get("content-type") || "";
    const contentLength = headerNumber(response.headers, "content-length");
    const head = {
      status: response.status,
      final_url: finalUrl,
      redirected: finalUrl !== url,
      content_type: contentType,
      content_length: contentLength,
      content_disposition: response.headers.get("content-disposition") || null,
    };
    if (!response.ok) {
      const preview = previewBytes > 0 ? (await readTextWithLimit(response, previewBytes)).text : "";
      return { ok: false, reason: "http", error: `HTTP ${response.status}: ${response.statusText || "请求失败"}`, ...head, text: preview };
    }
    if (isLikelyAttachment(response.headers) || !isTextualContentType(contentType)) {
      return { ok: false, reason: "binary", error: "响应不是文本内容", ...head };
    }
    if (contentLength != null && contentLength > maxBytes) {
      return { ok: false, reason: "too_large", error: `响应超过 ${maxBytes} bytes`, ...head };
    }
    const body = await readTextWithLimit(response, maxBytes);
    if (body.exceeded) return { ok: false, reason: "too_large", cut: true, error: `响应超过 ${maxBytes} bytes`, ...head };
    return { ok: true, ...head, text: body.text };
  } catch (error) {
    if (error.name === "AbortError") return { ok: false, reason: "timeout", error: `请求超时（>${Math.round(timeoutMs / 1000)}s）` };
    return { ok: false, reason: "network", error: error.message };
  } finally {
    clearTimeout(timer);
  }
}
