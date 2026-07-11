#!/usr/bin/env node
import { ConfigError, loadConfig, normalizeOpenRouterSearchEngine } from "./lib/config.js";
import { searchGrokResponses } from "./lib/grok-responses.js";
import { cleanupOutputDir, previewText, printJson, writeJsonOutput } from "./lib/output.js";
import { firecrawlAuthMode, firecrawlSearch, tavilySearch } from "./lib/providers.js";
import {
  buildRawSourcesPayload,
  compactSources,
  hasRawSourceValues,
  mergeSources,
} from "./lib/sources.js";

const DEFAULT_MAX_CHARS = 30000;
const QUOTA_CODE_PATTERN = /insufficient[_-]?quota|quota[_-]?exhausted|credits?[_-]?exhausted|insufficient[_-]?credits?|payment[_-]?required/i;
const QUOTA_MESSAGE_PATTERN = /quota|credits?|balance|billing|rate[ _-]?limit|insufficient|额度|余额|计费|限流/i;

function usage() {
  return `Usage: ./scripts/search.js [--platform NAME] [--model MODEL] [--extra N|--no-extra] [--source-chars N] [--full-sources] [--max-chars N] <query>

Run a Responses-compatible Grok/OpenRouter web search and return JSON with independent Tavily/Firecrawl sources.

Environment:
  GROK_API_URL         Responses-compatible base URL; required
  GROK_API_KEY         API key for GROK_API_URL; required
  GROK_API_PROVIDER    Optional provider: xai, openrouter, or openai-compatible
  GROK_MODEL           Optional default model; default grok-4.3
  GROK_RESPONSES_MAX_TURNS
                       Optional Responses max_turns; default 3
  GROK_DEFAULT_EXTRA   Optional total Tavily/Firecrawl source count; default 6
  GROK_SOURCE_CHARS    Optional source snippet size; default 400
  TAVILY_API_KEY       Optional Tavily parallel source provider
  FIRECRAWL_API_KEY    Optional Firecrawl key; keyless search works without it
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
  };
}

function providerAttempt(result) {
  return {
    provider: result.provider,
    ok: Boolean(result.ok),
    count: result.sources?.length || 0,
    ...(result.skipped ? { skipped: true } : {}),
    ...(result.auth_mode ? { auth_mode: result.auth_mode } : {}),
    ...(result.credits_used == null ? {} : { credits_used: result.credits_used }),
    ...(result.error ? { error: result.error } : {}),
  };
}

function extraAllocation(limit, config) {
  if (limit <= 0) return { tavily: 0, firecrawl: 0 };
  if (!config.tavilyApiKey) return { tavily: 0, firecrawl: limit };
  const tavily = Math.ceil(limit / 2);
  return { tavily, firecrawl: limit - tavily };
}

async function extraSources(query, limit, config) {
  const warnings = [];
  const providerRaw = {};
  const allocation = extraAllocation(limit, config);
  if (limit <= 0) {
    return { sources: [], warnings, provider_attempts: [], provider_raw: providerRaw, allocation };
  }

  const jobs = [];
  if (allocation.tavily > 0) jobs.push(tavilySearch(query, allocation.tavily, config));
  if (allocation.firecrawl > 0) jobs.push(firecrawlSearch(query, allocation.firecrawl, config));
  const results = await Promise.all(jobs);
  const sources = [];
  const providerAttempts = [];

  for (const result of results) {
    providerAttempts.push(providerAttempt(result));
    if (result.raw !== undefined) providerRaw[result.provider] = result.raw;
    if (result.ok) sources.push(...(result.sources || []));
    else warnings.push(`${result.provider} extra source search failed: ${result.error || "unknown error"}`);
  }

  return {
    sources: sources.slice(0, limit),
    warnings,
    provider_attempts: providerAttempts,
    provider_raw: providerRaw,
    allocation,
  };
}

function resolveExtra(args, config) {
  if (args.extraMode === "off") return { limit: 0, mode: "off" };
  if (args.extraMode === "explicit") return { limit: args.extra, mode: "explicit" };
  return { limit: config.defaultExtra, mode: "auto" };
}

function exclusiveOptionPair(argsLeft, argsRight, configLeft, configRight) {
  if (argsLeft != null || argsRight != null) {
    return { left: argsLeft == null ? [] : [...argsLeft], right: argsRight == null ? [] : [...argsRight] };
  }
  return { left: [...(configLeft || [])], right: [...(configRight || [])] };
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
  };
}

async function rawSourcesPath(config, args, rawPayload, rawSourceSets, compactSourceSets) {
  const hasProviderRaw = Object.keys(rawPayload.provider_raw || {}).length > 0;
  const hasHiddenSourceValues = rawSourceSets.some((sources, index) => hasRawSourceValues(sources, compactSourceSets[index]));
  if (!args.fullSources && !hasProviderRaw && !hasHiddenSourceValues) return null;
  return writeJsonOutput(config, { kind: "sources", provider: "search", label: args.query, value: rawPayload });
}

async function grokChannel(args, config, searchOptions) {
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
    endpoint: grok.endpoint,
    model: grok.model,
    answer: grok.content,
    sources: grok.sources,
    warnings,
    provider_attempts: [{ provider: `grok-responses:${config.apiProvider}`, ok: true, count: grok.sources.length }],
    diagnostics,
    raw_content_chars: grok.content.length,
  };
}

function isQuotaExhaustedError(error) {
  if (error?.status === 402) return true;
  const codeText = [error?.code, error?.upstreamCode, error?.details?.code].filter(Boolean).join(" ");
  if (QUOTA_CODE_PATTERN.test(codeText)) return true;
  return error?.status === 429 && QUOTA_MESSAGE_PATTERN.test(String(error?.message || ""));
}

function grokFailureAttempt(config, error) {
  return { provider: `grok-responses:${config.apiProvider}`, ok: false, count: 0, error: error.message };
}

function clipText(value, max = 800) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function degradedAnswer(sources) {
  const lines = [
    "> ⚠️ Grok Responses 额度已耗尽。以下为 Tavily / Firecrawl 原始搜索结果，未经 Grok 综合生成。",
    "",
  ];
  const groups = new Map();
  for (const source of sources) {
    const provider = source.provider || "search";
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(source);
  }
  for (const [provider, items] of groups) {
    lines.push(`## ${provider === "tavily" ? "Tavily" : provider === "firecrawl" ? "Firecrawl" : provider}`);
    lines.push("");
    for (const [index, source] of items.entries()) {
      const title = String(source.title || `Result ${index + 1}`).trim();
      lines.push(`${index + 1}. [${title}](${source.url})`);
      const snippet = clipText(source.snippet || source.description || source.content);
      if (snippet) lines.push(`   ${snippet.replace(/\s+/g, " ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function failureDiagnostics(config, searchOptions, extraOptions, extra, error, { quota = false } = {}) {
  const warning = quota
    ? "Grok Responses quota was exhausted."
    : `Responses search failed: ${error.message}`;
  return {
    grok_endpoint: "responses",
    ...(quota ? { grok_error: { code: "QUOTA_EXHAUSTED", message: error.message } } : {}),
    warnings: [warning, ...(extra?.warnings || []), ...(error?.diagnostics?.warnings || [])],
    provider_attempts: [grokFailureAttempt(config, error), ...(extra?.provider_attempts || [])],
    options: {
      api_provider: config.apiProvider,
      extra: extraOptions.limit,
      extra_mode: extraOptions.mode,
      extra_allocation: extra?.allocation || { tavily: 0, firecrawl: 0 },
      firecrawl_auth_mode: extraOptions.limit > 0 ? firecrawlAuthMode(config) : null,
      ...responsesDiagnosticOptions(searchOptions),
    },
  };
}

async function publicResult(args, config) {
  const searchOptions = resolveSearchOptions(args, config);
  const sourceChars = args.sourceChars ?? config.sourceChars;
  const extraOptions = resolveExtra(args, config);
  const grokPromise = grokChannel(args, config, searchOptions).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  const [grokResult, extra] = await Promise.all([grokPromise, extraSources(args.query, extraOptions.limit, config)]);

  let grok;
  let degraded = false;
  let grokError = null;
  if (grokResult.ok) {
    grok = grokResult.value;
  } else {
    const quota = isQuotaExhaustedError(grokResult.error);
    if (!quota) {
      grokResult.error.diagnostics = failureDiagnostics(config, searchOptions, extraOptions, extra, grokResult.error);
      throw grokResult.error;
    }
    if (extraOptions.limit <= 0 || !extra.sources.length) {
      const error = new Error(
        extraOptions.limit <= 0
          ? "Grok Responses 额度已耗尽；extra sources 已显式关闭，无法降级"
          : "Grok Responses 额度已耗尽，且 Tavily/Firecrawl 未返回可用结果"
      );
      error.code = "GROK_QUOTA_EXHAUSTED";
      error.diagnostics = failureDiagnostics(config, searchOptions, extraOptions, extra, grokResult.error, { quota: true });
      throw error;
    }
    degraded = true;
    grokError = { code: "QUOTA_EXHAUSTED", message: grokResult.error.message };
    grok = {
      endpoint: "responses",
      model: searchOptions.model,
      answer: degradedAnswer(extra.sources),
      sources: [],
      warnings: [
        "Grok Responses 因额度耗尽不可用；当前 answer 仅包含 Tavily/Firecrawl 原始搜索结果，未经 Grok 综合生成。",
      ],
      provider_attempts: [grokFailureAttempt(config, grokResult.error)],
      diagnostics: {},
      raw_content_chars: 0,
    };
  }

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
    provider: degraded ? "search-fallback" : "grok-responses",
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
  const sources = { grok: grokCompact, extra: extraCompact, merged: mergedCompact, raw_path: rawPath };
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
      grok_endpoint: "responses",
      ...grok.diagnostics,
      ...(degraded ? { degraded: true, grok_error: grokError } : {}),
      warnings,
      provider_attempts: providerAttempts,
      options: {
        api_provider: config.apiProvider,
        extra: extraOptions.limit,
        extra_mode: extraOptions.mode,
        extra_allocation: extra.allocation,
        firecrawl_auth_mode: extraOptions.limit > 0 ? firecrawlAuthMode(config) : null,
        source_chars: sourceChars,
        max_chars: args.maxChars,
        full_sources: args.fullSources,
        ...responsesDiagnosticOptions(searchOptions),
      },
      raw_grok_content_chars: grok.raw_content_chars,
      searched_at: createdAt,
    },
  };
}

function errorOutput(error, code, diagnostics = {}) {
  return {
    error: { message: error.message, code },
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
  printJson(await publicResult(args, config));
} catch (error) {
  const code = error.code || (stage === "argument" ? "ARGUMENT_ERROR" : stage === "search" ? "SEARCH_ERROR" : "RUNTIME_ERROR");
  printJson(errorOutput(error, code, error.diagnostics));
  console.error(error.message);
  process.exitCode = stage === "argument" ? 2 : 1;
}
