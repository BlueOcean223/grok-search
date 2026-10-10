/**
 * The part of a site a map covers. Both map providers keep to it: Direct Map filters what it
 * finds, Tavily Map gets it as `select_paths`.
 */
import { escapeRegExp } from "./sources.js";

/**
 * The path a map stays under: "/docs" for ".../docs" and ".../docs/", "" for the site root. Both
 * map providers keep to it, the scope Firecrawl's crawl uses by default ("crawl ignores sublinks
 * that are not children of the URL you provide"). A URL that names a file (".../docs/index.html")
 * maps its directory: nothing is under a file, and the old whole-site map returned that section.
 * An extension needs a letter, so a version segment such as "v1.2" stays a directory.
 */
export function mapScope(url) {
  const path = new URL(url).pathname;
  const directory = /\/[^/]*\.[a-z][a-z0-9]{0,7}$/i.test(path) ? path.replace(/\/[^/]*$/, "") : path;
  return directory.replace(/\/+$/, "");
}

/** On `host`, at or under the `scope` path. */
export function inMapScope(candidate, host, scope) {
  const parsed = new URL(candidate);
  if (parsed.hostname !== host) return false;
  const path = parsed.pathname.replace(/\/+$/, "");
  return !scope || path === scope || path.startsWith(`${scope}/`);
}

/** The `select_paths` pattern for Tavily Map: paths at or under `scope`. */
export function scopePattern(scope) {
  return `^${escapeRegExp(scope)}(/.*)?$`;
}
