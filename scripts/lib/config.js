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

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function envBool(name, defaultValue = false) {
  const value = env(name);
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
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

function resolveUserPath(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function applyOpenRouterOnlineSuffix(model, grokApiUrl) {
  if (grokApiUrl && grokApiUrl.includes("openrouter") && !model.includes(":online")) {
    return `${model}:online`;
  }
  return model;
}

export async function loadConfig({ requireGrok = false } = {}) {
  const fileConfig = await loadConfigFile();
  const grokApiUrl = envOrFile("GROK_API_URL", fileConfig, ["GROK_API_URL", "grokApiUrl", "grok_api_url", "apiUrl", "api_url"]);
  const grokApiKey = envOrFile("GROK_API_KEY", fileConfig, ["GROK_API_KEY", "grokApiKey", "grok_api_key", "apiKey", "api_key"]);

  if (requireGrok && !grokApiUrl) {
    throw new ConfigError("GROK_API_URL 未配置", "GROK_API_URL_MISSING");
  }
  if (requireGrok && !grokApiKey) {
    throw new ConfigError("GROK_API_KEY 未配置", "GROK_API_KEY_MISSING");
  }

  const configuredModel = envOrFile("GROK_MODEL", fileConfig, ["GROK_MODEL", "grokModel", "grok_model", "model"], DEFAULT_MODEL);
  const outputDir = resolveUserPath(
    envOrFile("GROK_OUTPUT_DIR", fileConfig, ["GROK_OUTPUT_DIR", "outputDir", "output_dir"], DEFAULT_OUTPUT_DIR)
  );

  return {
    grokApiUrl,
    grokApiKey,
    grokModel: applyOpenRouterOnlineSuffix(configuredModel, grokApiUrl),

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
