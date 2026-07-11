#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { cleanupOutputDir, previewText, printJson } from "./lib/output.js";
import { fetchUrl } from "./lib/providers.js";

const DEFAULT_MAX_CHARS = 12000;

function usage() {
  return `Usage: ./scripts/fetch.js [--provider auto|tavily|firecrawl|direct] [--max-chars N] <url>

Fetch a web page as readable text/Markdown using Tavily Extract, Firecrawl Scrape, then Direct Fetch.

Environment:
  TAVILY_API_KEY       Tavily key used by the primary provider
  TAVILY_API_URL       Default: https://api.tavily.com
  FIRECRAWL_API_KEY    Optional Firecrawl key; keyless fallback works without it
  FIRECRAWL_API_URL    Default: https://api.firecrawl.dev/v2
  GROK_OUTPUT_DIR      Optional directory for full content when preview is truncated
  GROK_RETRY_*         Retry tuning shared with grok-search scripts
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
  let provider = "auto";
  let maxChars = DEFAULT_MAX_CHARS;
  let url;

  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--provider") {
      provider = args.shift();
      continue;
    }
    if (arg?.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
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
    if (arg?.startsWith("-")) {
      throw new Error(`未知参数: ${arg}`);
    }
    if (url) {
      throw new Error(`只能提供一个 URL，多余参数: ${arg}`);
    }
    url = arg;
  }

  if (!url) throw new Error("缺少 URL");
  if (!["auto", "tavily", "firecrawl", "direct"].includes(provider)) {
    throw new Error("--provider 只能是 auto、tavily、firecrawl 或 direct");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL 无效: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL 必须使用 http 或 https 协议");
  }

  return { url: parsed.toString(), provider, maxChars };
}

async function publicResult(args, result, config) {
  const ok = Boolean(result.ok);
  const warnings = [...(result.warnings || [])];
  const fetchedAt = new Date().toISOString();
  const diagnostics = {
    provider: result.provider,
    ...(result.auth_mode ? { firecrawl_auth_mode: result.auth_mode } : {}),
    warnings,
    provider_attempts: result.tried || [],
    options: {
      provider: args.provider,
      max_chars: args.maxChars,
    },
    fetched_at: fetchedAt,
  };

  if (!ok) {
    const error = {
      message: result.error || "提取失败: 所有提取服务均未能获取内容",
      code: "FETCH_ERROR",
    };
    if (result.error_preview != null) error.preview = result.error_preview;

    return {
      error,
      diagnostics,
    };
  }

  const contentInfo = ok
    ? await previewText(config, {
        kind: "fetch",
        provider: result.provider,
        label: result.final_url || args.url,
        content: result.content || "",
        maxChars: args.maxChars,
        extension: "md",
      })
    : { preview: "", truncated: false, original_length: 0, full_output_path: null };

  return {
    url: args.url,
    final_url: result.final_url || args.url,
    redirected: Boolean(result.redirected),
    metadata: result.metadata || {},
    content: {
      text: contentInfo.preview,
      chars: contentInfo.preview.length,
      original_chars: contentInfo.original_length,
      truncated: contentInfo.truncated,
      full_path: contentInfo.full_output_path,
    },
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
      fetched_at: new Date().toISOString(),
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
  const config = await loadConfig({ requireGrok: false });
  await cleanupOutputDir(config);
  stage = "fetch";
  const result = await fetchUrl(args.url, config, { provider: args.provider });
  const output = await publicResult(args, result, config);

  printJson(output);
  if (output.error) {
    console.error(output.error.message);
    process.exitCode = 1;
  }
} catch (error) {
  const code = error.code || (stage === "argument" ? "ARGUMENT_ERROR" : stage === "fetch" ? "FETCH_ERROR" : "RUNTIME_ERROR");
  printJson(errorOutput(error, code));
  console.error(error.message);
  if (stage === "argument") console.error(usage());
  process.exitCode = stage === "argument" ? 2 : 1;
}
