const X_HOST_PATTERN = /^(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)$/i;
// Path segments X reserves for its own routes; none of them is a user handle.
const X_RESERVED_HANDLES = new Set([
  "i",
  "home",
  "explore",
  "notifications",
  "messages",
  "search",
  "settings",
  "compose",
  "intent",
  "hashtag",
  "share",
  "status",
  "statuses",
  "about",
  "tos",
  "privacy",
  "login",
  "logout",
  "signup",
  "download",
  "jobs",
]);

function trimUrl(value) {
  return String(value || "").replace(/[.,;:!?，。、；：！？》）】)]+$/g, "");
}

function xHandleSegment(segment) {
  const handle = String(segment || "").trim();
  if (!handle || X_RESERVED_HANDLES.has(handle.toLowerCase())) return "";
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : "";
}

/**
 * Extract the handle and post id an X citation carries in its URL. Grok returns X
 * citations as bare URLs whose title is only the inline citation marker, so the URL
 * is the sole free source of attribution.
 */
export function parseXPostUrl(url) {
  let parsed;
  try {
    parsed = new URL(trimUrl(String(url || "").trim()));
  } catch {
    return null;
  }

  if (!X_HOST_PATTERN.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const statusIndex = segments.findIndex((segment) => segment === "status" || segment === "statuses");

  if (statusIndex < 1) {
    const handle = segments.length === 1 ? xHandleSegment(segments[0]) : "";
    return handle ? { x_handle: handle } : null;
  }

  const postId = segments[statusIndex + 1];
  if (!/^\d+$/.test(postId || "")) return null;
  // Only /<handle>/status/<id> names its author. Deeper forms such as /i/web/status/<id>
  // put an internal route segment there, which must not be read as a handle.
  const handle = statusIndex === 1 ? xHandleSegment(segments[0]) : "";
  return { ...(handle ? { x_handle: handle } : {}), x_post_id: postId };
}

export function isXUrl(url) {
  try {
    return X_HOST_PATTERN.test(new URL(trimUrl(String(url || "").trim())).hostname);
  } catch {
    return false;
  }
}

export function normalizeSourceUrl(url) {
  try {
    const parsed = new URL(trimUrl(url));
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    }
    return parsed.toString();
  } catch {
    return String(url || "").trim();
  }
}

export function textField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Grok's url_citation annotations carry the inline marker ("1", "[2]") as their title. It
 * says nothing about the page, so any real title must be allowed to replace it.
 */
export function isCitationMarker(title) {
  return /^\[?\d+\]?$/.test(String(title || "").trim());
}

/** A title that says something about the page: present and not a citation marker. */
export function usableTitle(title) {
  const text = textField(title);
  return Boolean(text) && !isCitationMarker(text);
}

/**
 * A source card from what Grok's response says about a page. Every card is built here, so it has
 * one shape wherever in the response it came from: the URL normalized, strings trimmed, empty
 * fields left out, `snippet` the one name for descriptive text. For an X post the handle and post id
 * come from the URL. A title that is only a citation marker ("1") or the URL itself says nothing
 * about the page and is dropped; an X handle stands in as "@handle". Returns null without a URL.
 */
export function sourceCard(url, { provider, source_type, tool, opened, title, snippet } = {}) {
  const rawUrl = textField(url);
  if (!rawUrl) return null;
  const normalizedUrl = normalizeSourceUrl(rawUrl);
  const givenTitle = textField(title);
  const realTitle = givenTitle !== rawUrl && givenTitle !== normalizedUrl && usableTitle(givenTitle) ? givenTitle : "";
  const post = parseXPostUrl(normalizedUrl);

  const card = { provider, url: normalizedUrl };
  const sourceType = textField(source_type);
  if (sourceType) card.source_type = sourceType;
  const toolName = textField(tool);
  if (toolName) card.tool = toolName;
  if (opened === true) card.opened = true;
  if (post?.x_handle) card.x_handle = post.x_handle;
  if (post?.x_post_id) card.x_post_id = post.x_post_id;
  const cardTitle = realTitle || (post?.x_handle ? `@${post.x_handle}` : "");
  if (cardTitle) card.title = cardTitle;
  const text = textField(snippet);
  if (text) card.snippet = text;
  return card;
}

/**
 * The identity a card is deduplicated by, everywhere Grok's cards meet (its citations, its
 * search listings, the pages it opened): the normalized URL, or one key per X post whatever
 * the URL form. xAI's X search cites `/i/status/<id>`, which names no author (120 of 186
 * grok-4.6 X-search cards on record up to 2026-10-10), while the answer may link the same post
 * as `/<handle>/status/<id>`; merging the two puts the handle on one card.
 */
export function sourceKey(url) {
  const post = isXUrl(url) ? parseXPostUrl(url) : null;
  return post?.x_post_id ? `x-post:${post.x_post_id}` : normalizeSourceUrl(url);
}

function clipText(value, maxChars) {
  const text = textField(value);
  if (!text) return "";
  const limit = Number.isFinite(maxChars) ? Math.max(0, maxChars) : text.length;
  if (limit <= 0) return "";
  return text.length > limit ? text.slice(0, limit).trimEnd() : text;
}

export function compactSource(source, { sourceChars = 400 } = {}) {
  const url = typeof source?.url === "string" ? trimUrl(source.url.trim()) : "";
  if (!url) return null;

  const out = {
    provider: textField(source.provider) || "unknown",
    url,
  };

  const title = textField(source.title);
  if (title) out.title = title;

  const sourceType = textField(source?.source_type);
  if (sourceType) out.source_type = sourceType;

  if (source?.opened === true) out.opened = true;

  const tool = textField(source?.tool);
  if (tool) out.tool = tool;

  const xHandle = textField(source?.x_handle);
  if (xHandle) out.x_handle = xHandle;

  const xPostId = textField(source?.x_post_id);
  if (xPostId) out.x_post_id = xPostId;

  const snippet = clipText(source?.snippet, sourceChars);
  if (snippet) out.snippet = snippet;

  return out;
}

export function compactSources(sources, options = {}) {
  return (sources || []).map((source) => compactSource(source, options)).filter(Boolean);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Grok's own order for its cards: cited > opened by Grok > merely listed by a search. */
function grokRank(source) {
  if (textField(source?.source_type) === "citation") return 0;
  return source?.opened === true ? 1 : 2;
}

/**
 * The visible cards: when there are more than `maxSources`, the best by grokRank (input order
 * breaks ties), printed in input order.
 */
export function selectSources(sources, { maxSources } = {}) {
  const list = sources || [];
  const total = list.length;
  const limit = Number.isFinite(maxSources) && maxSources > 0 ? maxSources : total;

  let items = list;
  if (total > limit) {
    items = list
      .map((source, index) => ({ source, index, rank: grokRank(source) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.source);
  }

  return { items, total, returned: items.length, omitted: total - items.length };
}

/** What `--full-sources` attaches as sources.raw: every Grok source and tool call. */
export function buildRawSourcesPayload({ query, grok = [], providerAttempts = [], grokToolCalls = [], createdAt = new Date().toISOString() } = {}) {
  return {
    query,
    grok,
    provider_attempts: providerAttempts || [],
    ...(grokToolCalls?.length ? { grok_tool_calls: grokToolCalls } : {}),
    created_at: createdAt,
  };
}
