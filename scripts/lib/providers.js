/**
 * Provider orchestration: which service fetches or maps a URL, in what order, and how a failure
 * of one hands over to the next. The adapters live in their own modules (`tavily.js`,
 * `firecrawl.js`, `deepseek.js`, `direct-fetch.js`, `direct-map.js`); every call is timed and
 * recorded through `provider-result.js`.
 */
import { activeFirecrawlCooldown, clearFirecrawlCooldown, cooldownSkipMessage } from "./cooldown.js";
import { deepseekFetch } from "./deepseek.js";
import { directFetch, directFirstForX, validateXPostContent } from "./direct-fetch.js";
import { directMap } from "./direct-map.js";
import { firecrawlAuthMode, firecrawlScrape } from "./firecrawl.js";
import { attemptFrom, skippedResult, timed } from "./provider-result.js";
import { isXUrl, parseXPostUrl } from "./sources.js";
import { tavilyExtract, tavilyMap } from "./tavily.js";

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
    const result = await timed(directMap(url, options));
    tried.push(attemptFrom(result));
    return { ...result, tried };
  }

  if (provider === "auto" || provider === "tavily") {
    const result = await timed(tavilyMap(url, options, config));
    // Tavily can map a site to an empty list that Direct Map reads fine from its sitemap:
    // www.compshare.cn/docs gave 0 URLs on 2026-10-07 and 200 from Direct on 10-10. Under auto
    // an empty list hands over like a failure.
    const empty = result.ok && !result.results.length;
    const handOver = empty && provider === "auto";
    tried.push(attemptFrom({ ...result, ok: result.ok && !handOver, error: handOver ? "returned no URLs" : result.error }));
    if (result.ok && !handOver) {
      const warnings = empty ? ["Tavily Map returned no URLs; --provider direct reads the page's links and the site's sitemaps instead."] : [];
      return { ...result, warnings: [...(result.warnings || []), ...warnings], tried };
    }
    if (provider === "tavily") return { ...result, tried };
  }

  if (provider === "auto") {
    const result = await timed(directMap(url, options));
    tried.push(attemptFrom(result));
    if (result.ok) return { ...result, tried };
    return { ...result, tried, error: summarizeMapFailure(tried, result.error) };
  }

  return { ok: false, provider, results: [], tried, error: `未知 provider: ${provider}` };
}

// auto's first Direct request only probes for a non-HTML answer; a page that stalls it should
// not hold up the extractors. Fetching 60 HTML pages from the run records on 2026-10-10, Direct
// took 0.9s at the median and 1.8s at p90, the slowest 6.3s; its own default is 60s.
const DIRECT_PROBE_TIMEOUT_MS = 15_000;

function summarizeFetchFailure(tried, fallback) {
  const details = tried
    .filter((item) => item.error)
    .map((item) => `${item.provider}: ${item.error}`)
    .join("; ");
  return details ? `提取失败: ${details}` : fallback || "提取失败: 所有提取服务均未能获取内容";
}

/**
 * The result of the provider that answered, with `tried` (one attempt per provider call) and
 * `fallback`: whether an extractor failed before the answer, or auto reused Direct's first copy
 * after every extractor failed (see fellBack).
 */
export async function fetchUrl(url, config, { provider = "auto" } = {}) {
  const tried = [];
  let directFirst = null;
  const done = (result, extra = {}) => ({ ...result, tried, fallback: fellBack(tried), ...extra });

  if (provider === "direct") {
    const result = await timed(directFetch(url));
    tried.push(attemptFrom(result));
    return done(result);
  }
  if (provider === "deepseek") return done(await deepseekStep(url, config, tried));

  const xPost = directFirstForX(url, provider);
  if (xPost) {
    const result = await timed(directFetch(url));
    // X redirects /<anyhandle>/status/<id> to the post's real handle, so the page names
    // the canonical handle, not the one in the requested URL. Validate against the former.
    const finalPost = result.ok ? parseXPostUrl(result.final_url || url) : null;
    const post = finalPost?.x_handle && finalPost.x_post_id === xPost.x_post_id ? finalPost : xPost;
    const validation = result.ok ? validateXPostContent(result.content, post) : { ok: false, missing: [] };
    if (result.ok && validation.ok) {
      tried.push(attemptFrom(result, { x_validated: true, ...(post.x_handle !== xPost.x_handle ? { x_handle: post.x_handle } : {}) }));
      return done(result);
    }
    directFirst = result;
    tried.push(attemptFrom({ ...result, ok: false, error: result.ok ? `x_validation_failed: ${validation.missing.join(",")}` : result.error }));
  } else if (provider === "auto") {
    // Direct asks for Markdown first (Accept: text/markdown). Whatever is not HTML comes back
    // as served: Markdown from sites that negotiate it (45 of 153 HTML URLs on record did on
    // 2026-10-10, code.claude.com and platform.openai.com among them), plain-text files, and
    // JSON (re-indented).
    // An HTML page goes to the extractors, and Direct's copy is kept as the last resort. So does
    // text that did not decode (U+FFFD): its charset was not declared and is not UTF-8.
    const result = await timed(directFetch(url, { timeoutMs: DIRECT_PROBE_TIMEOUT_MS }));
    const type = result.metadata?.content_type || "";
    if (result.ok && !servedHtml(result) && !String(result.content).includes("\uFFFD")) {
      tried.push(attemptFrom(result, { content_type: type }));
      return done(result);
    }
    directFirst = result;
    tried.push(result.ok ? attemptFrom(result, { content_type: type, used: false }) : attemptFrom(result));
  }

  // Firecrawl before Tavily: fetching 60 HTML pages from the run records both ways on
  // 2026-10-10, Tavily lost body text on about 20 (the comments of all 11 GitHub issues, arXiv
  // abstracts) and Firecrawl on 1 (a listing page). X pages keep Tavily first, since Firecrawl
  // bills about 30 credits for one.
  const order = isXUrl(url) ? ["tavily", "firecrawl"] : ["firecrawl", "tavily"];
  for (const name of order) {
    if (provider !== "auto" && provider !== name) continue;
    const result = name === "firecrawl" ? await firecrawlStep(url, config, provider, tried) : await tavilyStep(url, config, tried);
    if (result && (result.ok || provider === name)) return done(result);
  }

  if (provider === "auto") {
    // Direct already ran for this URL (an HTML page, or an X post that did not validate). With
    // nothing better available, its copy beats an error; reuse it instead of fetching again.
    // When Direct got no page either (an error, or nothing beyond the title), DeepSeek Fetch is
    // the last resort. It does not go earlier: on 60 HTML pages from the run records
    // (2026-10-19) Direct had the page body for 42 and DeepSeek for 32, DeepSeek returned 11
    // shells (login walls, a bare title) that would have hidden Direct's copy, and it took 6s at
    // the median and up to 60s against Direct's 0.7s. It refuses X outright, so X skips it, and
    // without a key it is left out rather than recorded as skipped on every failed fetch.
    const directUsable = directFirst.ok && !directFirst.title_only;
    if (!directUsable && !isXUrl(url) && config.deepseekApiKey) {
      const result = await deepseekStep(url, config, tried);
      if (result.ok) return done(result);
    }
    if (directFirst.ok) {
      const notices = [...(directFirst.notices || [])];
      if (xPost) {
        const failed = tried.find((attempt) => attempt.provider === "direct" && !attempt.ok);
        notices.push(
          `The X page Direct fetched failed post validation (${failed?.error || "x_validation_failed"}) and no other provider was available, so it is returned as is; use --provider firecrawl for the full post or the thread.`
        );
      }
      tried.push(attemptFrom({ provider: "direct", ok: true }, { reused: true }));
      return done(directFirst, { notices });
    }
    return done(directFirst, { error: summarizeFetchFailure(tried, directFirst.error) });
  }

  return { ok: false, provider, tried, error: `未知 provider: ${provider}` };
}

/**
 * Whether the answer is a fallback: an extractor (Firecrawl, Tavily, DeepSeek) failed before the
 * provider that answered, or auto returned Direct's first copy after they failed. The failure may be a
 * rate limit or an outage that is over by the next call, so the fetch cache does not keep such
 * a result: in a reproduction on 2026-10-10 (Firecrawl answering 503, no Tavily key), Direct's
 * copy, navigation and all, was cached under auto, and the next fetch never asked the recovered
 * Firecrawl. A skipped provider (no key, a quota cooldown) does not count, nor does auto's first
 * Direct request failing, which only probes for a non-HTML answer.
 */
function fellBack(tried) {
  return tried.some((attempt) => attempt.reused || (attempt.provider !== "direct" && attempt.ok === false && !attempt.skipped));
}

/** An HTML page, by its content type or, when a server mislabels it, by its first tag. */
function servedHtml(result) {
  return /html/i.test(result.metadata?.content_type || "") || /^\s*<(?:!doctype\s+html|html[\s>])/i.test(result.content || "");
}

async function deepseekStep(url, config, tried) {
  const result = await timed(deepseekFetch(url, config));
  tried.push(attemptFrom(result));
  return result;
}

async function tavilyStep(url, config, tried) {
  const result = await timed(tavilyExtract(url, config));
  tried.push(attemptFrom(result));
  return result;
}

/** Returns null when `auto` skips Firecrawl for an active quota cooldown. */
async function firecrawlStep(url, config, provider, tried) {
  const authMode = firecrawlAuthMode(config);
  // An explicit --provider firecrawl still makes the request: the user may have just added
  // a key or topped up, and a success clears the stale cooldown.
  const cooldown = provider === "auto" ? await activeFirecrawlCooldown(config, authMode) : null;
  if (cooldown) {
    tried.push(attemptFrom(skippedResult("firecrawl", cooldownSkipMessage(cooldown), { auth_mode: authMode })));
    return null;
  }
  const result = await timed(firecrawlScrape(url, config));
  tried.push(attemptFrom(result));
  if (result.ok && provider === "firecrawl") await clearFirecrawlCooldown(config);
  return result;
}
