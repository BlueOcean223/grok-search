#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FETCH_CACHE_TTL_MS, readFetchCache, rememberFullPath, writeFetchCache } from "../scripts/lib/fetch-cache.js";

const stateDir = await mkdtemp(path.join(tmpdir(), "grok-search-fetch-cache-"));
const config = { stateDir };
const cacheDir = path.join(stateDir, "fetch-cache");
const url = "https://example.com/post";

// auto served by Tavily: auto and an explicit --provider tavily reuse it; --provider firecrawl
// asks Firecrawl, since the agent switched provider to get a different copy.
await writeFetchCache(config, url, "auto", {
  ok: true,
  provider: "tavily",
  content: "tavily text",
  final_url: url,
  redirected: false,
  metadata: { title: "Post" },
  warnings: ["w"],
  notices: [],
  tried: [{ provider: "tavily", ok: true }],
  credits_used: 3,
  auth_mode: "keyless",
});
let hit = await readFetchCache(config, url, "auto");
assert.equal(hit.content, "tavily text");
assert.equal(hit.provider, "tavily");
assert.deepEqual(hit.metadata, { title: "Post" });
assert.deepEqual(hit.warnings, ["w"]);
assert.deepEqual(hit.tried, []);
assert.equal(hit.cache.hit, true);
assert.equal(typeof hit.cache.age_seconds, "number");
// What it cost the first time is not charged again.
assert.equal(Object.hasOwn(hit, "credits_used"), false);
assert.equal(Object.hasOwn(hit, "auth_mode"), false);
assert.equal((await readFetchCache(config, url, "tavily")).content, "tavily text");
assert.equal(await readFetchCache(config, url, "firecrawl"), null);
assert.equal(await readFetchCache(config, "https://example.com/other", "auto"), null);

// An explicit Firecrawl fetch adds its own entry; auto keeps its own.
await writeFetchCache(config, url, "firecrawl", { ok: true, provider: "firecrawl", content: "firecrawl text" });
assert.equal((await readFetchCache(config, url, "firecrawl")).content, "firecrawl text");
assert.equal((await readFetchCache(config, url, "auto")).content, "tavily text");

// Failures are not written.
assert.equal(await writeFetchCache(config, "https://example.com/down", "auto", { ok: false, provider: "direct", error: "HTTP 503" }), null);
assert.equal(await readFetchCache(config, "https://example.com/down", "auto"), null);
assert.equal((await readdir(cacheDir)).length, 1);
const [postFile] = await readdir(cacheDir);

// Nor are fallbacks, which fetchUrl marks: a result served after an extractor failed, or Direct's
// first copy reused after both did. The failure, such as a Firecrawl 503, may be over by the next call.
const fallbackUrl = "https://example.com/fallback";
assert.equal(
  await writeFetchCache(config, fallbackUrl, "auto", {
    ok: true,
    provider: "direct",
    content: "nav and body",
    tried: [{ provider: "direct", ok: true, reused: true }],
    fallback: true,
  }),
  null
);
assert.equal(
  await writeFetchCache(config, fallbackUrl, "auto", {
    ok: true,
    provider: "tavily",
    content: "tavily text",
    tried: [{ provider: "firecrawl", ok: false, error: "Rate limit exceeded" }, { provider: "tavily", ok: true }],
    fallback: true,
  }),
  null
);
assert.equal(await readFetchCache(config, fallbackUrl, "auto"), null);
// A result fetchUrl did not mark as a fallback is kept.
const keptAt = await writeFetchCache(config, fallbackUrl, "auto", {
  ok: true,
  provider: "firecrawl",
  content: "firecrawl text",
  tried: [{ provider: "direct", ok: false, error: "HTTP 403" }, { provider: "firecrawl", ok: true }],
  fallback: false,
});
assert.equal(typeof keptAt, "string");
assert.equal((await readFetchCache(config, fallbackUrl, "auto")).content, "firecrawl text");

// The file a cut page's full text went to is kept on the entry, so a continuation reuses it,
// as long as the file is still there.
const fullFile = path.join(stateDir, "full.md");
await writeFile(fullFile, "firecrawl text");
await rememberFullPath(config, fallbackUrl, keptAt, fullFile);
assert.equal((await readFetchCache(config, fallbackUrl, "auto")).full_path, fullFile);
assert.equal((await readFetchCache(config, fallbackUrl, "auto")).cache.fetched_at, keptAt);
await unlink(fullFile);
assert.equal(Object.hasOwn(await readFetchCache(config, fallbackUrl, "auto"), "full_path"), false);
for (const name of await readdir(cacheDir)) if (name !== postFile) await unlink(path.join(cacheDir, name));

// Entries older than the lifetime are ignored, and their files swept on the next write.
const [file] = await readdir(cacheDir);
const stored = JSON.parse(await readFile(path.join(cacheDir, file), "utf8"));
const old = new Date(Date.now() - FETCH_CACHE_TTL_MS - 1000).toISOString();
for (const entry of stored.entries) entry.cached_at = old;
await writeFile(path.join(cacheDir, file), JSON.stringify(stored));
assert.equal(await readFetchCache(config, url, "auto"), null);
const staleTime = new Date(Date.now() - FETCH_CACHE_TTL_MS - 1000);
await utimes(path.join(cacheDir, file), staleTime, staleTime);
await writeFetchCache(config, "https://example.com/fresh", "auto", { ok: true, provider: "direct", content: "fresh" });
const left = await readdir(cacheDir);
assert.equal(left.length, 1);
assert.notEqual(left[0], file);
// Windows has no Unix mode bits (every file reads back 0o666); the profile dir's ACL keeps it private.
if (process.platform !== "win32") assert.equal((await stat(path.join(cacheDir, left[0]))).mode & 0o777, 0o600);

// No state dir, no cache.
assert.equal(await readFetchCache({}, url, "auto"), null);
await writeFetchCache({}, url, "auto", { ok: true, provider: "direct", content: "x" });

await rm(stateDir, { recursive: true, force: true });
console.log("fetch cache fixtures ok");
