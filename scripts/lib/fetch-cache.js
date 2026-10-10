import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { debugLog } from "./http.js";

/**
 * Short per-URL cache of fetch results, the same 15 minutes Claude Code's WebFetch keeps.
 *
 * Agents fetch a page again to filter it another way, to see past the preview, or to retry a
 * script of their own that failed. In the Claude Code and pi sessions of 2026-08-27..10-09,
 * 12 of the 109 URLs fetched in a session were fetched again within about three minutes
 * (docs.siliconflow.cn 5 times in 37 seconds), and every repeat paid a provider call.
 * Only successful results are kept, and not fallbacks (`fallback` on fetchUrl's result), so a
 * failure is always retried for real.
 *
 * `auto` reuses what an earlier `auto` fetch of the URL returned. An explicit provider reuses
 * any fresh result that provider produced: asking for Firecrawl after `auto` served Tavily's
 * copy still goes to Firecrawl.
 */

export const FETCH_CACHE_TTL_MS = 15 * 60 * 1000;
const DIR_NAME = "fetch-cache";
// What a cached result carries: the text and how it was obtained, not what it cost.
const CACHED_FIELDS = ["ok", "provider", "content", "final_url", "redirected", "metadata", "warnings", "notices"];

function cacheDir(config) {
  return config?.stateDir ? path.join(config.stateDir, DIR_NAME) : null;
}

function entryPath(dir, url) {
  return path.join(dir, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.json`);
}

async function freshEntries(file, url) {
  let record;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  if (record?.url !== url || !Array.isArray(record.entries)) return [];
  const cutoff = Date.now() - FETCH_CACHE_TTL_MS;
  return record.entries.filter((entry) => entry?.result?.ok && Date.parse(entry.cached_at) > cutoff);
}

// Parallel fetches of one URL each write a whole file; the rename keeps readers from seeing half of one.
async function writeEntries(file, url, entries) {
  const temporary = `${file}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify({ url, entries }), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * A result shaped like `fetchUrl`'s, with `cache` set and no provider attempts; null on a miss.
 * `full_path` is the file an earlier run wrote this text to, when it still exists.
 */
export async function readFetchCache(config, url, provider) {
  const dir = cacheDir(config);
  if (!dir) return null;
  const entries = await freshEntries(entryPath(dir, url), url);
  const entry = entries
    .filter((candidate) => (provider === "auto" ? candidate.requested === "auto" : candidate.result.provider === provider))
    .sort((a, b) => Date.parse(b.cached_at) - Date.parse(a.cached_at))[0];
  if (!entry) return null;
  const fullPath = typeof entry.full_path === "string" && (await fileExists(entry.full_path)) ? entry.full_path : null;
  return {
    ...entry.result,
    tried: [],
    cache: { hit: true, fetched_at: entry.cached_at, age_seconds: Math.round((Date.now() - Date.parse(entry.cached_at)) / 1000) },
    ...(fullPath ? { full_path: fullPath } : {}),
  };
}

/** Returns the entry's `cached_at`, or null when the result was not kept. */
export async function writeFetchCache(config, url, provider, result) {
  const dir = cacheDir(config);
  if (!dir || !result?.ok || result.fallback) return null;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await sweep(dir);
    const file = entryPath(dir, url);
    const kept = Object.fromEntries(CACHED_FIELDS.filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
    const entries = (await freshEntries(file, url)).filter(
      (entry) => !(entry.requested === provider && entry.result.provider === result.provider)
    );
    const cachedAt = new Date().toISOString();
    entries.push({ requested: provider, cached_at: cachedAt, result: kept });
    await writeEntries(file, url, entries);
    return cachedAt;
  } catch (error) {
    debugLog(config, `fetch cache write skipped: ${error.message}`);
    return null;
  }
}

/**
 * Record the file a cut page's full text went to on the entry cached at `cachedAt`, so a run
 * that continues with --offset points at that file instead of writing the text again.
 */
export async function rememberFullPath(config, url, cachedAt, fullPath) {
  const dir = cacheDir(config);
  if (!dir || !cachedAt || !fullPath) return;
  try {
    const file = entryPath(dir, url);
    const entries = await freshEntries(file, url);
    const entry = entries.find((candidate) => candidate.cached_at === cachedAt);
    if (!entry || entry.full_path === fullPath) return;
    entry.full_path = fullPath;
    await writeEntries(file, url, entries);
  } catch (error) {
    debugLog(config, `fetch cache update skipped: ${error.message}`);
  }
}

/** Delete entries (and stray temporary files) older than the cache lifetime. */
async function sweep(dir) {
  const cutoff = Date.now() - FETCH_CACHE_TTL_MS;
  const names = await readdir(dir).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      try {
        if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
      } catch {
        // Another process swept it first.
      }
    })
  );
}
