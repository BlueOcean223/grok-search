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
import { deepseekFetch, unescapeDeepSeekMarkdown } from "../scripts/lib/deepseek.js";
import { collapseRepeatedLines, directFirstForX, validateXPostContent } from "../scripts/lib/direct-fetch.js";
import { firecrawlMetadata, firecrawlScrape } from "../scripts/lib/firecrawl.js";
import { fetchUrl } from "../scripts/lib/providers.js";
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

/** An attempt without its timing, which is asserted to be there. */
function untimed(attempt) {
  const { duration_ms: durationMs, ...rest } = attempt;
  assert.equal(typeof durationMs, "number");
  return rest;
}

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

// fetchUrl(auto) skips Firecrawl while cooling down and falls back to the page Direct already
// fetched, without a second request.
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
// Every page on record with a status of 400 or more was an error page, so it hands over to the
// next provider, and the final error names every failure.
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
        ["direct", false],
        ["firecrawl", false],
        ["tavily", false],
      ]
    );
    assert.match(fetched.error, /firecrawl: target page returned HTTP 404/);
    assert.match(fetched.error, /direct: HTTP 404/);
  }
);

// An error page with no text fails at once too: the empty-markdown retry (a longer waitFor) does
// not revive a 404, and each try costs a credit.
{
  let scrapes = 0;
  await withServer(
    (req, res) => {
      req.resume();
      scrapes += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { markdown: "", metadata: { statusCode: 404, creditsUsed: 1 } } }));
    },
    async (base) => {
      const scraped = await firecrawlScrape(`${base}/gone`, { ...baseConfig, firecrawlApiUrl: base });
      assert.equal(scraped.ok, false);
      assert.equal(scraped.error, "target page returned HTTP 404");
      assert.equal(Object.hasOwn(scraped, "error_preview"), false);
      assert.equal(scrapes, 1);
    }
  );
}

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
    // A notice, not only a warning: fetch.js opens content.text with it.
    const shell = await fetchUrl(`${base}/shell`, baseConfig, { provider: "direct" });
    assert.equal(shell.ok, true);
    assert.equal(shell.content, "# Reddit");
    assert.equal(shell.notices.some((notice) => /no text beyond the page title/.test(notice)), true);

    const page = await fetchUrl(`${base}/post`, baseConfig, { provider: "direct" });
    assert.equal(page.ok, true);
    assert.deepEqual(page.warnings, []);
    assert.deepEqual(page.notices, []);
  }
);

// Non-HTML comes back as served, so a Markdown file that is only a heading is that file, not a
// script shell.
await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    res.end("# Project\n");
  },
  async (base) => {
    const file = await fetchUrl(`${base}/README.md`, baseConfig, { provider: "direct" });
    assert.equal(file.content, "# Project\n");
    assert.deepEqual(file.notices, []);
  }
);

// Direct decodes by the declared charset: the Content-Type parameter, else a <meta> tag. A GBK
// file decoded as UTF-8 was all U+FFFD. Text that still does not decode (no charset declared)
// goes on to the extractors under auto, with Direct's copy kept as the last resort.
{
  // "中文说明" in GBK.
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xcb, 0xb5, 0xc3, 0xf7]);
  await withServer(
    (req, res) => {
      req.resume();
      if (req.url === "/scrape") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { markdown: "Firecrawl's copy", metadata: { statusCode: 200 } } }));
        return;
      }
      if (req.url === "/declared.txt") {
        res.writeHead(200, { "content-type": "text/plain; charset=gbk" });
        res.end(gbk);
        return;
      }
      if (req.url === "/meta.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(Buffer.concat([Buffer.from('<html><head><meta charset="gbk"><title>t</title></head><body><p>'), gbk, Buffer.from("</p></body></html>")]));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(gbk);
    },
    async (base) => {
      const config = { ...baseConfig, firecrawlApiUrl: base, retryMaxAttempts: 1 };
      const declared = await fetchUrl(`${base}/declared.txt`, config, { provider: "auto" });
      assert.equal(declared.provider, "direct");
      assert.equal(declared.content, "中文说明");

      const meta = await fetchUrl(`${base}/meta.html`, config, { provider: "direct" });
      assert.match(meta.content, /中文说明/);

      const undeclared = await fetchUrl(`${base}/undeclared.txt`, config, { provider: "auto" });
      assert.equal(undeclared.provider, "firecrawl");
      assert.deepEqual(untimed(undeclared.tried[0]), { provider: "direct", ok: true, content_type: "text/plain", used: false });
    }
  );
}

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

// X posts: Direct goes first under auto, but only for URLs that name their author. Keys do not
// change the answer (2026-09-08): Tavily returns the post without a date and Firecrawl bills 30
// credits, so Direct goes first for every X post; --provider firecrawl opts in.
const directFirst = (url, provider) => Boolean(directFirstForX(url, provider));
assert.equal(directFirst("https://x.com/thsottiaux/status/2089143488696705077", "auto"), true);
assert.equal(directFirst("https://x.com/i/web/status/2089143488696705077", "auto"), false);
assert.equal(directFirst("https://x.com/thsottiaux", "auto"), false);
assert.equal(directFirst("https://example.com/thsottiaux/status/1", "auto"), false);
assert.equal(directFirst("https://x.com/thsottiaux/status/2089143488696705077", "firecrawl"), false);

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
  const requested = directFirstForX("https://x.com/xai/status/2087942296721559607", "auto");
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

// Direct asks for Markdown first and returns anything that is not HTML as served: a page the
// server negotiates to Markdown, a plain-text file, JSON. An HTML page goes to Firecrawl, then
// Tavily. A server that labels HTML as text/plain is still treated as HTML. An explicit
// --provider is left alone.
{
  const seen = { scrape: 0, extract: 0, accept: "" };
  await withServer(
    (req, res) => {
      req.resume();
      if (req.url === "/scrape") {
        seen.scrape += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { markdown: "# Docs\n\nFirecrawl's copy", metadata: { statusCode: 200, creditsUsed: 1 } } }));
        return;
      }
      if (req.url === "/tavily/extract") {
        seen.extract += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: [{ raw_content: "Tavily's copy" }] }));
        return;
      }
      if (req.url === "/docs/page") {
        seen.accept = req.headers.accept;
        const markdown = /^text\/markdown/.test(req.headers.accept || "");
        res.writeHead(200, { "content-type": markdown ? "text/markdown; charset=utf-8" : "text/html" });
        res.end(markdown ? "# Docs\n\nThe page as Markdown." : "<title>Docs</title><nav>Menu</nav><p>The page</p>");
        return;
      }
      if (req.url === "/data.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"version":"1.2.3"}');
        return;
      }
      if (req.url === "/mislabeled") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("<!DOCTYPE html><html><body><p>HTML served as text</p></body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>Article</title><p>An HTML page</p>");
    },
    async (base) => {
      const config = { ...baseConfig, firecrawlApiKey: "fc-key", tavilyApiKey: "tavily-key", tavilyApiUrl: `${base}/tavily`, firecrawlApiUrl: base, retryMaxAttempts: 1 };
      const attempts = (result) => result.tried.map((attempt) => [attempt.provider, attempt.ok]);

      const docs = await fetchUrl(`${base}/docs/page`, config, { provider: "auto" });
      assert.equal(docs.provider, "direct");
      assert.equal(docs.content, "# Docs\n\nThe page as Markdown.");
      assert.match(seen.accept, /^text\/markdown, text\/html;q=0\.9/);
      assert.deepEqual(docs.tried.map(untimed), [{ provider: "direct", ok: true, content_type: "text/markdown; charset=utf-8" }]);

      const data = await fetchUrl(`${base}/data.json`, config, { provider: "auto" });
      assert.equal(data.provider, "direct");
      assert.match(data.content, /"version": "1\.2\.3"/);
      assert.deepEqual([seen.scrape, seen.extract], [0, 0]);

      const article = await fetchUrl(`${base}/article`, config, { provider: "auto" });
      assert.equal(article.provider, "firecrawl");
      assert.equal(article.content, "# Docs\n\nFirecrawl's copy");
      assert.deepEqual(attempts(article), [
        ["direct", true],
        ["firecrawl", true],
      ]);
      assert.deepEqual(untimed(article.tried[0]), { provider: "direct", ok: true, content_type: "text/html", used: false });
      assert.deepEqual([seen.scrape, seen.extract], [1, 0]);

      const mislabeled = await fetchUrl(`${base}/mislabeled`, config, { provider: "auto" });
      assert.equal(mislabeled.provider, "firecrawl");

      const named = await fetchUrl(`${base}/docs/page`, config, { provider: "tavily" });
      assert.equal(named.provider, "tavily");
      assert.deepEqual(attempts(named), [["tavily", true]]);
    }
  );
}

// A Firecrawl failure, a per-minute rate limit included, hands over to Tavily. X pages try
// Tavily first, since Firecrawl bills about 30 credits for one.
{
  const order = [];
  await withServer(
    (req, res) => {
      req.resume();
      if (req.url === "/scrape") {
        order.push("firecrawl");
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end(JSON.stringify({ success: false, error: "Rate limit exceeded. Consumed (req/min): 11, Remaining (req/min): 0." }));
        return;
      }
      if (req.url === "/tavily/extract") {
        order.push("tavily");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: [{ raw_content: "Tavily's copy" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>Article</title><p>An HTML page</p>");
    },
    async (base) => {
      const config = { ...baseConfig, firecrawlApiKey: "fc-key", tavilyApiKey: "tavily-key", tavilyApiUrl: `${base}/tavily`, firecrawlApiUrl: base, retryMaxAttempts: 1 };
      const limited = await fetchUrl(`${base}/article`, config, { provider: "auto" });
      assert.equal(limited.provider, "tavily");
      assert.deepEqual(order, ["firecrawl", "tavily"]);
      assert.match(limited.tried[1].error, /Rate limit exceeded/);
      assert.equal(await activeFirecrawlCooldown(config, "api_key"), null);
    }
  );
  // The X URL is routed to the mock server; only the order matters here.
  order.length = 0;
  await withServer(
    (req, res) => {
      req.resume();
      if (req.url === "/tavily/extract") {
        order.push("tavily");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: [{ raw_content: "Tavily's copy of the X page" }] }));
        return;
      }
      if (req.url === "/scrape") {
        order.push("firecrawl");
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("not expected");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>X</title><p>JavaScript is not available.</p>");
    },
    async (base) => {
      const config = { ...baseConfig, firecrawlApiKey: "fc-key", tavilyApiKey: "tavily-key", tavilyApiUrl: `${base}/tavily`, firecrawlApiUrl: base, retryMaxAttempts: 1 };
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => realFetch(String(url).replace("https://x.com", base), init);
      try {
        const page = await fetchUrl("https://x.com/i/status/2108000619122593926", config, { provider: "auto" });
        assert.equal(page.provider, "tavily");
        assert.deepEqual(order, ["tavily"]);
      } finally {
        globalThis.fetch = realFetch;
      }
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
    assert.deepEqual(result.tried.at(-1), { provider: "direct", ok: true, reused: true });
    assert.equal(pageGets, 1);
  }
);

// DeepSeek Fetch escapes every ASCII punctuation character, code included; one backslash comes
// off each, so a literal backslash (sent as \\) survives. Chinese punctuation is left alone.
assert.equal(
  unescapeDeepSeekMarkdown(String.raw`\#\# Rust 1\.99 include\_domains curl https\:\/\/a\.b \\ C\:\\path 中文，`),
  String.raw`## Rust 1.99 include_domains curl https://a.b \ C:\path 中文，`
);

// deepseekFetch: bearer key, the URL in the body, the escapes undone; a 504 (its crawler timed
// out) is retried once, a 404 (refused or unreadable) is not; without a key it is skipped.
{
  const seen = [];
  await withServer(
    (req, res) => {
      readBody(req, (body) => {
        seen.push([req.url, req.headers.authorization, body.url]);
        if (body.url.endsWith("/refused")) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "failed to fetch URL", type: "invalid_request_error", param: null, code: "invalid_request_error" } }));
          return;
        }
        if (body.url.endsWith("/slow") && seen.filter((s) => s[2].endsWith("/slow")).length === 1) {
          res.writeHead(504, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Request timeout" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ title: "Rust 1\\.99", content: "\\# Rust 1\\.99\n\nAnnouncing\\!" }));
      });
    },
    async (base) => {
      const config = { ...baseConfig, deepseekApiKey: "ds-key", deepseekApiUrl: base };
      const page = await deepseekFetch("https://example.com/post", config);
      assert.deepEqual(page, { ok: true, provider: "deepseek", content: "# Rust 1.99\n\nAnnouncing!", metadata: { title: "Rust 1.99" }, requests: 1 });
      assert.deepEqual(seen[0], ["/v1/tools/fetch", "Bearer ds-key", "https://example.com/post"]);

      const refused = await deepseekFetch("https://example.com/refused", config);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /^HTTP 404/);
      assert.equal(refused.requests, 1);

      const slow = await deepseekFetch("https://example.com/slow", config);
      assert.equal(slow.ok, true);
      assert.equal(slow.requests, 2);

      const noKey = await deepseekFetch("https://example.com/post", { ...baseConfig, deepseekApiUrl: base });
      assert.deepEqual(noKey, { ok: false, provider: "deepseek", skipped: true, error: "DEEPSEEK_API_KEY 未配置" });
    }
  );
}

// Under auto DeepSeek is the last resort: only when Direct got no page (an error, or nothing
// beyond the title) after Firecrawl and Tavily failed. When it fails too, Direct's title-only copy
// is still returned. A named --provider deepseek goes straight to it.
{
  const calls = [];
  await withServer(
    (req, res) => {
      if (req.url === "/v1/tools/fetch") {
        readBody(req, (body) => {
          calls.push(body.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""));
          if (body.url.endsWith("/js-dead")) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "failed to fetch URL" } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ title: "Doc", content: "DeepSeek\\'s copy" }));
        });
        return;
      }
      req.resume();
      if (req.url === "/tavily/extract" || req.url === "/scrape") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("down");
        return;
      }
      if (req.url === "/blocked") {
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<title>Forbidden</title>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.url.startsWith("/js") ? "<title>App</title><script>render()</script>" : "<title>Page</title><p>Direct's text</p>");
    },
    async (base) => {
      const config = {
        ...baseConfig,
        tavilyApiKey: "tavily-key",
        tavilyApiUrl: `${base}/tavily`,
        firecrawlApiUrl: base,
        deepseekApiKey: "ds-key",
        deepseekApiUrl: base,
        retryMaxAttempts: 1,
      };
      const steps = (result) => result.tried.map((attempt) => [attempt.provider, attempt.ok]);

      const blocked = await fetchUrl(`${base}/blocked`, config, { provider: "auto" });
      assert.equal(blocked.provider, "deepseek");
      assert.equal(blocked.content, "DeepSeek's copy");
      assert.deepEqual(steps(blocked), [["direct", false], ["firecrawl", false], ["tavily", false], ["deepseek", true]]);
      // Served after extractors failed: a fallback, which the fetch cache does not keep.
      assert.equal(blocked.fallback, true);

      const app = await fetchUrl(`${base}/js-app`, config, { provider: "auto" });
      assert.equal(app.provider, "deepseek");

      const dead = await fetchUrl(`${base}/js-dead`, config, { provider: "auto" });
      assert.equal(dead.provider, "direct");
      assert.match(dead.notices[0], /no text beyond the page title/);
      assert.deepEqual(steps(dead).slice(-2), [["deepseek", false], ["direct", true]]);

      // Direct had the page: DeepSeek is not asked.
      const page = await fetchUrl(`${base}/page`, config, { provider: "auto" });
      assert.equal(page.provider, "direct");
      assert.equal(steps(page).some(([name]) => name === "deepseek"), false);

      const named = await fetchUrl(`${base}/page`, config, { provider: "deepseek" });
      assert.equal(named.provider, "deepseek");
      assert.deepEqual(steps(named), [["deepseek", true]]);
      assert.deepEqual(calls, ["/blocked", "/js-app", "/js-dead", "/page"]);
    }
  );
}

console.log("providers fixtures ok");
