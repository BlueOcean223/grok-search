#!/usr/bin/env node
import { parseArgv, runCommand } from "./lib/cli.js";
import { runRecordBase, writeRunRecord } from "./lib/output.js";
import { DIRECT_MAP_REQUEST_TIMEOUT_SECONDS, mapUrl } from "./lib/providers.js";

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

const OPTIONS = {
  provider: { flag: "--provider", type: "string", default: "auto", values: ["auto", "tavily", "direct"] },
  instructions: { flag: "--instructions", type: "string" },
  maxDepth: { flag: "--max-depth", type: "int", min: 0, default: 1 },
  maxBreadth: { flag: "--max-breadth", type: "int", min: 1, default: 20 },
  limit: { flag: "--limit", type: "int", min: 1, default: 50 },
  // --timeout is Tavily's remote crawl budget; --direct-timeout is per request for Direct Map.
  timeout: { flag: "--timeout", type: "int", min: 1, default: 150 },
  directTimeout: { flag: "--direct-timeout", type: "int", min: 1, default: DIRECT_MAP_REQUEST_TIMEOUT_SECONDS },
  deadline: { flag: "--deadline", type: "int", min: 0 },
};

function parseArgs(argv) {
  return parseArgv(argv, { options: OPTIONS, positional: { name: "url", type: "url", required: "缺少 URL" } });
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

async function mapCommand(args, config) {
  const startedAtMs = Date.now();
  const result = await mapUrl(args.url, config, args);
  const output = publicResult(args, result, Date.now() - startedAtMs);
  const runPath = await writeRunRecord(config, { kind: "map", label: args.url, record: runRecord(config, args, output) });
  if (runPath) output.diagnostics.run_path = runPath;
  return output;
}

await runCommand({
  kind: "map",
  usage,
  parseArgs,
  label: (args) => args.url,
  errorRecord: runRecord,
  run: mapCommand,
});
