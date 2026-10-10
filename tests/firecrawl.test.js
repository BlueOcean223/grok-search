#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activeFirecrawlCooldown,
  clearFirecrawlCooldown,
  readFirecrawlCooldown,
  recordFirecrawlCooldown,
} from "../scripts/lib/cooldown.js";
import {
  collapseRepeatedLines,
  fetchUrl,
  firecrawlMetadata,
  firecrawlScrape,
  firecrawlSearch,
  githubIssueUrl,
  tavilySearch,
  directFirstForX,
  validateXPostContent,
  xDirectFirstEligible,
} from "../scripts/lib/providers.js";
import { addedProseChars, clearlyFuller, looksThin } from "../scripts/lib/page-text.js";
import { parseXPostUrl } from "../scripts/lib/sources.js";

const stateDir = await mkdtemp(path.join(tmpdir(), "grok-search-state-"));
const baseConfig = {
  retryMaxAttempts: 3,
  retryMultiplier: 0,
  retryMaxWait: 0.05,
  debug: false,
  firecrawlApiKey: "",
  tavilyApiKey: "",
  stateDir,
};

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function readBody(req, callback) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => callback(body ? JSON.parse(body) : {}));
}

const quotaBody = (retryAfterSeconds) =>
  JSON.stringify({
    success: false,
    error: "You've hit Firecrawl's keyless free tier rate limit. To continue now, create a free API key.",
    reason: "credits",
    retry_after_seconds: retryAfterSeconds,
  });

let requests = 0;

// Quota exhausted (429 + reason: credits + a day-long retry_after_seconds): one request, the
// failure is flagged, and a cooldown is recorded for this auth mode.
await withServer(
  (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(429, { "content-type": "application/json" });
    res.end(quotaBody(86361));
  },
  async (base) => {
    const result = await firecrawlScrape("https://x.com/a/status/1", { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(result.ok, false);
    assert.equal(requests, 1);
    assert.equal(result.requests, 1);
    assert.equal(result.quota_exhausted, true);
    assert.equal(typeof result.duration_ms, "number");
    assert.match(result.error, /HTTP 429/);

    const cooldown = await readFirecrawlCooldown(baseConfig);
    assert.equal(cooldown.auth_mode, "keyless");
    assert.equal(cooldown.reason, "credits");
    const remainingMs = Date.parse(cooldown.until) - Date.now();
    assert.equal(remainingMs > 86_000_000 && remainingMs <= 86_361_000, true);
  }
);

// The cooldown is scoped to the auth mode that hit it.
assert.equal((await activeFirecrawlCooldown(baseConfig, "keyless"))?.reason, "credits");
assert.equal(await activeFirecrawlCooldown(baseConfig, "api_key"), null);

// fetchUrl(auto) skips Firecrawl while cooling down and goes straight to Direct.
requests = 0;
await withServer(
  (req, res) => {
    requests += 1;
    req.resume();
    if (req.url.startsWith("/scrape")) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("must not be called during cooldown");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Direct</title><p>Direct content</p>");
  },
  async (base) => {
    const result = await fetchUrl(`${base}/page`, { ...baseConfig, firecrawlApiUrl: base }, { provider: "auto" });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "direct");
    assert.match(result.content, /Direct content/);
    const firecrawlAttempt = result.tried.find((attempt) => attempt.provider === "firecrawl");
    assert.equal(firecrawlAttempt.skipped, true);
    assert.match(firecrawlAttempt.error, /cooldown until/);
    assert.equal(requests, 1);
  }
);

// An explicit --provider firecrawl still makes the request; success clears the cooldown and
// the page metadata is surfaced under stable names.
requests = 0;
await withServer(
  (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        data: {
          markdown: "# Back online",
          metadata: {
            creditsUsed: 1,
            title: "Back online",
            author: "Ada",
            publishedTime: "2026-09-01T00:00:00Z",
            statusCode: 200,
            sourceURL: "https://example.com/back",
            language: "en",
          },
        },
      })
    );
  },
  async (base) => {
    const result = await fetchUrl("https://example.com/back", { ...baseConfig, firecrawlApiUrl: base }, { provider: "firecrawl" });
    assert.equal(result.ok, true);
    assert.equal(requests, 1);
    assert.equal(result.requests, 1);
    assert.equal(result.credits_used, 1);
    assert.deepEqual(result.metadata, {
      title: "Back online",
      author: "Ada",
      published_at: "2026-09-01T00:00:00Z",
      language: "en",
      status: 200,
      source_url: "https://example.com/back",
    });
    assert.equal(result.tried.at(-1).requests, 1);
    assert.equal(await readFirecrawlCooldown(baseConfig), null);
    assert.equal(Object.hasOwn(result, "final_url"), false);
  }
);

// Firecrawl renders whatever the target served and reports the target's status beside it.
// Every page on record with a status of 400 or more was an error page, so it hands over to
// Direct, and the final error names both failures.
await withServer(
  (req, res) => {
    req.resume();
    if (req.url.startsWith("/scrape")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: { markdown: "404\n\n# 页面未找到\n\n抱歉,您访问的页面不存在或已被移动。", metadata: { statusCode: 404, creditsUsed: 1 } },
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<title>Not found</title>");
  },
  async (base) => {
    const scraped = await firecrawlScrape(`${base}/gone`, { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(scraped.ok, false);
    assert.equal(scraped.error, "target page returned HTTP 404");
    assert.match(scraped.error_preview, /页面未找到/);
    assert.equal(scraped.credits_used, 1);

    const fetched = await fetchUrl(`${base}/gone`, { ...baseConfig, firecrawlApiUrl: base }, { provider: "auto" });
    assert.equal(fetched.ok, false);
    assert.deepEqual(
      fetched.tried.map((attempt) => [attempt.provider, attempt.ok]),
      [
        ["tavily", false],
        ["firecrawl", false],
        ["direct", false],
      ]
    );
    assert.match(fetched.error, /firecrawl: target page returned HTTP 404/);
    assert.match(fetched.error, /direct: HTTP 404/);
  }
);

// metadata.url is where Firecrawl's browser ended up. gov.cn sends a removed page to its home
// page by script and Firecrawl reports 200 there (checked 2026-10-10); only this field shows it.
// A fragment alone is not a redirect.
await withServer(
  (req, res) => {
    readBody(req, (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      const landed = body.url.includes("gov.cn") ? "https://www.gov.cn/" : body.url.replace(/#.*$/, "");
      res.end(JSON.stringify({ success: true, data: { markdown: "# Page", metadata: { statusCode: 200, sourceURL: body.url, url: landed } } }));
    });
  },
  async (base) => {
    const moved = await firecrawlScrape("https://www.gov.cn/zhengce/content/202511/content_7038000.htm", { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(moved.ok, true);
    assert.equal(moved.final_url, "https://www.gov.cn/");
    assert.equal(moved.redirected, true);

    const same = await firecrawlScrape("https://example.com/a#part", { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(same.ok, true);
    assert.equal(Object.hasOwn(same, "final_url"), false);
  }
);

// Direct turns an HTML <title> into a "# " line, so a script-only shell still has text. Reddit
// served one on 2026-10-08 and the fetch came back as "# Reddit" with no warning.
await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      req.url === "/shell"
        ? "<html><head><title>Reddit</title></head><body><script>boot()</script></body></html>"
        : "<html><head><title>Post</title></head><body><p>Post body</p></body></html>"
    );
  },
  async (base) => {
    const shell = await fetchUrl(`${base}/shell`, baseConfig, { provider: "direct" });
    assert.equal(shell.ok, true);
    assert.equal(shell.content, "# Reddit");
    assert.equal(shell.warnings.some((warning) => /no text beyond the page title/.test(warning)), true);

    const page = await fetchUrl(`${base}/post`, baseConfig, { provider: "direct" });
    assert.equal(page.ok, true);
    assert.deepEqual(page.warnings, []);
  }
);

// HTTP 200 with malformed JSON: a stable bad body is not retried.
requests = 0;
await withServer(
  (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end("<html>not json</html>");
  },
  async (base) => {
    const result = await firecrawlScrape("https://example.com", { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(result.ok, false);
    assert.equal(requests, 1);
    assert.match(result.error, /不是有效 JSON/);
  }
);

// HTTP 200 with success:false: a definite refusal, returned once with Firecrawl's own reason.
requests = 0;
await withServer(
  (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "This website is not supported" }));
  },
  async (base) => {
    const result = await firecrawlScrape("https://example.com", { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(result.ok, false);
    assert.equal(requests, 1);
    assert.equal(result.error, "This website is not supported");
  }
);

// HTTP 200 with empty markdown is the JS-rendered-page case: retried with a growing waitFor.
requests = 0;
const waits = [];
await withServer(
  (req, res) => {
    requests += 1;
    readBody(req, (body) => {
      waits.push(body.waitFor);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { markdown: "" } }));
    });
  },
  async (base) => {
    const result = await firecrawlScrape("https://example.com", { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(result.ok, false);
    assert.equal(requests, 3);
    assert.equal(result.requests, 3);
    assert.deepEqual(waits, [1500, 3000, 4500]);
    assert.match(result.error, /返回空内容/);
  }
);

// 403 (keyless IP refused) is neither retried nor a quota cooldown.
await clearFirecrawlCooldown(baseConfig);
requests = 0;
await withServer(
  (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "Unfortunately, your IP address looks suspicious" }));
  },
  async (base) => {
    const result = await firecrawlScrape("https://example.com", { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(result.ok, false);
    assert.equal(requests, 1);
    assert.equal(Object.hasOwn(result, "quota_exhausted"), false);
    assert.equal(await readFirecrawlCooldown(baseConfig), null);
  }
);

// 5xx retries live in requestJson; the real request count is reported.
requests = 0;
await withServer(
  (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("down");
  },
  async (base) => {
    const result = await firecrawlScrape("https://example.com", { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(result.ok, false);
    assert.equal(requests, 3);
    assert.equal(result.requests, 3);
  }
);

// A scrape timeout is not retried: three 90s waits would overrun the command deadline.
requests = 0;
await withServer(
  (req) => {
    requests += 1;
    req.resume();
  },
  async (base) => {
    const result = await firecrawlScrape("https://example.com", { ...baseConfig, firecrawlApiUrl: base }, { timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.equal(requests, 1);
    assert.match(result.error, /请求超时/);
  }
);

// firecrawlSearch hitting the quota also records the cooldown, using the shorter wait as is.
requests = 0;
await withServer(
  (req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(429, { "content-type": "application/json" });
    res.end(quotaBody(4567));
  },
  async (base) => {
    const result = await firecrawlSearch("query", 3, { ...baseConfig, firecrawlApiUrl: base });
    assert.equal(result.ok, false);
    assert.equal(result.quota_exhausted, true);
    assert.equal(requests, 1);
    const cooldown = await readFirecrawlCooldown(baseConfig);
    const remainingMs = Date.parse(cooldown.until) - Date.now();
    assert.equal(remainingMs > 4_500_000 && remainingMs <= 4_567_000, true);
  }
);
await clearFirecrawlCooldown(baseConfig);

// Missing retry_after falls back to the default 15 minutes; an absurd one is capped at 24h.
{
  const short = await recordFirecrawlCooldown(baseConfig, { authMode: "keyless", retryAfterMs: null });
  const shortMs = Date.parse(short.until) - Date.now();
  assert.equal(shortMs > 14 * 60 * 1000 && shortMs <= 15 * 60 * 1000, true);
  const capped = await recordFirecrawlCooldown(baseConfig, { authMode: "keyless", retryAfterMs: 10 * 24 * 60 * 60 * 1000 });
  assert.equal(Date.parse(capped.until) - Date.now() <= 24 * 60 * 60 * 1000, true);
  await clearFirecrawlCooldown(baseConfig);
  assert.equal(await readFirecrawlCooldown(baseConfig), null);
}

// Domain filters reach both extra providers in their own vocabulary.
await withServer(
  (req, res) => {
    readBody(req, (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/search") {
        assert.deepEqual(body.includeDomains, ["github.com"]);
        assert.equal(Object.hasOwn(body, "excludeDomains"), false);
        res.end(JSON.stringify({ success: true, data: { web: [] } }));
        return;
      }
      if (req.url === "/tavily/search") {
        assert.deepEqual(body.include_domains, ["github.com"]);
        assert.equal(body.include_domains_mode, "filter");
        assert.equal(Object.hasOwn(body, "exclude_domains"), false);
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      if (req.url === "/excluded/search") {
        assert.deepEqual(body.excludeDomains, ["reddit.com"]);
        assert.equal(Object.hasOwn(body, "includeDomains"), false);
        res.end(JSON.stringify({ success: true, data: { web: [] } }));
        return;
      }
      res.end(JSON.stringify({}));
    });
  },
  async (base) => {
    const filters = { allowedDomains: ["github.com"], excludedDomains: [] };
    const firecrawl = await firecrawlSearch("query", 2, { ...baseConfig, firecrawlApiUrl: base }, filters);
    assert.equal(firecrawl.ok, true);
    const tavily = await tavilySearch("query", 2, { ...baseConfig, tavilyApiKey: "key", tavilyApiUrl: `${base}/tavily` }, filters);
    assert.equal(tavily.ok, true);
    const excluded = await firecrawlSearch(
      "query",
      2,
      { ...baseConfig, firecrawlApiUrl: `${base}/excluded` },
      { allowedDomains: [], excludedDomains: ["reddit.com"] }
    );
    assert.equal(excluded.ok, true);
  }
);

// Metadata normalisation falls back to Open Graph keys and drops what is missing.
assert.deepEqual(
  firecrawlMetadata({
    data: {
      markdown: "x",
      metadata: { "og:title": "OG Title", "article:published_time": "2026-08-17T00:13:16.000Z", statusCode: 200, creditsUsed: 30 },
    },
  }),
  { title: "OG Title", published_at: "2026-08-17T00:13:16.000Z", status: 200 }
);
assert.deepEqual(firecrawlMetadata({ data: { markdown: "x" } }), {});

// X posts: on the keyless tier Direct goes first, but only for URLs that name their author.
assert.equal(xDirectFirstEligible("https://x.com/thsottiaux/status/2089143488696705077", baseConfig, "auto"), true);
assert.equal(xDirectFirstEligible("https://x.com/i/web/status/2089143488696705077", baseConfig, "auto"), false);
assert.equal(xDirectFirstEligible("https://x.com/thsottiaux", baseConfig, "auto"), false);
assert.equal(xDirectFirstEligible("https://example.com/thsottiaux/status/1", baseConfig, "auto"), false);
// Keys no longer change the answer (2026-09-08): Tavily returns the post without a date and
// Firecrawl bills 30 credits, so Direct goes first for every X post; --provider firecrawl opts in.
assert.equal(xDirectFirstEligible("https://x.com/thsottiaux/status/2089143488696705077", { ...baseConfig, firecrawlApiKey: "key" }, "auto"), true);
assert.equal(xDirectFirstEligible("https://x.com/thsottiaux/status/2089143488696705077", { ...baseConfig, tavilyApiKey: "key", firecrawlApiKey: "key" }, "auto"), true);
assert.equal(xDirectFirstEligible("https://x.com/thsottiaux/status/2089143488696705077", { ...baseConfig, firecrawlApiKey: "key" }, "firecrawl"), false);
assert.equal(xDirectFirstEligible("https://x.com/thsottiaux/status/2089143488696705077", baseConfig, "firecrawl"), false);

// Validation needs the handle, a date and post text beyond X's login shell.
const post = { x_handle: "nateberkopec", x_post_id: "2093489508897698124" };
const renderedPost = [
  '# Nate Berkopec on X: "Interesting details here." / X',
  "Post",
  "Log in Sign up",
  "Nate Berkopec",
  "@nateberkopec",
  "Interesting details here. Automatic compaction is triggered at 400k tokens.",
  "12:02 AM · Aug 29, 2026 100.1K Views",
  "Log in or sign up for X",
  "Relevant people",
  "Trending now",
].join("\n");
assert.deepEqual(validateXPostContent(renderedPost, post), { ok: true, missing: [] });
const loginShell = ["# X", "Post", "Log in", "Sign up", "Don’t miss what’s happening", "People on X are the first to know.", "Terms · Privacy · Cookies"].join("\n");
assert.deepEqual(validateXPostContent(loginShell, post), { ok: false, missing: ["handle", "date", "text"] });
assert.deepEqual(validateXPostContent("@nateberkopec\nSome real post text that is long enough.", post), { ok: false, missing: ["date"] });
assert.deepEqual(validateXPostContent("Posted 2026-08-17T00:13:16Z\n@nateberkopec said a thing worth reading.", post), { ok: true, missing: [] });

// X redirects /<anyhandle>/status/<id> to the canonical handle. The page then names the real
// handle, so fetchUrl validates against the final URL, not the one the caller typed. Seen live
// on 2026-09-08: x.com/xai/status/2087942296721559607 -> /kunchenguid/..., page had @kunchenguid.
{
  const requested = directFirstForX("https://x.com/xai/status/2087942296721559607", baseConfig, "auto");
  assert.deepEqual(requested, { x_handle: "xai", x_post_id: "2087942296721559607" });
  const canonical = parseXPostUrl("https://x.com/kunchenguid/status/2087942296721559607");
  const redirectedPage = [
    '# Kun Chen on X: "used grok 4.6 for a full day of real work" / X',
    "Post",
    "Log in Sign up",
    "Kun Chen",
    "@kunchenguid",
    "used grok 4.6 for a full day of real work, here's my unbiased review. first, the good: yes it's fast.",
    "9:41 PM · Aug 13, 2026 · 120K Views",
  ].join("\n");
  assert.deepEqual(validateXPostContent(redirectedPage, requested), { ok: false, missing: ["handle"] });
  assert.deepEqual(validateXPostContent(redirectedPage, canonical), { ok: true, missing: [] });
  // A redirect to a different post id must not be trusted as the same post.
  assert.notEqual(parseXPostUrl("https://x.com/kunchenguid/status/1").x_post_id, requested.x_post_id);
}

// The status page repeats the post three times; long lines are kept once, short ones untouched.
assert.equal(
  collapseRepeatedLines(["Post", "A long line of post text here", "Post", "A long line of post text here", "1.", "1."].join("\n")),
  ["Post", "A long line of post text here", "Post", "1.", "1."].join("\n")
);

// A URL naming a plain-text file goes to Direct first: served as text it comes back verbatim,
// where Tavily Extract returned under 70% of the text for 9 of 41 such files (2026-10-10). A
// file-like URL that serves HTML (github.com/.../blob/x.md) goes on to the usual order, and an
// explicit --provider is left alone.
let tavilyExtracts = 0;
await withServer(
  (req, res) => {
    req.resume();
    if (req.url === "/tavily/extract") {
      tavilyExtracts += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ raw_content: "Tavily's shorter copy" }] }));
      return;
    }
    if (req.url === "/docs/statusline.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(`# Status line\n\n${"full text ".repeat(100)}`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>blob</title><p>GitHub page</p>");
  },
  async (base) => {
    const config = { ...baseConfig, tavilyApiKey: "tavily-key", tavilyApiUrl: `${base}/tavily`, firecrawlApiUrl: base, retryMaxAttempts: 1 };
    const file = await fetchUrl(`${base}/docs/statusline.md`, config, { provider: "auto" });
    assert.equal(file.provider, "direct");
    assert.match(file.content, /full text/);
    assert.deepEqual(file.tried, [{ provider: "direct", ok: true, skipped: false, direct_first: "plain_text" }]);
    assert.equal(tavilyExtracts, 0);

    // Tavily's copy here is thin, so it is also compared with the HTML Direct already has.
    const blob = await fetchUrl(`${base}/o/r/blob/main/x.md`, config, { provider: "auto" });
    assert.equal(blob.provider, "tavily");
    assert.deepEqual(
      blob.tried.map((attempt) => [attempt.provider, attempt.ok]),
      [
        ["direct", false],
        ["tavily", true],
        ["direct", false],
      ]
    );
    assert.match(blob.tried[0].error, /served text\/html, not plain text/);
    assert.equal(blob.tried[2].reused, true);

    const named = await fetchUrl(`${base}/docs/statusline.md`, config, { provider: "tavily" });
    assert.equal(named.provider, "tavily");
  }
);

// GitHub issue pages go to Direct first too, and its HTML is taken: Tavily lost body sections
// or comments on all 8 issue pages it served (2026-10-10). Pull requests and other GitHub
// pages are not included.
assert.equal(githubIssueUrl("https://github.com/openclaw/openclaw/issues/91956"), true);
assert.equal(githubIssueUrl("https://github.com/o/r/issues/12#issuecomment-3"), true);
assert.equal(githubIssueUrl("https://github.com/o/r/issues/12?q=1"), true);
assert.equal(githubIssueUrl("https://github.com/o/r/issues"), false);
assert.equal(githubIssueUrl("https://github.com/o/r/issues/new"), false);
assert.equal(githubIssueUrl("https://github.com/o/r/pull/12"), false);
assert.equal(githubIssueUrl("https://github.com/o/r/issues/12x"), false);
{
  let tavilyCalls = 0;
  await withServer(
    (req, res) => {
      req.resume();
      if (req.url === "/tavily/extract") {
        tavilyCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: [{ raw_content: "Tavily copy" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<title>Issue 91956</title><p>The issue body and every comment.</p>");
    },
    async (base) => {
      // directFetch uses the global fetch; send github.com to the local server.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => realFetch(String(url).replace("https://github.com", base), init);
      try {
        const config = { ...baseConfig, tavilyApiKey: "tavily-key", tavilyApiUrl: `${base}/tavily`, retryMaxAttempts: 1 };
        const issue = await fetchUrl("https://github.com/openclaw/openclaw/issues/91956", config, { provider: "auto" });
        assert.equal(issue.provider, "direct");
        assert.match(issue.content, /every comment/);
        assert.deepEqual(issue.tried, [{ provider: "direct", ok: true, skipped: false, direct_first: "github_issue" }]);
        assert.equal(tavilyCalls, 0);
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  );
}

// Long lines are matched across Markdown formatting: the same sentence with a link, bold or a
// list marker is not counted as new text.
assert.equal(addedProseChars("- **Install** with [npm](https://npmjs.com) and run the setup command once.", "Install with npm and run the setup command once."), 0);
// Past 1,500 characters an extract is thin when half or more of at least five headings are empty.
{
  const section = (n) => `## Section ${n}\n\nSection ${n} body: ${"text long enough to count as a sentence. ".repeat(12)}`;
  const headings = (empty) => [1, 2, 3, 4, 5, 6].map((n) => (n <= empty ? `## Empty ${n}` : section(n))).join("\n\n");
  assert.equal(looksThin(headings(3)), true);
  assert.equal(looksThin(headings(2)), false);
  assert.equal(clearlyFuller(headings(0), headings(3)), true);
  assert.equal(clearlyFuller(headings(0), headings(2)), false);
}

// A thin Tavily extract (under 1,500 characters, or mostly empty headings) is compared with
// Direct, and Direct's copy is taken only when it has clearly more text. Tuned on 19 thin
// extracts: Direct for all 8 that had lost text, Tavily kept for the 9 that had not.
{
  const sentence = (n) => `Sentence ${n} of the article body, long enough to count as real text.`;
  const skeleton = ["# Title", "## Install", "## Usage", "## Options", "## FAQ", "## License"].join("\n\n");
  const pages = {
    // Tavily kept the headings only; the page has the body under them.
    "/lost": {
      tavily: skeleton,
      html: `<h1>Title</h1>${Array.from({ length: 30 }, (_, n) => `<p>${sentence(n)}</p>`).join("")}`,
    },
    // Tavily has the body; Direct adds only navigation and a footer.
    "/short": {
      tavily: Array.from({ length: 12 }, (_, n) => sentence(n)).join("\n\n"),
      html: `<nav><a href="/">Home</a> <a href="/docs">Docs</a></nav>${Array.from({ length: 12 }, (_, n) => `<p>${sentence(n)}</p>`).join("")}<footer>Copyright 2026 Example Corporation, all rights reserved.</footer>`,
    },
    // Not thin: never compared.
    "/full": {
      tavily: Array.from({ length: 30 }, (_, n) => sentence(n)).join("\n\n"),
      html: "<p>unused</p>",
    },
  };
  const pageGets = {};
  await withServer(
    (req, res) => {
      if (req.url === "/tavily/extract") {
        readBody(req, (body) => {
          const page = pages[new URL(body.urls[0]).pathname];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ results: [{ raw_content: page.tavily }] }));
        });
        return;
      }
      req.resume();
      pageGets[req.url] = (pageGets[req.url] || 0) + 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pages[req.url].html);
    },
    async (base) => {
      const config = { ...baseConfig, tavilyApiKey: "tavily-key", tavilyApiUrl: `${base}/tavily`, firecrawlApiUrl: base, retryMaxAttempts: 1 };
      const attempts = (result) => result.tried.map((attempt) => [attempt.provider, attempt.ok]);

      const lost = await fetchUrl(`${base}/lost`, config, { provider: "auto" });
      assert.equal(lost.provider, "direct");
      assert.match(lost.content, /Sentence 29/);
      assert.deepEqual(attempts(lost), [
        ["tavily", true],
        ["direct", true],
      ]);
      assert.equal(lost.tried[0].thin, true);
      assert.equal(lost.tried[1].compared_with, "tavily");

      const short = await fetchUrl(`${base}/short`, config, { provider: "auto" });
      assert.equal(short.provider, "tavily");
      assert.deepEqual(attempts(short), [
        ["tavily", true],
        ["direct", false],
      ]);
      assert.match(short.tried[1].error, /not clearly fuller/);

      const full = await fetchUrl(`${base}/full`, config, { provider: "auto" });
      assert.equal(full.provider, "tavily");
      assert.deepEqual(attempts(full), [["tavily", true]]);
      assert.equal(pageGets["/full"], undefined);

      // An explicit --provider tavily is left alone.
      const named = await fetchUrl(`${base}/lost`, config, { provider: "tavily" });
      assert.equal(named.provider, "tavily");
      assert.equal(named.tried.length, 1);
      assert.equal(pageGets["/lost"], 1);
    }
  );
  // Direct failing the comparison keeps Tavily's copy.
  await withServer(
    (req, res) => {
      if (req.url === "/tavily/extract") {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: [{ raw_content: skeleton }] }));
        return;
      }
      req.resume();
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("unavailable");
    },
    async (base) => {
      const config = { ...baseConfig, tavilyApiKey: "tavily-key", tavilyApiUrl: `${base}/tavily`, retryMaxAttempts: 1 };
      const gone = await fetchUrl(`${base}/gone`, config, { provider: "auto" });
      assert.equal(gone.provider, "tavily");
      assert.equal(gone.content, skeleton);
      assert.equal(gone.tried[1].ok, false);
      assert.match(gone.tried[1].error, /503/);
    }
  );
}

// When Tavily and Firecrawl fail too, the HTML Direct already fetched is returned rather than
// fetched again, and without the X validation warning.
let pageGets = 0;
await withServer(
  (req, res) => {
    req.resume();
    if (req.url === "/tavily/extract" || req.url === "/scrape") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("down");
      return;
    }
    pageGets += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>blob</title><p>GitHub page</p>");
  },
  async (base) => {
    const config = { ...baseConfig, tavilyApiKey: "tavily-key", tavilyApiUrl: `${base}/tavily`, firecrawlApiUrl: base, retryMaxAttempts: 1 };
    const result = await fetchUrl(`${base}/o/r/blob/main/x.md`, config, { provider: "auto" });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "direct");
    assert.match(result.content, /GitHub page/);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.tried.at(-1), { provider: "direct", ok: true, skipped: false, reused: true });
    assert.equal(pageGets, 1);
  }
);

console.log("firecrawl fixtures ok");
