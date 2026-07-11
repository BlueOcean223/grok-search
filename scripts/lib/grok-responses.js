import { authHeaders, requestJson } from "./providers.js";
import { getLocalTimeContext, platformPrompt } from "./context.js";
import { searchPrompt } from "./prompts.js";
import { normalizeSourceUrl } from "./sources.js";
import { usageDiagnostics } from "./usage.js";

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function textField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function responsesEndpoint(config) {
  return `${config.grokApiUrl.replace(/\/+$/, "")}/responses`;
}

function inputMessages(query, platform) {
  return [
    { role: "system", content: searchPrompt },
    { role: "user", content: getLocalTimeContext() + query + platformPrompt(platform) },
  ];
}

function directWebSearchTool(options) {
  const tool = { type: "web_search" };
  const filters = {};
  if (options.allowedDomains.length) filters.allowed_domains = options.allowedDomains;
  if (options.excludedDomains.length) filters.excluded_domains = options.excludedDomains;
  if (Object.keys(filters).length) tool.filters = filters;
  return tool;
}

function directXSearchTool(options) {
  const tool = { type: "x_search" };
  if (options.allowedXHandles.length) tool.allowed_x_handles = options.allowedXHandles;
  if (options.excludedXHandles.length) tool.excluded_x_handles = options.excludedXHandles;
  return tool;
}

function buildDirectResponsesBody(query, options) {
  const tools = [directWebSearchTool(options)];
  if (options.includeXSearch) tools.push(directXSearchTool(options));

  const body = {
    model: options.model,
    input: inputMessages(query, options.platform),
    tools,
    max_turns: options.maxTurns,
    stream: false,
  };

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
    input: inputMessages(query, options.platform),
    tools: [{ type: "openrouter:web_search", parameters }],
    stream: false,
  };

  if (options.includeXSearch) {
    const xSearchFilter = {};
    if (options.allowedXHandles.length) xSearchFilter.allowed_x_handles = options.allowedXHandles;
    if (options.excludedXHandles.length) xSearchFilter.excluded_x_handles = options.excludedXHandles;
    body.x_search_filter = xSearchFilter;
  }

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

function extractResponsesText(data) {
  const directText = textField(data?.output_text);
  if (directText) return directText;

  const texts = [];
  for (const item of outputItems(data)) {
    if (item?.type && item.type !== "message" && !item.message && !item.content) continue;
    for (const content of contentItems(item)) {
      const text = outputTextFromContent(content);
      if (text) texts.push(text);
    }
  }

  if (!texts.length && Array.isArray(data?.choices)) {
    for (const choice of data.choices) {
      const text = textField(choice?.message?.content) || textField(choice?.text);
      if (text) texts.push(text);
    }
  }

  return texts.join("\n\n").trim();
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
  return {
    provider: "grok-responses",
    source_type: sourceType,
    tool,
    url: normalizeSourceUrl(url),
    ...(titleFromObject(value) ? { title: titleFromObject(value) } : {}),
    ...(snippetFromObject(value) ? { snippet: snippetFromObject(value) } : {}),
  };
}

function citationTool(value, defaultTool) {
  const url = urlFromObject(value);
  if (defaultTool === "web_search" && /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(url)) {
    return "x_search";
  }
  return defaultTool;
}

function toolFromCall(item, defaultTool) {
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
  const type = textField(item?.type);
  const name = textField(item?.name) || textField(item?.tool);
  return /search/i.test(type) || /search/i.test(name);
}

function extractSearchedSources(data, defaultTool) {
  const sources = [];
  const toolCalls = [];
  let webSearchCalls = 0;
  let xSearchCalls = 0;

  for (const item of outputItems(data)) {
    if (!isSearchToolCall(item)) continue;
    const tool = toolFromCall(item, defaultTool);
    if (tool.includes("x_search")) xSearchCalls += 1;
    else if (tool.includes("web_search") || tool.includes("openrouter:web_search")) webSearchCalls += 1;

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
      ...(textField(item?.status) ? { status: textField(item.status) } : {}),
      ...(textField(item?.action?.type) ? { action_type: textField(item.action.type) } : {}),
      ...(textField(item?.action?.query) ? { query: textField(item.action.query) } : {}),
      ...(textField(item?.action?.url) ? { url: textField(item.action.url) } : {}),
      source_count: sourceCount,
    });
  }

  return { sources, toolCalls, webSearchCalls, xSearchCalls };
}

function extractCitationSources(data, defaultTool) {
  const sources = [];
  for (const annotation of collectAnnotations(data)) {
    const source = sourceFromValue(annotation, { sourceType: "citation", tool: citationTool(annotation, defaultTool) });
    if (source) sources.push(source);
  }

  for (const citation of asArray(data?.citations)) {
    const source = sourceFromValue(citation, { sourceType: "citation", tool: citationTool(citation, defaultTool) });
    if (source) sources.push(source);
  }

  return sources;
}

function dedupeResponsesSources(citationSources, searchedSources) {
  const out = [];
  const indexByUrl = new Map();

  for (const source of [...citationSources, ...searchedSources]) {
    const key = normalizeSourceUrl(source.url);
    const existingIndex = indexByUrl.get(key);
    if (existingIndex == null) {
      indexByUrl.set(key, out.length);
      out.push(source);
      continue;
    }

    const existing = out[existingIndex];
    if (existing.source_type !== "citation" && source.source_type === "citation") {
      out[existingIndex] = { ...existing, ...source };
      continue;
    }

    if (!existing.title && source.title) existing.title = source.title;
    if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
  }

  return out;
}

export function parseGrokResponses(data, { defaultTool = "web_search" } = {}) {
  const warnings = [];
  const text = extractResponsesText(data);
  if (!text) warnings.push("Responses returned no output text.");
  if (!outputItems(data).length && !textField(data?.output_text)) warnings.push("Responses output array is missing or empty.");

  const citationSources = extractCitationSources(data, defaultTool);
  const searched = extractSearchedSources(data, defaultTool);
  const sources = dedupeResponsesSources(citationSources, searched.sources);

  return {
    text,
    sources,
    diagnostics: {
      ...usageDiagnostics(data),
      responses_web_search_calls: searched.webSearchCalls,
      responses_x_search_calls: searched.xSearchCalls,
      responses_tool_calls: searched.toolCalls,
      warnings,
    },
  };
}

export async function searchGrokResponses(query, options, config) {
  const endpoint = responsesEndpoint(config);
  const body = buildResponsesBody(query, options, config);
  const data = await requestJson(endpoint, {
    headers: authHeaders(config.grokApiKey),
    body,
    timeoutMs: 180_000,
    config,
    retry: true,
  });

  const defaultTool = config.apiProvider === "openrouter" ? "openrouter:web_search" : "web_search";
  const parsed = parseGrokResponses(data, { defaultTool });
  if (!parsed.text.trim()) {
    const error = new Error("Grok Responses 返回空内容");
    error.code = "GROK_RESPONSES_EMPTY";
    error.diagnostics = parsed.diagnostics;
    throw error;
  }

  return {
    model: options.model,
    content: parsed.text,
    sources: parsed.sources,
    endpoint: "responses",
    diagnostics: parsed.diagnostics,
    raw: data,
  };
}
