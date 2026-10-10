#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { startDeadline } from "./lib/deadline.js";
import {
  cleanupOutputDir,
  fitTextToStdoutBudget,
  previewText,
  printJson,
  runRecordBase,
  STDOUT_BUDGET_BYTES,
  writeFullOutput,
  writeRunRecord,
  writeRunRecordSync,
} from "./lib/output.js";
import { fetchUrl } from "./lib/providers.js";
import { assertProxyUsable } from "./lib/proxy.js";

const DEFAULT_MAX_CHARS = 12000;

function usage() {
  return `Usage: ./scripts/fetch.js [--provider auto|tavily|firecrawl|direct] [--max-chars N] [--deadline SECONDS] <url>

Fetch a web page as readable text/Markdown using Tavily Extract, Firecrawl Scrape, then Direct Fetch.

Environment:
  TAVILY_API_KEY       Tavily key used by the primary provider
  TAVILY_API_URL       Default: https://api.tavily.com
  FIRECRAWL_API_KEY    Optional Firecrawl key; keyless fallback works without it
  FIRECRAWL_API_URL    Default: https://api.firecrawl.dev/v2
  GROK_DEADLINE_SECONDS
                       Optional whole-command deadline; default 240, 0 disables
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
  let deadline = null;
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
    if (arg === "--deadline") {
      deadline = parseIntOption("--deadline", args.shift(), { min: 0 });
      continue;
    }
    if (arg?.startsWith("--deadline=")) {
      deadline = parseIntOption("--deadline", arg.slice("--deadline=".length), { min: 0 });
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

  return { url: parsed.toString(), provider, maxChars, deadline };
}

// Firecrawl bills ordinary pages at 1 credit; X posts and other JS-heavy pages cost ~30, and
// the keyless tier only has a few dozen per day. Worth a line so the agent can budget.
const HIGH_CREDITS_THRESHOLD = 10;

/**
 * A deep URL that ends on the site's root page is most likely gone: gov.cn sends removed
 * pages to its home page by script, and on 2026-10-04 Firecrawl returned that home page as
 * an ordinary fetch. Too few redirects are on record to call this an error yet.
 */
function landedOnSiteRoot(requestedUrl, finalUrl) {
  if (!finalUrl) return false;
  try {
    return new URL(finalUrl).pathname === "/" && new URL(requestedUrl).pathname !== "/";
  } catch {
    return false;
  }
}

async function publicResult(args, result, config) {
  const ok = Boolean(result.ok);
  const warnings = [...(result.warnings || [])];
  if (ok && result.redirected && landedOnSiteRoot(args.url, result.final_url)) {
    warnings.push(`The page redirected to the site's home page (${result.final_url}); the requested page probably no longer exists.`);
  }
  if (Number.isFinite(result.credits_used) && result.credits_used >= HIGH_CREDITS_THRESHOLD) {
    warnings.push(
      `Firecrawl 本次消耗 ${result.credits_used} credits（普通页面 1 credit）；keyless 免费档几次这样的抓取就会耗尽当日额度，X 原帖优先考虑 Direct。`
    );
  }
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

/** `--max-chars` counts characters; what the agent's shell keeps is bytes of the whole JSON. */
async function fitContentToStdout(config, output, result) {
  const content = output.content;
  const cut = await fitTextToStdoutBudget(output, content, "text", async () => {
    content.full_path ??= await writeFullOutput(config, {
      kind: "fetch",
      provider: result.provider,
      label: output.final_url,
      content: result.content || "",
      extension: "md",
    });
    content.truncated = true;
    output.diagnostics.warnings.push(
      `content.text 只保留开头，让整个输出不超过 ${STDOUT_BUDGET_BYTES / 1024}KB（agent 的 shell 工具会截掉更长的输出）；全文在 content.full_path，分段读。`
    );
  });
  if (cut) content.chars = content.text.length;
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

/** Durable copy of this fetch: full text (not the preview), metadata, every provider tried. */
function runRecord(config, args, output, result) {
  return {
    ...runRecordBase("fetch", config, output.diagnostics.fetched_at),
    url: args?.url ?? null,
    final_url: output.final_url ?? null,
    redirected: Boolean(output.redirected),
    options: output.diagnostics.options ?? null,
    provider: output.diagnostics.provider ?? null,
    metadata: output.metadata ?? {},
    content: result?.ok ? result.content || "" : null,
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
  stage = "fetch";
  const deadlineSeconds = args.deadline ?? config.deadlineSeconds;
  const stopDeadline = startDeadline(deadlineSeconds, () => {
    const error = new Error(`提取总耗时超过 deadline（>${deadlineSeconds}s），已中止`);
    const output = errorOutput(error, "DEADLINE_EXCEEDED");
    const runPath = writeRunRecordSync(config, { kind: "fetch", label: args.url, record: runRecord(config, args, output, null) });
    if (runPath) output.diagnostics.run_path = runPath;
    printJson(output);
    console.error(error.message);
    process.exit(1);
  });
  try {
    const result = await fetchUrl(args.url, config, { provider: args.provider });
    const output = await publicResult(args, result, config);
    const runPath = await writeRunRecord(config, {
      kind: "fetch",
      label: result.final_url || args.url,
      record: runRecord(config, args, output, result),
    });
    if (runPath) output.diagnostics.run_path = runPath;
    if (output.content) await fitContentToStdout(config, output, result);

    printJson(output);
    if (output.error) {
      console.error(output.error.message);
      process.exitCode = 1;
    }
  } finally {
    stopDeadline();
  }
} catch (error) {
  const code = error.code || (stage === "argument" ? "ARGUMENT_ERROR" : stage === "fetch" ? "FETCH_ERROR" : "RUNTIME_ERROR");
  const output = errorOutput(error, code);
  if (config) {
    const runPath = await writeRunRecord(config, { kind: "fetch", label: args?.url || "error", record: runRecord(config, args, output, null) });
    if (runPath) output.diagnostics.run_path = runPath;
  }
  printJson(output);
  console.error(error.message);
  if (stage === "argument") console.error(usage());
  process.exitCode = stage === "argument" ? 2 : 1;
}
