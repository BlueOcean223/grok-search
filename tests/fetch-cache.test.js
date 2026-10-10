#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FETCH_CACHE_TTL_MS, readFetchCache, writeFetchCache } from "../scripts/lib/fetch-cache.js";

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
await writeFetchCache(config, "https://example.com/down", "auto", { ok: false, provider: "direct", error: "HTTP 503" });
assert.equal(await readFetchCache(config, "https://example.com/down", "auto"), null);
assert.equal((await readdir(cacheDir)).length, 1);

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
assert.equal((await stat(path.join(cacheDir, left[0]))).mode & 0o777, 0o600);

// No state dir, no cache.
assert.equal(await readFetchCache({}, url, "auto"), null);
await writeFetchCache({}, url, "auto", { ok: true, provider: "direct", content: "x" });

console.log("fetch cache fixtures ok");
