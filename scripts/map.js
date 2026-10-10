#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { startDeadline } from "./lib/deadline.js";
import { cleanupOutputDir, printJson, runRecordBase, writeRunRecord, writeRunRecordSync } from "./lib/output.js";
import { DIRECT_MAP_REQUEST_TIMEOUT_SECONDS, mapUrl } from "./lib/providers.js";
import { assertProxyUsable } from "./lib/proxy.js";

const DEFAULTS = {
  provider: "auto",
  maxDepth: 1,
  maxBreadth: 20,
  limit: 50,
  timeout: 150,
  directTimeout: DIRECT_MAP_REQUEST_TIMEOUT_SECONDS,
  instructions: "",
};

function usage() {
  return `Usage: ./scripts/map.js [--provider auto|tavily|direct] [--instructions TEXT] [--max-depth N] [--max-breadth N] [--limit N] [--timeout SECONDS] [--direct-timeout SECONDS] [--deadline SECONDS] <url>

Discover same-site URLs with Tavily Map or a lightweight Direct Map fallback.

Timeouts:
  --timeout SECONDS         Crawl budget handed to Tavily Map (default 150)
  --direct-timeout SECONDS  Per-request timeout for Direct Map's robots.txt, sitemap and page fetches (default 30)

Environment:
  TAVILY_API_KEY       Optional Tavily Map key
  TAVILY_API_URL       Default: https://api.tavily.com
  GROK_DEADLINE_SECONDS
                       Optional whole-command deadline; default 240, 0 disables
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
  const out = { ...DEFAULTS };
  let url = "";

  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--provider") {
      out.provider = args.shift() || "";
      if (!out.provider) throw new Error("--provider 缺少值");
      continue;
    }
    if (arg?.startsWith("--provider=")) {
      out.provider = arg.slice("--provider=".length);
      continue;
    }
    if (arg === "--instructions") {
      out.instructions = args.shift() || "";
      if (!out.instructions) throw new Error("--instructions 缺少值");
      continue;
    }
    if (arg?.startsWith("--instructions=")) {
      out.instructions = arg.slice("--instructions=".length);
      continue;
    }
    if (arg === "--max-depth") {
      out.maxDepth = parseIntOption("--max-depth", args.shift(), { min: 0 });
      continue;
    }
    if (arg?.startsWith("--max-depth=")) {
      out.maxDepth = parseIntOption("--max-depth", arg.slice("--max-depth=".length), { min: 0 });
      continue;
    }
    if (arg === "--max-breadth") {
      out.maxBreadth = parseIntOption("--max-breadth", args.shift(), { min: 1 });
      continue;
    }
    if (arg?.startsWith("--max-breadth=")) {
      out.maxBreadth = parseIntOption("--max-breadth", arg.slice("--max-breadth=".length), { min: 1 });
      continue;
    }
    if (arg === "--limit") {
      out.limit = parseIntOption("--limit", args.shift(), { min: 1 });
      continue;
    }
    if (arg?.startsWith("--limit=")) {
      out.limit = parseIntOption("--limit", arg.slice("--limit=".length), { min: 1 });
      continue;
    }
    if (arg === "--timeout") {
      out.timeout = parseIntOption("--timeout", args.shift(), { min: 1 });
      continue;
    }
    if (arg?.startsWith("--timeout=")) {
      out.timeout = parseIntOption("--timeout", arg.slice("--timeout=".length), { min: 1 });
      continue;
    }
    if (arg === "--direct-timeout") {
      out.directTimeout = parseIntOption("--direct-timeout", args.shift(), { min: 1 });
      continue;
    }
    if (arg?.startsWith("--direct-timeout=")) {
      out.directTimeout = parseIntOption("--direct-timeout", arg.slice("--direct-timeout=".length), { min: 1 });
      continue;
    }
    if (arg === "--deadline") {
      out.deadline = parseIntOption("--deadline", args.shift(), { min: 0 });
      continue;
    }
    if (arg?.startsWith("--deadline=")) {
      out.deadline = parseIntOption("--deadline", arg.slice("--deadline=".length), { min: 0 });
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`未知参数: ${arg}`);
    if (url) throw new Error(`只能提供一个 URL，多余参数: ${arg}`);
    url = arg;
  }

  if (!["auto", "tavily", "direct"].includes(out.provider)) {
    throw new Error("--provider 只能是 auto、tavily 或 direct");
  }
  if (!url) throw new Error("缺少 URL");

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL 无效: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL 必须使用 http 或 https 协议");

  return { ...out, url: parsed.toString() };
}

function publicResult(args, result, durationMs) {
  const ok = Boolean(result.ok);
  const mappedAt = new Date().toISOString();
  const diagnostics = {
    provider: result.provider,
    response_time: result.response_time ?? null,
    instructions_ignored: Boolean(result.instructions_ignored),
    warnings: result.warnings || [],
    provider_attempts: result.tried || [],
    options: {
      provider: args.provider,
      instructions: args.instructions,
      max_depth: args.maxDepth,
      max_breadth: args.maxBreadth,
      limit: args.limit,
      timeout: args.timeout,
      requestTimeout: args.directTimeout,
      direct_timeout: args.directTimeout,
    },
    duration_ms: durationMs,
    mapped_at: mappedAt,
  };

  if (!ok) {
    return {
      error: {
        message: result.error || "映射失败",
        code: "MAP_ERROR",
      },
      diagnostics,
    };
  }

  return {
    url: args.url,
    base_url: result.base_url || new URL(args.url).origin,
    urls: Array.isArray(result.results) ? result.results : [],
    diagnostics,
  };
}

function errorOutput(error, code) {
  return {
    error: {
      message: error.message,
      code,
    },
    diagnostics: {
      warnings: [],
      provider_attempts: [],
      mapped_at: new Date().toISOString(),
    },
  };
}

function runRecord(config, args, output) {
  return {
    ...runRecordBase("map", config, output.diagnostics.mapped_at),
    url: args?.url ?? null,
    base_url: output.base_url ?? null,
    options: output.diagnostics.options ?? null,
    provider: output.diagnostics.provider ?? null,
    urls: output.urls ?? null,
    provider_attempts: output.diagnostics.provider_attempts,
    warnings: output.diagnostics.warnings,
    diagnostics: output.diagnostics,
    error: output.error ?? null,
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
  config = await loadConfig({ requireGrok: false });
  assertProxyUsable();
  await cleanupOutputDir(config);
  stage = "map";
  const deadlineSeconds = args.deadline ?? config.deadlineSeconds;
  const stopDeadline = startDeadline(deadlineSeconds, () => {
    const error = new Error(`映射总耗时超过 deadline（>${deadlineSeconds}s），已中止`);
    const output = errorOutput(error, "DEADLINE_EXCEEDED");
    const runPath = writeRunRecordSync(config, { kind: "map", label: args.url, record: runRecord(config, args, output) });
    if (runPath) output.diagnostics.run_path = runPath;
    printJson(output);
    console.error(error.message);
    process.exit(1);
  });
  try {
    const startedAtMs = Date.now();
    const result = await mapUrl(args.url, config, args);
    const output = publicResult(args, result, Date.now() - startedAtMs);
    const runPath = await writeRunRecord(config, { kind: "map", label: args.url, record: runRecord(config, args, output) });
    if (runPath) output.diagnostics.run_path = runPath;
    printJson(output);
    if (output.error) {
      console.error(output.error.message);
      process.exitCode = 1;
    }
  } finally {
    stopDeadline();
  }
} catch (error) {
  const code = error.code || (stage === "argument" ? "ARGUMENT_ERROR" : stage === "map" ? "MAP_ERROR" : "RUNTIME_ERROR");
  const output = errorOutput(error, code);
  if (config) {
    const runPath = await writeRunRecord(config, { kind: "map", label: args?.url || "error", record: runRecord(config, args, output) });
    if (runPath) output.diagnostics.run_path = runPath;
  }
  printJson(output);
  console.error(error.message);
  process.exitCode = stage === "argument" ? 2 : 1;
}
