#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { startDeadline } from "./lib/deadline.js";
import { FETCH_CACHE_TTL_MS, readFetchCache, writeFetchCache } from "./lib/fetch-cache.js";
import {
  cleanupOutputDir,
  fitTextToStdoutBudget,
  previewText,
  printJson,
  runRecordBase,
  runRecordPath,
  STDOUT_BUDGET_BYTES,
  withNotices,
  writeFullOutput,
  writeRunRecord,
  writeRunRecordSync,
} from "./lib/output.js";
import { fetchUrl } from "./lib/providers.js";
import { assertProxyUsable } from "./lib/proxy.js";

const DEFAULT_MAX_CHARS = 12000;

function usage() {
  return `Usage: ./scripts/fetch.js [--provider auto|tavily|firecrawl|direct] [--max-chars N] [--offset N] [--no-cache] [--deadline SECONDS] <url>

Fetch a web page as readable text/Markdown. auto: Direct when the server sends Markdown or another
non-HTML type (returned as served), otherwise Firecrawl Scrape, then Tavily Extract, then Direct's HTML.

Options:
  --max-chars N        Characters of text to print (default ${DEFAULT_MAX_CHARS}); the full text goes to content.full_path
  --offset N           Start at character N, to continue a page that was cut
  --no-cache           Fetch again even if this URL was fetched in the last ${FETCH_CACHE_TTL_MS / 60000} minutes

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
  let offset = 0;
  let noCache = false;
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
    if (arg === "--offset") {
      offset = parseIntOption("--offset", args.shift(), { min: 0 });
      continue;
    }
    if (arg?.startsWith("--offset=")) {
      offset = parseIntOption("--offset", arg.slice("--offset=".length), { min: 0 });
      continue;
    }
    if (arg === "--no-cache") {
      noCache = true;
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

  return { url: parsed.toString(), provider, maxChars, offset, noCache, deadline };
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

/** Warnings that say the text is not what was asked for; they also open content.text. */
function contentNotices(args, result) {
  const notices = [...(result.notices || [])];
  if (result.ok && result.redirected && landedOnSiteRoot(args.url, result.final_url)) {
    notices.push(
      `The page redirected to the site's home page (${result.final_url}); the requested page probably no longer exists, and the text below is that home page.`
    );
  }
  return notices;
}

async function publicResult(args, result, config, durationMs, notices) {
  const ok = Boolean(result.ok);
  const warnings = [...(result.warnings || []), ...notices];
  if (Number.isFinite(result.credits_used) && result.credits_used >= HIGH_CREDITS_THRESHOLD) {
    warnings.push(
      `Firecrawl used ${result.credits_used} credits on this page (an ordinary page costs 1); a few such fetches use up the keyless tier's daily allowance. For X posts prefer Direct.`
    );
  }
  const fetchedAt = new Date().toISOString();
  const diagnostics = {
    provider: result.provider,
    ...(result.auth_mode ? { firecrawl_auth_mode: result.auth_mode } : {}),
    ...(result.cache ? { cache: result.cache } : {}),
    warnings,
    provider_attempts: result.tried || [],
    options: {
      provider: args.provider,
      max_chars: args.maxChars,
      offset: args.offset,
      no_cache: args.noCache,
    },
    duration_ms: durationMs,
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

  const contentInfo = await previewText(config, {
    kind: "fetch",
    provider: result.provider,
    label: result.final_url || args.url,
    content: result.content || "",
    maxChars: args.maxChars,
    offset: args.offset,
    extension: "md",
  });

  return {
    url: args.url,
    final_url: result.final_url || args.url,
    redirected: Boolean(result.redirected),
    metadata: result.metadata || {},
    content: {
      text: contentInfo.preview,
      offset: contentInfo.offset,
      chars: contentInfo.preview.length,
      original_chars: contentInfo.original_length,
      truncated: contentInfo.truncated,
      full_path: contentInfo.full_output_path,
    },
    diagnostics,
  };
}

/**
 * Where the rest of a cut page is. Agents asked for a larger --max-chars to see past a preview
 * (a CrowdStrike post whose first 29,618 characters were navigation, 2026-10-08), printing the
 * start again; --offset continues from the cut, and the cache makes it free.
 */
function continueNotice(content, shownChars) {
  const end = content.offset + shownChars;
  if (end >= content.original_chars) return null;
  return `Showing characters ${content.offset}–${end} of ${content.original_chars}. For the rest, rerun with --offset ${end} (cached for ${FETCH_CACHE_TTL_MS / 60000} minutes) or read ${content.full_path}.`;
}

/**
 * Put the notices into content.text and keep the whole JSON within the stdout budget:
 * `--max-chars` counts characters, what the agent's shell keeps is bytes of the whole JSON.
 * `content.chars` counts the page text shown, not the notices.
 */
async function finishContent(config, output, result, notices) {
  const content = output.content;
  const requestedOffset = output.diagnostics.options.offset;
  const lead = [...notices];
  if (requestedOffset > content.original_chars) {
    lead.push(`--offset ${requestedOffset} is past the end of the text, which has ${content.original_chars} characters.`);
    output.diagnostics.warnings.push(lead.at(-1));
  }
  const compose = (text) => withNotices(text, { lead, tail: [continueNotice(content, text.length)].filter(Boolean) });
  const kept = await fitTextToStdoutBudget(
    output,
    content,
    "text",
    async () => {
      content.full_path ??= await writeFullOutput(config, {
        kind: "fetch",
        provider: result.provider,
        label: output.final_url,
        content: result.content || "",
        extension: "md",
      });
      content.truncated = true;
      output.diagnostics.warnings.push(
        `content.text was cut to keep the whole output under ${STDOUT_BUDGET_BYTES / 1024}KB (agent shell tools cut longer output); its last line gives the --offset to continue from, and content.full_path has the full text.`
      );
    },
    { compose }
  );
  if (kept != null) content.chars = kept.length;
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
    // What stdout carried of it: the preview length and, when cut, where the full text went.
    printed_content: output.content
      ? {
          offset: output.content.offset,
          chars: output.content.chars,
          truncated: output.content.truncated,
          full_path: output.content.full_path,
        }
      : null,
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
    const startedAtMs = Date.now();
    const cached = args.noCache ? null : await readFetchCache(config, args.url, args.provider);
    const result = cached ?? (await fetchUrl(args.url, config, { provider: args.provider }));
    if (!cached) await writeFetchCache(config, args.url, args.provider, result);
    const notices = contentNotices(args, result);
    const output = await publicResult(args, result, config, Date.now() - startedAtMs, notices);
    const runPath = runRecordPath(config, { kind: "fetch", label: result.final_url || args.url });
    if (runPath) output.diagnostics.run_path = runPath;
    if (output.content) await finishContent(config, output, result, notices);
    if (!(await writeRunRecord(config, { at: runPath, record: runRecord(config, args, output, result) }))) {
      delete output.diagnostics.run_path;
    }

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
