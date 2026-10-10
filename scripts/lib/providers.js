/**
 * Provider orchestration: which service fetches or maps a URL, in what order, and how a
 * failure of one hands over to the next. The adapters live in their own modules
 * (`http.js`, `tavily.js`, `firecrawl.js`, `direct.js`); everything they export is re-exported
 * here so callers keep a single import path.
 */
import { activeFirecrawlCooldown, clearFirecrawlCooldown, cooldownSkipMessage } from "./cooldown.js";
import { directFetch, directFirstForX, directMap, validateXPostContent } from "./direct.js";
import { firecrawlAuthMode, firecrawlScrape } from "./firecrawl.js";
import { isXUrl, parseXPostUrl } from "./sources.js";
import { tavilyExtract, tavilyMap } from "./tavily.js";

export { authHeaders, backoffMs, debugLog, redactSecrets, requestJson, retryAfterMs, upstreamMessage } from "./http.js";
export { tavilyExtract, tavilyMap, tavilySearch } from "./tavily.js";
export { firecrawlAuthMode, firecrawlMetadata, firecrawlScrape, firecrawlSearch, isFirecrawlQuotaError } from "./firecrawl.js";
export {
  DIRECT_MAP_REQUEST_TIMEOUT_SECONDS,
  collapseRepeatedLines,
  directFetch,
  directFirstForX,
  directMap,
  validateXPostContent,
  xDirectFirstEligible,
} from "./direct.js";

function summarizeMapFailure(tried, fallback) {
  const details = tried
    .filter((item) => item.error)
    .map((item) => `${item.provider}: ${item.error}`)
    .join("; ");
  return details ? `映射失败: ${details}` : fallback || "映射失败";
}

export async function mapUrl(url, config, { provider = "auto", ...options } = {}) {
  const tried = [];

  if (provider === "direct") {
    const result = await directMap(url, options);
    tried.push({ provider: result.provider, ok: result.ok, skipped: false, error: result.error });
    return { ...result, tried };
  }

  if (provider === "auto" || provider === "tavily") {
    const result = await tavilyMap(url, options, config);
    // Tavily can map a site to an empty list that Direct Map reads fine from its sitemap:
    // www.compshare.cn/docs gave 0 URLs on 2026-10-07 and 200 from Direct on 10-10. Under auto
    // an empty list hands over like a failure.
    const empty = result.ok && !result.results.length;
    const handOver = empty && provider === "auto";
    tried.push({
      provider: result.provider,
      ok: result.ok && !handOver,
      skipped: Boolean(result.skipped),
      error: handOver ? "returned no URLs" : result.error,
    });
    if (result.ok && !handOver) {
      const warnings = empty ? ["Tavily Map returned no URLs; --provider direct reads the page's links and the site's sitemaps instead."] : [];
      return { ...result, warnings: [...(result.warnings || []), ...warnings], tried };
    }
    if (provider === "tavily") return { ...result, tried };
  }

  if (provider === "auto") {
    const result = await directMap(url, options);
    tried.push({ provider: result.provider, ok: result.ok, skipped: false, error: result.error });
    if (result.ok) return { ...result, tried };
    return { ...result, tried, error: summarizeMapFailure(tried, result.error) };
  }

  return { ok: false, provider, results: [], tried, error: `未知 provider: ${provider}` };
}

function summarizeFetchFailure(tried, fallback) {
  const details = tried
    .filter((item) => item.error)
    .map((item) => `${item.provider}: ${item.error}`)
    .join("; ");
  return details ? `提取失败: ${details}` : fallback || "提取失败: 所有提取服务均未能获取内容";
}

export async function fetchUrl(url, config, { provider = "auto" } = {}) {
  const tried = [];
  let directFirst = null;

  if (provider === "direct") {
    const result = await directFetch(url);
    tried.push({ provider: result.provider, ok: result.ok, skipped: false, error: result.error });
    return { ...result, tried };
  }

  const xPost = directFirstForX(url, config, provider);
  if (xPost) {
    const result = await directFetch(url);
    // X redirects /<anyhandle>/status/<id> to the post's real handle, so the page names
    // the canonical handle, not the one in the requested URL. Validate against the former.
    const finalPost = result.ok ? parseXPostUrl(result.final_url || url) : null;
    const post = finalPost?.x_handle && finalPost.x_post_id === xPost.x_post_id ? finalPost : xPost;
    const validation = result.ok ? validateXPostContent(result.content, post) : { ok: false, missing: [] };
    if (result.ok && validation.ok) {
      tried.push({
        provider: "direct",
        ok: true,
        skipped: false,
        x_validated: true,
        ...(post.x_handle !== xPost.x_handle ? { x_handle: post.x_handle } : {}),
      });
      return { ...result, tried };
    }
    directFirst = result;
    tried.push({
      provider: "direct",
      ok: false,
      skipped: false,
      error: result.ok ? `x_validation_failed: ${validation.missing.join(",")}` : result.error,
    });
  } else if (provider === "auto") {
    // Direct asks for Markdown first (Accept: text/markdown). Whatever is not HTML comes back
    // as served: Markdown from sites that negotiate it (45 of 153 HTML URLs on record did on
    // 2026-10-10, code.claude.com and platform.openai.com among them), plain-text files, and
    // JSON (re-indented).
    // An HTML page goes to the extractors, and Direct's copy is kept as the last resort.
    const result = await directFetch(url);
    const type = result.metadata?.content_type || "";
    if (result.ok && !servedHtml(result)) {
      tried.push({ provider: "direct", ok: true, skipped: false, content_type: type });
      return { ...result, tried };
    }
    directFirst = result;
    tried.push(
      result.ok
        ? { provider: "direct", ok: true, skipped: false, content_type: type, used: false }
        : { provider: "direct", ok: false, skipped: false, error: result.error }
    );
  }

  // Firecrawl before Tavily: fetching 60 HTML pages from the run records both ways on
  // 2026-10-10, Tavily lost body text on about 20 (the comments of all 11 GitHub issues, arXiv
  // abstracts) and Firecrawl on 1 (a listing page). X pages keep Tavily first, since Firecrawl
  // bills about 30 credits for one.
  const order = isXUrl(url) ? ["tavily", "firecrawl"] : ["firecrawl", "tavily"];
  for (const name of order) {
    if (provider !== "auto" && provider !== name) continue;
    const result = name === "firecrawl" ? await firecrawlStep(url, config, provider, tried) : await tavilyStep(url, config, tried);
    if (result && (result.ok || provider === name)) return { ...result, tried };
  }

  if (provider === "auto") {
    // Direct already ran for this URL (an HTML page, or an X post that did not validate). With
    // nothing better available, its copy beats an error; reuse it instead of fetching again.
    if (directFirst.ok) {
      const notices = [...(directFirst.notices || [])];
      if (xPost) {
        const failed = tried.find((attempt) => attempt.provider === "direct" && !attempt.ok);
        notices.push(
          `The X page Direct fetched failed post validation (${failed?.error || "x_validation_failed"}) and no other provider was available, so it is returned as is; use --provider firecrawl for the full post or the thread.`
        );
      }
      tried.push({ provider: "direct", ok: true, skipped: false, reused: true });
      return { ...directFirst, notices, tried };
    }
    return { ...directFirst, tried, error: summarizeFetchFailure(tried, directFirst.error) };
  }

  return { ok: false, provider, tried, error: `未知 provider: ${provider}` };
}

/** An HTML page, by its content type or, when a server mislabels it, by its first tag. */
function servedHtml(result) {
  return /html/i.test(result.metadata?.content_type || "") || /^\s*<(?:!doctype\s+html|html[\s>])/i.test(result.content || "");
}

async function tavilyStep(url, config, tried) {
  const result = await tavilyExtract(url, config);
  tried.push({ provider: result.provider, ok: result.ok, skipped: Boolean(result.skipped), error: result.error });
  return result;
}

/** Returns null when `auto` skips Firecrawl for an active quota cooldown. */
async function firecrawlStep(url, config, provider, tried) {
  const authMode = firecrawlAuthMode(config);
  // An explicit --provider firecrawl still makes the request: the user may have just added
  // a key or topped up, and a success clears the stale cooldown.
  const cooldown = provider === "auto" ? await activeFirecrawlCooldown(config, authMode) : null;
  if (cooldown) {
    tried.push({ provider: "firecrawl", ok: false, skipped: true, auth_mode: authMode, error: cooldownSkipMessage(cooldown) });
    return null;
  }
  const result = await firecrawlScrape(url, config);
  tried.push({
    provider: result.provider,
    ok: result.ok,
    skipped: Boolean(result.skipped),
    error: result.error,
    auth_mode: result.auth_mode,
    ...(result.requests == null ? {} : { requests: result.requests }),
    ...(result.duration_ms == null ? {} : { duration_ms: result.duration_ms }),
    ...(result.credits_used == null ? {} : { credits_used: result.credits_used }),
  });
  if (result.ok && provider === "firecrawl") await clearFirecrawlCooldown(config);
  return result;
}
