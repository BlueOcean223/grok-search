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
 * A source card from what a channel knows about a page. Every channel builds its cards here, so
 * a card has one shape wherever it came from: the URL normalized, strings trimmed, empty fields
 * left out, `snippet` the one name for descriptive text. For an X post the handle and post id
 * come from the URL. A title that is only a citation marker ("1") or the URL itself says nothing
 * about the page and is dropped; an X handle stands in as "@handle". Returns null without a URL.
 */
export function sourceCard(url, { provider, source_type, tool, opened, title, snippet, published_date, score } = {}) {
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
  const date = textField(published_date);
  if (date) card.published_date = date;
  if (Number.isFinite(score)) card.score = score;
  return card;
}

/**
 * Fill what the first record of a URL lacks from a later duplicate. A Grok citation arrives
 * as a bare URL with a marker title; the same page found by Tavily or Firecrawl has a title
 * and a snippet. Dropping the duplicate threw both away.
 */
function mergeSourceFields(existing, incoming) {
  const out = { ...existing };
  let merged = false;

  if (!usableTitle(out.title) && usableTitle(incoming.title)) {
    out.title = textField(incoming.title);
    merged = true;
  }
  if (!textField(out.snippet) && textField(incoming.snippet)) {
    out.snippet = textField(incoming.snippet);
    merged = true;
  }
  for (const key of ["published_date", "x_handle", "x_post_id"]) {
    if (!textField(out[key]) && textField(incoming[key])) {
      out[key] = textField(incoming[key]);
      merged = true;
    }
  }
  if (!Number.isFinite(out.score) && Number.isFinite(incoming.score)) {
    out.score = incoming.score;
    merged = true;
  }
  if (incoming.opened === true && out.opened !== true) {
    out.opened = true;
    merged = true;
  }

  if (merged) {
    const provider = textField(incoming.provider);
    if (provider && provider !== textField(out.provider)) {
      out.merged_from = [...new Set([...(out.merged_from || []), provider])];
    }
  }
  return out;
}

/**
 * The identity a card is deduplicated by, everywhere cards meet (Grok's own lists, the merge
 * across channels, the pages Grok opened): the normalized URL, or one key per X post whatever
 * the URL form. xAI's X search cites `/i/status/<id>`, which names no author (120 of 186
 * grok-4.6 X-search cards on record up to 2026-10-10), while the answer may link the same post
 * as `/<handle>/status/<id>`; merging the two puts the handle on one card.
 */
export function sourceKey(url) {
  const post = isXUrl(url) ? parseXPostUrl(url) : null;
  return post?.x_post_id ? `x-post:${post.x_post_id}` : normalizeSourceUrl(url);
}

/**
 * Cards merged across channels. `list_ranks` records every result list a URL was in and its
 * position there ({ grok: 3, tavily: 0 }), duplicates included, for selectSources; `merged_from`
 * only names providers that filled in a field. compactSource leaves `list_ranks` out.
 */
export function mergeSources(...sourceLists) {
  const indexByKey = new Map();
  const merged = [];
  const nextRank = new Map();

  for (const sources of sourceLists) {
    for (const item of sources || []) {
      const url = typeof item?.url === "string" ? item.url.trim() : "";
      if (!url) continue;
      const list = resultList(item);
      const rank = nextRank.get(list) ?? 0;
      nextRank.set(list, rank + 1);
      const key = sourceKey(url);
      const existingIndex = indexByKey.get(key);
      if (existingIndex == null) {
        indexByKey.set(key, merged.length);
        merged.push({ ...item, url, list_ranks: { [list]: rank } });
        continue;
      }
      const existing = merged[existingIndex];
      merged[existingIndex] = {
        ...mergeSourceFields(existing, item),
        list_ranks: { [list]: rank, ...existing.list_ranks },
      };
    }
  }

  return merged;
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

  if (Number.isFinite(source?.score)) out.score = source.score;

  const publishedDate = textField(source?.published_date);
  if (publishedDate) out.published_date = publishedDate;

  if (Array.isArray(source?.merged_from) && source.merged_from.length) out.merged_from = [...source.merged_from];

  return out;
}

export function compactSources(sources, options = {}) {
  return (sources || []).map((source) => compactSource(source, options)).filter(Boolean);
}

export function hostMatchesDomain(host, domain) {
  const h = String(host || "").toLowerCase();
  const d = String(domain || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\*\./, "");
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

function urlInDomains(url, domains) {
  if (!Array.isArray(domains) || !domains.length) return false;
  let host;
  try {
    host = new URL(trimUrl(String(url || "").trim())).hostname;
  } catch {
    return false;
  }
  return domains.some((domain) => hostMatchesDomain(host, domain));
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExtraSource(source) {
  return !textField(source?.source_type);
}

/**
 * An extra-provider result that falls outside the domain filters the caller gave Grok. The
 * providers get the same filters, so these only appear when one of them leaks; they are
 * kept but ranked last so they cannot displace in-scope candidates.
 */
export function isOffDomainExtra(source, { allowedDomains = [], excludedDomains = [] } = {}) {
  if (!isExtraSource(source)) return false;
  if (allowedDomains.length && !urlInDomains(source?.url, allowedDomains)) return true;
  if (excludedDomains.length && urlInDomains(source?.url, excludedDomains)) return true;
  return false;
}

// Reciprocal Rank Fusion constant: the value from the original paper (Cormack et al., 2009) and
// the default in Elasticsearch, OpenSearch and Azure AI Search.
const RRF_K = 60;

/** Grok's own order for its cards: cited > opened by Grok > merely listed by a search. */
function grokRank(source) {
  if (textField(source?.source_type) === "citation") return 0;
  return source?.opened === true ? 1 : 2;
}

/** The result list a source came in: Grok's, or one extra provider's. */
function resultList(source) {
  return isExtraSource(source) ? textField(source?.provider) || "extra" : "grok";
}

/**
 * Reciprocal Rank Fusion over the lists the cards came from: Grok's, in grokRank order, and each
 * extra provider's, in the order it returned them. A card scores 1 / (RRF_K + rank) in every
 * list it is in, so a URL that two channels returned rises. Membership and order come from
 * mergeSources' `list_ranks`; a card without it is in its own list, in input order.
 */
function fusionScores(sources) {
  const lists = new Map();
  sources.forEach((source, index) => {
    const ranks = source?.list_ranks ?? { [resultList(source)]: index };
    for (const [name, rank] of Object.entries(ranks)) {
      if (!lists.has(name)) lists.set(name, []);
      lists.get(name).push({ index, rank });
    }
  });
  const scores = sources.map(() => 0);
  for (const [name, members] of lists) {
    members.sort((a, b) => (name === "grok" ? grokRank(sources[a.index]) - grokRank(sources[b.index]) : 0) || a.rank - b.rank);
    members.forEach(({ index }, position) => {
      scores[index] += 1 / (RRF_K + position + 1);
    });
  }
  return scores;
}

/**
 * The visible cards, picked by fusionScores. Ranking every Grok card ahead of the extra
 * providers hid all extras in 44 of the 182 searches on record that had them (2026-10-10);
 * in 38 the answer cited 12 or more links, which filled the cards and are in the answer
 * already. Extra results outside the requested domains go last.
 */
export function selectSources(sources, { maxSources, allowedDomains = [], excludedDomains = [] } = {}) {
  const list = sources || [];
  const total = list.length;
  const limit = Number.isFinite(maxSources) && maxSources > 0 ? maxSources : total;
  const filters = { allowedDomains, excludedDomains };

  let items = list;
  if (total > limit) {
    const scores = fusionScores(list);
    items = list
      .map((source, index) => ({ source, index, offDomain: isOffDomainExtra(source, filters), score: scores[index] }))
      .sort((a, b) => a.offDomain - b.offDomain || b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.source);
  }

  return { items, total, returned: items.length, omitted: total - items.length };
}

export function buildRawSourcesPayload({
  query,
  grok = [],
  extra = [],
  providerRaw = {},
  providerAttempts = [],
  grokToolCalls = [],
  createdAt = new Date().toISOString(),
} = {}) {
  const provider_raw = {};
  for (const [provider, raw] of Object.entries(providerRaw || {})) {
    if (raw !== undefined) provider_raw[provider] = raw;
  }

  return {
    query,
    grok,
    extra,
    provider_raw,
    provider_attempts: providerAttempts || [],
    ...(grokToolCalls?.length ? { grok_tool_calls: grokToolCalls } : {}),
    created_at: createdAt,
  };
}

/** Normalize the allowed/excluded domain lists that search adapters push down. */
export function domainFilters(filters) {
  return {
    allowed: Array.isArray(filters?.allowedDomains) ? filters.allowedDomains.filter(Boolean) : [],
    excluded: Array.isArray(filters?.excludedDomains) ? filters.excludedDomains.filter(Boolean) : [],
  };
}
