#!/usr/bin/env node
import { runCommand } from "./lib/cli.js";
import { FETCH_CACHE_TTL_MS, readFetchCache, rememberFullPath, writeFetchCache } from "./lib/fetch-cache.js";
import { emitText, runRecordBase, runRecordPath, STDOUT_BUDGET_BYTES, writeRunRecord } from "./lib/output.js";
import { fetchUrl } from "./lib/providers.js";

const DEFAULT_MAX_CHARS = 12000;

const OPTIONS = {
  provider: {
    flag: "--provider",
    type: "string",
    default: "auto",
    values: ["auto", "tavily", "firecrawl", "deepseek", "direct"],
    value: "auto|tavily|firecrawl|deepseek|direct",
    help: "auto (default): Direct when the server sends Markdown or another non-HTML\ntype, else Firecrawl Scrape, then Tavily Extract, then Direct's HTML; DeepSeek\nFetch only when Direct got no page text",
  },
  maxChars: {
    flag: "--max-chars",
    type: "int",
    min: 0,
    default: DEFAULT_MAX_CHARS,
    value: "N",
    help: `Characters of text to print (default ${DEFAULT_MAX_CHARS}); the full text goes to content.full_path`,
  },
  offset: { flag: "--offset", type: "int", min: 0, default: 0, value: "N", help: "Start at character N, to continue a page that was cut" },
  noCache: { flag: "--no-cache", type: "flag", help: `Fetch again even if this URL was fetched in the last ${FETCH_CACHE_TTL_MS / 60000} minutes` },
  deadline: { flag: "--deadline", type: "int", min: 0, value: "SECONDS", config: "deadlineSeconds", help: "Whole-command deadline (default 240; 0 disables)" },
};
const POSITIONAL = { name: "url", type: "url", required: "缺少 URL" };

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

function publicResult(args, result, durationMs, notices) {
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

  return {
    url: args.url,
    final_url: result.final_url || args.url,
    redirected: Boolean(result.redirected),
    metadata: result.metadata || {},
    // Filled by emitContent once the diagnostics it must fit beside are complete.
    content: null,
    diagnostics,
  };
}

/**
 * Where the rest of a cut page is. Agents asked for a larger --max-chars to see past a preview
 * (a CrowdStrike post whose first 29,618 characters were navigation, 2026-10-08), printing the
 * start again; --offset continues from the cut, and the cache makes it free. `cacheMinutes` is
 * how long the cached copy has left; the line names the cache only while one is there.
 */
function continueNotice(content, shownChars, cacheMinutes) {
  const end = content.offset + shownChars;
  if (end >= content.original_chars) return null;
  const cached = cacheMinutes >= 1 ? ` (cached for ${cacheMinutes} minutes)` : "";
  return `Showing characters ${content.offset}–${end} of ${content.original_chars}. For the rest, rerun with --offset ${end}${cached} or read ${content.full_path}.`;
}

/**
 * content.text for stdout: `--max-chars` characters from `--offset`, the notices that change how to
 * read it, and the whole JSON within the stdout budget. `content.chars` counts the page text shown,
 * not the notices. `cachedAt` is when the cached copy of this text was stored, null when there is none.
 */
async function emitContent(config, output, args, result, notices, cachedAt) {
  const cacheMinutes = cachedAt ? Math.round((Date.parse(cachedAt) + FETCH_CACHE_TTL_MS - Date.now()) / 60000) : 0;
  const warn = (message) => {
    output.diagnostics.warnings.push(message);
    return message;
  };
  await emitText(config, output, "content", {
    text: result.content || "",
    maxChars: args.maxChars,
    offset: args.offset,
    fullPath: result.full_path ?? null,
    file: { kind: "fetch", provider: result.provider, label: output.final_url, extension: "md" },
    lead: (content) => [
      ...notices,
      ...(args.offset > content.original_chars
        ? [warn(`--offset ${args.offset} is past the end of the text, which has ${content.original_chars} characters.`)]
        : []),
      // Offsets count characters of one copy of the page. A new fetch (the cached copy expired, or
      // auto went to another provider this time) may hold different text.
      ...(args.offset > 0 && !result.cache
        ? [
            warn(
              `This is a new fetch of the page, not the cached copy an earlier --offset hint referred to; if the text changed, --offset ${args.offset} does not continue where that fetch stopped.`
            ),
          ]
        : []),
    ],
    tail: (shown, content) => [continueNotice(content, shown.length, cacheMinutes)].filter(Boolean),
    cutWarning: `content.text was cut to keep the whole output under ${STDOUT_BUDGET_BYTES / 1024}KB (agent shell tools cut longer output); its last line gives the --offset to continue from, and content.full_path has the full text.`,
  });
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

async function fetchCommand(args, config) {
  const startedAtMs = Date.now();
  const cached = args.noCache ? null : await readFetchCache(config, args.url, args.provider);
  const result = cached ?? (await fetchUrl(args.url, config, { provider: args.provider }));
  const cachedAt = cached ? cached.cache.fetched_at : await writeFetchCache(config, args.url, args.provider, result);
  const notices = contentNotices(args, result);
  const output = publicResult(args, result, Date.now() - startedAtMs, notices);
  const runPath = runRecordPath(config, { kind: "fetch", label: result.final_url || args.url });
  if (runPath) output.diagnostics.run_path = runPath;
  if (result.ok) await emitContent(config, output, args, result, notices, cachedAt);
  if (output.content?.full_path) await rememberFullPath(config, args.url, cachedAt, output.content.full_path);
  if (!(await writeRunRecord(config, { at: runPath, record: runRecord(config, args, output, result) }))) {
    delete output.diagnostics.run_path;
  }
  return output;
}

await runCommand({
  kind: "fetch",
  options: OPTIONS,
  positional: POSITIONAL,
  intro: "Fetch a web page as readable text/Markdown.",
  environment: `  FIRECRAWL_API_KEY    Optional Firecrawl key; keyless works without it
  FIRECRAWL_API_URL    Default: https://api.firecrawl.dev/v2
  TAVILY_API_KEY       Tavily key for the second extractor
  TAVILY_API_URL       Default: https://api.tavily.com
  DEEPSEEK_API_KEY     DeepSeek key for the last resort when Direct gets no page text
  DEEPSEEK_API_URL     Default: https://api.deepseek.com
  GROK_DEADLINE_SECONDS
                       Optional whole-command deadline; default 240, 0 disables
  GROK_OUTPUT_DIR      Optional directory for full content when preview is truncated
  GROK_RETRY_*         Retry tuning shared with grok-search scripts`,
  label: (args) => args.url,
  errorRecord: (config, args, output) => runRecord(config, args, output, null),
  run: fetchCommand,
});
