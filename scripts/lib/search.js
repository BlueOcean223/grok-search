/**
 * The Search command behind one interface: `runSearch(args, config, adapters)` takes the parsed
 * arguments, the loaded config and the three search channels, and returns the stdout object
 * (writing the run record and any full-answer file on the way). scripts/search.js only parses
 * argv and prints.
 */
import {
  ConfigError,
  X_HANDLE_LIMIT,
  normalizeOpenRouterSearchEngine,
  normalizeSearchSource,
  usesWebSearch,
  usesXSearch,
} from "./config.js";
import { activeFirecrawlCooldown, cooldownSkipMessage } from "./cooldown.js";
import { searchGrokResponses } from "./grok-responses.js";
import { emitText, runRecordBase, runRecordPath, STDOUT_BUDGET_BYTES, writeRunRecord } from "./output.js";
import { firecrawlAuthMode, firecrawlSearch } from "./firecrawl.js";
import { attemptFrom, skippedResult, timed } from "./provider-result.js";
import { tavilySearch } from "./tavily.js";
import { getProxyState } from "./proxy.js";
import { buildRawSourcesPayload, compactSources, isOffDomainExtra, mergeSources, selectSources } from "./sources.js";

export const DEFAULT_MAX_CHARS = 30000;

/** The Search command's flags; see parseArgv in cli.js for the entry shape. */
export const SEARCH_OPTIONS = {
  responsesParallelToolCalls: {
    flag: "--responses-parallel-tool-calls",
    type: "bool",
    value: "true|false",
    group: "Cost",
    config: "responsesParallelToolCalls",
    help: "false asks Grok for one server-side tool call per turn. Cuts X search calls\nseveral-fold on relays that honor it; check diagnostics.responses_tool_calls.",
  },
  instructions: {
    flag: "--instructions",
    type: "string",
    value: "TEXT",
    group: "Research instructions",
    help: "What Grok should return (fields, language, what to leave out). Only\nGrok sees it; Tavily/Firecrawl still search the plain query.",
  },
  // Rejected in the parser so an unknown source fails like every other argument error, before
  // config load and output-dir cleanup.
  searchSource: {
    flag: "--source",
    type: "string",
    value: "web|x|both",
    group: "Search sources",
    validate: normalizeSearchSource,
    help: "web: Grok web_search only (default). x: x_search only, for X posts,\nprofiles and threads. both: Grok decides between the two.",
  },
  // Aliases kept from before --source existed; both mean the "both" mode.
  xSearchAlias: { flags: ["--responses-x-search", "--responses-include-x-search"], type: "const", target: "searchSource", value: "both" },
  xFromDate: { flag: "--x-from-date", type: "date", value: "DATE", group: "Search sources", help: "Restrict X posts to on/after DATE (YYYY-MM-DD); implies X search" },
  xToDate: { flag: "--x-to-date", type: "date", value: "DATE", group: "Search sources", help: "Restrict X posts to on/before DATE (YYYY-MM-DD); implies X search" },
  // The media toggles and the handle lists have no `config` key on purpose: on the command line
  // they imply X search (xOptionsRequested), as a configured preference they do not, so the
  // config value is merged in resolveSearchOptions once that has been decided.
  xImageUnderstanding: {
    flag: "--x-images",
    off: "--no-x-images",
    type: "toggle",
    group: "Search sources",
    help: "Analyze images in X posts; billed as extra tokens",
    offHelp: "Turn off image analysis enabled in config",
  },
  xVideoUnderstanding: {
    flag: "--x-videos",
    off: "--no-x-videos",
    type: "toggle",
    group: "Search sources",
    help: "Analyze videos in X posts; billed as extra tokens",
    offHelp: "Turn off video analysis enabled in config",
  },
  responsesAllowedXHandles: {
    flag: "--responses-allowed-x-handles",
    type: "list",
    value: "LIST",
    group: "Search sources",
    help: "Comma-separated X handles to search (max 20); implies X search",
  },
  responsesExcludedXHandles: {
    flag: "--responses-excluded-x-handles",
    type: "list",
    value: "LIST",
    group: "Search sources",
    help: "Comma-separated X handles to leave out (max 20); implies X search",
  },
  model: { flag: "--model", type: "string", value: "MODEL", group: "Grok request", config: "grokModel", help: "Model to ask; default from config (grok-4.3)" },
  platform: { flag: "--platform", type: "string", value: "NAME", group: "Grok request", help: "Platform to focus the search on; added to the prompt" },
  responsesMaxTurns: {
    flag: "--responses-max-turns",
    type: "int",
    min: 1,
    value: "N",
    group: "Grok request",
    config: "responsesMaxTurns",
    help: "Responses max_turns (default 3); a hard cap on X search only",
  },
  responsesReasoningEffort: {
    flag: "--responses-reasoning-effort",
    type: "string",
    value: "LEVEL",
    group: "Grok request",
    config: "responsesReasoningEffort",
    help: "Reasoning effort sent for reasoning models (default low)",
  },
  responsesOpenRouterEngine: {
    flag: "--responses-openrouter-engine",
    type: "string",
    value: "ENGINE",
    group: "Grok request",
    config: "responsesOpenRouterEngine",
    help: "OpenRouter web search engine: auto (default), native, exa, firecrawl,\nparallel or perplexity",
  },
  responsesAllowedDomains: {
    flag: "--responses-allowed-domains",
    type: "list",
    value: "LIST",
    group: "Domain filters",
    help: "Comma-separated domains to search (max 5). Grok, Tavily and Firecrawl all\nget them; the command line may only narrow a configured list",
  },
  responsesExcludedDomains: {
    flag: "--responses-excluded-domains",
    type: "list",
    value: "LIST",
    group: "Domain filters",
    help: "Comma-separated domains to leave out (max 5)",
  },
  extra: { flag: "--extra", type: "int", min: 0, value: "N", group: "Extra sources", help: "Total Tavily/Firecrawl results (default 6; 0 turns them off)" },
  noExtra: { flag: "--no-extra", type: "flag", group: "Extra sources", help: "No Tavily/Firecrawl results" },
  sourceChars: { flag: "--source-chars", type: "int", min: 0, value: "N", group: "Output", config: "sourceChars", help: "Snippet length per source card (default 400)" },
  maxSources: {
    flag: "--max-sources",
    type: "int",
    min: 1,
    value: "N",
    group: "Output",
    config: "maxSources",
    help: "Cap on source cards in stdout (default 12); the rest are in the run record",
  },
  fullSources: { flag: "--full-sources", type: "flag", group: "Output", help: "Attach every source and the raw provider payloads as sources.raw" },
  maxChars: {
    flag: "--max-chars",
    type: "int",
    min: 0,
    default: DEFAULT_MAX_CHARS,
    value: "N",
    group: "Output",
    help: "Characters of the answer to print (default 30000); the rest goes to answer.full_path",
  },
  deadline: { flag: "--deadline", type: "int", min: 0, value: "SECONDS", group: "Output", config: "deadlineSeconds", help: "Whole-command deadline (default 240; 0 disables)" },
};

export const SEARCH_POSITIONAL = { name: "query", rest: true, required: "缺少 query" };

/** Checks across fields once every flag is in. */
export function finishSearchArgs(args) {
  if (args.extra != null && args.noExtra) throw new Error("--extra 与 --no-extra 不能同时使用");
  if (args.noExtra) args.extra = 0;
  args.extraMode = args.extra === 0 ? "off" : args.extra != null ? "explicit" : "auto";
  delete args.noExtra;
  if (args.xFromDate && args.xToDate && args.xFromDate > args.xToDate) throw new Error("--x-from-date 不能晚于 --x-to-date");
}

const QUOTA_CODE_PATTERN = /insufficient[_-]?quota|quota[_-]?exhausted|credits?[_-]?exhausted|insufficient[_-]?credits?|payment[_-]?required/i;
const QUOTA_MESSAGE_PATTERN = /quota|credits?|balance|billing|insufficient|额度|余额|计费/i;
const GROK_FAILURE_LABELS = {
  quota: { code: "QUOTA_EXHAUSTED", errorCode: "GROK_QUOTA_EXHAUSTED", label: "额度已耗尽", warning: "Grok Responses quota was exhausted." },
  rate_limit: { code: "RATE_LIMITED", errorCode: "GROK_RATE_LIMITED", label: "触发限流", warning: "Grok Responses was rate limited." },
};

function extraAllocation(limit, config, { firecrawlAvailable = true } = {}) {
  if (limit <= 0) return { tavily: 0, firecrawl: 0 };
  if (!config.tavilyApiKey) return { tavily: 0, firecrawl: firecrawlAvailable ? limit : 0 };
  if (!firecrawlAvailable) return { tavily: limit, firecrawl: 0 };
  const tavily = Math.ceil(limit / 2);
  return { tavily, firecrawl: limit - tavily };
}

/**
 * Independent Tavily / Firecrawl searches. Domain filters are the same ones Grok's web_search
 * gets: when the caller scopes a search to github.com, extras that wander off to blogs and
 * video sites only displace in-scope candidates. A Firecrawl quota cooldown hands its share to
 * Tavily when a key exists, otherwise the channel is skipped rather than re-failing.
 */
async function extraSources(query, limit, config, filters, { tavily, firecrawl }) {
  const warnings = [];
  const providerRaw = {};
  if (limit <= 0) {
    return { sources: [], warnings, provider_attempts: [], provider_raw: providerRaw, allocation: { tavily: 0, firecrawl: 0 } };
  }

  const firecrawlMode = firecrawlAuthMode(config);
  const cooldown = await activeFirecrawlCooldown(config, firecrawlMode);
  const allocation = extraAllocation(limit, config, { firecrawlAvailable: !cooldown });

  // Timed per provider so the attempt says which side made the caller wait.
  const jobs = [];
  if (allocation.tavily > 0) jobs.push(timed(tavily(query, allocation.tavily, config, filters)));
  if (allocation.firecrawl > 0) jobs.push(timed(firecrawl(query, allocation.firecrawl, config, filters)));
  const results = await Promise.all(jobs);
  const sources = [];
  const providerAttempts = [];

  const hasFilters = Boolean(filters.allowedDomains?.length || filters.excludedDomains?.length);
  for (const result of results) {
    const attempt = attemptFrom(result, { count: result.sources?.length || 0 });
    if (result.ok && hasFilters) {
      attempt.off_domain = (result.sources || []).filter((source) => isOffDomainExtra(source, filters)).length;
    }
    providerAttempts.push(attempt);
    if (result.raw !== undefined) providerRaw[result.provider] = result.raw;
    if (result.ok) sources.push(...(result.sources || []));
    else warnings.push(`${result.provider} extra source search failed: ${result.error || "unknown error"}`);
  }

  if (cooldown) {
    const message = cooldownSkipMessage(cooldown);
    providerAttempts.push(attemptFrom(skippedResult("firecrawl", message, { auth_mode: firecrawlMode }), { count: 0 }));
    warnings.push(`firecrawl extra source search skipped: ${message}`);
  }

  return {
    sources: sources.slice(0, limit),
    warnings,
    provider_attempts: providerAttempts,
    provider_raw: providerRaw,
    allocation,
  };
}

function resolveExtra(args, config, searchSource) {
  if (args.extraMode === "off") return { limit: 0, mode: "off" };
  if (args.extraMode === "explicit") return { limit: args.extra, mode: "explicit" };
  // Tavily and Firecrawl only search the web. On an X-only search their results are off-topic
  // by construction (6 of 6 in the 2026-09-08 side-by-side) and still bill credits, so they
  // stay off unless the caller asks for them with --extra N.
  if (usesXSearch(searchSource) && !usesWebSearch(searchSource)) return { limit: 0, mode: "off-x-only" };
  return { limit: config.defaultExtra, mode: "auto" };
}

function dedupeFilterValues(values) {
  const byKey = new Map();
  for (const value of values) {
    const key = value.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.values()];
}

function containsValue(list, value) {
  return list.some((other) => other.toLowerCase() === value.toLowerCase());
}

/**
 * Resolve an allow/deny filter pair from CLI args over config.
 *
 * Config is written by the user, CLI args by the agent calling this tool, so a CLI
 * value must not silently discard a configured restriction. Both list kinds are
 * restrictions: a deny-list removes named values, an allow-list removes everything it
 * does not name. So command-line values may narrow either one but never widen it.
 *
 * - Configured allow-list: CLI allow values must be a subset of it; a CLI deny-list
 *   subtracts from it. Emptying it entirely is an error, because an empty allow-list
 *   means "no restriction" to the API — the opposite of what was configured.
 * - Configured deny-list: a CLI allow-list satisfies it vacuously unless it explicitly
 *   names an excluded value; two deny-lists are unioned rather than replaced.
 */
function resolveFilterPair({
  argsAllowed,
  argsExcluded,
  configAllowed,
  configExcluded,
  allowedName,
  excludedName,
  max,
}) {
  const configAllowedList = configAllowed || [];
  const configExcludedList = configExcluded || [];
  if (argsAllowed == null && argsExcluded == null) {
    return { allowed: [...configAllowedList], excluded: [...configExcludedList] };
  }

  const allowed = argsAllowed == null ? [] : [...argsAllowed];
  const excluded = argsExcluded == null ? [] : [...argsExcluded];

  if (configAllowedList.length) {
    if (allowed.length) {
      const forbidden = allowed.filter((value) => !containsValue(configAllowedList, value));
      if (forbidden.length) {
        throw new ConfigError(
          `${allowedName} 请求了配置允许清单之外的值: ${forbidden.join(", ")}`,
          "RESPONSES_FILTER_FORBIDDEN"
        );
      }
      return { allowed, excluded: [] };
    }
    const narrowed = configAllowedList.filter((value) => !containsValue(excluded, value));
    if (!narrowed.length) {
      throw new ConfigError(
        `${excludedName} 排除了配置允许清单中的全部值，结果为空`,
        "RESPONSES_FILTER_EMPTY"
      );
    }
    return { allowed: narrowed, excluded: [] };
  }

  if (!configExcludedList.length) return { allowed, excluded };

  if (allowed.length) {
    const forbidden = allowed.filter((value) => containsValue(configExcludedList, value));
    if (forbidden.length) {
      throw new ConfigError(
        `${allowedName} 请求了配置中已排除的值: ${forbidden.join(", ")}`,
        "RESPONSES_FILTER_FORBIDDEN"
      );
    }
    return { allowed, excluded: [] };
  }

  const merged = dedupeFilterValues([...configExcludedList, ...excluded]);
  if (merged.length > max) {
    throw new ConfigError(
      `配置与命令行的排除项合并后超过 ${max} 个（${merged.length}）；请收敛其中一侧`,
      "RESPONSES_FILTER_LIMIT"
    );
  }
  return { allowed, excluded: merged };
}

function validateExclusiveLists(left, right, leftName, rightName) {
  if (left.length && right.length) {
    throw new ConfigError(`${leftName} 与 ${rightName} 不能同时使用`, "RESPONSES_FILTER_CONFLICT");
  }
}

function validateMaxItems(list, name, max) {
  if (list.length > max) throw new ConfigError(`${name} 最多支持 ${max} 个值`, "RESPONSES_FILTER_LIMIT");
}

/**
 * Only command-line X options imply X search. Configured handle lists and media flags
 * are standing preferences for when X search runs; letting them switch the source on
 * would turn a configured restriction into a billed extra search channel.
 */
function xOptionsRequested(args) {
  return Boolean(
    args.responsesAllowedXHandles?.length ||
      args.responsesExcludedXHandles?.length ||
      args.xFromDate ||
      args.xToDate ||
      args.xImageUnderstanding ||
      args.xVideoUnderstanding
  );
}

function resolveSearchSource(args, config) {
  const requested = args.searchSource || config.responsesSearchSource;
  const source = normalizeSearchSource(requested || "web");
  const explicit = Boolean(requested);
  if (!xOptionsRequested(args) || usesXSearch(source)) return { source, explicit };
  // X-specific filters are meaningless without X search: promote a defaulted source,
  // but never silently override an explicit --source web.
  if (args.searchSource) {
    throw new ConfigError("--source web 与 X 过滤参数（handles / dates / media）冲突", "SEARCH_SOURCE_CONFLICT");
  }
  return { source: "both", explicit };
}

function resolveSearchOptions(args, config) {
  const domainFilters = resolveFilterPair({
    argsAllowed: args.responsesAllowedDomains,
    argsExcluded: args.responsesExcludedDomains,
    configAllowed: config.responsesAllowedDomains,
    configExcluded: config.responsesExcludedDomains,
    allowedName: "responses allowed domains",
    excludedName: "responses excluded domains",
    max: 5,
  });
  const xHandleFilters = resolveFilterPair({
    argsAllowed: args.responsesAllowedXHandles,
    argsExcluded: args.responsesExcludedXHandles,
    configAllowed: config.responsesAllowedXHandles,
    configExcluded: config.responsesExcludedXHandles,
    allowedName: "responses allowed X handles",
    excludedName: "responses excluded X handles",
    max: X_HANDLE_LIMIT,
  });
  const allowedDomains = domainFilters.allowed;
  const excludedDomains = domainFilters.excluded;
  const allowedXHandles = xHandleFilters.allowed;
  const excludedXHandles = xHandleFilters.excluded;

  validateExclusiveLists(allowedDomains, excludedDomains, "responses allowed domains", "responses excluded domains");
  validateExclusiveLists(allowedXHandles, excludedXHandles, "responses allowed X handles", "responses excluded X handles");
  validateMaxItems(allowedDomains, "responses allowed domains", 5);
  validateMaxItems(excludedDomains, "responses excluded domains", 5);
  validateMaxItems(allowedXHandles, "responses allowed X handles", X_HANDLE_LIMIT);
  validateMaxItems(excludedXHandles, "responses excluded X handles", X_HANDLE_LIMIT);

  const source = resolveSearchSource(args, config);

  // The simple options already carry their config defaults (SEARCH_OPTIONS `config`, applied by
  // the command runner); the filters, the source and the X media toggles still need the config
  // beside the flags, since for them a command-line value means more than a configured one.
  return {
    model: args.model,
    maxTurns: args.responsesMaxTurns,
    reasoningEffort: args.responsesReasoningEffort,
    parallelToolCalls: args.responsesParallelToolCalls ?? null,
    allowedDomains,
    excludedDomains,
    searchSource: source.source,
    explicitSearchSource: source.explicit,
    allowedXHandles,
    excludedXHandles,
    xFromDate: args.xFromDate,
    xToDate: args.xToDate,
    xImageUnderstanding: args.xImageUnderstanding ?? config.responsesXImageUnderstanding,
    xVideoUnderstanding: args.xVideoUnderstanding ?? config.responsesXVideoUnderstanding,
    openRouterEngine: normalizeOpenRouterSearchEngine(args.responsesOpenRouterEngine),
    instructions: args.instructions || "",
  };
}

/**
 * OpenRouter attaches x_search to native web search for xAI models with no way to turn
 * either side off, so the requested source is only a hint there. Say so rather than
 * letting the diagnostics claim a mode that was not enforced.
 */
function searchSourceWarnings(searchOptions, config) {
  const warnings = [];
  if (config.apiProvider !== "openrouter") return warnings;

  const { searchSource, openRouterEngine } = searchOptions;
  const nativeCapable = openRouterEngine === "auto" || openRouterEngine === "native";

  if (!usesXSearch(searchSource)) {
    // Only worth saying when the caller actually asked for web-only; on the default path
    // it is unactionable noise on every single OpenRouter search.
    if (nativeCapable && searchOptions.explicitSearchSource) {
      warnings.push("OpenRouter may attach x_search to native web search for xAI models; --source web is not enforced there.");
    }
    return warnings;
  }

  if (!usesWebSearch(searchSource)) {
    warnings.push("OpenRouter cannot run x_search alone; web search stays enabled alongside it.");
  }
  if (!nativeCapable) {
    warnings.push(`OpenRouter engine "${openRouterEngine}" replaces native search, so x_search and its filters do not run.`);
  }
  return warnings;
}

function responsesDiagnosticOptions(searchOptions) {
  return {
    responses_max_turns: searchOptions.maxTurns,
    responses_reasoning_effort: searchOptions.reasoningEffort,
    ...(typeof searchOptions.parallelToolCalls === "boolean" ? { responses_parallel_tool_calls: searchOptions.parallelToolCalls } : {}),
    responses_allowed_domains: searchOptions.allowedDomains,
    responses_excluded_domains: searchOptions.excludedDomains,
    search_source: searchOptions.searchSource,
    ...(usesXSearch(searchOptions.searchSource)
      ? {
          responses_allowed_x_handles: searchOptions.allowedXHandles,
          responses_excluded_x_handles: searchOptions.excludedXHandles,
          ...(searchOptions.xFromDate ? { x_from_date: searchOptions.xFromDate } : {}),
          ...(searchOptions.xToDate ? { x_to_date: searchOptions.xToDate } : {}),
          ...(searchOptions.xImageUnderstanding ? { x_image_understanding: true } : {}),
          ...(searchOptions.xVideoUnderstanding ? { x_video_understanding: true } : {}),
        }
      : {}),
    responses_openrouter_engine: searchOptions.openRouterEngine,
    ...(searchOptions.instructions ? { instructions_chars: searchOptions.instructions.length } : {}),
  };
}

async function grokChannel(args, config, searchOptions, searchGrok) {
  const grok = await searchGrok(args.query, { platform: args.platform, ...searchOptions }, config);
  const warnings = [...grok.warnings];
  if (!grok.sources.length) warnings.push("No responses citations or searched sources were found.");
  return {
    endpoint: grok.endpoint,
    model: grok.model,
    answer: grok.content,
    answer_preamble: grok.preamble ?? null,
    sources: grok.sources,
    tool_calls: grok.tool_calls,
    warnings,
    provider_attempts: [attemptFrom({ provider: `grok-responses:${config.apiProvider}`, ok: true, requests: grok.requests }, { count: grok.sources.length })],
    diagnostics: grok.diagnostics,
    raw_content_chars: grok.content.length,
    raw: grok.raw,
  };
}

/**
 * Only two Grok failures are worth degrading to raw extras for: an exhausted quota (nothing
 * will change until someone pays) and a rate limit that survived the retries. They must be
 * reported as what they are, though; calling a transient 429 "quota exhausted" sends the
 * user to check billing for nothing.
 */
function classifyGrokFailure(error) {
  if (error?.status === 402) return "quota";
  const codeText = [error?.code, error?.upstreamCode, error?.details?.code].filter(Boolean).join(" ");
  if (QUOTA_CODE_PATTERN.test(codeText)) return "quota";
  if (error?.status !== 429) return null;
  return QUOTA_MESSAGE_PATTERN.test(String(error?.message || "")) ? "quota" : "rate_limit";
}

function grokFailureAttempt(config, error) {
  return attemptFrom({ provider: `grok-responses:${config.apiProvider}`, ok: false, error: error.message, requests: error.requests }, { count: 0 });
}

function clipText(value, max = 800) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function degradedAnswer(sources, label) {
  const lines = [
    `> ⚠️ Grok Responses ${label}。以下为 Tavily / Firecrawl 原始搜索结果，未经 Grok 综合生成。`,
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
      const snippet = clipText(source.snippet);
      if (snippet) lines.push(`   ${snippet.replace(/\s+/g, " ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function failureDiagnostics(config, searchOptions, extraOptions, extra, error, { failure = null } = {}) {
  const labels = failure ? GROK_FAILURE_LABELS[failure] : null;
  const warning = labels ? labels.warning : `Responses search failed: ${error.message}`;
  // An empty answer still has usage, cost and a served model on it; only its warnings are
  // merged into ours below.
  const { warnings: _errorWarnings, ...measured } = error?.diagnostics || {};
  return {
    grok_endpoint: "responses",
    ...measured,
    ...(labels ? { grok_error: { code: labels.code, message: error.message } } : {}),
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

/**
 * The Search command: Grok Responses and the extra providers in parallel, the Grok quota
 * fallback, source cards merged, picked and compacted, the answer fitted to the stdout budget,
 * and the run record. Returns the stdout object. `args` are the parsed flags with their config
 * defaults applied (applyConfigDefaults in cli.js); `adapters` are the three search channels,
 * fakes in tests, nothing from the CLI.
 */
export async function runSearch(args, config, adapters = {}) {
  const { grok: searchGrok = searchGrokResponses, tavily = tavilySearch, firecrawl = firecrawlSearch } = adapters;
  const startedAtMs = Date.now();
  const searchOptions = resolveSearchOptions(args, config);
  const sourceChars = args.sourceChars;
  const maxSources = args.maxSources;
  const extraOptions = resolveExtra(args, config, searchOptions.searchSource);
  const grokPromise = grokChannel(args, config, searchOptions, searchGrok).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  const [grokResult, extra] = await Promise.all([
    grokPromise,
    extraSources(
      args.query,
      extraOptions.limit,
      config,
      { allowedDomains: searchOptions.allowedDomains, excludedDomains: searchOptions.excludedDomains },
      { tavily, firecrawl }
    ),
  ]);

  let grok;
  let degraded = false;
  let grokError = null;
  if (grokResult.ok) {
    grok = grokResult.value;
  } else {
    const failure = classifyGrokFailure(grokResult.error);
    if (!failure) {
      grokResult.error.diagnostics = failureDiagnostics(config, searchOptions, extraOptions, extra, grokResult.error);
      throw grokResult.error;
    }
    const labels = GROK_FAILURE_LABELS[failure];
    if (extraOptions.limit <= 0 || !extra.sources.length) {
      const error = new Error(
        extraOptions.mode === "off-x-only"
          ? `Grok Responses ${labels.label}；--source x 下 extra sources 默认关闭（传 --extra N 可开启），无法降级`
          : extraOptions.limit <= 0
            ? `Grok Responses ${labels.label}；extra sources 已显式关闭，无法降级`
            : `Grok Responses ${labels.label}，且 Tavily/Firecrawl 未返回可用结果`
      );
      error.code = labels.errorCode;
      error.diagnostics = failureDiagnostics(config, searchOptions, extraOptions, extra, grokResult.error, { failure });
      throw error;
    }
    degraded = true;
    grokError = { code: labels.code, message: grokResult.error.message };
    grok = {
      endpoint: "responses",
      model: searchOptions.model,
      answer: degradedAnswer(extra.sources, labels.label),
      sources: [],
      tool_calls: [],
      warnings: [
        `${labels.warning} answer.text lists the raw Tavily/Firecrawl results; Grok did not write it.`,
      ],
      provider_attempts: [grokFailureAttempt(config, grokResult.error)],
      diagnostics: {},
      raw_content_chars: 0,
    };
  }

  const warnings = [...searchSourceWarnings(searchOptions, config), ...grok.warnings, ...extra.warnings];
  const providerAttempts = [...grok.provider_attempts, ...extra.provider_attempts];
  const rawGrokSources = grok.sources;
  const rawExtraSources = extra.sources;
  const rawMergedSources = mergeSources(rawGrokSources, rawExtraSources);
  const selected = selectSources(rawMergedSources, {
    maxSources,
    allowedDomains: searchOptions.allowedDomains,
    excludedDomains: searchOptions.excludedDomains,
  });
  const itemsCompact = compactSources(selected.items, { sourceChars });
  const mergedCompactFull = compactSources(rawMergedSources, { sourceChars });

  const createdAt = new Date().toISOString();
  const rawPayload = buildRawSourcesPayload({
    query: args.query,
    grok: rawGrokSources,
    extra: rawExtraSources,
    providerRaw: extra.provider_raw,
    providerAttempts,
    grokToolCalls: grok.tool_calls,
    createdAt,
  });
  const diagnostics = {
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
      // Domain filters are pushed to Tavily/Firecrawl as well; results that still fall
      // outside them are ranked last (see sources.js selectSources).
      extra_domain_filter:
        extraOptions.limit > 0 && (searchOptions.allowedDomains.length || searchOptions.excludedDomains.length) ? "pushed" : "none",
      firecrawl_auth_mode: extraOptions.limit > 0 ? firecrawlAuthMode(config) : null,
      source_chars: sourceChars,
      max_sources: maxSources,
      max_chars: args.maxChars,
      full_sources: args.fullSources,
      ...(getProxyState().mode === "direct" ? {} : { proxy_mode: getProxyState().mode }),
      ...responsesDiagnosticOptions(searchOptions),
    },
    raw_grok_content_chars: grok.raw_content_chars,
    duration_ms: Date.now() - startedAtMs,
    searched_at: createdAt,
  };

  // The run record is the durable copy of this call: full answer, every source (not just the
  // 12 shown), provider raw payloads, tool calls, usage. stdout only carries its path. It is
  // written last, so it also holds what the stdout cut changed.
  const runPath = runRecordPath(config, { kind: "search", label: args.query });
  const sources = {
    items: itemsCompact,
    returned: selected.returned,
    total: selected.total,
    omitted: selected.omitted,
    raw_path: runPath,
  };
  if (args.fullSources) sources.raw = rawPayload;

  const output = {
    query: args.query,
    platform: args.platform || null,
    model: grok.model,
    answer: null,
    sources,
    diagnostics,
  };
  // `--max-chars` counts characters; what the agent's shell keeps is bytes of the whole JSON.
  // With `--full-sources` the raw payload alone can exceed the budget; then nothing is cut.
  // A cut answer ends with a line saying so, for agents that print only answer.text.
  await emitText(config, output, "answer", {
    text: grok.answer,
    maxChars: args.maxChars,
    file: { kind: "search", provider: degraded ? "search-fallback" : "grok-responses", label: args.query, extension: "md" },
    tail: (shown, answer) =>
      answer.truncated ? [`The answer was cut at ${shown.length} of ${answer.original_chars} characters; the full answer is in ${answer.full_path}.`] : [],
    cutWarning: `answer.text keeps only the beginning so the whole output stays under ${STDOUT_BUDGET_BYTES / 1024}KB (agent shell tools cut longer output); the full text is in answer.full_path, read it in chunks.`,
  });

  const written = await writeRunRecord(config, {
    at: runPath,
    record: {
      ...runRecordBase("search", config, createdAt),
      query: args.query,
      instructions: args.instructions || null,
      platform: args.platform || null,
      model: grok.model,
      options: diagnostics.options,
      answer: grok.answer,
      // Text before the answer marker, cut from the answer (null when the model wrote none).
      answer_preamble: grok.answer_preamble ?? null,
      // What stdout carried of the answer: its length and, when cut, where the full text went.
      printed_answer: { chars: output.answer.chars, truncated: output.answer.truncated, full_path: output.answer.full_path },
      sources: {
        grok: rawGrokSources,
        extra: rawExtraSources,
        items: mergedCompactFull,
        returned: selected.returned,
        total: selected.total,
        omitted: selected.omitted,
      },
      provider_raw: rawPayload.provider_raw,
      provider_attempts: providerAttempts,
      grok_tool_calls: grok.tool_calls,
      diagnostics,
      error: null,
      ...(config.debugRaw || args.fullSources ? { grok_raw: grok.raw ?? null } : {}),
    },
  });
  if (!written) sources.raw_path = null;
  return output;
}

/** The run record of a search that failed or hit the deadline. */
export function searchErrorRecord(config, args, output) {
  return {
    ...runRecordBase("search", config, output.diagnostics.searched_at),
    query: args?.query ?? null,
    error: output.error,
    diagnostics: output.diagnostics,
  };
}
