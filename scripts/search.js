#!/usr/bin/env node
import { applyOpenRouterOnlineSuffix, loadConfig } from "./lib/config.js";
import { searchGrok } from "./lib/grok.js";
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
  return `Usage: ./scripts/search.js [--platform NAME] [--model MODEL] [--extra N|--no-extra] [--source-chars N] [--full-sources] [--max-chars N] <query>

Run a Grok/OpenRouter web search and return JSON with answer and sources.

Environment:
  GROK_API_URL         OpenAI-compatible base URL; required
  GROK_API_KEY         API key for GROK_API_URL; required
  GROK_MODEL           Optional default model; default grok-4-fast
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

  return { query, platform, model, extra, extraMode, sourceChars, fullSources, maxChars };
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

async function publicResult(args, config) {
  const model = applyOpenRouterOnlineSuffix(args.model || config.grokModel, config.grokApiUrl);
  const sourceChars = args.sourceChars ?? config.sourceChars;
  const extraOptions = resolveExtra(args, config);
  const grok = await searchGrok(args.query, { platform: args.platform, model }, config);
  const split = splitAnswerAndSources(grok.content);
  if (!split.answer.trim()) throw new Error("Grok 返回内容中没有可显示 answer");

  const warnings = [];
  if (!split.sources.length) warnings.push("No parseable sources found in Grok response.");

  const extra = await extraSources(args.query, extraOptions.limit, config, { explicit: extraOptions.mode === "explicit" });
  warnings.push(...extra.warnings);

  const rawGrokSources = grokSources(split.sources);
  const rawExtraSources = extra.sources;
  const rawMergedSources = mergeSources(rawGrokSources, rawExtraSources);
  const grokCompact = compactSources(rawGrokSources, { sourceChars });
  const extraCompact = compactSources(rawExtraSources, { sourceChars });
  const mergedCompact = compactSources(rawMergedSources, { sourceChars });

  const answerInfo = await previewText(config, {
    kind: "search",
    provider: "grok",
    label: args.query,
    content: split.answer,
    maxChars: args.maxChars,
    extension: "md",
  });
  const createdAt = new Date().toISOString();
  const rawPayload = buildRawSourcesPayload({
    query: args.query,
    grok: rawGrokSources,
    extra: rawExtraSources,
    providerRaw: extra.provider_raw,
    providerAttempts: extra.provider_attempts,
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
      warnings,
      provider_attempts: extra.provider_attempts,
      options: {
        extra: extraOptions.limit,
        extra_mode: extraOptions.mode,
        source_chars: sourceChars,
        max_chars: args.maxChars,
        full_sources: args.fullSources,
      },
      raw_grok_content_chars: grok.content.length,
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
  printJson(errorOutput(error, code));
  console.error(error.message);
  process.exitCode = stage === "argument" ? 2 : 1;
}
