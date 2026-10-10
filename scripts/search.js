#!/usr/bin/env node
import { parseArgv, runCommand } from "./lib/cli.js";
import { normalizeSearchSource } from "./lib/config.js";
import { runSearch, searchErrorRecord } from "./lib/search.js";

const DEFAULT_MAX_CHARS = 30000;

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

const OPTIONS = {
  instructions: { flag: "--instructions", type: "string" },
  platform: { flag: "--platform", type: "string" },
  model: { flag: "--model", type: "string" },
  responsesMaxTurns: { flag: "--responses-max-turns", type: "int", min: 1 },
  responsesParallelToolCalls: { flag: "--responses-parallel-tool-calls", type: "bool" },
  responsesReasoningEffort: { flag: "--responses-reasoning-effort", type: "string" },
  responsesAllowedDomains: { flag: "--responses-allowed-domains", type: "list" },
  responsesExcludedDomains: { flag: "--responses-excluded-domains", type: "list" },
  // Rejected here so an unknown source fails like every other argument error, before config
  // load and output-dir cleanup.
  searchSource: { flag: "--source", type: "string", validate: normalizeSearchSource },
  // Aliases kept from before --source existed; both mean the "both" mode.
  xSearchAlias: { flags: ["--responses-x-search", "--responses-include-x-search"], type: "const", target: "searchSource", value: "both" },
  xFromDate: { flag: "--x-from-date", type: "date" },
  xToDate: { flag: "--x-to-date", type: "date" },
  xImageUnderstanding: { flag: "--x-images", off: "--no-x-images", type: "toggle" },
  xVideoUnderstanding: { flag: "--x-videos", off: "--no-x-videos", type: "toggle" },
  responsesAllowedXHandles: { flag: "--responses-allowed-x-handles", type: "list" },
  responsesExcludedXHandles: { flag: "--responses-excluded-x-handles", type: "list" },
  responsesOpenRouterEngine: { flag: "--responses-openrouter-engine", type: "string" },
  extra: { flag: "--extra", type: "int", min: 0 },
  noExtra: { flag: "--no-extra", type: "flag" },
  sourceChars: { flag: "--source-chars", type: "int", min: 0 },
  maxSources: { flag: "--max-sources", type: "int", min: 1 },
  deadline: { flag: "--deadline", type: "int", min: 0 },
  fullSources: { flag: "--full-sources", type: "flag" },
  maxChars: { flag: "--max-chars", type: "int", min: 0, default: DEFAULT_MAX_CHARS },
};

function parseArgs(argv) {
  return parseArgv(argv, {
    options: OPTIONS,
    positional: { name: "query", rest: true, required: "缺少 query" },
    finish(args) {
      if (args.extra != null && args.noExtra) throw new Error("--extra 与 --no-extra 不能同时使用");
      if (args.noExtra) args.extra = 0;
      args.extraMode = args.extra === 0 ? "off" : args.extra != null ? "explicit" : "auto";
      delete args.noExtra;
      if (args.xFromDate && args.xToDate && args.xFromDate > args.xToDate) throw new Error("--x-from-date 不能晚于 --x-to-date");
    },
  });
}

await runCommand({
  kind: "search",
  requireGrok: true,
  usage,
  parseArgs,
  label: (args) => args.query,
  errorRecord: searchErrorRecord,
  run: runSearch,
});
