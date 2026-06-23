#!/usr/bin/env node
import { ConfigError, loadConfig, normalizeOpenRouterSearchEngine, normalizeSearchMode } from "./lib/config.js";
import { searchGrok } from "./lib/grok.js";
import { searchGrokResponses } from "./lib/grok-responses.js";
import { cleanupOutputDir, previewText, printJson, writeJsonOutput } from "./lib/output.js";
import { firecrawlSearch, tavilySearch } from "./lib/providers.js";
import {
  buildRawSourcesPayload,
  compactSources,
  hasRawSourceValues,
  mergeSources,
  splitAnswerAndSources,
} from "./lib/sources.js";

const DEFAULT_MAX_CHARS = 30000;

function usage() {
  return `Usage: ./scripts/search.js [--platform NAME] [--model MODEL] [--search-mode chat|responses] [--extra N|--no-extra] [--source-chars N] [--full-sources] [--max-chars N] <query>

Run a Grok/OpenRouter web search and return JSON with answer and sources.

Environment:
  GROK_API_URL         OpenAI-compatible base URL; required
  GROK_API_KEY         API key for GROK_API_URL; required
  GROK_API_PROVIDER    Optional provider: xai, openrouter, or openai-compatible
  GROK_MODEL           Optional default model; default grok-4-fast
  GROK_SEARCH_MODE     Optional search mode: chat or responses; default chat
  GROK_RESPONSES_MAX_TURNS
                       Optional Responses max_turns; default 1
  GROK_DEFAULT_EXTRA   Optional default extra source count when a provider key exists; default 5
  GROK_SOURCE_CHARS    Optional source snippet size; default 400
  TAVILY_API_KEY       Optional extra sources provider
  FIRECRAWL_API_KEY    Optional extra sources provider
  GROK_OUTPUT_DIR      Optional directory for full answer when preview is truncated
`;
}

function parseIntOption(name, value, { min = 0 } = {}) {
  if (value == null || value === "") throw new Error(`${name} 缺少数值`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name} 必须是 >= ${min} 的整数`);
  return parsed;
}

function parseListOption(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseListArg(name, value) {
  if (value == null || value === "") throw new Error(`${name} 缺少值`);
  return parseListOption(value);
}

function parseArgs(argv) {
  const args = [...argv];
  const queryParts = [];
  let platform = "";
  let model = "";
  let searchMode = "";
  let extra = null;
  let extraMode = "auto";
  let extraSeen = false;
  let noExtraSeen = false;
  let sourceChars = null;
  let fullSources = false;
  let maxChars = DEFAULT_MAX_CHARS;
  let responsesMaxTurns = null;
  let responsesReasoningEffort = "";
  let responsesAllowedDomains = null;
  let responsesExcludedDomains = null;
  let responsesIncludeXSearch = null;
  let responsesAllowedXHandles = null;
  let responsesExcludedXHandles = null;
  let responsesOpenRouterEngine = "";
  let fallbackChat = null;

  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--platform") {
      platform = args.shift() || "";
      if (!platform) throw new Error("--platform 缺少值");
      continue;
    }
    if (arg?.startsWith("--platform=")) {
      platform = arg.slice("--platform=".length);
      continue;
    }
    if (arg === "--model") {
      model = args.shift() || "";
      if (!model) throw new Error("--model 缺少值");
      continue;
    }
    if (arg?.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--search-mode") {
      searchMode = args.shift() || "";
      if (!searchMode) throw new Error("--search-mode 缺少值");
      continue;
    }
    if (arg?.startsWith("--search-mode=")) {
      searchMode = arg.slice("--search-mode=".length);
      continue;
    }
    if (arg === "--responses-max-turns") {
      responsesMaxTurns = parseIntOption("--responses-max-turns", args.shift(), { min: 1 });
      continue;
    }
    if (arg?.startsWith("--responses-max-turns=")) {
      responsesMaxTurns = parseIntOption("--responses-max-turns", arg.slice("--responses-max-turns=".length), { min: 1 });
      continue;
    }
    if (arg === "--responses-reasoning-effort") {
      responsesReasoningEffort = args.shift() || "";
      if (!responsesReasoningEffort) throw new Error("--responses-reasoning-effort 缺少值");
      continue;
    }
    if (arg?.startsWith("--responses-reasoning-effort=")) {
      responsesReasoningEffort = arg.slice("--responses-reasoning-effort=".length);
      continue;
    }
    if (arg === "--responses-allowed-domains") {
      responsesAllowedDomains = parseListArg("--responses-allowed-domains", args.shift());
      continue;
    }
    if (arg?.startsWith("--responses-allowed-domains=")) {
      responsesAllowedDomains = parseListOption(arg.slice("--responses-allowed-domains=".length));
      continue;
    }
    if (arg === "--responses-excluded-domains") {
      responsesExcludedDomains = parseListArg("--responses-excluded-domains", args.shift());
      continue;
    }
    if (arg?.startsWith("--responses-excluded-domains=")) {
      responsesExcludedDomains = parseListOption(arg.slice("--responses-excluded-domains=".length));
      continue;
    }
    if (arg === "--responses-x-search" || arg === "--responses-include-x-search") {
      responsesIncludeXSearch = true;
      continue;
    }
    if (arg === "--responses-allowed-x-handles") {
      responsesAllowedXHandles = parseListArg("--responses-allowed-x-handles", args.shift());
      continue;
    }
    if (arg?.startsWith("--responses-allowed-x-handles=")) {
      responsesAllowedXHandles = parseListOption(arg.slice("--responses-allowed-x-handles=".length));
      continue;
    }
    if (arg === "--responses-excluded-x-handles") {
      responsesExcludedXHandles = parseListArg("--responses-excluded-x-handles", args.shift());
      continue;
    }
    if (arg?.startsWith("--responses-excluded-x-handles=")) {
      responsesExcludedXHandles = parseListOption(arg.slice("--responses-excluded-x-handles=".length));
      continue;
    }
    if (arg === "--responses-openrouter-engine") {
      responsesOpenRouterEngine = args.shift() || "";
      if (!responsesOpenRouterEngine) throw new Error("--responses-openrouter-engine 缺少值");
      continue;
    }
    if (arg?.startsWith("--responses-openrouter-engine=")) {
      responsesOpenRouterEngine = arg.slice("--responses-openrouter-engine=".length);
      continue;
    }
    if (arg === "--fallback-chat") {
      fallbackChat = true;
      continue;
    }
    if (arg === "--extra") {
      if (noExtraSeen) throw new Error("--extra 与 --no-extra 不能同时使用");
      extraSeen = true;
      extra = parseIntOption("--extra", args.shift(), { min: 0 });
      extraMode = extra > 0 ? "explicit" : "off";
      continue;
    }
    if (arg?.startsWith("--extra=")) {
      if (noExtraSeen) throw new Error("--extra 与 --no-extra 不能同时使用");
      extraSeen = true;
      extra = parseIntOption("--extra", arg.slice("--extra=".length), { min: 0 });
      extraMode = extra > 0 ? "explicit" : "off";
      continue;
    }
    if (arg === "--no-extra") {
      if (extraSeen) throw new Error("--extra 与 --no-extra 不能同时使用");
      noExtraSeen = true;
      extra = 0;
      extraMode = "off";
      continue;
    }
    if (arg === "--source-chars") {
      sourceChars = parseIntOption("--source-chars", args.shift(), { min: 0 });
      continue;
    }
    if (arg?.startsWith("--source-chars=")) {
      sourceChars = parseIntOption("--source-chars", arg.slice("--source-chars=".length), { min: 0 });
      continue;
    }
    if (arg === "--full-sources") {
      fullSources = true;
      continue;
    }
    if (arg === "--max-chars") {
      maxChars = parseIntOption("--max-chars", args.shift(), { min: 0 });
      continue;
    }
    if (arg?.startsWith("--max-chars=")) {
      maxChars = parseIntOption("--max-chars", arg.slice("--max-chars=".length), { min: 0 });
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`未知参数: ${arg}`);
    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) throw new Error("缺少 query");

  return {
    query,
    platform,
    model,
    searchMode,
    extra,
    extraMode,
    sourceChars,
    fullSources,
    maxChars,
    responsesMaxTurns,
    responsesReasoningEffort,
    responsesAllowedDomains,
    responsesExcludedDomains,
    responsesIncludeXSearch,
    responsesAllowedXHandles,
    responsesExcludedXHandles,
    responsesOpenRouterEngine,
    fallbackChat,
  };
}

function grokSources(rawSources) {
  return (rawSources || []).map((source) => ({ ...source, provider: "grok" }));
}

function providerAttempt(result) {
  return {
    provider: result.provider,
    ok: Boolean(result.ok),
    count: result.sources?.length || 0,
    ...(result.skipped ? { skipped: true } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function missingProviderAttempt(provider, error) {
  return { provider, ok: false, skipped: true, count: 0, error };
}

async function extraSources(query, limit, config, { explicit = false } = {}) {
  const warnings = [];
  const providerAttempts = [];
  const providerRaw = {};
  const sources = [];

  if (limit <= 0) return { sources, warnings, provider_attempts: providerAttempts, provider_raw: providerRaw };

  if (!config.tavilyApiKey && !config.firecrawlApiKey) {
    if (explicit) {
      warnings.push("--extra requested but neither TAVILY_API_KEY nor FIRECRAWL_API_KEY is configured.");
      providerAttempts.push(
        missingProviderAttempt("tavily", "TAVILY_API_KEY 未配置"),
        missingProviderAttempt("firecrawl", "FIRECRAWL_API_KEY 未配置")
      );
    }
    return { sources, warnings, provider_attempts: providerAttempts, provider_raw: providerRaw };
  }

  let remaining = limit;
  if (config.tavilyApiKey) {
    const result = await tavilySearch(query, remaining, config);
    providerAttempts.push(providerAttempt(result));
    if (result.raw !== undefined) providerRaw.tavily = result.raw;
    if (result.ok) {
      sources.push(...result.sources);
      remaining = Math.max(0, limit - sources.length);
    } else if (explicit) {
      warnings.push(`Tavily extra source search failed: ${result.error || "unknown error"}`);
    }
  } else if (explicit) {
    providerAttempts.push(missingProviderAttempt("tavily", "TAVILY_API_KEY 未配置"));
    warnings.push("TAVILY_API_KEY is not configured; Tavily extra sources were skipped.");
  }

  if (remaining > 0 && config.firecrawlApiKey) {
    const result = await firecrawlSearch(query, remaining, config);
    providerAttempts.push(providerAttempt(result));
    if (result.raw !== undefined) providerRaw.firecrawl = result.raw;
    if (result.ok) sources.push(...result.sources);
    else if (explicit) warnings.push(`Firecrawl extra source search failed: ${result.error || "unknown error"}`);
  } else if (remaining > 0 && explicit) {
    providerAttempts.push(missingProviderAttempt("firecrawl", "FIRECRAWL_API_KEY 未配置"));
    warnings.push("FIRECRAWL_API_KEY is not configured; Firecrawl extra sources were skipped.");
  }

  return {
    sources: sources.slice(0, limit),
    warnings,
    provider_attempts: providerAttempts,
    provider_raw: providerRaw,
  };
}

function resolveExtra(args, config) {
  if (args.extraMode === "off") return { limit: 0, mode: "off" };
  if (args.extraMode === "explicit") return { limit: args.extra, mode: "explicit" };
  const hasExtraProvider = Boolean(config.tavilyApiKey || config.firecrawlApiKey);
  return { limit: hasExtraProvider ? config.defaultExtra : 0, mode: "auto" };
}

function exclusiveOptionPair(argsLeft, argsRight, configLeft, configRight) {
  if (argsLeft != null || argsRight != null) {
    return {
      left: argsLeft == null ? [] : [...argsLeft],
      right: argsRight == null ? [] : [...argsRight],
    };
  }
  return {
    left: [...(configLeft || [])],
    right: [...(configRight || [])],
  };
}

function validateExclusiveLists(left, right, leftName, rightName) {
  if (left.length && right.length) {
    throw new ConfigError(`${leftName} 与 ${rightName} 不能同时使用`, "RESPONSES_FILTER_CONFLICT");
  }
}

function validateMaxItems(list, name, max) {
  if (list.length > max) throw new ConfigError(`${name} 最多支持 ${max} 个值`, "RESPONSES_FILTER_LIMIT");
}

function resolveSearchOptions(args, config) {
  const domainFilters = exclusiveOptionPair(
    args.responsesAllowedDomains,
    args.responsesExcludedDomains,
    config.responsesAllowedDomains,
    config.responsesExcludedDomains
  );
  const xHandleFilters = exclusiveOptionPair(
    args.responsesAllowedXHandles,
    args.responsesExcludedXHandles,
    config.responsesAllowedXHandles,
    config.responsesExcludedXHandles
  );
  const allowedDomains = domainFilters.left;
  const excludedDomains = domainFilters.right;
  const allowedXHandles = xHandleFilters.left;
  const excludedXHandles = xHandleFilters.right;

  validateExclusiveLists(allowedDomains, excludedDomains, "responses allowed domains", "responses excluded domains");
  validateExclusiveLists(allowedXHandles, excludedXHandles, "responses allowed X handles", "responses excluded X handles");
  validateMaxItems(allowedDomains, "responses allowed domains", 5);
  validateMaxItems(excludedDomains, "responses excluded domains", 5);

  return {
    searchMode: normalizeSearchMode(args.searchMode || config.searchMode),
    model: args.model || config.grokModel,
    maxTurns: args.responsesMaxTurns ?? config.responsesMaxTurns,
    reasoningEffort: args.responsesReasoningEffort || config.responsesReasoningEffort,
    allowedDomains,
    excludedDomains,
    includeXSearch:
      (args.responsesIncludeXSearch ?? config.responsesIncludeXSearch) || Boolean(allowedXHandles.length || excludedXHandles.length),
    allowedXHandles,
    excludedXHandles,
    openRouterEngine: normalizeOpenRouterSearchEngine(args.responsesOpenRouterEngine || config.responsesOpenRouterEngine),
    fallbackChat: args.fallbackChat ?? config.responsesFallbackChat,
  };
}

function responsesDiagnosticOptions(searchOptions) {
  return {
    responses_max_turns: searchOptions.maxTurns,
    responses_reasoning_effort: searchOptions.reasoningEffort,
    responses_allowed_domains: searchOptions.allowedDomains,
    responses_excluded_domains: searchOptions.excludedDomains,
    responses_include_x_search: searchOptions.includeXSearch,
    responses_allowed_x_handles: searchOptions.allowedXHandles,
    responses_excluded_x_handles: searchOptions.excludedXHandles,
    responses_openrouter_engine: searchOptions.openRouterEngine,
    responses_fallback_chat: searchOptions.fallbackChat,
  };
}

async function rawSourcesPath(config, args, rawPayload, rawSourceSets, compactSourceSets) {
  const hasProviderRaw = Object.keys(rawPayload.provider_raw || {}).length > 0;
  const hasHiddenSourceValues = rawSourceSets.some((sources, index) => hasRawSourceValues(sources, compactSourceSets[index]));
  if (!args.fullSources && !hasProviderRaw && !hasHiddenSourceValues) return null;

  return writeJsonOutput(config, {
    kind: "sources",
    provider: "search",
    label: args.query,
    value: rawPayload,
  });
}

async function chatGrokChannel(args, config, searchOptions) {
  const grok = await searchGrok(args.query, { platform: args.platform, model: searchOptions.model }, config);
  const split = splitAnswerAndSources(grok.content);
  if (!split.answer.trim()) throw new Error("Grok 返回内容中没有可显示 answer");

  const warnings = [];
  if (!split.sources.length) warnings.push("No parseable sources found in Grok response.");

  return {
    search_mode: "chat",
    endpoint: grok.endpoint,
    model: grok.model,
    answer: split.answer,
    sources: grokSources(split.sources),
    warnings,
    provider_attempts: [],
    diagnostics: {},
    raw_content_chars: grok.content.length,
  };
}

async function responsesGrokChannel(args, config, searchOptions) {
  const grok = await searchGrokResponses(
    args.query,
    {
      platform: args.platform,
      model: searchOptions.model,
      maxTurns: searchOptions.maxTurns,
      reasoningEffort: searchOptions.reasoningEffort,
      allowedDomains: searchOptions.allowedDomains,
      excludedDomains: searchOptions.excludedDomains,
      includeXSearch: searchOptions.includeXSearch,
      allowedXHandles: searchOptions.allowedXHandles,
      excludedXHandles: searchOptions.excludedXHandles,
      openRouterEngine: searchOptions.openRouterEngine,
    },
    config
  );

  const diagnostics = { ...(grok.diagnostics || {}) };
  const warnings = [...(diagnostics.warnings || [])];
  delete diagnostics.warnings;
  if (!grok.sources.length) warnings.push("No responses citations or searched sources were found.");

  return {
    search_mode: "responses",
    endpoint: grok.endpoint,
    model: grok.model,
    answer: grok.content,
    sources: grok.sources,
    warnings,
    provider_attempts: [],
    diagnostics,
    raw_content_chars: grok.content.length,
  };
}

function responsesFailureAttempt(config, error) {
  return {
    provider: `grok-responses:${config.apiProvider}`,
    ok: false,
    error: error.message,
  };
}

function responsesFailureDiagnostics(config, searchOptions, error) {
  const innerDiagnostics = error.diagnostics || {};
  return {
    ...innerDiagnostics,
    grok_endpoint: "responses",
    warnings: [`Responses search failed: ${error.message}`, ...(innerDiagnostics.warnings || [])],
    provider_attempts: [responsesFailureAttempt(config, error)],
    options: {
      search_mode: "responses",
      actual_search_mode: null,
      api_provider: config.apiProvider,
      ...responsesDiagnosticOptions(searchOptions),
    },
  };
}

async function grokChannel(args, config, searchOptions) {
  if (searchOptions.searchMode === "chat") return chatGrokChannel(args, config, searchOptions);

  try {
    return await responsesGrokChannel(args, config, searchOptions);
  } catch (error) {
    if (!searchOptions.fallbackChat) {
      error.diagnostics = responsesFailureDiagnostics(config, searchOptions, error);
      throw error;
    }

    const chat = await chatGrokChannel(args, config, searchOptions);
    return {
      ...chat,
      warnings: [`Responses failed; fell back to Chat: ${error.message}`, ...chat.warnings],
      provider_attempts: [
        responsesFailureAttempt(config, error),
        { provider: "grok-chat", ok: true, count: chat.sources.length },
      ],
      diagnostics: {
        ...chat.diagnostics,
        requested_grok_endpoint: "responses",
        fallback_chat: true,
        responses_error: error.message,
      },
    };
  }
}

async function publicResult(args, config) {
  const searchOptions = resolveSearchOptions(args, config);
  const sourceChars = args.sourceChars ?? config.sourceChars;
  const extraOptions = resolveExtra(args, config);
  const grok = await grokChannel(args, config, searchOptions);

  const extra = await extraSources(args.query, extraOptions.limit, config, { explicit: extraOptions.mode === "explicit" });
  const warnings = [...grok.warnings, ...extra.warnings];
  const providerAttempts = [...grok.provider_attempts, ...extra.provider_attempts];

  const rawGrokSources = grok.sources;
  const rawExtraSources = extra.sources;
  const rawMergedSources = mergeSources(rawGrokSources, rawExtraSources);
  const grokCompact = compactSources(rawGrokSources, { sourceChars });
  const extraCompact = compactSources(rawExtraSources, { sourceChars });
  const mergedCompact = compactSources(rawMergedSources, { sourceChars });

  const answerInfo = await previewText(config, {
    kind: "search",
    provider: "grok",
    label: args.query,
    content: grok.answer,
    maxChars: args.maxChars,
    extension: "md",
  });
  const createdAt = new Date().toISOString();
  const rawPayload = buildRawSourcesPayload({
    query: args.query,
    grok: rawGrokSources,
    extra: rawExtraSources,
    providerRaw: extra.provider_raw,
    providerAttempts,
    createdAt,
  });
  const rawPath = await rawSourcesPath(
    config,
    args,
    rawPayload,
    [rawGrokSources, rawExtraSources, rawMergedSources],
    [grokCompact, extraCompact, mergedCompact]
  );

  const sources = {
    grok: grokCompact,
    extra: extraCompact,
    merged: mergedCompact,
    raw_path: rawPath,
  };
  if (args.fullSources) sources.raw = rawPayload;

  return {
    query: args.query,
    platform: args.platform || null,
    model: grok.model,
    answer: {
      text: answerInfo.preview,
      chars: answerInfo.preview.length,
      original_chars: answerInfo.original_length,
      truncated: answerInfo.truncated,
      full_path: answerInfo.full_output_path,
    },
    sources,
    diagnostics: {
      grok_endpoint: grok.endpoint,
      ...grok.diagnostics,
      warnings,
      provider_attempts: providerAttempts,
      options: {
        search_mode: searchOptions.searchMode,
        actual_search_mode: grok.search_mode,
        api_provider: config.apiProvider,
        extra: extraOptions.limit,
        extra_mode: extraOptions.mode,
        source_chars: sourceChars,
        max_chars: args.maxChars,
        full_sources: args.fullSources,
        ...(searchOptions.searchMode === "responses" ? responsesDiagnosticOptions(searchOptions) : {}),
      },
      raw_grok_content_chars: grok.raw_content_chars,
      searched_at: createdAt,
    },
  };
}

function errorOutput(error, code, diagnostics = {}) {
  return {
    error: {
      message: error.message,
      code,
    },
    diagnostics: {
      warnings: [],
      provider_attempts: [],
      searched_at: new Date().toISOString(),
      ...diagnostics,
    },
  };
}

let stage = "argument";
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  stage = "config";
  const config = await loadConfig({ requireGrok: true });
  await cleanupOutputDir(config);
  stage = "search";
  const output = await publicResult(args, config);
  printJson(output);
} catch (error) {
  const code = error.code || (stage === "argument" ? "ARGUMENT_ERROR" : stage === "search" ? "SEARCH_ERROR" : "RUNTIME_ERROR");
  printJson(errorOutput(error, code, error.diagnostics));
  console.error(error.message);
  process.exitCode = stage === "argument" ? 2 : 1;
}
