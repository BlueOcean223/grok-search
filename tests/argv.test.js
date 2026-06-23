#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testHome = await mkdtemp(path.join(tmpdir(), "grok-search-test-home-"));

async function runNode(args, env = {}) {
  try {
    const result = await execFileAsync("node", args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        TAVILY_API_KEY: "",
        FIRECRAWL_API_KEY: "",
        TAVILY_API_URL: "",
        FIRECRAWL_API_URL: "",
        GROK_DEFAULT_EXTRA: "",
        GROK_SOURCE_CHARS: "",
        ...env,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function assertCommandErrorSchema(output, timestampField, code) {
  assert.equal(typeof output.error.message, "string");
  assert.equal(output.error.code, code);
  assert.equal(Array.isArray(output.diagnostics.warnings), true);
  assert.equal(Array.isArray(output.diagnostics.provider_attempts), true);
  assert.equal(typeof output.diagnostics[timestampField], "string");
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await callback(server, server.address().port);
  } finally {
    server.close();
  }
}

let result = await runNode(["scripts/fetch.js", "--provider", "bad", "https://example.com"]);
assert.equal(result.code, 2);
assert.match(result.stderr, /--provider/);
assertCommandErrorSchema(parseJson(result.stdout), "fetched_at", "ARGUMENT_ERROR");

result = await runNode(["scripts/search.js"], { GROK_API_KEY: "secret-search-key" });
assert.equal(result.code, 2);
assert.equal(result.stdout.includes("secret-search-key"), false);
assert.equal(result.stderr.includes("secret-search-key"), false);
assertCommandErrorSchema(parseJson(result.stdout), "searched_at", "ARGUMENT_ERROR");

result = await runNode(["scripts/map.js", "ftp://example.com"]);
assert.equal(result.code, 2);
assertCommandErrorSchema(parseJson(result.stdout), "mapped_at", "ARGUMENT_ERROR");

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Test</title><h1>Hello</h1><p>World</p>");
  },
  async (_server, port) => {
    const fetchResult = await runNode(["scripts/fetch.js", "--provider", "direct", `http://127.0.0.1:${port}/page`]);
    assert.equal(fetchResult.code, 0);
    const output = parseJson(fetchResult.stdout);
    assert.equal(Object.hasOwn(output, "ok"), false);
    assert.equal(output.diagnostics.provider, "direct");
    assert.equal(output.diagnostics.options.provider, "direct");
    assert.equal(output.diagnostics.options.max_chars, 12000);
    assert.match(output.content.text, /Hello/);
    assert.equal(output.content.chars, output.content.text.length);
    assert.equal(output.content.truncated, false);
    assert.equal(output.content.full_path, null);
    assert.equal(fetchResult.stderr, "");
  }
);

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("z".repeat(13_000));
  },
  async (_server, port) => {
    const defaultFetch = await runNode(["scripts/fetch.js", "--provider", "direct", `http://127.0.0.1:${port}/long`]);
    assert.equal(defaultFetch.code, 0);
    let output = parseJson(defaultFetch.stdout);
    assert.equal(output.content.chars, 12_000);
    assert.equal(output.content.original_chars, 13_000);
    assert.equal(output.content.truncated, true);
    assert.equal(typeof output.content.full_path, "string");
    assert.equal((await readFile(output.content.full_path, "utf8")).length, 13_000);

    const explicitFetch = await runNode(["scripts/fetch.js", "--provider", "direct", "--max-chars", "50000", `http://127.0.0.1:${port}/long`]);
    assert.equal(explicitFetch.code, 0);
    output = parseJson(explicitFetch.stdout);
    assert.equal(output.content.chars, 13_000);
    assert.equal(output.content.original_chars, 13_000);
    assert.equal(output.content.truncated, false);
    assert.equal(output.content.full_path, null);
    assert.equal(output.diagnostics.options.max_chars, 50_000);
  }
);

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("fetch failure preview");
  },
  async (_server, port) => {
    const fetchResult = await runNode(["scripts/fetch.js", "--provider", "direct", `http://127.0.0.1:${port}/fail`]);
    assert.equal(fetchResult.code, 1);
    const output = parseJson(fetchResult.stdout);
    assert.equal(output.error.code, "FETCH_ERROR");
    assert.match(output.error.preview, /fetch failure preview/);
    assert.equal(output.diagnostics.provider, "direct");
    assert.equal(output.diagnostics.provider_attempts.length, 1);
  }
);

await withServer(
  (req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<urlset><url><loc>http://${req.headers.host}/a</loc></url></urlset>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<a href='/a'>A</a>");
  },
  async (_server, port) => {
    const mapResult = await runNode(["scripts/map.js", "--provider", "direct", `http://127.0.0.1:${port}/`]);
    assert.equal(mapResult.code, 0);
    const output = parseJson(mapResult.stdout);
    assert.equal(Object.hasOwn(output, "ok"), false);
    assert.equal(Object.hasOwn(output, "results"), false);
    assert.deepEqual(output.urls, [`http://127.0.0.1:${port}/a`]);
    assert.equal(output.diagnostics.provider, "direct");
    assert.deepEqual(output.diagnostics.provider_attempts, [{ provider: "direct", ok: true, skipped: false }]);
    assert.deepEqual(output.diagnostics.warnings, []);
    assert.equal(output.diagnostics.options.limit, 50);
    assert.equal(mapResult.stderr, "");
  }
);

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("map failure");
  },
  async (_server, port) => {
    const mapResult = await runNode(["scripts/map.js", "--provider", "direct", `http://127.0.0.1:${port}/`]);
    assert.equal(mapResult.code, 1);
    const output = parseJson(mapResult.stdout);
    assert.equal(output.error.code, "MAP_ERROR");
    assert.equal(output.diagnostics.provider, "direct");
    assert.equal(output.diagnostics.provider_attempts.length, 1);
    assert.equal(Array.isArray(output.diagnostics.warnings), true);
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.stream, false);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Answer.\n\nSources:\n- https://source.example/a" } }] }));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_MODEL: "mock-model",
    });
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(Object.hasOwn(output, "ok"), false);
    assert.equal(output.answer.text, "Answer.");
    assert.equal(output.answer.chars, "Answer.".length);
    assert.deepEqual(output.sources.grok, [{ provider: "grok", url: "https://source.example/a" }]);
    assert.deepEqual(output.sources.extra, []);
    assert.equal(output.sources.merged.length, 1);
    assert.equal(output.sources.raw_path, null);
    assert.deepEqual(output.diagnostics.provider_attempts, []);
    assert.deepEqual(output.diagnostics.warnings, []);
    assert.equal(output.diagnostics.options.extra, 0);
    assert.equal(output.diagnostics.options.extra_mode, "auto");
    assert.equal(searchResult.stderr, "");
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      assert.equal(req.url, "/responses");
      const parsed = JSON.parse(body);
      assert.equal(parsed.model, "mock-model");
      assert.equal(parsed.max_turns, 2);
      assert.equal(parsed.reasoning.effort, "medium");
      assert.deepEqual(parsed.tools, [
        { type: "web_search", allowed_domains: ["docs.x.ai", "openai.com"] },
        { type: "x_search", allowed_x_handles: ["xai", "OpenAI"] },
      ]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Responses answer.",
                  annotations: [{ url: "https://Example.com/a/#cite", title: "Official A" }],
                },
              ],
            },
            {
              type: "web_search_call",
              status: "completed",
              action: {
                sources: [
                  { url: "https://example.com/a", snippet: "official snippet" },
                  { url: "https://example.com/b", title: "Candidate B" },
                ],
              },
            },
          ],
          usage: { cost_in_usd_ticks: 123456 },
        })
      );
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      [
        "scripts/search.js",
        "--search-mode",
        "responses",
        "--responses-max-turns",
        "2",
        "--responses-reasoning-effort",
        "medium",
        "--responses-allowed-domains",
        "docs.x.ai,openai.com",
        "--responses-x-search",
        "--responses-allowed-x-handles",
        "xai,OpenAI",
        "mock query",
      ],
      {
        GROK_API_URL: `http://127.0.0.1:${port}`,
        GROK_API_KEY: "secret-search-key",
        GROK_API_PROVIDER: "xai",
        GROK_MODEL: "mock-model",
      }
    );
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.answer.text, "Responses answer.");
    assert.equal(output.diagnostics.grok_endpoint, "responses");
    assert.equal(output.diagnostics.options.search_mode, "responses");
    assert.equal(output.diagnostics.options.actual_search_mode, "responses");
    assert.equal(output.diagnostics.cost_in_usd_ticks, 123456);
    assert.equal(output.diagnostics.cost_usd, 0.0000123456);
    assert.deepEqual(
      output.sources.grok.map((source) => ({ source_type: source.source_type, tool: source.tool, url: source.url })),
      [
        { source_type: "citation", tool: "web_search", url: "https://example.com/a" },
        { source_type: "searched", tool: "web_search", url: "https://example.com/b" },
      ]
    );
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      assert.equal(req.url, "/responses");
      const parsed = JSON.parse(body);
      assert.equal(parsed.model, "x-ai/grok-4.1-fast");
      assert.equal(parsed.model.includes(":online"), false);
      assert.deepEqual(parsed.tools, [
        {
          type: "openrouter:web_search",
          parameters: {
            engine: "exa",
            max_results: 5,
            max_total_results: 10,
            excluded_domains: ["reddit.com"],
          },
        },
      ]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          output: [
            {
              type: "message",
              message: {
                content: [
                  {
                    type: "output_text",
                    text: "OpenRouter Responses answer.",
                    annotations: [{ url: "https://router.example/source", title: "Router Source" }],
                  },
                ],
              },
            },
          ],
          citations: ["https://router.example/top"],
        })
      );
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      [
        "scripts/search.js",
        "--search-mode",
        "responses",
        "--responses-openrouter-engine",
        "exa",
        "--responses-excluded-domains",
        "reddit.com",
        "mock query",
      ],
      {
        GROK_API_URL: `http://127.0.0.1:${port}`,
        GROK_API_KEY: "secret-search-key",
        GROK_API_PROVIDER: "openrouter",
        GROK_MODEL: "x-ai/grok-4.1-fast",
        GROK_SEARCH_MODE: "bad-env-value",
        GROK_RESPONSES_OPENROUTER_ENGINE: "bad-env-value",
        GROK_RESPONSES_ALLOWED_DOMAINS: "from-env.example",
      }
    );
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.model, "x-ai/grok-4.1-fast");
    assert.equal(output.diagnostics.options.api_provider, "openrouter");
    assert.equal(output.sources.grok[0].tool, "openrouter:web_search");
  }
);

await withServer(
  (req, res) => {
    req.resume();
    if (req.url === "/responses") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("responses unavailable");
      return;
    }
    if (req.url === "/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Fallback answer.\n\nSources:\n- https://source.example/fallback" } }] }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--search-mode", "responses", "--fallback-chat", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_API_PROVIDER: "xai",
      GROK_MODEL: "mock-model",
      GROK_RETRY_MAX_ATTEMPTS: "1",
    });
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.answer.text, "Fallback answer.");
    assert.equal(output.diagnostics.grok_endpoint, "chat/completions");
    assert.equal(output.diagnostics.requested_grok_endpoint, "responses");
    assert.equal(output.diagnostics.fallback_chat, true);
    assert.equal(output.diagnostics.options.search_mode, "responses");
    assert.equal(output.diagnostics.options.actual_search_mode, "chat");
    assert.deepEqual(
      output.diagnostics.provider_attempts.map((attempt) => attempt.provider),
      ["grok-responses:xai", "grok-chat"]
    );
  }
);

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("should not be called");
  },
  async (_server, port) => {
    const searchResult = await runNode(
      [
        "scripts/search.js",
        "--search-mode",
        "responses",
        "--responses-allowed-domains",
        "a.example",
        "--responses-excluded-domains",
        "b.example",
        "mock query",
      ],
      {
        GROK_API_URL: `http://127.0.0.1:${port}`,
        GROK_API_KEY: "secret-search-key",
      }
    );
    assert.equal(searchResult.code, 1);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.error.code, "RESPONSES_FILTER_CONFLICT");
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Answer.\n\nSources:\n- https://source.example/a" } }] }));
        return;
      }

      if (req.url === "/tavily/search") {
        assert.equal(parsed.max_results, 5);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: [
              { title: "Tavily 1", url: "https://tavily.example/1", content: "tavily-one" },
              { title: "Tavily 2", url: "https://tavily.example/2", content: "tavily-two" },
            ],
          })
        );
        return;
      }

      if (req.url === "/firecrawl/search") {
        assert.equal(parsed.limit, 3);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              web: [
                { title: "Firecrawl 1", url: "https://firecrawl.example/1", description: "firecrawl-one" },
                { title: "Firecrawl 2", url: "https://firecrawl.example/2", description: "firecrawl-two" },
                { title: "Firecrawl 3", url: "https://firecrawl.example/3", description: "firecrawl-three" },
              ],
            },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "5", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_MODEL: "mock-model",
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}/tavily`,
      FIRECRAWL_API_KEY: "firecrawl-key",
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
    });
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.sources.extra.length, 5);
    assert.deepEqual(
      output.diagnostics.provider_attempts.map((attempt) => ({ provider: attempt.provider, ok: attempt.ok, count: attempt.count })),
      [
        { provider: "tavily", ok: true, count: 2 },
        { provider: "firecrawl", ok: true, count: 3 },
      ]
    );
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Answer.\n\nSources:\n- https://source.example/a" } }] }));
        return;
      }

      if (req.url === "/tavily/search") {
        const count = parsed.max_results || 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: Array.from({ length: count }, (_item, index) => ({
              title: `Tavily ${index + 1}`,
              url: `https://tavily-full.example/${index + 1}`,
              content: "tavily-filled",
            })),
          })
        );
        return;
      }

      if (req.url === "/firecrawl/search") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("firecrawl should not be called");
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "3", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_MODEL: "mock-model",
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}/tavily`,
      FIRECRAWL_API_KEY: "firecrawl-key",
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
    });
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.deepEqual(output.diagnostics.provider_attempts, [{ provider: "tavily", ok: true, count: 3 }]);
    assert.equal(output.sources.extra.length, 3);
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/chat/completions") {
        assert.equal(parsed.stream, false);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Answer.\n\nSources:\n- https://source.example/a" } }] }));
        return;
      }

      if (req.url === "/search") {
        const count = parsed.max_results || parsed.limit || 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: Array.from({ length: count }, (_item, index) => ({
              title: `Extra ${index + 1}`,
              url: `https://extra.example/${index + 1}`,
              content: `${String(index + 1).padStart(2, "0")}-` + "x".repeat(800),
              score: 0.9,
              published_date: "2026-06-22",
            })),
          })
        );
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_MODEL: "mock-model",
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(searchResult.code, 0);
    assert.equal(searchResult.stdout.includes("description"), false);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.sources.extra.length, 5);
    assert.equal(output.sources.extra[0].snippet.length, 400);
    assert.equal(output.sources.merged.length, 6);
    assert.equal(typeof output.sources.raw_path, "string");
    assert.equal(output.diagnostics.options.extra, 5);
    assert.equal(output.diagnostics.options.extra_mode, "auto");
    assert.deepEqual(output.diagnostics.provider_attempts, [{ provider: "tavily", ok: true, count: 5 }]);
    const raw = JSON.parse(await readFile(output.sources.raw_path, "utf8"));
    assert.equal(raw.extra.length, 5);
    assert.equal(raw.provider_raw.tavily.results.length, 5);
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/search") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("provider should not be called");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Answer.\n\nSources:\n- https://source.example/a" } }] }));
    });
  },
  async (_server, port) => {
    for (const args of [
      ["scripts/search.js", "--no-extra", "mock query"],
      ["scripts/search.js", "--extra", "0", "mock query"],
    ]) {
      const searchResult = await runNode(args, {
        GROK_API_URL: `http://127.0.0.1:${port}`,
        GROK_API_KEY: "secret-search-key",
        GROK_MODEL: "mock-model",
        TAVILY_API_KEY: "tavily-key",
        TAVILY_API_URL: `http://127.0.0.1:${port}`,
      });
      assert.equal(searchResult.code, 0);
      const output = parseJson(searchResult.stdout);
      assert.deepEqual(output.sources.extra, []);
      assert.deepEqual(output.diagnostics.provider_attempts, []);
      assert.equal(output.diagnostics.options.extra, 0);
      assert.equal(output.diagnostics.options.extra_mode, "off");
    }
  }
);

result = await runNode(["scripts/search.js", "--extra", "1", "--no-extra", "mock query"]);
assert.equal(result.code, 2);
assertCommandErrorSchema(parseJson(result.stdout), "searched_at", "ARGUMENT_ERROR");

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "Answer.\n\nSources:\n- https://source.example/a" } }] }));
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "2", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_MODEL: "mock-model",
    });
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.sources.extra.length, 0);
    assert.equal(output.diagnostics.warnings.length, 1);
    assert.equal(output.diagnostics.provider_attempts.length, 2);
    assert.equal(output.diagnostics.options.extra_mode, "explicit");
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Answer.\n\nSources:\n- https://source.example/a" } }] }));
        return;
      }

      const count = parsed.max_results || 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: Array.from({ length: count }, (_item, index) => ({
            title: `Extra ${index + 1}`,
            url: `https://wide.example/${index + 1}`,
            content: "y".repeat(2000),
          })),
        })
      );
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "10", "--source-chars", "100", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_MODEL: "mock-model",
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(searchResult.code, 0);
    assert.equal(searchResult.stdout.includes("description"), false);
    assert.equal(searchResult.stdout.length < 12000, true);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.sources.extra.length, 10);
    assert.equal(output.sources.extra[0].snippet.length, 100);
    assert.equal(typeof output.sources.raw_path, "string");
  }
);

await withServer(
  (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "Answer.\n\nSources:\n- https://source.example/a" } }] }));
        return;
      }

      const count = parsed.max_results || 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: Array.from({ length: count }, (_item, index) => ({
            title: `Extra ${index + 1}`,
            url: `https://full.example/${index + 1}`,
            content: "full-source-content",
          })),
        })
      );
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--full-sources", "--source-chars", "5", "--extra", "1", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_MODEL: "mock-model",
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.sources.extra[0].snippet, "full-");
    assert.equal(typeof output.sources.raw_path, "string");
    assert.equal(output.sources.raw.extra[0].description, "full-source-content");
    assert.equal(output.sources.raw.provider_raw.tavily.results[0].content, "full-source-content");
  }
);

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("provider saw secret-search-key");
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "mock query"], {
      GROK_API_URL: `http://127.0.0.1:${port}`,
      GROK_API_KEY: "secret-search-key",
      GROK_MODEL: "mock-model",
      GROK_RETRY_MAX_ATTEMPTS: "1",
    });
    assert.equal(searchResult.code, 1);
    assert.equal(searchResult.stdout.includes("secret-search-key"), false);
    assert.equal(searchResult.stderr.includes("secret-search-key"), false);
    assert.match(searchResult.stdout, /\*\*\*/);
    assertCommandErrorSchema(parseJson(searchResult.stdout), "searched_at", "SEARCH_ERROR");
  }
);

console.log("argv fixtures ok");
