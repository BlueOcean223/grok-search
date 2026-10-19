import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export class ConfigError extends Error {
  constructor(message, code = "CONFIG_ERROR") {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

const DEFAULT_MODEL = "grok-4.3";
export const DEFAULT_SOURCE_CHARS = 400;
export const DEFAULT_MAX_SOURCES = 12;
const DEFAULT_STATE_DIR = path.join(homedir(), ".cache", "grok-search");
const DEFAULT_OUTPUT_DIR = path.join(DEFAULT_STATE_DIR, "outputs");
const DEFAULT_OUTPUT_RETENTION_DAYS = 30;
const API_PROVIDERS = new Set(["xai", "openrouter", "openai-compatible"]);
const OPENROUTER_SEARCH_ENGINES = new Set(["auto", "native", "exa", "firecrawl", "parallel", "perplexity"]);
const SEARCH_SOURCES = new Set(["web", "x", "both"]);
export const X_HANDLE_LIMIT = 20;

/**
 * Every option the environment or the config file can set, except the Grok endpoint, key and
 * provider, which loadConfig checks on its own. `env` is the variable; `fileKeys` are the
 * config-file spellings (the variable's own name is always accepted too; null means the option
 * is environment-only). The environment wins over the file, the file over `default`; a value
 * that does not parse falls back to the default.
 */
const CONFIG_OPTIONS = [
  { key: "grokModel", env: "GROK_MODEL", fileKeys: ["grokModel", "grok_model", "model"], type: "string", default: DEFAULT_MODEL },
  { key: "responsesMaxTurns", env: "GROK_RESPONSES_MAX_TURNS", fileKeys: ["responsesMaxTurns", "responses_max_turns"], type: "int", min: 1, default: 3 },
  // null = not sent; the relay decides. false is a cost lever where the relay passes it through.
  { key: "responsesParallelToolCalls", env: "GROK_RESPONSES_PARALLEL_TOOL_CALLS", fileKeys: ["responsesParallelToolCalls", "responses_parallel_tool_calls"], type: "bool", default: null },
  { key: "responsesReasoningEffort", env: "GROK_RESPONSES_REASONING_EFFORT", fileKeys: ["responsesReasoningEffort", "responses_reasoning_effort"], type: "string", default: "low" },
  { key: "responsesAllowedDomains", env: "GROK_RESPONSES_ALLOWED_DOMAINS", fileKeys: ["responsesAllowedDomains", "responses_allowed_domains"], type: "list" },
  { key: "responsesExcludedDomains", env: "GROK_RESPONSES_EXCLUDED_DOMAINS", fileKeys: ["responsesExcludedDomains", "responses_excluded_domains"], type: "list" },
  { key: "responsesSearchSource", env: "GROK_SEARCH_SOURCE", fileKeys: ["searchSource", "search_source"], type: "string", default: "" },
  { key: "responsesAllowedXHandles", env: "GROK_RESPONSES_ALLOWED_X_HANDLES", fileKeys: ["responsesAllowedXHandles", "responses_allowed_x_handles"], type: "list" },
  { key: "responsesExcludedXHandles", env: "GROK_RESPONSES_EXCLUDED_X_HANDLES", fileKeys: ["responsesExcludedXHandles", "responses_excluded_x_handles"], type: "list" },
  { key: "responsesXImageUnderstanding", env: "GROK_X_IMAGE_UNDERSTANDING", fileKeys: ["xImageUnderstanding", "x_image_understanding"], type: "bool", default: false },
  { key: "responsesXVideoUnderstanding", env: "GROK_X_VIDEO_UNDERSTANDING", fileKeys: ["xVideoUnderstanding", "x_video_understanding"], type: "bool", default: false },
  { key: "responsesOpenRouterEngine", env: "GROK_RESPONSES_OPENROUTER_ENGINE", fileKeys: ["responsesOpenRouterEngine", "responses_openrouter_engine"], type: "string", default: "auto" },
  { key: "tavilyApiUrl", env: "TAVILY_API_URL", fileKeys: ["tavilyApiUrl", "tavily_api_url"], type: "string", default: "https://api.tavily.com" },
  { key: "tavilyApiKey", env: "TAVILY_API_KEY", fileKeys: ["tavilyApiKey", "tavily_api_key"], type: "string" },
  { key: "firecrawlApiUrl", env: "FIRECRAWL_API_URL", fileKeys: ["firecrawlApiUrl", "firecrawl_api_url"], type: "string", default: "https://api.firecrawl.dev/v2" },
  { key: "firecrawlApiKey", env: "FIRECRAWL_API_KEY", fileKeys: ["firecrawlApiKey", "firecrawl_api_key"], type: "string" },
  { key: "sourceChars", env: "GROK_SOURCE_CHARS", fileKeys: ["sourceChars", "source_chars"], type: "int", min: 0, default: DEFAULT_SOURCE_CHARS },
  { key: "maxSources", env: "GROK_MAX_SOURCES", fileKeys: ["maxSources", "max_sources"], type: "int", min: 1, default: DEFAULT_MAX_SOURCES },
  { key: "deadlineSeconds", env: "GROK_DEADLINE_SECONDS", fileKeys: ["deadlineSeconds", "deadline_seconds"], type: "int", min: 0, default: 240 },
  { key: "outputDir", env: "GROK_OUTPUT_DIR", fileKeys: ["outputDir", "output_dir"], type: "path", default: DEFAULT_OUTPUT_DIR },
  // Small cross-command state (provider cooldowns, the fetch cache). Kept outside outputDir so
  // the retention sweep never deletes it.
  { key: "stateDir", env: "GROK_STATE_DIR", fileKeys: ["stateDir", "state_dir"], type: "path", default: DEFAULT_STATE_DIR },
  // One JSON record per command (query, options, answer, sources, usage, errors) so a run can be
  // replayed without a session export. `GROK_RUN_LOG=off` disables it.
  { key: "runLog", env: "GROK_RUN_LOG", fileKeys: ["runLog", "run_log"], type: "bool", default: true },
  // A proxy URL for this tool alone, or off / direct to force direct connections (see proxy.js).
  { key: "proxy", env: "GROK_PROXY", fileKeys: ["proxy"], type: "string" },
  { key: "retryMaxAttempts", env: "GROK_RETRY_MAX_ATTEMPTS", fileKeys: null, type: "int", min: 1, default: 3 },
  { key: "retryMultiplier", env: "GROK_RETRY_MULTIPLIER", fileKeys: null, type: "float", min: 0, default: 1 },
  { key: "retryMaxWait", env: "GROK_RETRY_MAX_WAIT", fileKeys: null, type: "float", min: 0, default: 10 },
  // Also keep the raw Grok Responses body inside the run record.
  { key: "debugRaw", env: "GROK_DEBUG_RAW", fileKeys: null, type: "bool", default: false },
  { key: "debug", env: "GROK_DEBUG", fileKeys: null, type: "bool", default: false },
];

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function parseBoolValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseListValue(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items.map((item) => String(item || "").trim()).filter(Boolean);
}

function configFilePath() {
  return path.join(homedir(), ".config", "grok-search", "config.json");
}

async function loadConfigFile() {
  let text;
  try {
    text = await readFile(configFilePath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return {};
    throw new ConfigError(`无法读取配置文件 ${configFilePath()}: ${error.message}`, "CONFIG_FILE_INVALID");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`配置文件 ${configFilePath()} 不是有效 JSON: ${error.message}`, "CONFIG_FILE_INVALID");
  }
}

function fileValue(fileConfig, keys) {
  for (const key of keys) {
    const value = fileConfig?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function envOrFile(envName, fileConfig, keys) {
  return env(envName) ?? fileValue(fileConfig, [envName, ...keys]);
}

function resolveUserPath(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function inRange(parsed, entry) {
  return Number.isFinite(parsed) && parsed >= (entry.min ?? -Infinity) ? parsed : entry.default;
}

function readOption(entry, fileConfig) {
  const raw = entry.fileKeys ? envOrFile(entry.env, fileConfig, entry.fileKeys) : env(entry.env);
  if (raw == null) return entry.default;
  switch (entry.type) {
    case "int":
      return inRange(Number.parseInt(raw, 10), entry);
    case "float":
      return inRange(Number.parseFloat(raw), entry);
    case "bool":
      return parseBoolValue(raw, entry.default);
    case "list":
      return parseListValue(raw);
    case "path":
      return resolveUserPath(raw);
    default:
      return raw;
  }
}

export function inferApiProvider(grokApiUrl) {
  const normalized = String(grokApiUrl || "").toLowerCase();
  if (normalized.includes("openrouter")) return "openrouter";
  if (normalized.includes("api.x.ai")) return "xai";
  return "openai-compatible";
}

function normalizeApiProvider(value, grokApiUrl) {
  const provider = String(value || inferApiProvider(grokApiUrl)).trim().toLowerCase();
  if (API_PROVIDERS.has(provider)) return provider;
  throw new ConfigError(`GROK_API_PROVIDER 必须是: ${[...API_PROVIDERS].join(", ")}`, "GROK_API_PROVIDER_INVALID");
}

export function normalizeSearchSource(value) {
  const source = String(value || "web").trim().toLowerCase();
  if (SEARCH_SOURCES.has(source)) return source;
  throw new ConfigError(`search source 必须是: ${[...SEARCH_SOURCES].join(", ")}`, "SEARCH_SOURCE_INVALID");
}

export function usesXSearch(searchSource) {
  return searchSource === "x" || searchSource === "both";
}

export function usesWebSearch(searchSource) {
  return searchSource === "web" || searchSource === "both";
}

export function normalizeOpenRouterSearchEngine(value) {
  const engine = String(value || "auto").trim().toLowerCase();
  if (OPENROUTER_SEARCH_ENGINES.has(engine)) return engine;
  throw new ConfigError(
    `GROK_RESPONSES_OPENROUTER_ENGINE 必须是: ${[...OPENROUTER_SEARCH_ENGINES].join(", ")}`,
    "GROK_RESPONSES_OPENROUTER_ENGINE_INVALID"
  );
}

// Options removed after a deprecation window. A truthy value used to change results (it
// attached X search), so ignoring it would fail silently; refuse to start instead. A false or
// missing value never did anything and stays accepted.
const REMOVED_OPTIONS = [
  {
    env: "GROK_RESPONSES_INCLUDE_X_SEARCH",
    keys: ["responsesIncludeXSearch", "responses_include_x_search"],
    replacement: 'searchSource: "both"（或 GROK_SEARCH_SOURCE=both / --source both）',
  },
];

function rejectRemovedOptions(fileConfig) {
  for (const option of REMOVED_OPTIONS) {
    if (!parseBoolValue(envOrFile(option.env, fileConfig, option.keys), false)) continue;
    throw new ConfigError(`${option.keys[0]} / ${option.env} 已移除，请改用 ${option.replacement}`, "CONFIG_OPTION_REMOVED");
  }
}

export async function loadConfig({ requireGrok = false } = {}) {
  const fileConfig = await loadConfigFile();
  rejectRemovedOptions(fileConfig);
  const grokApiUrl = envOrFile("GROK_API_URL", fileConfig, ["grokApiUrl", "grok_api_url", "apiUrl", "api_url"]);
  const grokApiKey = envOrFile("GROK_API_KEY", fileConfig, ["grokApiKey", "grok_api_key", "apiKey", "api_key"]);
  const rawApiProvider = envOrFile("GROK_API_PROVIDER", fileConfig, ["apiProvider", "api_provider", "grokApiProvider", "grok_api_provider"]);

  if (requireGrok && !grokApiUrl) {
    throw new ConfigError("GROK_API_URL 未配置", "GROK_API_URL_MISSING");
  }
  if (requireGrok && !grokApiKey) {
    throw new ConfigError("GROK_API_KEY 未配置", "GROK_API_KEY_MISSING");
  }

  const apiProvider = requireGrok
    ? normalizeApiProvider(rawApiProvider, grokApiUrl)
    : rawApiProvider == null
      ? inferApiProvider(grokApiUrl)
      : String(rawApiProvider).trim().toLowerCase();

  const config = { grokApiUrl, grokApiKey, apiProvider };
  for (const entry of CONFIG_OPTIONS) config[entry.key] = readOption(entry, fileConfig);
  config.outputRetentionDays = DEFAULT_OUTPUT_RETENTION_DAYS;
  return config;
}
