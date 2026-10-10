#!/usr/bin/env node
import { runCommand } from "./lib/cli.js";
import { runRecordBase, writeRunRecord } from "./lib/output.js";
import { DIRECT_MAP_REQUEST_TIMEOUT_SECONDS } from "./lib/direct-map.js";
import { mapUrl } from "./lib/providers.js";

const OPTIONS = {
  provider: {
    flag: "--provider",
    type: "string",
    default: "auto",
    values: ["auto", "tavily", "direct"],
    value: "auto|tavily|direct",
    help: "auto (default): Tavily Map when a key is configured, else Direct Map",
  },
  instructions: { flag: "--instructions", type: "string", value: "TEXT", help: "Natural-language filter for Tavily Map; Direct Map ignores it" },
  maxDepth: { flag: "--max-depth", type: "int", min: 0, default: 1, value: "N", help: "Crawl depth for Tavily Map (default 1); Direct Map reads one level" },
  maxBreadth: { flag: "--max-breadth", type: "int", min: 1, default: 20, value: "N", help: "Links followed per page (default 20)" },
  limit: { flag: "--limit", type: "int", min: 1, default: 50, value: "N", help: "URLs to return (default 50)" },
  timeout: { flag: "--timeout", type: "int", min: 1, default: 150, value: "SECONDS", group: "Timeouts", help: "Crawl budget handed to Tavily Map (default 150)" },
  directTimeout: {
    flag: "--direct-timeout",
    type: "int",
    min: 1,
    default: DIRECT_MAP_REQUEST_TIMEOUT_SECONDS,
    value: "SECONDS",
    group: "Timeouts",
    help: `Per-request timeout for Direct Map's robots.txt, sitemap and page fetches (default ${DIRECT_MAP_REQUEST_TIMEOUT_SECONDS})`,
  },
  deadline: { flag: "--deadline", type: "int", min: 0, value: "SECONDS", group: "Timeouts", config: "deadlineSeconds", help: "Whole-command deadline (default 240; 0 disables)" },
};
const POSITIONAL = { name: "url", type: "url", required: "缺少 URL" };

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
  options: OPTIONS,
  positional: POSITIONAL,
  intro: "Discover same-site URLs with Tavily Map or a lightweight Direct Map fallback.",
  environment: `  TAVILY_API_KEY       Optional Tavily Map key
  TAVILY_API_URL       Default: https://api.tavily.com
  GROK_DEADLINE_SECONDS
                       Optional whole-command deadline; default 240, 0 disables`,
  label: (args) => args.url,
  errorRecord: runRecord,
  run: mapCommand,
});
