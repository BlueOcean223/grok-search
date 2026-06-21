#!/usr/bin/env node
import { applyOpenRouterOnlineSuffix, loadConfig } from "./lib/config.js";
import { searchGrok } from "./lib/grok.js";
import { cleanupOutputDir, previewText, printJson } from "./lib/output.js";
import { firecrawlSearch, tavilySearch } from "./lib/providers.js";
import { mergeSources, splitAnswerAndSources } from "./lib/sources.js";

const DEFAULT_MAX_CHARS = 30000;

function usage() {
  return `Usage: node scripts/search.js [--platform NAME] [--model MODEL] [--extra N] [--max-chars N] <query>

Run a Grok/OpenRouter web search and return JSON with answer and sources.

Environment:
  GROK_API_URL         OpenAI-compatible base URL; required
  GROK_API_KEY         API key for GROK_API_URL; required
  GROK_MODEL           Optional default model; default grok-4-fast
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
  let extra = 0;
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
      extra = parseIntOption("--extra", args.shift(), { min: 0 });
      continue;
    }
    if (arg?.startsWith("--extra=")) {
      extra = parseIntOption("--extra", arg.slice("--extra=".length), { min: 0 });
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

  return { query, platform, model, extra, maxChars };
}

function grokSources(rawSources) {
  return (rawSources || []).map((source) => ({ provider: "grok", ...source }));
}

async function extraSources(query, limit, config) {
  const warnings = [];
  const extraTried = [];
  const sources = [];

  if (limit <= 0) return { sources, warnings, extra_tried: extraTried };

  if (!config.tavilyApiKey && !config.firecrawlApiKey) {
    warnings.push("--extra requested but neither TAVILY_API_KEY nor FIRECRAWL_API_KEY is configured.");
    extraTried.push(
      { provider: "tavily", ok: false, skipped: true, error: "TAVILY_API_KEY 未配置" },
      { provider: "firecrawl", ok: false, skipped: true, error: "FIRECRAWL_API_KEY 未配置" }
    );
    return { sources, warnings, extra_tried: extraTried };
  }

  let remaining = limit;
  if (config.tavilyApiKey) {
    const result = await tavilySearch(query, remaining, config);
    extraTried.push({
      provider: "tavily",
      ok: result.ok,
      skipped: Boolean(result.skipped),
      error: result.error,
      count: result.sources?.length || 0,
    });
    if (result.ok) {
      sources.push(...result.sources);
      remaining = Math.max(0, limit - sources.length);
    }
  } else {
    extraTried.push({ provider: "tavily", ok: false, skipped: true, error: "TAVILY_API_KEY 未配置" });
  }

  if (remaining > 0 && config.firecrawlApiKey) {
    const result = await firecrawlSearch(query, remaining, config);
    extraTried.push({
      provider: "firecrawl",
      ok: result.ok,
      skipped: Boolean(result.skipped),
      error: result.error,
      count: result.sources?.length || 0,
    });
    if (result.ok) sources.push(...result.sources);
  } else if (remaining > 0) {
    extraTried.push({ provider: "firecrawl", ok: false, skipped: true, error: "FIRECRAWL_API_KEY 未配置" });
  }

  return { sources: sources.slice(0, limit), warnings, extra_tried: extraTried };
}

async function publicResult(args, config) {
  const model = applyOpenRouterOnlineSuffix(args.model || config.grokModel, config.grokApiUrl);
  const grok = await searchGrok(args.query, { platform: args.platform, model }, config);
  const split = splitAnswerAndSources(grok.content);
  if (!split.answer.trim()) throw new Error("Grok 返回内容中没有可显示 answer");
  const warnings = [];
  if (!split.sources.length) warnings.push("No parseable sources found in Grok response.");

  const extra = await extraSources(args.query, args.extra, config);
  warnings.push(...extra.warnings);

  const sources = mergeSources(grokSources(split.sources), extra.sources);
  const answerInfo = await previewText(config, {
    kind: "search",
    provider: "grok",
    label: args.query,
    content: split.answer,
    maxChars: args.maxChars,
    extension: "md",
  });

  return {
    ok: true,
    query: args.query,
    model: grok.model,
    answer: answerInfo.preview,
    sources,
    sources_count: sources.length,
    answer_length: answerInfo.preview.length,
    original_length: answerInfo.original_length,
    truncated: answerInfo.truncated,
    full_output_path: answerInfo.full_output_path,
    raw_content_length: grok.content.length,
    warnings,
    extra_tried: extra.extra_tried,
    searched_at: new Date().toISOString(),
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const config = await loadConfig({ requireGrok: true });
  await cleanupOutputDir(config);
  const output = await publicResult(args, config);
  printJson(output);
} catch (error) {
  printJson({
    ok: false,
    error: error.message,
    warnings: [],
    searched_at: new Date().toISOString(),
  });
  console.error(error.message);
  process.exitCode = 1;
}
