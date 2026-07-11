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
        GROK_RESPONSES_MAX_TURNS: "",
        GROK_SEARCH_MODE: "",
        GROK_RESPONSES_FALLBACK_CHAT: "",
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

function readJson(req, callback) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => callback(body ? JSON.parse(body) : {}));
}

function responsesPayload(text = "Responses answer.") {
  return {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text,
            annotations: [{ url: "https://official.example/a", title: "Official A" }],
          },
        ],
      },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "official query", sources: [{ url: "https://official.example/a" }] },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, cost_in_usd_ticks: 150000 },
  };
}

function baseGrokEnv(port, extra = {}) {
  return {
    GROK_API_URL: `http://127.0.0.1:${port}`,
    GROK_API_KEY: "secret-search-key",
    GROK_API_PROVIDER: "xai",
    GROK_MODEL: "mock-model",
    ...extra,
  };
}

let result = await runNode(["scripts/fetch.js", "--provider", "bad", "https://example.com"]);
assert.equal(result.code, 2);
assertCommandErrorSchema(parseJson(result.stdout), "fetched_at", "ARGUMENT_ERROR");

result = await runNode(["scripts/search.js"], { GROK_API_KEY: "secret-search-key" });
assert.equal(result.code, 2);
assertCommandErrorSchema(parseJson(result.stdout), "searched_at", "ARGUMENT_ERROR");

for (const removed of ["--search-mode", "--fallback-chat", "--ground-extra"]) {
  result = await runNode(["scripts/search.js", removed, "mock query"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /未知参数/);
  assertCommandErrorSchema(parseJson(result.stdout), "searched_at", "ARGUMENT_ERROR");
}

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
    assert.equal(output.diagnostics.provider, "direct");
    assert.match(output.content.text, /Hello/);
    assert.equal(output.content.truncated, false);
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
    assert.equal(output.content.truncated, true);
    assert.equal((await readFile(output.content.full_path, "utf8")).length, 13_000);

    const explicitFetch = await runNode([
      "scripts/fetch.js",
      "--provider",
      "direct",
      "--max-chars",
      "50000",
      `http://127.0.0.1:${port}/long`,
    ]);
    output = parseJson(explicitFetch.stdout);
    assert.equal(output.content.original_chars, 13_000);
    assert.equal(output.content.truncated, false);
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
    assert.deepEqual(output.urls, [`http://127.0.0.1:${port}/a`]);
    assert.equal(output.diagnostics.provider, "direct");
  }
);

await withServer(
  (req, res) => {
    assert.equal(req.url, "/responses");
    readJson(req, (body) => {
      assert.equal(body.model, "mock-model");
      assert.equal(body.max_turns, 3);
      assert.equal(body.stream, false);
      assert.deepEqual(body.tools, [{ type: "web_search" }]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload()));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port));
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.answer.text, "Responses answer.");
    assert.equal(output.diagnostics.grok_endpoint, "responses");
    assert.equal(output.diagnostics.options.responses_max_turns, 3);
    assert.equal(Object.hasOwn(output.diagnostics.options, "search_mode"), false);
    assert.equal(output.diagnostics.options.extra_mode, "off");
    assert.deepEqual(output.diagnostics.provider_attempts, [{ provider: "grok-responses:xai", ok: true, count: 1 }]);
    assert.equal(output.diagnostics.cost_usd, 0.000015);
  }
);

await withServer(
  (req, res) => {
    assert.equal(req.url, "/responses");
    readJson(req, (body) => {
      assert.equal(body.max_turns, 2);
      assert.equal(body.reasoning.effort, "medium");
      assert.deepEqual(body.tools, [
        { type: "web_search", filters: { allowed_domains: ["docs.x.ai", "openai.com"] } },
        { type: "x_search", allowed_x_handles: ["xai", "OpenAI"] },
      ]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload("Filtered answer.")));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      [
        "scripts/search.js",
        "--no-extra",
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
      baseGrokEnv(port)
    );
    assert.equal(searchResult.code, 0);
    assert.equal(parseJson(searchResult.stdout).answer.text, "Filtered answer.");
  }
);

await withServer(
  (req, res) => {
    assert.equal(req.url, "/responses");
    readJson(req, (body) => {
      assert.equal(body.model, "x-ai/grok-4.1-fast");
      assert.equal(body.model.includes(":online"), false);
      assert.equal(body.tools[0].type, "openrouter:web_search");
      assert.equal(body.tools[0].parameters.engine, "exa");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload("OpenRouter answer.")));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      ["scripts/search.js", "--no-extra", "--responses-openrouter-engine", "exa", "mock query"],
      baseGrokEnv(port, { GROK_API_PROVIDER: "openrouter", GROK_MODEL: "x-ai/grok-4.1-fast" })
    );
    assert.equal(searchResult.code, 0);
    assert.equal(parseJson(searchResult.stdout).model, "x-ai/grok-4.1-fast");
  }
);

await withServer(
  (() => {
    const pending = new Map();
    const seen = new Set();
    const release = () => {
      if (seen.size !== 3) return;
      pending.get("/responses").end(JSON.stringify(responsesPayload("Parallel answer.")));
      pending.get("/tavily/search").end(
        JSON.stringify({
          results: Array.from({ length: 3 }, (_item, index) => ({
            title: `Tavily ${index + 1}`,
            url: `https://tavily.example/${index + 1}`,
            content: "tavily content",
          })),
        })
      );
      pending.get("/firecrawl/search").end(
        JSON.stringify({
          success: true,
          creditsUsed: 2,
          data: {
            web: Array.from({ length: 3 }, (_item, index) => ({
              title: `Firecrawl ${index + 1}`,
              url: `https://firecrawl.example/${index + 1}`,
              description: "firecrawl content",
            })),
          },
        })
      );
    };
    return (req, res) => {
      readJson(req, (body) => {
        seen.add(req.url);
        pending.set(req.url, res);
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/tavily/search") assert.equal(body.max_results, 3);
        if (req.url === "/firecrawl/search") {
          assert.equal(body.limit, 3);
          assert.equal(req.headers.authorization, undefined);
        }
        release();
      });
    };
  })(),
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "mock query"], baseGrokEnv(port, {
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}/tavily`,
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
    }));
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.answer.text, "Parallel answer.");
    assert.equal(output.sources.extra.length, 6);
    assert.deepEqual(output.diagnostics.options.extra_allocation, { tavily: 3, firecrawl: 3 });
    assert.equal(output.diagnostics.options.firecrawl_auth_mode, "keyless");
    assert.deepEqual(
      output.diagnostics.provider_attempts.map((attempt) => [attempt.provider, attempt.ok, attempt.count]),
      [
        ["grok-responses:xai", true, 1],
        ["tavily", true, 3],
        ["firecrawl", true, 3],
      ]
    );
  }
);

await withServer(
  (req, res) => {
    readJson(req, (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/responses") {
        res.end(JSON.stringify(responsesPayload()));
        return;
      }
      assert.equal(req.url, "/firecrawl/search");
      assert.equal(body.limit, 4);
      assert.equal(req.headers.authorization, undefined);
      res.end(JSON.stringify({ data: { web: [{ title: "Only Firecrawl", url: "https://firecrawl.example/only" }] } }));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "4", "mock query"], baseGrokEnv(port, {
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
    }));
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.deepEqual(output.diagnostics.options.extra_allocation, { tavily: 0, firecrawl: 4 });
    assert.equal(output.sources.extra.length, 1);
  }
);

await withServer(
  (req, res) => {
    req.resume();
    if (req.url === "/responses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload("Grok survives extra failure.")));
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "firecrawl unavailable" }));
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "2", "mock query"], baseGrokEnv(port, {
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
      GROK_RETRY_MAX_ATTEMPTS: "1",
    }));
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.answer.text, "Grok survives extra failure.");
    assert.equal(output.diagnostics.degraded, undefined);
    assert.equal(output.diagnostics.provider_attempts[1].provider, "firecrawl");
    assert.equal(output.diagnostics.provider_attempts[1].ok, false);
    assert.equal(output.diagnostics.warnings.length, 1);
  }
);

await withServer(
  (req, res) => {
    readJson(req, (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/responses") {
        res.end(JSON.stringify(responsesPayload()));
        return;
      }
      assert.equal(body.limit, 2);
      assert.equal(req.headers.authorization, "Bearer firecrawl-key");
      res.end(JSON.stringify({ creditsUsed: 2, data: { web: [] } }));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "2", "mock query"], baseGrokEnv(port, {
      FIRECRAWL_API_KEY: "firecrawl-key",
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
    }));
    const output = parseJson(searchResult.stdout);
    assert.equal(output.diagnostics.options.firecrawl_auth_mode, "api_key");
    assert.equal(output.diagnostics.provider_attempts[1].auth_mode, "api_key");
  }
);

await withServer(
  (req, res) => {
    readJson(req, (body) => {
      if (req.url === "/responses") {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "insufficient_quota", message: "credits exhausted" } }));
        return;
      }
      assert.equal(body.limit, 2);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: { web: [{ title: "Fallback source", url: "https://fallback.example/a", description: "raw result" }] },
        })
      );
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "2", "mock query"], baseGrokEnv(port, {
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
      GROK_RETRY_MAX_ATTEMPTS: "1",
    }));
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.diagnostics.degraded, true);
    assert.equal(output.diagnostics.grok_error.code, "QUOTA_EXHAUSTED");
    assert.match(output.answer.text, /Grok Responses 额度已耗尽/);
    assert.match(output.answer.text, /Fallback source/);
    assert.deepEqual(output.sources.grok, []);
    assert.equal(output.sources.extra.length, 1);
  }
);

await withServer(
  (req, res) => {
    readJson(req, () => {
      if (req.url === "/responses") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rate limit: quota exhausted" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Tavily fallback", url: "https://tavily.example/fallback" }] }));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--extra", "1", "mock query"], baseGrokEnv(port, {
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}/tavily`,
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
      GROK_RETRY_MAX_ATTEMPTS: "1",
    }));
    assert.equal(searchResult.code, 0);
    assert.equal(parseJson(searchResult.stdout).diagnostics.degraded, true);
  }
);

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "credits exhausted" }));
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port, {
      GROK_RETRY_MAX_ATTEMPTS: "1",
    }));
    assert.equal(searchResult.code, 1);
    const output = parseJson(searchResult.stdout);
    assertCommandErrorSchema(output, "searched_at", "GROK_QUOTA_EXHAUSTED");
    assert.match(output.error.message, /extra sources 已显式关闭/);
    assert.equal(output.diagnostics.grok_error.code, "QUOTA_EXHAUSTED");
  }
);

for (const [status, message] of [
  [401, "invalid API key"],
  [422, "responses protocol unsupported"],
  [429, "too many requests"],
  [500, "upstream unavailable"],
]) {
  await withServer(
    (req, res) => {
      req.resume();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    },
    async (_server, port) => {
      const searchResult = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port, {
        GROK_RETRY_MAX_ATTEMPTS: "1",
      }));
      assert.equal(searchResult.code, 1);
      const output = parseJson(searchResult.stdout);
      assertCommandErrorSchema(output, "searched_at", "SEARCH_ERROR");
      assert.equal(output.diagnostics.degraded, undefined);
    }
  );
}

result = await runNode(["scripts/search.js", "--extra", "1", "--no-extra", "mock query"]);
assert.equal(result.code, 2);
assertCommandErrorSchema(parseJson(result.stdout), "searched_at", "ARGUMENT_ERROR");

await withServer(
  (req, res) => {
    readJson(req, (body) => {
      if (req.url === "/tavily/extract") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "tavily failed" }));
        return;
      }
      assert.equal(req.url, "/firecrawl/scrape");
      assert.equal(req.headers.authorization, undefined);
      assert.equal(body.formats[0], "markdown");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { markdown: "# Firecrawl keyless", metadata: { creditsUsed: 1 } } }));
    });
  },
  async (_server, port) => {
    const fetchResult = await runNode(["scripts/fetch.js", `http://127.0.0.1:${port}/page`], {
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}/tavily`,
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
      GROK_RETRY_MAX_ATTEMPTS: "1",
    });
    assert.equal(fetchResult.code, 0);
    const output = parseJson(fetchResult.stdout);
    assert.equal(output.diagnostics.provider, "firecrawl");
    assert.equal(output.diagnostics.firecrawl_auth_mode, "keyless");
    assert.equal(output.diagnostics.provider_attempts[1].auth_mode, "keyless");
  }
);

await withServer(
  (req, res) => {
    readJson(req, () => {
      assert.equal(req.headers.authorization, "Bearer firecrawl-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { markdown: "# Firecrawl API key" } }));
    });
  },
  async (_server, port) => {
    const fetchResult = await runNode(["scripts/fetch.js", "--provider", "firecrawl", "https://example.com"], {
      FIRECRAWL_API_KEY: "firecrawl-key",
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(fetchResult.code, 0);
    assert.equal(parseJson(fetchResult.stdout).diagnostics.firecrawl_auth_mode, "api_key");
  }
);

await withServer(
  (req, res) => {
    if (req.url === "/firecrawl/scrape") {
      req.resume();
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("firecrawl failed");
      return;
    }
    req.resume();
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Direct fallback</title><p>Direct content</p>");
  },
  async (_server, port) => {
    const fetchResult = await runNode(["scripts/fetch.js", `http://127.0.0.1:${port}/page`], {
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
      GROK_RETRY_MAX_ATTEMPTS: "1",
    });
    assert.equal(fetchResult.code, 0);
    const output = parseJson(fetchResult.stdout);
    assert.equal(output.diagnostics.provider, "direct");
    assert.match(output.content.text, /Direct content/);
    assert.deepEqual(output.diagnostics.provider_attempts.map((attempt) => attempt.provider), ["tavily", "firecrawl", "direct"]);
  }
);

console.log("argv fixtures ok");
