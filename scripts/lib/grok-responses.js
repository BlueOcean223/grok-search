import { authHeaders, isPlainObject, requestJson } from "./http.js";
import { usesWebSearch, usesXSearch } from "./config.js";
import { getLocalTimeContext, platformPrompt } from "./context.js";
import { ANSWER_MARKER_PATTERN, SEARCH_BUDGET_TOTAL, SEARCH_BUDGET_X, searchPrompt, xSearchPrompt } from "./prompts.js";
import { isXUrl, sourceCard, sourceKey, textField, usableTitle } from "./sources.js";
import { numericField, usageDiagnostics } from "./usage.js";

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function responsesEndpoint(config) {
  return `${config.grokApiUrl.replace(/\/+$/, "")}/responses`;
}

/**
 * The query doubles as the keywords Tavily/Firecrawl search for, so it should stay short.
 * Anything the caller wants from Grok beyond "search this" (what to return, in which
 * language, what not to do) travels here, appended to the user message so the system
 * prompt prefix stays cacheable.
 */
function instructionsPrompt(instructions) {
  const text = textField(instructions);
  return text ? `\n\n# Instructions from the caller\n${text}\n` : "";
}

/**
 * Without instructions the query is the last thing in the message and reads as the request.
 * With instructions a short query sits between the time block and a "# Instructions" header
 * and the model can take it for a stray context line ("No topic was specified", seen live
 * 2026-09-08 with the query "Grok 4.6 coding agent"), so it gets a header of its own.
 */
function queryPrompt(query, instructions) {
  return textField(instructions) ? `\n# Search query\n${query}` : query;
}

function inputMessages(query, options) {
  const messages = [{ role: "system", content: searchPrompt }];
  // Appended rather than merged so the base prompt remains a stable cache prefix.
  if (usesXSearch(options.searchSource)) messages.push({ role: "system", content: xSearchPrompt });
  messages.push({
    role: "user",
    content:
      getLocalTimeContext() + queryPrompt(query, options.instructions) + platformPrompt(options.platform) + instructionsPrompt(options.instructions),
  });
  return messages;
}

function directWebSearchTool(options) {
  const tool = { type: "web_search" };
  const filters = {};
  if (options.allowedDomains.length) filters.allowed_domains = options.allowedDomains;
  if (options.excludedDomains.length) filters.excluded_domains = options.excludedDomains;
  if (Object.keys(filters).length) tool.filters = filters;
  return tool;
}

function xSearchFilters(options) {
  const filters = {};
  if (options.allowedXHandles.length) filters.allowed_x_handles = options.allowedXHandles;
  if (options.excludedXHandles.length) filters.excluded_x_handles = options.excludedXHandles;
  if (options.xFromDate) filters.from_date = options.xFromDate;
  if (options.xToDate) filters.to_date = options.xToDate;
  if (options.xImageUnderstanding) filters.enable_image_understanding = true;
  if (options.xVideoUnderstanding) filters.enable_video_understanding = true;
  return filters;
}

function buildDirectResponsesBody(query, options) {
  const tools = [];
  if (usesWebSearch(options.searchSource)) tools.push(directWebSearchTool(options));
  if (usesXSearch(options.searchSource)) tools.push({ type: "x_search", ...xSearchFilters(options) });
  // Mounting no tool at all silently turns a search into a from-memory answer, so treat
  // an unrecognized source as a programming error rather than shipping an empty request.
  if (!tools.length) {
    const error = new Error(`未知的 search source: ${JSON.stringify(options.searchSource)}`);
    error.code = "SEARCH_SOURCE_INVALID";
    throw error;
  }

  const body = {
    model: options.model,
    input: inputMessages(query, options),
    tools,
    max_turns: options.maxTurns,
    stream: false,
  };

  // Only sent when the caller decided; relays that honor it cut X search calls sharply
  // (12 -> 3 in the 2026-09-08 test), relays that do not echo it back unchanged.
  if (typeof options.parallelToolCalls === "boolean") body.parallel_tool_calls = options.parallelToolCalls;

  const fixedReasoning420 = /^grok-4\.20(?!.*multi-agent)/i.test(options.model);
  if (options.reasoningEffort && !/non-reasoning/i.test(options.model) && !fixedReasoning420) {
    body.reasoning = {
      effort: options.reasoningEffort,
      summary: "concise",
    };
  }

  return body;
}

function buildOpenRouterResponsesBody(query, options) {
  const parameters = {
    engine: options.openRouterEngine,
    max_results: 5,
    max_total_results: 10,
  };
  if (options.allowedDomains.length) parameters.allowed_domains = options.allowedDomains;
  if (options.excludedDomains.length) parameters.excluded_domains = options.excludedDomains;

  const body = {
    model: options.model,
    input: inputMessages(query, options),
    tools: [{ type: "openrouter:web_search", parameters }],
    stream: false,
  };

  // OpenRouter attaches x_search to native search on its own for xAI models; the only
  // control it exposes is this top-level filter, so "x"/"web" cannot be enforced here.
  if (usesXSearch(options.searchSource)) body.x_search_filter = xSearchFilters(options);
  if (typeof options.parallelToolCalls === "boolean") body.parallel_tool_calls = options.parallelToolCalls;

  return body;
}

export function buildResponsesBody(query, options, config) {
  if (config.apiProvider === "openrouter") return buildOpenRouterResponsesBody(query, options);
  return buildDirectResponsesBody(query, options);
}

function outputItems(data) {
  return Array.isArray(data?.output) ? data.output : [];
}

function contentItems(item) {
  const content = item?.content ?? item?.message?.content ?? item?.output?.content;
  return asArray(content);
}

function outputTextFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!isPlainObject(content)) return "";
  if (["output_text", "text", "message_text"].includes(content.type) && typeof content.text === "string") {
    return content.text.trim();
  }
  if (typeof content.text === "string") return content.text.trim();
  if (typeof content.content === "string") return content.content.trim();
  return "";
}

const NARRATION_MAX_CHARS = 300;

/**
 * When an answer carries no inline citation, xAI attaches every page its searches returned
 * as url_citation annotations with a zero span at offset 0 and the URL as the title (seen on
 * api.x.ai and two relays, 2026-10-10). That is a search listing, not a citation: grok-4.7
 * seldom cites inline, so it lists 20–90 pages this way on nearly every answer.
 */
function isSourceListing(annotation) {
  if (annotation?.start_index !== 0 || annotation?.end_index !== 0) return false;
  const title = titleFromObject(annotation);
  return !title || title === urlFromObject(annotation);
}

// xAI's markup for rendering a citation sometimes leaks into the answer text, either between
// private-use delimiters ("\ue200render_inline_citation speecheo_citation_id="10"\ue201",
// grok-4.6, 2026-10-08) or bare after a link (` show render_inline_citation with
// citation_id="2"`, grok-4.6-build, 2026-09-17). Neither carries anything for a reader.
const RENDER_MARKUP =
  /[ \t]*(?:\ue200[^\ue200\ue201]*\ue201|\bshow render_inline_citation with citation_id="\d+"|\brender_inline_citation (?:\w+_)?citation_id="\d+")/g;

function stripRenderMarkup(text) {
  return text.replace(RENDER_MARKUP, "").trim();
}

function extractResponsesText(data) {
  const directText = textField(data?.output_text);
  if (directText) return stripRenderMarkup(directText);

  const messages = [];
  for (const item of outputItems(data)) {
    if (item?.type && item.type !== "message" && !item.message && !item.content) continue;
    const parts = [];
    let annotations = 0;
    for (const content of contentItems(item)) {
      const text = outputTextFromContent(content);
      if (text) parts.push(text);
      annotations += Array.isArray(content?.annotations) ? content.annotations.filter((a) => !isSourceListing(a)).length : 0;
    }
    if (parts.length) messages.push({ text: parts.join("\n\n"), annotations });
  }

  // Between tool calls the model narrates ("I'll search X for…", "Opening the changelog…"),
  // and some relays return every such message. The answer is the last message; an earlier
  // one is kept only when it is substantial or carries citations.
  const texts = messages
    .filter((message, index) => index === messages.length - 1 || message.annotations > 0 || message.text.length >= NARRATION_MAX_CHARS)
    .map((message) => message.text);

  if (!texts.length && Array.isArray(data?.choices)) {
    for (const choice of data.choices) {
      const text = textField(choice?.message?.content) || textField(choice?.text);
      if (text) texts.push(text);
    }
  }

  return stripRenderMarkup(texts.join("\n\n"));
}

/**
 * The text after the last ANSWER_MARKER, and what came before it. Narration between tool calls
 * ("我先检索…", "I'll look up…") opened the answer in 18 of 82 searches from 2026-10-02 to 10-10
 * (grok-4.6, grok-4.6-build and grok-4.7 through the relay); the raw responses on record had it
 * glued to the answer in a single text part, out of reach of the message filter above. grok-4.7
 * opened its answer with the marker in 9 of 9 test runs on 2026-10-10. Without a marker the
 * text is kept whole and `preamble` is null. Spacing and case may vary ("<!--answer-->"); a
 * marker matched only exactly would stay in the text with the narration before it.
 */
function splitAtAnswerMarker(text) {
  const last = [...text.matchAll(ANSWER_MARKER_PATTERN)].at(-1);
  if (!last) return { text, preamble: null };
  const answer = text.slice(last.index + last[0].length).trim();
  // A marker at the very end leaves nothing after it; keep everything but the markers then.
  if (!answer) return { text: text.replace(ANSWER_MARKER_PATTERN, "").trim(), preamble: "" };
  return { text: answer, preamble: text.slice(0, last.index).trim() };
}

function collectAnnotations(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectAnnotations(item, out);
    return out;
  }

  if (!isPlainObject(value)) return out;
  if (Array.isArray(value.annotations)) out.push(...value.annotations);

  for (const [key, nested] of Object.entries(value)) {
    if (key === "annotations") continue;
    if (nested && typeof nested === "object") collectAnnotations(nested, out);
  }

  return out;
}

function urlFromObject(value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
  if (!isPlainObject(value)) return "";
  return (
    textField(value.url) ||
    textField(value.href) ||
    textField(value.link) ||
    textField(value.uri) ||
    textField(value?.source?.url) ||
    textField(value?.citation?.url) ||
    textField(value?.url_citation?.url)
  );
}

function titleFromObject(value) {
  if (!isPlainObject(value)) return "";
  return (
    textField(value.title) ||
    textField(value.name) ||
    textField(value.label) ||
    textField(value?.source?.title) ||
    textField(value?.citation?.title) ||
    textField(value?.url_citation?.title)
  );
}

function snippetFromObject(value) {
  if (!isPlainObject(value)) return "";
  return (
    textField(value.snippet) ||
    textField(value.description) ||
    textField(value.content) ||
    textField(value.text) ||
    textField(value.summary) ||
    textField(value?.source?.snippet) ||
    textField(value?.citation?.snippet) ||
    textField(value?.url_citation?.snippet)
  );
}

function sourceFromValue(value, { sourceType, tool }) {
  const url = urlFromObject(value);
  if (!url) return null;
  return sourceCard(url, {
    provider: "grok-responses",
    source_type: sourceType,
    tool,
    title: titleFromObject(value),
    snippet: snippetFromObject(value),
  });
}

function citationTool(value, defaultTool, xEnabled) {
  // Citations are not tagged with the tool that produced them. When x_search is mounted
  // an X link almost certainly came from it; when it is not, web search indexes x.com
  // pages too, so claiming x_search there would report a search that never ran.
  if (xEnabled && isXUrl(urlFromObject(value))) return "x_search";
  return defaultTool;
}

// Some relays pass xAI's x_search through as its underlying tools: custom_tool_call items
// named x_keyword_search, x_semantic_search, x_thread_fetch, x_user_search, with the arguments
// in a JSON string. They are x_search calls for counting and attribution.
const X_CUSTOM_TOOL = /^x_[a-z_]+$/i;

function customXToolName(item) {
  const name = textField(item?.name);
  return textField(item?.type) === "custom_tool_call" && X_CUSTOM_TOOL.test(name) ? name : "";
}

function customToolInput(item) {
  const raw = item?.input ?? item?.arguments;
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolFromCall(item, defaultTool) {
  if (customXToolName(item)) return "x_search";
  const raw = textField(item?.tool) || textField(item?.name) || textField(item?.type) || defaultTool;
  if (raw.endsWith("_call")) return raw.slice(0, -"_call".length);
  return raw;
}

function sourceArraysFromToolCall(item) {
  return [
    item?.action?.sources,
    item?.action?.results,
    item?.action?.search_results,
    item?.action?.web_results,
    item?.sources,
    item?.results,
    item?.search_results,
    item?.output?.sources,
    item?.output?.results,
  ].filter(Array.isArray);
}

function isSearchToolCall(item) {
  if (customXToolName(item)) return true;
  const type = textField(item?.type);
  const name = textField(item?.name) || textField(item?.tool);
  return /search/i.test(type) || /search/i.test(name);
}

function extractSearchedSources(data, defaultTool) {
  const sources = [];
  const toolCalls = [];
  // URLs Grok actually opened (action.type "open_page"), keyed by sourceKey.
  const openedUrls = new Map();
  let webSearchCalls = 0;
  let xSearchCalls = 0;

  for (const item of outputItems(data)) {
    if (!isSearchToolCall(item)) continue;
    const tool = toolFromCall(item, defaultTool);
    // A failed call (open_page on a dead or guessed URL, find_in_page on a page that did not
    // load) read nothing and is left out of the billed usage, so it neither counts nor marks
    // a page opened. It stays in toolCalls with its status for the `failed` summary.
    const status = textField(item?.status);
    const failed = Boolean(status) && status !== "completed";
    if (!failed) {
      if (tool.includes("x_search")) xSearchCalls += 1;
      else if (tool.includes("web_search") || tool.includes("openrouter:web_search")) webSearchCalls += 1;
    }

    const customName = customXToolName(item);
    const customInput = customName ? customToolInput(item) : {};
    // x_keyword_search -> keyword_search, x_thread_fetch -> thread_fetch, so by_action reads
    // like the web side (search / open_page / find_in_page).
    const actionType = textField(item?.action?.type) || (customName ? customName.replace(/^x_/i, "") : "");
    const actionUrl = textField(item?.action?.url) || textField(customInput.url);
    const actionQuery = textField(item?.action?.query) || textField(customInput.query);
    if (!failed && actionType === "open_page" && /^https?:\/\//i.test(actionUrl)) {
      const key = sourceKey(actionUrl);
      if (!openedUrls.has(key)) openedUrls.set(key, tool);
    }

    let sourceCount = 0;
    for (const sourceArray of sourceArraysFromToolCall(item)) {
      for (const value of sourceArray) {
        const source = sourceFromValue(value, { sourceType: "searched", tool });
        if (!source) continue;
        sources.push(source);
        sourceCount += 1;
      }
    }

    toolCalls.push({
      tool,
      ...(textField(item?.type) ? { type: textField(item.type) } : {}),
      ...(status ? { status } : {}),
      ...(actionType ? { action_type: actionType } : {}),
      ...(actionQuery ? { query: actionQuery } : {}),
      ...(actionUrl ? { url: actionUrl } : {}),
      ...(textField(customInput.post_id) ? { post_id: textField(customInput.post_id) } : {}),
      // Some relays attach the run's cumulative source list to every call item, so this is
      // not "results of this query"; it is kept for raw-file consumers only.
      source_count: sourceCount,
    });
  }

  return { sources, toolCalls, openedUrls, webSearchCalls, xSearchCalls };
}

/** Inline citations, plus the source listing that comes as annotations but is not one. */
function extractAnnotationSources(data, defaultTool, xEnabled) {
  const citations = [];
  const listed = [];
  for (const annotation of collectAnnotations(data)) {
    const tool = citationTool(annotation, defaultTool, xEnabled);
    const listing = isSourceListing(annotation);
    const source = sourceFromValue(annotation, { sourceType: listing ? "searched" : "citation", tool });
    if (source) (listing ? listed : citations).push(source);
  }

  for (const citation of asArray(data?.citations)) {
    const tool = citationTool(citation, defaultTool, xEnabled);
    const source = sourceFromValue(citation, { sourceType: "citation", tool });
    if (source) citations.push(source);
  }

  return { citations, listed };
}

// A Markdown link, whose label may itself hold brackets (Grok renders an inline citation as
// "[[1]](url)") and whose URL may hold one level of parentheses; or a bare URL.
const TEXT_LINK =
  /\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|(https?:\/\/[^\s<>()[\]{}"'`，。、；：！？《》（）【】「」]+)/g;
// Labels that only number the link, like the "web:58" grok-4.7 sometimes writes.
const NUMBERED_LABEL = /^[a-z]+:\d+$/i;

/**
 * Links the answer itself carries, in reading order. grok-4.7 seldom uses inline citations and
 * writes Markdown links or bare URLs instead, so its citations exist only in the text. URLs in
 * code are skipped: they are endpoints or base URLs the answer reports, not sources.
 */
function extractTextLinkSources(text, defaultTool, xEnabled) {
  const prose = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  const sources = [];
  for (const match of prose.matchAll(TEXT_LINK)) {
    const url = match[2] || match[3];
    const label = (match[1] || "").replace(/[*`]/g, "").trim();
    const title = NUMBERED_LABEL.test(label) ? "" : label;
    const source = sourceFromValue(
      { url, ...(title ? { title } : {}) },
      { sourceType: "citation", tool: citationTool({ url }, defaultTool, xEnabled) }
    );
    if (source) sources.push(source);
  }
  return sources;
}

/**
 * One card per page (sourceKey: one per X post whatever the URL form). The citation identity
 * wins, but a marker title ("1") is a placeholder, not a title, so a real one from the search
 * listing replaces it, and an X handle only the other URL form named is kept.
 */
function dedupeResponsesSources(citationSources, searchedSources) {
  const out = [];
  const indexByKey = new Map();

  for (const source of [...citationSources, ...searchedSources]) {
    const key = sourceKey(source.url);
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, out.length);
      out.push(source);
      continue;
    }

    const existing = out[existingIndex];
    if (existing.source_type !== "citation" && source.source_type === "citation") {
      const title = usableTitle(source.title) ? source.title : existing.title;
      out[existingIndex] = { ...existing, ...source, ...(title ? { title } : {}) };
      continue;
    }

    if (!usableTitle(existing.title) && usableTitle(source.title)) existing.title = source.title;
    if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
    if (!existing.x_handle && source.x_handle) existing.x_handle = source.x_handle;
  }

  return out;
}

/**
 * "searched" only means a search listed the URL. Grok opening the page is a stronger signal,
 * and the trace records it, so mark those cards and add opened pages the listings missed.
 */
function markOpenedSources(sources, openedUrls) {
  const remaining = new Map(openedUrls);
  for (const source of sources) {
    const key = sourceKey(source.url);
    if (!remaining.has(key)) continue;
    source.opened = true;
    remaining.delete(key);
  }
  for (const [url, tool] of remaining) {
    const source = sourceFromValue({ url }, { sourceType: "searched", tool });
    if (source) sources.push({ ...source, opened: true });
  }
  return sources;
}

/**
 * Billing-grade tool counts. Some relays bill server-side tool calls without emitting
 * the matching `*_call` items in `output[]`, so `usage` carries counts the output array
 * misses. Others do the reverse and report the field zeroed out, so take whichever
 * source saw more calls per tool rather than letting either one alone win.
 */
function usageToolCounts(data) {
  const details = data?.usage?.server_side_tool_usage_details;
  if (!isPlainObject(details)) return null;
  const webSearchCalls = numericField(details.web_search_calls);
  const xSearchCalls = numericField(details.x_search_calls);
  if (webSearchCalls == null && xSearchCalls == null) return null;
  return { webSearchCalls: webSearchCalls ?? 0, xSearchCalls: xSearchCalls ?? 0 };
}

export function parseGrokResponses(data, { defaultTool = "web_search", xEnabled = false, requestedModel = "" } = {}) {
  const warnings = [];
  const { text, preamble } = splitAtAnswerMarker(extractResponsesText(data));
  // Relays substitute models silently: one served grok-4.5-build for every grok-4.5 request
  // (2026-09-08), at two to three times the tool calls and cost. Say so when it happens.
  const servedModel = textField(data?.model);
  if (requestedModel && servedModel && servedModel !== requestedModel) {
    warnings.push(`Relay served model "${servedModel}" for requested "${requestedModel}".`);
  }
  if (!text) warnings.push("Responses returned no output text.");
  if (!outputItems(data).length && !textField(data?.output_text)) warnings.push("Responses output array is missing or empty.");

  const annotated = extractAnnotationSources(data, defaultTool, xEnabled);
  const textLinks = extractTextLinkSources(text, defaultTool, xEnabled);
  const searched = extractSearchedSources(data, defaultTool);
  const sources = markOpenedSources(
    dedupeResponsesSources([...annotated.citations, ...textLinks], [...searched.sources, ...annotated.listed]),
    searched.openedUrls
  );
  const usageCounts = usageToolCounts(data);
  const counts = {
    webSearchCalls: Math.max(usageCounts?.webSearchCalls ?? 0, searched.webSearchCalls),
    xSearchCalls: Math.max(usageCounts?.xSearchCalls ?? 0, searched.xSearchCalls),
  };

  return {
    text,
    preamble,
    sources,
    diagnostics: {
      ...usageDiagnostics(data),
      ...(servedModel ? { responses_model: servedModel } : {}),
      responses_web_search_calls: counts.webSearchCalls,
      responses_x_search_calls: counts.xSearchCalls,
      responses_tool_calls: searched.toolCalls,
      responses_tool_call_total: counts.webSearchCalls + counts.xSearchCalls,
      // Both raw tallies, so a consumer can see which side under-reported.
      responses_tool_call_counts: {
        upstream: usageCounts ? { web: usageCounts.webSearchCalls, x: usageCounts.xSearchCalls } : null,
        trace: { web: searched.webSearchCalls, x: searched.xSearchCalls },
      },
      warnings,
    },
  };
}

/**
 * `total` is the billing-grade figure (the larger of usage and trace per tool). The two raw
 * tallies stay visible because relays under-report on either side, and the per-action split
 * says how many of those calls were searches versus page opens.
 */
function summarizeToolCalls(toolCalls, total, counts) {
  const failed = toolCalls.filter((call) => call.status && call.status !== "completed");
  // Failed calls are listed under `failed` only, as the trace count leaves them out too.
  const byAction = {};
  for (const call of toolCalls) {
    if (failed.includes(call)) continue;
    const action = call.action_type || "other";
    byAction[action] = (byAction[action] || 0) + 1;
  }
  return {
    total,
    upstream: counts?.upstream ?? null,
    trace: counts?.trace ?? { web: 0, x: 0 },
    by_action: byAction,
    ...(failed.length ? { failed } : {}),
  };
}

// Calls that read a page rather than search. The prompt budgets searches and expects pages to
// be opened besides ("one focused search and one authoritative page").
const PAGE_ACTIONS = new Set(["open_page", "find_in_page", "thread_fetch"]);

/**
 * The prompts ask for about SEARCH_BUDGET_TOTAL searches (SEARCH_BUDGET_X of them on X).
 * That is advice, not a cap: max_turns bounds agentic turns and a turn can hold several
 * calls, so `enforced` stays false until a provider-side limit is wired in.
 *
 * `used_*` are billed calls, page reads included. `used_searches` / `used_x_searches` count
 * searches only, and `exceeded` compares those with the budget; billed calls the trace does
 * not show count as searches, since nothing says what they were. Counting page reads had
 * marked 47 of 199 runs (2026-09-14 to 10-10) as over budget when their searches were not.
 */
function searchBudget(searchSource, diagnostics, toolCalls) {
  const usedWeb = diagnostics.responses_web_search_calls ?? 0;
  const usedX = diagnostics.responses_x_search_calls ?? 0;
  const promptX = usesXSearch(searchSource) ? SEARCH_BUDGET_X : 0;
  const completed = toolCalls.filter((call) => !call.status || call.status === "completed");
  const isX = (call) => String(call.tool || "").includes("x_search");
  const searchesIn = (calls, billed) =>
    calls.filter((call) => !PAGE_ACTIONS.has(call.action_type)).length + Math.max(0, billed - calls.length);
  const xSearches = searchesIn(completed.filter(isX), usedX);
  const searches = searchesIn(completed.filter((call) => !isX(call)), usedWeb) + xSearches;
  return {
    prompt_total: SEARCH_BUDGET_TOTAL,
    prompt_x: promptX,
    used_web: usedWeb,
    used_x: usedX,
    used_total: usedWeb + usedX,
    used_searches: searches,
    used_x_searches: xSearches,
    exceeded: searches > SEARCH_BUDGET_TOTAL || xSearches > promptX,
    enforced: false,
  };
}

/**
 * A search result from a Responses body: the answer, its sources, and diagnostics in their final
 * shape, with the tool calls summarized and the search budget beside the counts. The raw tool
 * calls come back as `tool_calls` for the run record. Throws GROK_RESPONSES_EMPTY, the same
 * diagnostics attached, when the body carries no answer text.
 */
/**
 * Why an X search came back empty, when its filters explain it. `x_posts_fetched` (xAI usage)
 * counts the posts the searches read; zero under a date window or a handle list usually means
 * the accounts posted nothing there: @nodejs's last post was 2026-08-27, and --x-from-date
 * 2026-09-01 read nothing on 2026-10-11, which looked like a broken search.
 */
function xFilterWarnings(options, diagnostics) {
  const details = diagnostics.usage?.server_side_tool_usage_details;
  if (!isPlainObject(details) || numericField(details.x_posts_fetched) !== 0 || !numericField(details.x_search_calls)) return [];
  const filters = [
    ...(options.xFromDate ? [`--x-from-date ${options.xFromDate}`] : []),
    ...(options.xToDate ? [`--x-to-date ${options.xToDate}`] : []),
    ...(options.allowedXHandles?.length ? [`--responses-allowed-x-handles ${options.allowedXHandles.join(",")}`] : []),
  ];
  if (!filters.length) return [];
  return [`X search read no posts under ${filters.join(" ")}; the accounts may have nothing there. Widen the dates or drop the handle filter and retry.`];
}

export function grokSearchResult(data, options, config, { requests = 1 } = {}) {
  const defaultTool =
    config.apiProvider === "openrouter" ? "openrouter:web_search" : options.searchSource === "x" ? "x_search" : "web_search";
  // OpenRouter attaches x_search to native search for xAI models whatever we asked for.
  const xEnabled = usesXSearch(options.searchSource) || config.apiProvider === "openrouter";
  const parsed = parseGrokResponses(data, { defaultTool, xEnabled, requestedModel: options.model });
  const {
    responses_tool_calls: toolCalls,
    responses_tool_call_total: total,
    responses_tool_call_counts: counts,
    warnings: parsedWarnings,
    ...rest
  } = parsed.diagnostics;
  const warnings = [...parsedWarnings, ...xFilterWarnings(options, rest)];
  const diagnostics = {
    ...rest,
    responses_tool_calls: summarizeToolCalls(toolCalls, total, counts),
    search_budget: searchBudget(options.searchSource, rest, toolCalls),
  };
  if (!parsed.text.trim()) {
    const error = new Error("Grok Responses 返回空内容");
    error.code = "GROK_RESPONSES_EMPTY";
    error.diagnostics = { ...diagnostics, warnings };
    error.requests = requests;
    throw error;
  }

  return {
    model: options.model,
    content: parsed.text,
    preamble: parsed.preamble,
    sources: parsed.sources,
    endpoint: "responses",
    diagnostics,
    warnings,
    tool_calls: toolCalls,
    requests,
    raw: data,
  };
}

export async function searchGrokResponses(query, options, config) {
  const endpoint = responsesEndpoint(config);
  const body = buildResponsesBody(query, options, config);
  // Retries are otherwise invisible in the output; count the requests that went out.
  const stats = { requests: 0 };
  let data;
  try {
    data = await requestJson(endpoint, {
      headers: authHeaders(config.grokApiKey),
      body,
      timeoutMs: 180_000,
      config,
      retry: true,
      retryOnTimeout: false,
      stats,
    });
  } catch (error) {
    error.requests = stats.requests;
    throw error;
  }
  return grokSearchResult(data, options, config, { requests: stats.requests });
}
