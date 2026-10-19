#!/usr/bin/env node
import { runCommand } from "./lib/cli.js";
import { finishSearchArgs, runSearch, SEARCH_OPTIONS, SEARCH_POSITIONAL, searchErrorRecord } from "./lib/search.js";

await runCommand({
  kind: "search",
  requireGrok: true,
  options: SEARCH_OPTIONS,
  positional: SEARCH_POSITIONAL,
  finish: finishSearchArgs,
  intro: "Run a Responses-compatible Grok/OpenRouter search and return JSON with the answer and its source cards.",
  environment: `  GROK_API_URL         Responses-compatible base URL; required
  GROK_API_KEY         API key for GROK_API_URL; required
  GROK_API_PROVIDER    Optional provider: xai, openrouter, or openai-compatible
  GROK_MODEL           Optional default model; default grok-4.3
  GROK_SEARCH_SOURCE   Optional default search source: web, x, or both; default web
  GROK_RESPONSES_MAX_TURNS
                       Optional Responses max_turns; default 3
  GROK_RESPONSES_PARALLEL_TOOL_CALLS
                       Optional true|false; false makes Grok search one call per turn. Not sent unless set
  GROK_SOURCE_CHARS    Optional source snippet size; default 400
  GROK_MAX_SOURCES     Optional cap on returned source cards; default 12
  GROK_DEADLINE_SECONDS
                       Optional whole-command deadline; default 240, 0 disables
  GROK_OUTPUT_DIR      Optional directory for full answer when preview is truncated`,
  label: (args) => args.query,
  errorRecord: searchErrorRecord,
  run: runSearch,
});
