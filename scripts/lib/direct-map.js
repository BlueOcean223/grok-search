/**
 * Direct Map: a site's URLs from the links on the given page and from its sitemaps, found the way
 * sitemap tools find them (robots.txt, the conventional locations, index files expanded). The
 * fallback when Tavily Map is not configured or returns nothing.
 */
import { decodeHtmlEntities, hrefValues } from "./html.js";
import { getText } from "./http.js";
import { inMapScope, mapScope } from "./map-scope.js";

const DIRECT_MAP_MAX_BYTES = 2 * 1024 * 1024;
const DIRECT_MAP_ACCEPT = "application/xml,text/xml,text/html,*/*;q=0.8";
// Direct Map fetches robots.txt, the sitemaps and the page itself; each request gets its own timeout,
// separate from --timeout, which is Tavily's remote crawl budget (150s by default). A stalled
// sitemap should not eat most of the 240s command deadline.
export const DIRECT_MAP_REQUEST_TIMEOUT_SECONDS = 30;

/** A robots.txt, sitemap or page as text, or why not. */
async function fetchTextForMap(url, timeoutSeconds) {
  const got = await getText(url, { accept: DIRECT_MAP_ACCEPT, timeoutMs: timeoutSeconds * 1000, maxBytes: DIRECT_MAP_MAX_BYTES });
  if (got.ok) return got;
  const error = got.reason === "too_large" ? `响应超过 Direct Map 首版上限 ${DIRECT_MAP_MAX_BYTES} bytes` : got.error;
  return { ok: false, status: got.status, error };
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

/**
 * Candidate URLs for a site, or for the section a URL with a path names. Like a crawler, it
 * starts from the URL it was given: the links on that page come first, then the site's sitemaps.
 * Results keep to mapScope, filtered before the limit: mapping www.compshare.cn/docs with the
 * whole sitemap on 2026-10-10 returned 200 of the site's 891 URLs, 4 under /docs and 179 under
 * /images. When the page redirects (example.com to www.example.com), the scope is where it
 * landed, as a crawler's would be; the requested host alone would filter out every link.
 */
export async function directMap(url, options = {}) {
  const warnings = [];
  const requestedOrigin = new URL(url).origin;
  const limit = options.limit || 50;
  const maxBreadth = options.maxBreadth || 20;
  const timeout = options.directTimeout || DIRECT_MAP_REQUEST_TIMEOUT_SECONDS;
  const instructionsIgnored = Boolean(options.instructions);

  if (instructionsIgnored) {
    warnings.push("Direct Map does not support instructions; ignored.");
  }
  if ((options.maxDepth || 1) > 1) {
    warnings.push("Direct Map only supports max-depth 1; deeper traversal requires Tavily Map.");
  }

  const [robots, page] = await Promise.all([
    fetchTextForMap(`${requestedOrigin}/robots.txt`, timeout),
    fetchTextForMap(url, timeout),
  ]);
  const landed = new URL(page.ok ? page.final_url || url : url);
  const baseUrl = landed.origin;
  const host = landed.hostname;
  const scope = mapScope(landed.toString());
  const keep = (candidate) => inMapScope(candidate, host, scope);
  const conventional = [`${baseUrl}/sitemap.xml`, ...(scope ? [`${baseUrl}${scope}/sitemap.xml`] : [])];
  const declared = robots.ok ? robotsSitemaps(robots.text, robots.final_url || requestedOrigin) : [];
  const sitemaps = await readSitemaps([...declared, ...conventional], { timeout, keep, enough: limit });
  const links = page.ok ? absoluteUrls(hrefValues(page.text), landed.toString()) : [];

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
  if (host !== new URL(url).hostname || scope !== mapScope(url)) {
    warnings.push(`${url} redirected to ${page.final_url}; mapped ${baseUrl}${scope || "/"} instead.`);
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
