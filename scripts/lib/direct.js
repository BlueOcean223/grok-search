import { trimBody } from "./http.js";
import { inMapScope, isXUrl, mapScope, parseXPostUrl } from "./sources.js";

const DIRECT_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const DIRECT_ERROR_PREVIEW_BYTES = 1000;
// Direct Map fetches robots.txt, the sitemaps and the page itself; each request gets its own timeout,
// separate from --timeout, which is Tavily's remote crawl budget (150s by default). A stalled
// sitemap should not eat most of the 240s command deadline.
export const DIRECT_MAP_REQUEST_TIMEOUT_SECONDS = 30;
function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function fetchTextForMap(url, timeoutSeconds) {
  const timeout = withTimeout(timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: timeout.signal,
      headers: {
        Accept: "application/xml,text/xml,text/html,*/*;q=0.8",
        "User-Agent": "grok-search-skill/0.1",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${response.statusText || "请求失败"}` };
    }
    if (!isTextualContentType(contentType)) {
      return { ok: false, status: response.status, error: "响应不是文本内容" };
    }
    const contentLength = headerNumber(response.headers, "content-length");
    if (contentLength != null && contentLength > DIRECT_FETCH_MAX_BYTES) {
      return { ok: false, status: response.status, error: `响应超过 Direct Map 首版上限 ${DIRECT_FETCH_MAX_BYTES} bytes` };
    }
    const body = await readTextWithLimit(response, DIRECT_FETCH_MAX_BYTES);
    if (body.exceeded) {
      return { ok: false, status: response.status, error: `响应超过 Direct Map 首版上限 ${DIRECT_FETCH_MAX_BYTES} bytes` };
    }
    return { ok: true, status: response.status, final_url: response.url || url, text: body.text, content_type: contentType };
  } catch (error) {
    const message = error.name === "AbortError" ? `请求超时（>${timeoutSeconds}s）` : error.message;
    return { ok: false, error: message };
  } finally {
    timeout.clear();
  }
}

function uniqueLimited(urls, limit) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

// Sitemap documents read per map, index files included. A large store's index can list hundreds
// of child sitemaps, and reading them all would outlast the command deadline.
const MAX_SITEMAP_DOCUMENTS = 10;

/** Absolute http(s) URLs without fragments; malformed values are dropped. */
function absoluteUrls(values, base) {
  const urls = [];
  for (const value of values) {
    try {
      const parsed = new URL(decodeHtmlEntities(String(value).trim()), base);
      parsed.hash = "";
      if (parsed.protocol === "http:" || parsed.protocol === "https:") urls.push(parsed.toString());
    } catch {
      // Ignore malformed entries.
    }
  }
  return urls;
}

/** The sitemaps a robots.txt declares on its `Sitemap:` lines. */
function robotsSitemaps(text, base) {
  return absoluteUrls(
    [...String(text || "").matchAll(/^[ \t]*sitemap[ \t]*:[ \t]*(\S+)/gim)].map((match) => match[1]),
    base
  );
}

/** A sitemap's <loc> entries, and whether they name further sitemaps (a sitemap index). */
function sitemapEntries(xml, base) {
  const text = String(xml || "");
  return {
    index: /<sitemapindex[\s>]/i.test(text),
    locs: absoluteUrls(
      [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[\s*)?([^<]+?)(?:\s*\]\]>)?\s*<\/loc>/gi)].map((match) => match[1]),
      base
    ),
  };
}

/**
 * Page URLs from a site's sitemaps, found the way sitemap tools such as ultimate-sitemap-parser
 * find them: the sitemaps robots.txt declares and the conventional locations, with index files
 * expanded level by level. Stops at MAX_SITEMAP_DOCUMENTS documents, or once `enough` of the
 * URLs pass `keep`.
 */
async function readSitemaps(candidates, { timeout, keep, enough }) {
  const seen = new Set();
  const pages = [];
  let queue = candidates;
  let read = 0;
  let found = 0;
  const kept = () => pages.filter(keep).length;
  while (queue.length && read < MAX_SITEMAP_DOCUMENTS && kept() < enough) {
    const batch = [...new Set(queue)].filter((url) => !seen.has(url)).slice(0, MAX_SITEMAP_DOCUMENTS - read);
    for (const url of batch) seen.add(url);
    read += batch.length;
    queue = [];
    for (const doc of await Promise.all(batch.map((url) => fetchTextForMap(url, timeout)))) {
      if (!doc.ok) continue;
      const { index, locs } = sitemapEntries(doc.text, doc.final_url);
      // A 200 page with no <loc> (an HTML page served at /sitemap.xml) is not a sitemap.
      if (!locs.length) continue;
      found += 1;
      if (index) queue.push(...locs);
      else pages.push(...locs);
    }
  }
  const unread = [...new Set(queue)].filter((url) => !seen.has(url)).length;
  return { pages, found, unread: kept() < enough ? unread : 0 };
}

function hrefValues(html) {
  const values = [];
  for (const match of String(html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    values.push(match[1] || match[2] || match[3] || "");
  }
  return values;
}

/**
 * Candidate URLs for a site, or for the section a URL with a path names. Like a crawler, it
 * starts from the URL it was given: the links on that page come first, then the site's sitemaps.
 * Results keep to mapScope, filtered before the limit: mapping www.compshare.cn/docs with the
 * whole sitemap on 2026-10-10 returned 200 of the site's 891 URLs, 4 under /docs and 179 under
 * /images.
 */
export async function directMap(url, options = {}) {
  const warnings = [];
  const parsed = new URL(url);
  const baseUrl = parsed.origin;
  const host = parsed.hostname;
  const scope = mapScope(url);
  const limit = options.limit || 50;
  const maxBreadth = options.maxBreadth || 20;
  const timeout = options.requestTimeout || DIRECT_MAP_REQUEST_TIMEOUT_SECONDS;
  const instructionsIgnored = Boolean(options.instructions);

  if (instructionsIgnored) {
    warnings.push("Direct Map does not support instructions; ignored.");
  }
  if ((options.maxDepth || 1) > 1) {
    warnings.push("Direct Map only supports max-depth 1; deeper traversal requires Tavily Map.");
  }

  const keep = (candidate) => inMapScope(candidate, host, scope);
  const conventional = [`${baseUrl}/sitemap.xml`, ...(scope ? [`${baseUrl}${scope}/sitemap.xml`] : [])];
  const [robots, page] = await Promise.all([
    fetchTextForMap(`${baseUrl}/robots.txt`, timeout),
    fetchTextForMap(url, timeout),
  ]);
  const declared = robots.ok ? robotsSitemaps(robots.text, baseUrl) : [];
  const sitemaps = await readSitemaps([...declared, ...conventional], { timeout, keep, enough: limit });
  const links = page.ok ? absoluteUrls(hrefValues(page.text), page.final_url || url) : [];

  if (!page.ok && !sitemaps.found) {
    return {
      ok: false,
      provider: "direct",
      base_url: baseUrl,
      results: [],
      error: `Direct Map failed: ${page.error}; no sitemap found`,
      warnings,
      instructions_ignored: instructionsIgnored,
    };
  }

  const results = uniqueLimited([...uniqueLimited(links.filter(keep), maxBreadth), ...sitemaps.pages.filter(keep)], limit);
  const outside = new Set([...links, ...sitemaps.pages].filter((candidate) => new URL(candidate).hostname === host && !keep(candidate)));
  if (scope && outside.size) {
    warnings.push(`Direct Map kept URLs under ${scope}; ${outside.size} other URLs on ${host} were left out. Map ${baseUrl}/ for the whole site.`);
  }
  if (page.ok && new URL(page.final_url || url).hostname !== host) {
    warnings.push(`${url} redirected to ${page.final_url}; map that URL for its pages.`);
  }
  if (!page.ok) warnings.push(`Direct Map could not read ${url}: ${page.error}`);
  if (!sitemaps.found) {
    warnings.push(`Direct Map found no sitemap (robots.txt, ${conventional.map((candidate) => new URL(candidate).pathname).join(", ")}).`);
  }
  if (sitemaps.unread) {
    warnings.push(`Direct Map read ${MAX_SITEMAP_DOCUMENTS} sitemaps and left ${sitemaps.unread} unread; the list may be incomplete.`);
  }

  return {
    ok: true,
    provider: "direct",
    base_url: baseUrl,
    results,
    response_time: null,
    warnings,
    instructions_ignored: instructionsIgnored,
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

async function readTextWithLimit(response, limitBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), exceeded: false };

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
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), exceeded };
}

function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
    hellip: "...",
  };

  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

function stripHtmlToReadableText(html) {
  const withoutComments = String(html || "").replace(/<!--[\s\S]*?-->/g, " ");
  const titleMatch = withoutComments.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ").trim()) : "";

  let body = withoutComments
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<title\b[\s\S]*?<\/title>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|blockquote|pre|tr|table|ul|ol|dl|dt|dd)>/gi, "\n")
    .replace(/<(p|div|section|article|header|footer|main|nav|aside|blockquote|pre|tr|table|ul|ol|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  body = decodeHtmlEntities(body)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (title && !body.startsWith(title)) {
    return `# ${title}\n\n${body}`.trim();
  }
  return body;
}

/**
 * Drop exact repeats of long lines, keeping the first. X status pages render the post text
 * three times (title, Open Graph copy, timeline card); no sane page repeats a 20+ char line
 * verbatim on purpose.
 */
export function collapseRepeatedLines(text, { minLength = 20 } = {}) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const key = line.trim();
    if (key.length >= minLength) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderDirectContent(text, contentType, finalUrl) {
  const type = (contentType || "").toLowerCase();
  if (type.includes("html")) {
    const readable = stripHtmlToReadableText(text);
    return isXUrl(finalUrl) ? collapseRepeatedLines(readable) : readable;
  }
  if (type.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text.trim();
    }
  }
  return text.trim();
}

// ISO timestamps put a 'T' right after the date, so the tail needs a lookahead, not \b.
const X_DATE_PATTERN = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}, \d{4}\b|\b\d{4}-\d{2}-\d{2}(?!\d)/;
// Lines the logged-out X shell adds around (or instead of) the post.
const X_BOILERPLATE_LINE =
  /^(?:Post|Log in|Sign up|Log in or sign up for X|See what[’']s happening and join the conversation|Continue with (?:phone|Apple|Google)|or|Log in with username or email|Relevant people|Trending now|Follow|Back|Search|Something went wrong\.?.*|Try again|Don[’']t miss what[’']s happening.*|People on X are the first to know\.?|Terms\b.*|©.*X Corp\.?|-|\d[\d.,]*[KM]?(?: Views)?|\d{1,2}:\d{2} [AP]M .*)$/i;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Did a Direct fetch of an X status page return the post, or only the login shell? X serves
 * server-rendered HTML to some clients and a JavaScript shell to others; the shell has the
 * chrome but neither the author's handle, the post date, nor any post text.
 */
export function validateXPostContent(content, post) {
  const text = String(content || "");
  const missing = [];
  const handle = post?.x_handle;
  if (!handle || !new RegExp(`@${escapeRegExp(handle)}(?![A-Za-z0-9_])`, "i").test(text)) missing.push("handle");
  if (!X_DATE_PATTERN.test(text)) missing.push("date");

  const body = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !X_BOILERPLATE_LINE.test(line) && !/^@[A-Za-z0-9_]{1,15}$/.test(line))
    .filter((line) => !X_DATE_PATTERN.test(line) || line.length > 40);
  if (!body.some((line) => line.length >= 20)) missing.push("text");

  return { ok: missing.length === 0, missing };
}

/**
 * Whether fetchUrl(auto) should try Direct before the paid providers for this URL. Only X
 * status pages with a handle qualify (the handle is what the validation checks). Applies
 * regardless of keys (decided 2026-09-08 after a side-by-side): Tavily returns the post
 * without its date, Firecrawl bills ~30 credits and takes 10s+, Direct is free and carries
 * the date. Callers who want the thread ask for Firecrawl explicitly.
 */
export function directFirstForX(url, config, provider = "auto") {
  if (provider !== "auto") return null;
  const post = parseXPostUrl(url);
  return post?.x_handle && post?.x_post_id ? post : null;
}

export function xDirectFirstEligible(url, config, provider = "auto") {
  return Boolean(directFirstForX(url, config, provider));
}

function directMetadata(response, contentLength) {
  return {
    status: response.status,
    content_type: response.headers.get("content-type") || null,
    content_length: contentLength,
    content_disposition: response.headers.get("content-disposition") || null,
  };
}

export async function directFetch(url, options = {}) {
  const maxBytes = options.maxBytes || DIRECT_FETCH_MAX_BYTES;
  const warnings = [];
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const finish = (value) => {
    clearTimeout(timer);
    return value;
  };

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Markdown first: sites that negotiate it (code.claude.com, platform.openai.com, sites on
        // Cloudflare's Markdown for Agents) send the page as Markdown, without navigation. 45 of
        // 153 HTML URLs on record did (2026-10-10); none that worked with the previous header
        // (text/html first) failed with this one.
        Accept: "text/markdown, text/html;q=0.9, */*;q=0.8",
        "User-Agent": "grok-search-skill/0.1",
      },
    });
    const finalUrl = response.url || url;
    const redirected = finalUrl !== url;
    const contentLength = headerNumber(response.headers, "content-length");
    const contentType = response.headers.get("content-type") || "";
    const metadata = directMetadata(response, contentLength);

    if (!response.ok) {
      const preview = await readTextWithLimit(response, DIRECT_ERROR_PREVIEW_BYTES);
      return finish({
        ok: false,
        provider: "direct",
        final_url: finalUrl,
        redirected,
        error: `HTTP ${response.status}: ${response.statusText || "请求失败"}`,
        error_preview: preview.text ? trimBody(preview.text, DIRECT_ERROR_PREVIEW_BYTES) : null,
        metadata,
        warnings,
      });
    }

    if (isLikelyAttachment(response.headers) || !isTextualContentType(contentType)) {
      return finish({
        ok: false,
        provider: "direct",
        final_url: finalUrl,
        redirected,
        error: "目标看起来是二进制或附件，未注入正文",
        error_preview: null,
        metadata,
        warnings,
      });
    }

    if (contentLength != null && contentLength > maxBytes) {
      return finish({
        ok: false,
        provider: "direct",
        final_url: finalUrl,
        redirected,
        error: `响应超过 Direct Fetch 首版上限 ${maxBytes} bytes，未下载正文`,
        error_preview: null,
        metadata,
        warnings,
      });
    }

    const body = await readTextWithLimit(response, maxBytes);
    if (body.exceeded) {
      return finish({
        ok: false,
        provider: "direct",
        final_url: finalUrl,
        redirected,
        error: `响应超过 Direct Fetch 首版上限 ${maxBytes} bytes，未注入正文`,
        error_preview: null,
        metadata: { ...metadata, content_length: null },
        warnings,
      });
    }

    const content = renderDirectContent(body.text, contentType, finalUrl);
    // HTML gets its <title> as a "# " line, so an empty page still yields text. Reddit served
    // a script-only shell on 2026-10-08 and the fetch came back as just "# Reddit".
    if (!content.replace(/^# [^\n]*\n*/, "").trim()) {
      warnings.push("Direct Fetch got no text beyond the page title; the page may need JavaScript or block automated access.");
    }

    return finish({
      ok: true,
      provider: "direct",
      content,
      final_url: finalUrl,
      redirected,
      metadata,
      warnings,
    });
  } catch (error) {
    clearTimeout(timer);
    const message = error.name === "AbortError" ? `请求超时（>${Math.round(timeoutMs / 1000)}s）` : error.message;
    return {
      ok: false,
      provider: "direct",
      error: message,
      error_preview: null,
      metadata: {},
      warnings,
    };
  }
}
