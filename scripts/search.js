#!/usr/bin/env node
import {
  ConfigError,
  X_HANDLE_LIMIT,
  loadConfig,
  normalizeOpenRouterSearchEngine,
  normalizeSearchSource,
  usesWebSearch,
  usesXSearch,
} from "./lib/config.js";
import { activeFirecrawlCooldown, cooldownSkipMessage } from "./lib/cooldown.js";
import { startDeadline } from "./lib/deadline.js";
import { searchGrokResponses } from "./lib/grok-responses.js";
import {
  cleanupOutputDir,
  fitTextToStdoutBudget,
  previewText,
  printJson,
  runRecordBase,
  runRecordPath,
  STDOUT_BUDGET_BYTES,
  writeFullOutput,
  writeRunRecord,
  writeRunRecordSync,
} from "./lib/output.js";
import { SEARCH_BUDGET_TOTAL, SEARCH_BUDGET_X } from "./lib/prompts.js";
import { firecrawlAuthMode, firecrawlSearch } from "./lib/firecrawl.js";
import { tavilySearch } from "./lib/tavily.js";
import { assertProxyUsable, getProxyState } from "./lib/proxy.js";
import { buildRawSourcesPayload, compactSources, isOffDomainExtra, mergeSources, selectSources } from "./lib/sources.js";

const DEFAULT_MAX_CHARS = 30000;
const QUOTA_CODE_PATTERN = /insufficient[_-]?quota|quota[_-]?exhausted|credits?[_-]?exhausted|insufficient[_-]?credits?|payment[_-]?required/i;
const QUOTA_MESSAGE_PATTERN = /quota|credits?|balance|billing|insufficient|额度|余额|计费/i;
const GROK_FAILURE_LABELS = {
  quota: { code: "QUOTA_EXHAUSTED", errorCode: "GROK_QUOTA_EXHAUSTED", label: "额度已耗尽", warning: "Grok Responses quota was exhausted." },
  rate_limit: { code: "RATE_LIMITED", errorCode: "GROK_RATE_LIMITED", label: "触发限流", warning: "Grok Responses was rate limited." },
};

function usage() {
  return `Usage: ./scripts/search.js [--source web|x|both] [--instructions TEXT] [--platform NAME] [--model MODEL] [--extra N|--no-extra] [--source-chars N] [--max-sources N] [--full-sources] [--max-chars N] [--deadline SECONDS] <query>

Run a Responses-compatible Grok/OpenRouter search and return JSON with independent Tavily/Firecrawl sources.

Cost:
  --responses-parallel-tool-calls false
                       Ask Grok for one server-side tool call per turn. Cuts X search calls
                       several-fold on relays that honor it; check diagnostics.responses_tool_calls.

Research instructions:
  --instructions TEXT  What Grok should return (fields, language, what to leave out). Only
                       Grok sees it; Tavily/Firecrawl still search the plain query.

Search sources:
  --source web         Grok web_search only (default)
  --source x           Grok x_search only; search X posts, profiles, and threads
  --source both        Grok decides between web_search and x_search
  --x-from-date DATE   Restrict X posts to on/after DATE (YYYY-MM-DD); implies X search
  --x-to-date DATE     Restrict X posts to on/before DATE (YYYY-MM-DD); implies X search
  --x-images           Analyze images in X posts; billed as extra tokens
  --x-videos           Analyze videos in X posts; billed as extra tokens
  --no-x-images        Turn off image analysis enabled in config
  --no-x-videos        Turn off video analysis enabled in config

Environment:
  GROK_API_URL         Responses-compatible base URL; required
  GROK_API_KEY         API key for GROK_API_URL; required
  GROK_API_PROVIDER    Optional provider: xai, openrouter, or openai-compatible
  GROK_MODEL           Optional default model; default grok-4.3
  GROK_SEARCH_SOURCE   Optional default search source: web, x, or both; default web
  GROK_RESPONSES_MAX_TURNS
                       Optional Responses max_turns; default 3
  GROK_RESPONSES_PARALLEL_TOOL_CALLS
                       Optional true|false; false makes Grok search one call per turn. Not sent unless set
  GROK_DEFAULT_EXTRA   Optional total Tavily/Firecrawl source count; default 6
  GROK_SOURCE_CHARS    Optional source snippet size; default 400
  GROK_MAX_SOURCES     Optional cap on returned source cards; default 12
  GROK_DEADLINE_SECONDS
                       Optional whole-command deadline; default 240, 0 disables
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

function parseDateOption(name, value) {
  const date = String(value || "").trim();
  if (!date) throw new Error(`${name} 缺少值`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${name} 必须是 ISO8601 日期（YYYY-MM-DD）`);
  // Date.parse rolls overflowing days over (2026-02-30 becomes Mar 2) instead of failing,
  // so compare the round-trip rather than just checking for NaN.
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`${name} 不是有效日期: ${date}`);
  }
  return date;
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
  let maxSources = null;
  let fullSources = false;
  let maxChars = DEFAULT_MAX_CHARS;
  let deadline = null;
  let responsesMaxTurns = null;
  let responsesReasoningEffort = "";
  let responsesParallelToolCalls = null;
  let responsesAllowedDomains = null;
  let responsesExcludedDomains = null;
  let searchSource = "";
  let responsesAllowedXHandles = null;
  let responsesExcludedXHandles = null;
  let xFromDate = "";
  let xToDate = "";
  let xImageUnderstanding = null;
  let xVideoUnderstanding = null;
  let responsesOpenRouterEngine = "";
  let instructions = "";

  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--instructions") {
      instructions = (args.shift() || "").trim();
      if (!instructions) throw new Error("--instructions 缺少值");
      continue;
    }
    if (arg?.startsWith("--instructions=")) {
      instructions = arg.slice("--instructions=".length).trim();
      if (!instructions) throw new Error("--instructions 缺少值");
      continue;
    }
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
    if (arg === "--responses-parallel-tool-calls" || arg?.startsWith("--responses-parallel-tool-calls=")) {
      const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args.shift();
      if (!/^(true|false)$/i.test(String(raw || ""))) throw new Error("--responses-parallel-tool-calls 只能是 true 或 false");
      responsesParallelToolCalls = /^true$/i.test(raw);
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
    if (arg === "--source") {
      searchSource = args.shift() || "";
      if (!searchSource) throw new Error("--source 缺少值");
      continue;
    }
    if (arg?.startsWith("--source=")) {
      searchSource = arg.slice("--source=".length);
      if (!searchSource) throw new Error("--source 缺少值");
      continue;
    }
    // Aliases kept from before --source existed; both mean the "both" mode.
    if (arg === "--responses-x-search" || arg === "--responses-include-x-search") {
      searchSource = "both";
      continue;
    }
    if (arg === "--x-from-date") {
      xFromDate = parseDateOption("--x-from-date", args.shift());
      continue;
    }
    if (arg?.startsWith("--x-from-date=")) {
      xFromDate = parseDateOption("--x-from-date", arg.slice("--x-from-date=".length));
      continue;
    }
    if (arg === "--x-to-date") {
      xToDate = parseDateOption("--x-to-date", args.shift());
      continue;
    }
    if (arg?.startsWith("--x-to-date=")) {
      xToDate = parseDateOption("--x-to-date", arg.slice("--x-to-date=".length));
      continue;
    }
    if (arg === "--x-images") {
      xImageUnderstanding = true;
      continue;
    }
    if (arg === "--no-x-images") {
      xImageUnderstanding = false;
      continue;
    }
    if (arg === "--x-videos") {
      xVideoUnderstanding = true;
      continue;
    }
    if (arg === "--no-x-videos") {
      xVideoUnderstanding = false;
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
    if (arg === "--max-sources") {
      maxSources = parseIntOption("--max-sources", args.shift(), { min: 1 });
      continue;
    }
    if (arg?.startsWith("--max-sources=")) {
      maxSources = parseIntOption("--max-sources", arg.slice("--max-sources=".length), { min: 1 });
      continue;
    }
    if (arg === "--deadline") {
      deadline = parseIntOption("--deadline", args.shift(), { min: 0 });
      continue;
    }
    if (arg?.startsWith("--deadline=")) {
      deadline = parseIntOption("--deadline", arg.slice("--deadline=".length), { min: 0 });
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
  if (xFromDate && xToDate && xFromDate > xToDate) throw new Error("--x-from-date 不能晚于 --x-to-date");
  // Reject an unknown source here so it fails like every other argument error, instead of
  // after config load and output-dir cleanup.
  if (searchSource) normalizeSearchSource(searchSource);

  return {
    query,
    platform,
    model,
    extra,
    extraMode,
    sourceChars,
    maxSources,
    fullSources,
    maxChars,
    deadline,
    responsesMaxTurns,
    responsesReasoningEffort,
    responsesParallelToolCalls,
    responsesAllowedDomains,
    responsesExcludedDomains,
    searchSource,
    responsesAllowedXHandles,
    responsesExcludedXHandles,
    xFromDate,
    xToDate,
    xImageUnderstanding,
    xVideoUnderstanding,
    responsesOpenRouterEngine,
    instructions,
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
    ...(Number.isFinite(result.requests) ? { requests: result.requests } : {}),
    ...(Number.isFinite(result.duration_ms) ? { duration_ms: result.duration_ms } : {}),
    ...(result.quota_exhausted ? { quota_exhausted: true } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

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
async function extraSources(query, limit, config, filters = {}) {
  const warnings = [];
  const providerRaw = {};
  if (limit <= 0) {
    return { sources: [], warnings, provider_attempts: [], provider_raw: providerRaw, allocation: { tavily: 0, firecrawl: 0 } };
  }

  const firecrawlMode = firecrawlAuthMode(config);
  const cooldown = await activeFirecrawlCooldown(config, firecrawlMode);
  const allocation = extraAllocation(limit, config, { firecrawlAvailable: !cooldown });

  // Timed per provider so the attempt says which side made the caller wait.
  const timed = async (job) => {
    const started = performance.now();
    const result = await job;
    return { ...result, duration_ms: Math.round(performance.now() - started) };
  };
  const jobs = [];
  if (allocation.tavily > 0) jobs.push(timed(tavilySearch(query, allocation.tavily, config, filters)));
  if (allocation.firecrawl > 0) jobs.push(timed(firecrawlSearch(query, allocation.firecrawl, config, filters)));
  const results = await Promise.all(jobs);
  const sources = [];
  const providerAttempts = [];

  const hasFilters = Boolean(filters.allowedDomains?.length || filters.excludedDomains?.length);
  for (const result of results) {
    const attempt = providerAttempt(result);
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
    providerAttempts.push({ provider: "firecrawl", ok: false, count: 0, skipped: true, auth_mode: firecrawlMode, error: message });
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

  return {
    model: args.model || config.grokModel,
    maxTurns: args.responsesMaxTurns ?? config.responsesMaxTurns,
    reasoningEffort: args.responsesReasoningEffort || config.responsesReasoningEffort,
    parallelToolCalls: args.responsesParallelToolCalls ?? config.responsesParallelToolCalls ?? null,
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
    openRouterEngine: normalizeOpenRouterSearchEngine(args.responsesOpenRouterEngine || config.responsesOpenRouterEngine),
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

async function grokChannel(args, config, searchOptions) {
  const grok = await searchGrokResponses(
    args.query,
    {
      platform: args.platform,
      model: searchOptions.model,
      maxTurns: searchOptions.maxTurns,
      reasoningEffort: searchOptions.reasoningEffort,
      parallelToolCalls: searchOptions.parallelToolCalls,
      allowedDomains: searchOptions.allowedDomains,
      excludedDomains: searchOptions.excludedDomains,
      searchSource: searchOptions.searchSource,
      allowedXHandles: searchOptions.allowedXHandles,
      excludedXHandles: searchOptions.excludedXHandles,
      xFromDate: searchOptions.xFromDate,
      xToDate: searchOptions.xToDate,
      xImageUnderstanding: searchOptions.xImageUnderstanding,
      xVideoUnderstanding: searchOptions.xVideoUnderstanding,
      openRouterEngine: searchOptions.openRouterEngine,
      instructions: searchOptions.instructions,
    },
    config
  );
  const diagnostics = { ...(grok.diagnostics || {}) };
  const warnings = [...(diagnostics.warnings || [])];
  delete diagnostics.warnings;
  const toolCalls = Array.isArray(diagnostics.responses_tool_calls) ? diagnostics.responses_tool_calls : [];
  const toolCallTotal = diagnostics.responses_tool_call_total ?? toolCalls.length;
  const toolCallCounts = diagnostics.responses_tool_call_counts ?? null;
  delete diagnostics.responses_tool_call_total;
  delete diagnostics.responses_tool_call_counts;
  diagnostics.responses_tool_calls = summarizeToolCalls(toolCalls, toolCallTotal, toolCallCounts);
  diagnostics.search_budget = searchBudget(searchOptions.searchSource, diagnostics, toolCalls);
  if (!grok.sources.length) warnings.push("No responses citations or searched sources were found.");
  return {
    endpoint: grok.endpoint,
    model: grok.model,
    answer: grok.content,
    answer_preamble: grok.preamble ?? null,
    sources: grok.sources,
    tool_calls: toolCalls,
    warnings,
    provider_attempts: [{ provider: `grok-responses:${config.apiProvider}`, ok: true, count: grok.sources.length, requests: grok.requests }],
    diagnostics,
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
  return {
    provider: `grok-responses:${config.apiProvider}`,
    ok: false,
    count: 0,
    error: error.message,
    ...(error.requests == null ? {} : { requests: error.requests }),
  };
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
      const snippet = clipText(source.snippet || source.description || source.content);
      if (snippet) lines.push(`   ${snippet.replace(/\s+/g, " ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function failureDiagnostics(config, searchOptions, extraOptions, extra, error, { failure = null } = {}) {
  const labels = failure ? GROK_FAILURE_LABELS[failure] : null;
  const warning = labels ? labels.warning : `Responses search failed: ${error.message}`;
  return {
    grok_endpoint: "responses",
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

async function publicResult(args, config) {
  const startedAtMs = Date.now();
  const searchOptions = resolveSearchOptions(args, config);
  const sourceChars = args.sourceChars ?? config.sourceChars;
  const maxSources = args.maxSources ?? config.maxSources;
  const extraOptions = resolveExtra(args, config, searchOptions.searchSource);
  const grokPromise = grokChannel(args, config, searchOptions).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  const [grokResult, extra] = await Promise.all([
    grokPromise,
    extraSources(args.query, extraOptions.limit, config, {
      allowedDomains: searchOptions.allowedDomains,
      excludedDomains: searchOptions.excludedDomains,
    }),
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
    answer: {
      text: answerInfo.preview,
      chars: answerInfo.preview.length,
      original_chars: answerInfo.original_length,
      truncated: answerInfo.truncated,
      full_path: answerInfo.full_output_path,
    },
    sources,
    diagnostics,
  };
  // `--max-chars` counts characters; what the agent's shell keeps is bytes of the whole JSON.
  // With `--full-sources` the raw payload alone can exceed the budget; then nothing is cut.
  const cut = await fitTextToStdoutBudget(output, output.answer, "text", async () => {
    output.answer.full_path ??= await writeFullOutput(config, {
      kind: "search",
      provider: degraded ? "search-fallback" : "grok-responses",
      label: args.query,
      content: grok.answer,
      extension: "md",
    });
    output.answer.truncated = true;
    warnings.push(
      `answer.text keeps only the beginning so the whole output stays under ${STDOUT_BUDGET_BYTES / 1024}KB (agent shell tools cut longer output); the full text is in answer.full_path, read it in chunks.`
    );
  });
  if (cut) output.answer.chars = output.answer.text.length;

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

function errorRunRecord(config, args, output) {
  return {
    ...runRecordBase("search", config, output.diagnostics.searched_at),
    query: args?.query ?? null,
    error: output.error,
    diagnostics: output.diagnostics,
  };
}

let stage = "argument";
let args = null;
let config = null;
try {
  args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  stage = "config";
  config = await loadConfig({ requireGrok: true });
  assertProxyUsable();
  await cleanupOutputDir(config);
  stage = "search";
  const deadlineSeconds = args.deadline ?? config.deadlineSeconds;
  const stopDeadline = startDeadline(deadlineSeconds, () => {
    const error = new Error(`搜索总耗时超过 deadline（>${deadlineSeconds}s），已中止`);
    const output = errorOutput(error, "DEADLINE_EXCEEDED");
    const runPath = writeRunRecordSync(config, { kind: "search", label: args.query, record: errorRunRecord(config, args, output) });
    if (runPath) output.diagnostics.run_path = runPath;
    printJson(output);
    console.error(error.message);
    process.exit(1);
  });
  try {
    printJson(await publicResult(args, config));
  } finally {
    stopDeadline();
  }
} catch (error) {
  const code = error.code || (stage === "argument" ? "ARGUMENT_ERROR" : stage === "search" ? "SEARCH_ERROR" : "RUNTIME_ERROR");
  const output = errorOutput(error, code, error.diagnostics);
  if (config) {
    const runPath = await writeRunRecord(config, { kind: "search", label: args?.query || "error", record: errorRunRecord(config, args, output) });
    if (runPath) output.diagnostics.run_path = runPath;
  }
  printJson(output);
  console.error(error.message);
  process.exitCode = stage === "argument" ? 2 : 1;
}
