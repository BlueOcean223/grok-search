import { recordFirecrawlCooldown } from "./cooldown.js";
import { authHeaders, backoffMs, debugLog, isPlainObject, requestJson, sleep, trimBody, upstreamMessage } from "./http.js";

export function firecrawlAuthMode(config) {
  return config?.firecrawlApiKey ? "api_key" : "keyless";
}

function firecrawlHeaders(config) {
  return config?.firecrawlApiKey
    ? authHeaders(config.firecrawlApiKey)
    : { "Content-Type": "application/json" };
}

/** Firecrawl signals an exhausted allowance with 402, or 429 plus `reason: "credits"`. */
function isFirecrawlQuotaError(error) {
  return error?.status === 402 || error?.upstreamCode === "credits";
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Firecrawl returns the page's meta tags alongside the markdown. Title, author and publish
 * date are exactly what a source card is otherwise missing, so surface them under stable
 * names instead of dropping the whole object.
 */
export function firecrawlMetadata(data) {
  const meta = data?.data?.metadata ?? data?.metadata;
  if (!isPlainObject(meta)) return {};
  const out = {
    title: firstText(meta.title, meta.ogTitle, meta["og:title"], meta["twitter:title"]),
    description: firstText(meta.description, meta.ogDescription, meta["og:description"], meta["twitter:description"]),
    author: firstText(meta.author, meta["article:author"], meta["twitter:creator"], meta.creator),
    published_at: firstText(
      meta.publishedTime,
      meta["article:published_time"],
      meta.datePublished,
      meta["og:article:published_time"],
      meta.publishedDate
    ),
    language: firstText(meta.language, meta["og:locale"]),
    status: firstText(meta.statusCode),
    source_url: firstText(meta.sourceURL, meta.url, meta["og:url"]),
  };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) delete out[key];
  }
  return out;
}

function withoutHash(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * `metadata.url` is where Firecrawl's browser ended up; `sourceURL` is what was asked for.
 * gov.cn answers a removed page with a 404 whose script jumps to the home page, and Firecrawl
 * followed it and reported 200 for the home page (checked 2026-10-10), so the final URL is the
 * only sign of what happened. Returns it when it differs from the requested URL.
 */
function redirectTarget(data, requestedUrl) {
  const meta = data?.data?.metadata ?? data?.metadata;
  const finalUrl = typeof meta?.url === "string" ? meta.url.trim() : "";
  if (!/^https?:\/\//i.test(finalUrl)) return null;
  return withoutHash(finalUrl) === withoutHash(requestedUrl) ? null : finalUrl;
}

/**
 * Retry policy has two layers. HTTP-level failures (5xx, transient 429, timeouts) belong to
 * `requestJson`, which also knows when a Retry-After is too far away to bother. The loop here
 * covers exactly one case: a 200 with empty markdown, which usually means a JS-rendered page
 * that needed a longer `waitFor`. Definite refusals (`success: false`), malformed JSON and
 * exhausted quota are returned at once; retrying them only spends requests and credits.
 */
export async function firecrawlScrape(url, config, { timeoutMs = 90_000 } = {}) {
  const endpoint = `${config.firecrawlApiUrl.replace(/\/+$/, "")}/scrape`;
  const authMode = firecrawlAuthMode(config);
  const stats = { requests: 0 };
  const fail = (error, extra = {}) => ({
    ok: false,
    provider: "firecrawl",
    auth_mode: authMode,
    error,
    requests: stats.requests,
    ...extra,
  });

  for (let attempt = 0; attempt < config.retryMaxAttempts; attempt += 1) {
    let data;
    try {
      data = await requestJson(endpoint, {
        headers: firecrawlHeaders(config),
        body: {
          url,
          formats: ["markdown"],
          timeout: 60_000,
          waitFor: (attempt + 1) * 1500,
        },
        timeoutMs,
        config,
        retry: true,
        // A 90s scrape timeout retried three times overruns the 240s command deadline; the
        // caller then sees DEADLINE_EXCEEDED instead of the real cause.
        retryOnTimeout: false,
        stats,
      });
    } catch (error) {
      const quota = isFirecrawlQuotaError(error);
      if (quota) {
        await recordFirecrawlCooldown(config, { authMode, retryAfterMs: error.retryAfterMs, reason: error.upstreamCode || "quota" });
      }
      return fail(error.message, quota ? { quota_exhausted: true } : {});
    }

    if (data?.success === false) {
      return fail(upstreamMessage(data) || "Firecrawl Scrape 返回 success:false");
    }

    const content = data?.data?.markdown || data?.markdown || "";
    const metadata = firecrawlMetadata(data);
    const credits = Number.isFinite(data?.data?.metadata?.creditsUsed) ? { credits_used: data.data.metadata.creditsUsed } : {};
    // Firecrawl returns the markdown of whatever the target served, with the target's status
    // beside it. All seven pages it returned with a status of 400 or more (2026-09-15 to
    // 10-06) were error pages, such as "Page Not Found" or Google's "503. That's an error.",
    // so such a page hands over to the next provider like any other failure. Checked before
    // the empty-markdown retry: a longer waitFor does not revive a 404.
    if (Number(metadata.status) >= 400) {
      return fail(`target page returned HTTP ${metadata.status}`, {
        metadata,
        ...(content.trim() ? { error_preview: trimBody(content.trim(), 300) } : {}),
        ...credits,
      });
    }
    if (content.trim()) {
      const finalUrl = redirectTarget(data, url);
      return {
        ok: true,
        provider: "firecrawl",
        auth_mode: authMode,
        content,
        raw: data,
        attempts: attempt + 1,
        requests: stats.requests,
        metadata,
        ...(finalUrl ? { final_url: finalUrl, redirected: true } : {}),
        ...credits,
      };
    }

    debugLog(config, `Firecrawl empty markdown, retry ${attempt + 1}/${config.retryMaxAttempts}`);
    if (attempt < config.retryMaxAttempts - 1) await sleep(backoffMs(config, attempt));
  }

  return fail("Firecrawl Scrape 返回空内容");
}
