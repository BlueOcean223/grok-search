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

const DEFAULT_MODEL = "grok-4-fast";
const DEFAULT_EXTRA = 5;
const DEFAULT_SOURCE_CHARS = 400;
const DEFAULT_TAVILY_API_URL = "https://api.tavily.com";
const DEFAULT_FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2";
const DEFAULT_OUTPUT_DIR = path.join(homedir(), ".cache", "grok-search", "outputs");
const DEFAULT_OUTPUT_RETENTION_DAYS = 30;
const DEFAULT_SEARCH_MODE = "chat";
const DEFAULT_RESPONSES_MAX_TURNS = 1;
const DEFAULT_RESPONSES_REASONING_EFFORT = "low";
const DEFAULT_RESPONSES_OPENROUTER_ENGINE = "auto";
const API_PROVIDERS = new Set(["xai", "openrouter", "openai-compatible"]);
const SEARCH_MODES = new Set(["chat", "responses"]);
const OPENROUTER_SEARCH_ENGINES = new Set(["auto", "native", "exa", "firecrawl", "parallel", "perplexity"]);

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function envBool(name, defaultValue = false) {
  const value = env(name);
  if (value == null) return defaultValue;
  return parseBoolValue(value, defaultValue);
}

function envInt(name, defaultValue, { min = Number.MIN_SAFE_INTEGER } = {}) {
  const value = env(name);
  if (value == null) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : defaultValue;
}

function envFloat(name, defaultValue, { min = -Infinity } = {}) {
  const value = env(name);
  if (value == null) return defaultValue;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : defaultValue;
}

function parseConfigInt(value, fallback, { min = Number.MIN_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
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

export function configFilePath() {
  return path.join(homedir(), ".config", "grok-search", "config.json");
}

export async function loadConfigFile() {
  try {
    return JSON.parse(await readFile(configFilePath(), "utf8"));
  } catch {
    return {};
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

function envOrFile(envName, fileConfig, keys, fallback) {
  const envValue = env(envName);
  if (envValue != null) return envValue;
  const configValue = fileValue(fileConfig, keys);
  return configValue == null ? fallback : configValue;
}

function envOrFileInt(envName, fileConfig, keys, fallback, { min = Number.MIN_SAFE_INTEGER } = {}) {
  const envValue = env(envName);
  if (envValue != null) return parseConfigInt(envValue, fallback, { min });
  const configValue = fileValue(fileConfig, keys);
  return configValue == null ? fallback : parseConfigInt(configValue, fallback, { min });
}

function envOrFileBool(envName, fileConfig, keys, fallback) {
  const envValue = env(envName);
  if (envValue != null) return parseBoolValue(envValue, fallback);
  const configValue = fileValue(fileConfig, keys);
  return configValue == null ? fallback : parseBoolValue(configValue, fallback);
}

function envOrFileList(envName, fileConfig, keys, fallback = []) {
  const envValue = env(envName);
  if (envValue != null) return parseListValue(envValue);
  const configValue = fileValue(fileConfig, keys);
  return configValue == null ? fallback : parseListValue(configValue);
}

function resolveUserPath(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function applyOpenRouterOnlineSuffix(model, grokApiUrl) {
  if (isOpenRouterProvider(undefined, grokApiUrl) && !model.includes(":online")) {
    return `${model}:online`;
  }
  return model;
}

export function inferApiProvider(grokApiUrl) {
  const normalized = String(grokApiUrl || "").toLowerCase();
  if (normalized.includes("openrouter")) return "openrouter";
  if (normalized.includes("api.x.ai")) return "xai";
  return "openai-compatible";
}

export function normalizeApiProvider(value, grokApiUrl) {
  const provider = String(value || inferApiProvider(grokApiUrl)).trim().toLowerCase();
  if (API_PROVIDERS.has(provider)) return provider;
  throw new ConfigError(`GROK_API_PROVIDER 必须是: ${[...API_PROVIDERS].join(", ")}`, "GROK_API_PROVIDER_INVALID");
}

export function normalizeSearchMode(value) {
  const mode = String(value || DEFAULT_SEARCH_MODE).trim().toLowerCase();
  if (SEARCH_MODES.has(mode)) return mode;
  throw new ConfigError(`GROK_SEARCH_MODE 必须是: ${[...SEARCH_MODES].join(", ")}`, "GROK_SEARCH_MODE_INVALID");
}

export function normalizeOpenRouterSearchEngine(value) {
  const engine = String(value || DEFAULT_RESPONSES_OPENROUTER_ENGINE).trim().toLowerCase();
  if (OPENROUTER_SEARCH_ENGINES.has(engine)) return engine;
  throw new ConfigError(
    `GROK_RESPONSES_OPENROUTER_ENGINE 必须是: ${[...OPENROUTER_SEARCH_ENGINES].join(", ")}`,
    "GROK_RESPONSES_OPENROUTER_ENGINE_INVALID"
  );
}

export function isOpenRouterProvider(apiProvider, grokApiUrl) {
  return apiProvider === "openrouter" || (!apiProvider && String(grokApiUrl || "").toLowerCase().includes("openrouter"));
}

export function applyChatModelProviderDefaults(model, config) {
  if (isOpenRouterProvider(config?.apiProvider, config?.grokApiUrl) && !model.includes(":online")) {
    return `${model}:online`;
  }
  return model;
}

export async function loadConfig({ requireGrok = false } = {}) {
  const fileConfig = await loadConfigFile();
  const grokApiUrl = envOrFile("GROK_API_URL", fileConfig, ["GROK_API_URL", "grokApiUrl", "grok_api_url", "apiUrl", "api_url"]);
  const grokApiKey = envOrFile("GROK_API_KEY", fileConfig, ["GROK_API_KEY", "grokApiKey", "grok_api_key", "apiKey", "api_key"]);
  const rawApiProvider = envOrFile("GROK_API_PROVIDER", fileConfig, [
    "GROK_API_PROVIDER",
    "apiProvider",
    "api_provider",
    "grokApiProvider",
    "grok_api_provider",
  ]);

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

  const configuredModel = envOrFile("GROK_MODEL", fileConfig, ["GROK_MODEL", "grokModel", "grok_model", "model"], DEFAULT_MODEL);
  const outputDir = resolveUserPath(
    envOrFile("GROK_OUTPUT_DIR", fileConfig, ["GROK_OUTPUT_DIR", "outputDir", "output_dir"], DEFAULT_OUTPUT_DIR)
  );

  return {
    grokApiUrl,
    grokApiKey,
    apiProvider,
    grokModel: configuredModel,
    searchMode: envOrFile("GROK_SEARCH_MODE", fileConfig, ["GROK_SEARCH_MODE", "searchMode", "search_mode"], DEFAULT_SEARCH_MODE),

    responsesMaxTurns: envOrFileInt(
      "GROK_RESPONSES_MAX_TURNS",
      fileConfig,
      ["GROK_RESPONSES_MAX_TURNS", "responsesMaxTurns", "responses_max_turns"],
      DEFAULT_RESPONSES_MAX_TURNS,
      { min: 1 }
    ),
    responsesReasoningEffort: envOrFile(
      "GROK_RESPONSES_REASONING_EFFORT",
      fileConfig,
      ["GROK_RESPONSES_REASONING_EFFORT", "responsesReasoningEffort", "responses_reasoning_effort"],
      DEFAULT_RESPONSES_REASONING_EFFORT
    ),
    responsesAllowedDomains: envOrFileList("GROK_RESPONSES_ALLOWED_DOMAINS", fileConfig, [
      "GROK_RESPONSES_ALLOWED_DOMAINS",
      "responsesAllowedDomains",
      "responses_allowed_domains",
    ]),
    responsesExcludedDomains: envOrFileList("GROK_RESPONSES_EXCLUDED_DOMAINS", fileConfig, [
      "GROK_RESPONSES_EXCLUDED_DOMAINS",
      "responsesExcludedDomains",
      "responses_excluded_domains",
    ]),
    responsesIncludeXSearch: envOrFileBool("GROK_RESPONSES_INCLUDE_X_SEARCH", fileConfig, [
      "GROK_RESPONSES_INCLUDE_X_SEARCH",
      "responsesIncludeXSearch",
      "responses_include_x_search",
    ], false),
    responsesAllowedXHandles: envOrFileList("GROK_RESPONSES_ALLOWED_X_HANDLES", fileConfig, [
      "GROK_RESPONSES_ALLOWED_X_HANDLES",
      "responsesAllowedXHandles",
      "responses_allowed_x_handles",
    ]),
    responsesExcludedXHandles: envOrFileList("GROK_RESPONSES_EXCLUDED_X_HANDLES", fileConfig, [
      "GROK_RESPONSES_EXCLUDED_X_HANDLES",
      "responsesExcludedXHandles",
      "responses_excluded_x_handles",
    ]),
    responsesOpenRouterEngine: envOrFile(
      "GROK_RESPONSES_OPENROUTER_ENGINE",
      fileConfig,
      ["GROK_RESPONSES_OPENROUTER_ENGINE", "responsesOpenRouterEngine", "responses_openrouter_engine"],
      DEFAULT_RESPONSES_OPENROUTER_ENGINE
    ),
    responsesFallbackChat: envOrFileBool("GROK_RESPONSES_FALLBACK_CHAT", fileConfig, [
      "GROK_RESPONSES_FALLBACK_CHAT",
      "responsesFallbackChat",
      "responses_fallback_chat",
    ], false),

    tavilyApiUrl: envOrFile("TAVILY_API_URL", fileConfig, ["TAVILY_API_URL", "tavilyApiUrl", "tavily_api_url"], DEFAULT_TAVILY_API_URL),
    tavilyApiKey: envOrFile("TAVILY_API_KEY", fileConfig, ["TAVILY_API_KEY", "tavilyApiKey", "tavily_api_key"]),

    firecrawlApiUrl: envOrFile(
      "FIRECRAWL_API_URL",
      fileConfig,
      ["FIRECRAWL_API_URL", "firecrawlApiUrl", "firecrawl_api_url"],
      DEFAULT_FIRECRAWL_API_URL
    ),
    firecrawlApiKey: envOrFile("FIRECRAWL_API_KEY", fileConfig, ["FIRECRAWL_API_KEY", "firecrawlApiKey", "firecrawl_api_key"]),

    retryMaxAttempts: envInt("GROK_RETRY_MAX_ATTEMPTS", 3, { min: 1 }),
    retryMultiplier: envFloat("GROK_RETRY_MULTIPLIER", 1, { min: 0 }),
    retryMaxWait: envFloat("GROK_RETRY_MAX_WAIT", 10, { min: 0 }),
    defaultExtra: envOrFileInt("GROK_DEFAULT_EXTRA", fileConfig, ["GROK_DEFAULT_EXTRA", "defaultExtra", "default_extra"], DEFAULT_EXTRA, {
      min: 0,
    }),
    sourceChars: envOrFileInt("GROK_SOURCE_CHARS", fileConfig, ["GROK_SOURCE_CHARS", "sourceChars", "source_chars"], DEFAULT_SOURCE_CHARS, {
      min: 0,
    }),
    outputDir,
    outputRetentionDays: DEFAULT_OUTPUT_RETENTION_DAYS,
    debug: envBool("GROK_DEBUG", false),
  };
}

export function maskSecret(value) {
  if (!value) return "未配置";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}${"*".repeat(value.length - 8)}${value.slice(-4)}`;
}
