#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testHome = await mkdtemp(path.join(tmpdir(), "grok-search-test-home-"));
// Provider cooldowns persist across commands; give the suite its own state dir so one
// fixture's quota failure cannot leak into the next.
const testState = await mkdtemp(path.join(tmpdir(), "grok-search-test-state-"));

async function runNode(args, env = {}) {
  try {
    const result = await execFileAsync("node", args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        GROK_STATE_DIR: testState,
        TAVILY_API_KEY: "",
        FIRECRAWL_API_KEY: "",
        TAVILY_API_URL: "",
        FIRECRAWL_API_URL: "",
        GROK_DEFAULT_EXTRA: "",
        GROK_SOURCE_CHARS: "",
        GROK_MAX_SOURCES: "",
        GROK_DEADLINE_SECONDS: "",
        GROK_RESPONSES_MAX_TURNS: "",
        GROK_SEARCH_SOURCE: "",
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
    assert.equal(typeof output.diagnostics.duration_ms, "number");
    // The run record keeps the full text and says what stdout carried of it.
    const record = JSON.parse(await readFile(output.diagnostics.run_path, "utf8"));
    assert.equal(record.content.length, 13_000);
    assert.deepEqual(record.printed_content, { chars: 12_000, truncated: true, full_path: output.content.full_path });

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
    // --timeout is Tavily's crawl budget; Direct Map's own requests use --direct-timeout.
    assert.equal(output.diagnostics.options.timeout, 150);
    assert.equal(output.diagnostics.options.direct_timeout, 30);

    const custom = parseJson(
      (await runNode(["scripts/map.js", "--provider", "direct", "--direct-timeout", "5", `http://127.0.0.1:${port}/`])).stdout
    );
    assert.deepEqual(custom.urls, [`http://127.0.0.1:${port}/a`]);
    assert.equal(custom.diagnostics.options.direct_timeout, 5);
    assert.equal(custom.diagnostics.options.timeout, 150);

    const invalid = await runNode(["scripts/map.js", "--provider", "direct", "--direct-timeout", "0", `http://127.0.0.1:${port}/`]);
    assert.equal(invalid.code, 2);
    assert.equal(parseJson(invalid.stdout).error.code, "ARGUMENT_ERROR");
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
      // A failed open_page stays out of total and by_action; the summary lists it under failed.
      const payload = responsesPayload();
      payload.output.push({ type: "web_search_call", status: "failed", action: { type: "open_page", url: "https://dead.example/x" } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
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
    assert.deepEqual(output.diagnostics.provider_attempts, [{ provider: "grok-responses:xai", ok: true, count: 1, requests: 1 }]);
    assert.equal(output.diagnostics.cost_usd, 0.000015);
    assert.equal(output.sources.items.length, 1);
    assert.equal(output.sources.total, 1);
    assert.equal(output.sources.omitted, 0);
    assert.deepEqual(output.diagnostics.responses_tool_calls, {
      total: 1,
      upstream: null,
      trace: { web: 1, x: 0 },
      by_action: { search: 1 },
      failed: [{ tool: "web_search", type: "web_search_call", status: "failed", action_type: "open_page", url: "https://dead.example/x", source_count: 0 }],
    });
    // Prompt budget is advisory; the block just puts it next to what was actually used.
    assert.deepEqual(output.diagnostics.search_budget, {
      prompt_total: 6,
      prompt_x: 0,
      used_web: 1,
      used_x: 0,
      used_total: 1,
      used_searches: 1,
      used_x_searches: 0,
      exceeded: false,
      enforced: false,
    });
    assert.equal(Object.hasOwn(output.diagnostics.options, "instructions_chars"), false);
    assert.equal(typeof output.diagnostics.duration_ms, "number");
  }
);

// --instructions rides in the user message after the query so the system prompts stay a
// stable cache prefix; Tavily/Firecrawl never see it (extras are off here, asserted via body).
await withServer(
  (req, res) => {
    assert.equal(req.url, "/responses");
    readJson(req, (body) => {
      const systemMessages = body.input.filter((message) => message.role === "system");
      const userMessage = body.input.find((message) => message.role === "user");
      assert.equal(systemMessages.length, 1);
      assert.match(userMessage.content, /\n# Search query\nmock query\n/);
      assert.match(userMessage.content, /# Instructions from the caller\n只要官方 changelog 链接，中文回答/);
      assert.ok(userMessage.content.indexOf("mock query") < userMessage.content.indexOf("# Instructions from the caller"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload()));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      ["scripts/search.js", "--no-extra", "--instructions", "只要官方 changelog 链接，中文回答", "mock query"],
      baseGrokEnv(port)
    );
    assert.equal(searchResult.code, 0, searchResult.stderr);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.diagnostics.options.instructions_chars, "只要官方 changelog 链接，中文回答".length);
    const record = JSON.parse(await readFile(output.sources.raw_path, "utf8"));
    assert.equal(record.instructions, "只要官方 changelog 链接，中文回答");
    assert.equal(record.query, "mock query");
  }
);

{
  const missing = await runNode(["scripts/search.js", "--no-extra", "--instructions", "", "mock query"], baseGrokEnv(1));
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--instructions 缺少值/);
}

// --responses-parallel-tool-calls false reaches the request body and diagnostics; unset means
// the field is absent so the relay default applies. Env spelling works too.
await withServer(
  (req, res) => {
    readJson(req, (body) => {
      assert.equal(body.parallel_tool_calls, req.headers["x-test-expect"] === "false" ? false : undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload()));
    });
  },
  async (_server, port) => {
    const plain = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port));
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(Object.hasOwn(parseJson(plain.stdout).diagnostics.options, "responses_parallel_tool_calls"), false);
  }
);
await withServer(
  (req, res) => {
    readJson(req, (body) => {
      assert.equal(body.parallel_tool_calls, false);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload()));
    });
  },
  async (_server, port) => {
    const viaFlag = await runNode(["scripts/search.js", "--no-extra", "--responses-parallel-tool-calls", "false", "mock query"], baseGrokEnv(port));
    assert.equal(viaFlag.code, 0, viaFlag.stderr);
    assert.equal(parseJson(viaFlag.stdout).diagnostics.options.responses_parallel_tool_calls, false);
    const viaEnv = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port, { GROK_RESPONSES_PARALLEL_TOOL_CALLS: "false" }));
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    assert.equal(parseJson(viaEnv.stdout).diagnostics.options.responses_parallel_tool_calls, false);
    const bad = await runNode(["scripts/search.js", "--no-extra", "--responses-parallel-tool-calls", "maybe", "mock query"], baseGrokEnv(port));
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /只能是 true 或 false/);
  }
);

// --source x keeps Tavily/Firecrawl off by default: they search the web, so for an X question
// every one of their results is off-topic (6/6 in the 2026-09-08 side-by-side). --extra N opts in.
await withServer(
  (req, res) => {
    readJson(req, () => {
      if (req.url !== "/responses") assert.fail(`extra provider must not be called on --source x: ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload("X only answer.")));
    });
  },
  async (_server, port) => {
    const env = baseGrokEnv(port, {
      TAVILY_API_KEY: "tavily-key",
      TAVILY_API_URL: `http://127.0.0.1:${port}/tavily`,
      FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
    });
    const searchResult = await runNode(["scripts/search.js", "--source", "x", "mock query"], env);
    assert.equal(searchResult.code, 0, searchResult.stderr);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.diagnostics.options.extra_mode, "off-x-only");
    assert.deepEqual(output.diagnostics.options.extra_allocation, { tavily: 0, firecrawl: 0 });
    assert.deepEqual(output.diagnostics.provider_attempts.map((attempt) => attempt.provider), ["grok-responses:xai"]);
    // extra_mode says it; a warning on every X-only search was never acted on (9 of 9 on record).
    assert.deepEqual(output.diagnostics.warnings, []);
    // --source both still runs extras by default, so nothing changes for the routed mode.
    const both = await runNode(["scripts/search.js", "--source", "both", "--no-extra", "mock query"], env);
    assert.equal(parseJson(both.stdout).diagnostics.options.extra_mode, "off");
  }
);

// The prompt budgets searches and expects pages to be opened besides. Three searches and five
// page reads are eight billed calls but within the budget of six searches.
await withServer(
  (req, res) => {
    readJson(req, () => {
      const payload = responsesPayload();
      for (const query of ["b", "c"]) payload.output.push({ type: "web_search_call", status: "completed", action: { type: "search", query } });
      for (let page = 0; page < 5; page += 1) {
        payload.output.push({ type: "web_search_call", status: "completed", action: { type: "open_page", url: `https://official.example/p${page}` } });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  },
  async (_server, port) => {
    const output = parseJson((await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port))).stdout);
    assert.equal(output.diagnostics.search_budget.used_total, 8);
    assert.equal(output.diagnostics.search_budget.used_searches, 3);
    assert.equal(output.diagnostics.search_budget.exceeded, false);
  }
);

// A retried Grok request is counted, and the run record, written after the stdout cut, says
// what stdout carried of the answer.
let grokRequests = 0;
await withServer(
  (req, res) => {
    readJson(req, () => {
      grokRequests += 1;
      if (grokRequests === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream busy" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload("A".repeat(60_000))));
    });
  },
  async (_server, port) => {
    const env = baseGrokEnv(port, { GROK_RETRY_MULTIPLIER: "0" });
    const output = parseJson((await runNode(["scripts/search.js", "--no-extra", "--max-chars", "60000", "mock query"], env)).stdout);
    assert.equal(output.diagnostics.provider_attempts[0].requests, 2);
    assert.equal(output.answer.truncated, true);
    const record = JSON.parse(await readFile(output.sources.raw_path, "utf8"));
    assert.equal(record.answer.length, 60_000);
    assert.deepEqual(record.printed_answer, { chars: output.answer.chars, truncated: true, full_path: output.answer.full_path });
    assert.match(record.diagnostics.warnings.join("\n"), /answer\.text keeps only the beginning/);
  }
);

await withServer(
  (req, res) => {
    readJson(req, (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/responses") {
        res.end(JSON.stringify(responsesPayload("X plus extras.")));
        return;
      }
      assert.equal(req.url, "/firecrawl/search");
      assert.equal(body.limit, 2);
      res.end(JSON.stringify({ data: { web: [{ title: "Forced extra", url: "https://extra.example/forced" }] } }));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      ["scripts/search.js", "--source", "x", "--extra", "2", "mock query"],
      baseGrokEnv(port, { FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl` })
    );
    assert.equal(searchResult.code, 0, searchResult.stderr);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.diagnostics.options.extra_mode, "explicit");
    assert.equal(output.sources.items.some((source) => source.provider === "firecrawl"), true);
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
    // --responses-x-search is the legacy alias for --source both.
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
    const output = parseJson(searchResult.stdout);
    assert.equal(output.answer.text, "Filtered answer.");
    assert.equal(output.diagnostics.options.search_source, "both");
  }
);

function xPayload() {
  return {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "X answer.",
            annotations: [{ url: "https://x.com/xai/status/2087942296721559607", title: "1" }],
          },
        ],
      },
    ],
    // No x_search_call items: the relay reports its billed calls only through usage.
    usage: { input_tokens: 10, output_tokens: 5, server_side_tool_usage_details: { web_search_calls: 0, x_search_calls: 8 } },
  };
}

await withServer(
  (req, res) => {
    readJson(req, (body) => {
      assert.deepEqual(body.tools, [
        {
          type: "x_search",
          allowed_x_handles: ["xai"],
          from_date: "2026-08-01",
          to_date: "2026-08-16",
          enable_image_understanding: true,
        },
      ]);
      assert.equal(body.input.length, 3);
      assert.match(body.input[1].content, /X \(Twitter\) evidence/);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(xPayload()));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      [
        "scripts/search.js",
        "--no-extra",
        "--source",
        "x",
        "--responses-allowed-x-handles",
        "xai",
        "--x-from-date",
        "2026-08-01",
        "--x-to-date",
        "2026-08-16",
        "--x-images",
        "mock query",
      ],
      baseGrokEnv(port)
    );
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.diagnostics.options.search_source, "x");
    assert.equal(output.diagnostics.options.x_from_date, "2026-08-01");
    assert.equal(output.diagnostics.options.x_image_understanding, true);
    assert.equal(Object.hasOwn(output.diagnostics.options, "x_video_understanding"), false);
    // Billed x_search calls are reported even though output[] carried no call items.
    assert.equal(output.diagnostics.responses_x_search_calls, 8);
    // Usage said 8 x_search calls while the trace carried none: both tallies stay visible.
    assert.deepEqual(output.diagnostics.responses_tool_calls, {
      total: 8,
      upstream: { web: 0, x: 8 },
      trace: { web: 0, x: 0 },
      by_action: {},
    });
    assert.equal(output.diagnostics.search_budget.prompt_x, 4);
    assert.equal(output.diagnostics.search_budget.used_x, 8);
    // Billed calls the trace does not show count as searches.
    assert.equal(output.diagnostics.search_budget.used_x_searches, 8);
    assert.equal(output.diagnostics.search_budget.exceeded, true);
    assert.deepEqual(output.sources.items, [
      {
        provider: "grok-responses",
        url: "https://x.com/xai/status/2087942296721559607",
        title: "@xai",
        source_type: "citation",
        tool: "x_search",
        x_handle: "xai",
        x_post_id: "2087942296721559607",
      },
    ]);
    // Every search leaves a run record, X searches included: the answer only exists here.
    assert.equal(typeof output.sources.raw_path, "string");
    const record = JSON.parse(await readFile(output.sources.raw_path, "utf8"));
    assert.equal(record.schema_version, 2);
    assert.equal(record.kind, "search");
    assert.equal(record.query, "mock query");
    assert.equal(record.answer, "X answer.");
    assert.equal(record.options.search_source, "x");
    assert.equal(record.diagnostics.responses_x_search_calls, 8);
    assert.equal(record.sources.items.length, 1);
    assert.equal(record.error, null);
    assert.equal(Object.hasOwn(record, "grok_raw"), false);
    assert.deepEqual(record.argv.slice(0, 3), ["--no-extra", "--source", "x"]);
  }
);

// X filter options imply X search when the source was not explicitly set.
await withServer(
  (req, res) => {
    readJson(req, (body) => {
      assert.deepEqual(body.tools, [{ type: "web_search" }, { type: "x_search", from_date: "2026-08-01" }]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(xPayload()));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      ["scripts/search.js", "--no-extra", "--x-from-date", "2026-08-01", "mock query"],
      baseGrokEnv(port)
    );
    assert.equal(searchResult.code, 0);
    assert.equal(parseJson(searchResult.stdout).diagnostics.options.search_source, "both");
  }
);

// GROK_SEARCH_SOURCE sets the default without a flag.
await withServer(
  (req, res) => {
    readJson(req, (body) => {
      assert.deepEqual(body.tools, [{ type: "web_search" }, { type: "x_search" }]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(xPayload()));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      ["scripts/search.js", "--no-extra", "mock query"],
      baseGrokEnv(port, { GROK_SEARCH_SOURCE: "both" })
    );
    assert.equal(searchResult.code, 0);
    assert.equal(parseJson(searchResult.stdout).diagnostics.options.search_source, "both");
  }
);

// Bad arguments fail at the argument stage (exit 2) before any config or output work.
for (const [args, code, exitCode] of [
  [["--source", "twitter", "mock query"], "SEARCH_SOURCE_INVALID", 2],
  [["--source=", "mock query"], "ARGUMENT_ERROR", 2],
  [["--x-from-date", "08/01/2026", "mock query"], "ARGUMENT_ERROR", 2],
  // Date.parse rolls this over to Mar 2 rather than rejecting it.
  [["--x-from-date", "2026-02-30", "mock query"], "ARGUMENT_ERROR", 2],
  [["--x-from-date", "2026-08-16", "--x-to-date", "2026-08-01", "mock query"], "ARGUMENT_ERROR", 2],
  [["--source", "web", "--x-from-date", "2026-08-01", "mock query"], "SEARCH_SOURCE_CONFLICT", 1],
  [
    ["--responses-allowed-x-handles", Array.from({ length: 21 }, (_item, index) => `handle${index}`).join(","), "mock query"],
    "RESPONSES_FILTER_LIMIT",
    1,
  ],
  [["--responses-allowed-x-handles", "a", "--responses-excluded-x-handles", "b", "mock query"], "RESPONSES_FILTER_CONFLICT", 1],
]) {
  result = await runNode(["scripts/search.js", ...args], baseGrokEnv(1));
  assert.equal(result.code, exitCode);
  assert.equal(parseJson(result.stdout).error.code, code);
}

// Config is written by the user and CLI args by the agent, so a CLI filter must never
// silently discard a configured exclusion.
{
  const filterHome = await mkdtemp(path.join(tmpdir(), "grok-search-filters-"));
  await mkdir(path.join(filterHome, ".config", "grok-search"), { recursive: true });
  await writeFile(
    path.join(filterHome, ".config", "grok-search", "config.json"),
    JSON.stringify({ responsesExcludedDomains: ["reddit.com", "quora.com"], responsesExcludedXHandles: ["spam_account"] }),
    "utf8"
  );
  const filterEnv = (port) => ({ ...baseGrokEnv(port), HOME: filterHome, USERPROFILE: filterHome });

  await withServer(
    (req, res) => {
      readJson(req, () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responsesPayload()));
      });
    },
    async (_server, port) => {
      // An allow-list is stronger than a deny-list, so a non-conflicting one is honored.
      let output = parseJson(
        (await runNode(["scripts/search.js", "--no-extra", "--responses-allowed-domains", "github.com", "q"], filterEnv(port)))
          .stdout
      );
      assert.deepEqual(output.diagnostics.options.responses_allowed_domains, ["github.com"]);
      assert.deepEqual(output.diagnostics.options.responses_excluded_domains, []);

      // Two deny-lists compose instead of the CLI replacing the configured one.
      output = parseJson(
        (await runNode(["scripts/search.js", "--no-extra", "--responses-excluded-domains", "medium.com", "q"], filterEnv(port)))
          .stdout
      );
      assert.deepEqual(output.diagnostics.options.responses_excluded_domains, ["reddit.com", "quora.com", "medium.com"]);

      // Merging is case-insensitive and does not duplicate.
      output = parseJson(
        (await runNode(["scripts/search.js", "--no-extra", "--responses-excluded-domains", "REDDIT.com", "q"], filterEnv(port)))
          .stdout
      );
      assert.deepEqual(output.diagnostics.options.responses_excluded_domains, ["reddit.com", "quora.com"]);
    }
  );

  // Explicitly asking for an excluded value is the one real conflict.
  for (const [args, expected] of [
    [["--responses-allowed-domains", "reddit.com"], "reddit.com"],
    [["--responses-allowed-domains", "github.com,QUORA.com"], "QUORA.com"],
    [["--source", "x", "--responses-allowed-x-handles", "spam_account"], "spam_account"],
  ]) {
    result = await runNode(["scripts/search.js", "--no-extra", ...args, "q"], filterEnv(1));
    assert.notEqual(result.code, 0);
    const output = parseJson(result.stdout);
    assert.equal(output.error.code, "RESPONSES_FILTER_FORBIDDEN");
    assert.match(output.error.message, new RegExp(expected));
  }

  // A merged deny-list that overflows the provider cap must fail loudly, not silently drop.
  await writeFile(
    path.join(filterHome, ".config", "grok-search", "config.json"),
    JSON.stringify({ responsesExcludedDomains: ["a.com", "b.com", "c.com", "d.com", "e.com"] }),
    "utf8"
  );
  result = await runNode(["scripts/search.js", "--no-extra", "--responses-excluded-domains", "f.com", "q"], filterEnv(1));
  assert.notEqual(result.code, 0);
  assert.equal(parseJson(result.stdout).error.code, "RESPONSES_FILTER_LIMIT");
}

// A configured allow-list is the strongest exclusion of all: CLI filters narrow it, never
// widen it back to the open web.
{
  const allowHome = await mkdtemp(path.join(tmpdir(), "grok-search-allow-"));
  await mkdir(path.join(allowHome, ".config", "grok-search"), { recursive: true });
  await writeFile(
    path.join(allowHome, ".config", "grok-search", "config.json"),
    JSON.stringify({ responsesAllowedDomains: ["docs.python.org", "peps.python.org"] }),
    "utf8"
  );
  const allowEnv = (port) => ({ ...baseGrokEnv(port), HOME: allowHome, USERPROFILE: allowHome });

  await withServer(
    (req, res) => {
      readJson(req, () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responsesPayload()));
      });
    },
    async (_server, port) => {
      // A CLI deny-list subtracts from the configured allow-list instead of replacing it.
      let output = parseJson(
        (await runNode(["scripts/search.js", "--no-extra", "--responses-excluded-domains", "peps.python.org", "q"], allowEnv(port)))
          .stdout
      );
      assert.deepEqual(output.diagnostics.options.responses_allowed_domains, ["docs.python.org"]);
      assert.deepEqual(output.diagnostics.options.responses_excluded_domains, []);

      // A CLI allow-list must be a subset of it.
      output = parseJson(
        (await runNode(["scripts/search.js", "--no-extra", "--responses-allowed-domains", "DOCS.python.org", "q"], allowEnv(port)))
          .stdout
      );
      assert.deepEqual(output.diagnostics.options.responses_allowed_domains, ["DOCS.python.org"]);
    }
  );

  result = await runNode(["scripts/search.js", "--no-extra", "--responses-allowed-domains", "github.com", "q"], allowEnv(1));
  assert.notEqual(result.code, 0);
  assert.equal(parseJson(result.stdout).error.code, "RESPONSES_FILTER_FORBIDDEN");

  // Emptying the allow-list would mean "no restriction" to the API — the opposite of intent.
  result = await runNode(
    ["scripts/search.js", "--no-extra", "--responses-excluded-domains", "docs.python.org,peps.python.org", "q"],
    allowEnv(1)
  );
  assert.notEqual(result.code, 0);
  assert.equal(parseJson(result.stdout).error.code, "RESPONSES_FILTER_EMPTY");
}

// Configured X handle filters are preferences for when X search runs, not a request to
// turn on a billed extra search channel.
{
  const handleHome = await mkdtemp(path.join(tmpdir(), "grok-search-x-config-"));
  await mkdir(path.join(handleHome, ".config", "grok-search"), { recursive: true });
  await writeFile(
    path.join(handleHome, ".config", "grok-search", "config.json"),
    JSON.stringify({ searchSource: "web", responsesExcludedXHandles: ["spam_account"], xImageUnderstanding: true }),
    "utf8"
  );
  const handleEnv = (port) => ({ ...baseGrokEnv(port), HOME: handleHome, USERPROFILE: handleHome });

  await withServer(
    (req, res) => {
      readJson(req, (body) => {
        assert.deepEqual(body.tools, [{ type: "web_search" }]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responsesPayload()));
      });
    },
    async (_server, port) => {
      const output = parseJson((await runNode(["scripts/search.js", "--no-extra", "q"], handleEnv(port))).stdout);
      assert.equal(output.diagnostics.options.search_source, "web");
      assert.equal(Object.hasOwn(output.diagnostics.options, "responses_excluded_x_handles"), false);
    }
  );

  // Asking for X search does apply them, and --no-x-images can still turn the config off.
  await withServer(
    (req, res) => {
      readJson(req, (body) => {
        assert.deepEqual(body.tools, [
          { type: "web_search" },
          { type: "x_search", excluded_x_handles: ["spam_account"] },
        ]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(xPayload()));
      });
    },
    async (_server, port) => {
      const output = parseJson(
        (await runNode(["scripts/search.js", "--no-extra", "--source", "both", "--no-x-images", "q"], handleEnv(port))).stdout
      );
      assert.equal(output.diagnostics.options.search_source, "both");
      assert.deepEqual(output.diagnostics.options.responses_excluded_x_handles, ["spam_account"]);
      assert.equal(Object.hasOwn(output.diagnostics.options, "x_image_understanding"), false);
    }
  );
}

// The default OpenRouter path must stay warning-free; the non-enforcement note is only
// worth its stdout when web-only was actually asked for.
await withServer(
  (req, res) => {
    readJson(req, () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload("OpenRouter answer.")));
    });
  },
  async (_server, port) => {
    const openRouterEnv = baseGrokEnv(port, { GROK_API_PROVIDER: "openrouter", GROK_MODEL: "x-ai/grok-4.1-fast" });
    let output = parseJson((await runNode(["scripts/search.js", "--no-extra", "q"], openRouterEnv)).stdout);
    assert.deepEqual(output.diagnostics.warnings, []);

    output = parseJson((await runNode(["scripts/search.js", "--no-extra", "--source", "web", "q"], openRouterEnv)).stdout);
    assert.match(output.diagnostics.warnings[0], /--source web is not enforced/);
  }
);

// The removed boolean fails loudly where it would have changed results and stays silent otherwise.
{
  const removedHome = await mkdtemp(path.join(tmpdir(), "grok-search-removed-x-"));
  await mkdir(path.join(removedHome, ".config", "grok-search"), { recursive: true });
  const writeRemovedConfig = (value) =>
    writeFile(
      path.join(removedHome, ".config", "grok-search", "config.json"),
      JSON.stringify({ responsesIncludeXSearch: value }),
      "utf8"
    );
  const removedEnv = (port) => ({ ...baseGrokEnv(port), HOME: removedHome, USERPROFILE: removedHome });
  const mentionsRemoved = (warning) => /responsesIncludeXSearch/.test(warning);

  await withServer(
    (req, res) => {
      readJson(req, () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responsesPayload()));
      });
    },
    async (_server, port) => {
      // true used to attach X search; silently dropping that would change results.
      await writeRemovedConfig(true);
      let result = await runNode(["scripts/search.js", "--no-extra", "mock query"], removedEnv(port));
      assert.notEqual(result.code, 0);
      let output = parseJson(result.stdout);
      assert.equal(output.error.code, "CONFIG_OPTION_REMOVED");
      assert.match(output.error.message, /searchSource/);

      // The environment form is rejected the same way, whatever the file says.
      await writeRemovedConfig(false);
      result = await runNode(["scripts/search.js", "--no-extra", "mock query"], {
        ...removedEnv(port),
        GROK_RESPONSES_INCLUDE_X_SEARCH: "true",
      });
      assert.equal(parseJson(result.stdout).error.code, "CONFIG_OPTION_REMOVED");

      // false never did anything, so it keeps working: web search, nothing to warn about.
      result = await runNode(["scripts/search.js", "--no-extra", "mock query"], removedEnv(port));
      assert.equal(result.code, 0);
      output = parseJson(result.stdout);
      assert.equal(output.diagnostics.options.search_source, "web");
      assert.equal(output.diagnostics.warnings.some(mentionsRemoved), false);
    }
  );
}

// OpenRouter cannot enforce an X-only source; it must say so instead of implying it did.
await withServer(
  (req, res) => {
    readJson(req, (body) => {
      assert.equal(body.tools[0].type, "openrouter:web_search");
      assert.deepEqual(body.x_search_filter, {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsesPayload("OpenRouter X answer.")));
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      ["scripts/search.js", "--no-extra", "--source", "x", "mock query"],
      baseGrokEnv(port, { GROK_API_PROVIDER: "openrouter", GROK_MODEL: "x-ai/grok-4.1-fast" })
    );
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.diagnostics.options.search_source, "x");
    assert.match(output.diagnostics.warnings[0], /OpenRouter cannot run x_search alone/);
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
    assert.equal(output.sources.total, 7);
    assert.equal(output.sources.omitted, 0);
    assert.equal(output.sources.items.filter((source) => source.provider === "tavily").length, 3);
    assert.equal(output.sources.items.filter((source) => source.provider === "firecrawl").length, 3);
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
    assert.equal(output.sources.items.filter((source) => source.provider === "firecrawl").length, 1);
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
    assert.equal(output.sources.items.length, 1);
    assert.equal(output.sources.items[0].provider, "firecrawl");
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

// A plain 429 that survives the retries is a rate limit, not an exhausted quota: it still
// degrades when extras exist, but it must be named as what it is.
await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "too many requests" }));
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port, {
      GROK_RETRY_MAX_ATTEMPTS: "1",
    }));
    assert.equal(searchResult.code, 1);
    const output = parseJson(searchResult.stdout);
    assertCommandErrorSchema(output, "searched_at", "GROK_RATE_LIMITED");
    assert.match(output.error.message, /触发限流/);
    assert.equal(output.diagnostics.grok_error.code, "RATE_LIMITED");
  }
);

for (const [status, message] of [
  [401, "invalid API key"],
  [422, "responses protocol unsupported"],
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
    // Fetch keeps its full text and provider trail in a run record too.
    const record = JSON.parse(await readFile(output.diagnostics.run_path, "utf8"));
    assert.equal(record.kind, "fetch");
    assert.equal(record.provider, "direct");
    assert.match(record.content, /Direct content/);
    assert.equal(record.provider_attempts.length, 3);
    assert.equal(record.error, null);
  }
);

// A fetch cut to the stdout budget: the record, written after the cut, carries the warning
// and the file the full text went to.
await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("y".repeat(60_000));
  },
  async (_server, port) => {
    const output = parseJson((await runNode(["scripts/fetch.js", "--provider", "direct", "--max-chars", "100000", `http://127.0.0.1:${port}/big`])).stdout);
    assert.equal(output.content.truncated, true);
    assert.ok(output.content.chars < 60_000);
    const record = JSON.parse(await readFile(output.diagnostics.run_path, "utf8"));
    assert.equal(record.content.length, 60_000);
    assert.deepEqual(record.printed_content, { chars: output.content.chars, truncated: true, full_path: output.content.full_path });
    assert.match(record.warnings.join("\n"), /content\.text keeps only the beginning/);
  }
);

// A deep URL that ends on the site's root page (gov.cn's script redirect for removed pages)
// reports the final URL and a warning instead of passing as an ordinary fetch.
await withServer(
  (req, res) => {
    readJson(req, (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ success: true, data: { markdown: "# 中国政府网\n\n首页", metadata: { statusCode: 200, sourceURL: body.url, url: "https://www.gov.cn/" } } })
      );
    });
  },
  async (_server, port) => {
    const fetchResult = await runNode(
      ["scripts/fetch.js", "--provider", "firecrawl", "https://www.gov.cn/zhengce/content/202511/content_7038000.htm"],
      { FIRECRAWL_API_URL: `http://127.0.0.1:${port}` }
    );
    assert.equal(fetchResult.code, 0);
    const output = parseJson(fetchResult.stdout);
    assert.equal(output.final_url, "https://www.gov.cn/");
    assert.equal(output.redirected, true);
    assert.match(output.diagnostics.warnings.join("\n"), /redirected to the site's home page \(https:\/\/www\.gov\.cn\/\)/);
  }
);

// Tavily mapped www.compshare.cn/docs to an empty list (2026-10-07) while Direct read 200 URLs
// from the sitemap. Under auto an empty list falls through to Direct; asked for by name, Tavily's
// empty answer stands, with a warning.
await withServer(
  (req, res) => {
    req.resume();
    if (req.url === "/tavily/map") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ base_url: `http://${req.headers.host}`, results: [] }));
      return;
    }
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<urlset><url><loc>http://${req.headers.host}/docs/a</loc></url></urlset>`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  },
  async (_server, port) => {
    const env = { TAVILY_API_KEY: "tavily-key", TAVILY_API_URL: `http://127.0.0.1:${port}/tavily` };
    const auto = parseJson((await runNode(["scripts/map.js", `http://127.0.0.1:${port}/docs`], env)).stdout);
    assert.deepEqual(auto.urls, [`http://127.0.0.1:${port}/docs/a`]);
    assert.equal(auto.diagnostics.provider, "direct");
    assert.deepEqual(
      auto.diagnostics.provider_attempts.map((attempt) => [attempt.provider, attempt.ok, attempt.error ?? null]),
      [
        ["tavily", false, "returned no URLs"],
        ["direct", true, null],
      ]
    );

    const named = parseJson((await runNode(["scripts/map.js", "--provider", "tavily", `http://127.0.0.1:${port}/docs`], env)).stdout);
    assert.deepEqual(named.urls, []);
    assert.match(named.diagnostics.warnings.join("\n"), /Tavily Map returned no URLs/);
  }
);

// Domain filters given to Grok reach the extra providers too, and an extra that still falls
// outside them ranks below Grok's in-scope search results instead of displacing them.
await withServer(
  (req, res) => {
    readJson(req, (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/responses") {
        res.end(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Scoped answer.",
                    annotations: [{ type: "url_citation", url: "https://github.com/o/r/issues/1", title: "1" }],
                  },
                ],
              },
              {
                type: "web_search_call",
                status: "completed",
                action: {
                  type: "search",
                  query: "scoped",
                  sources: [
                    { url: "https://github.com/o/r/issues/1", title: "Issue one" },
                    { url: "https://github.com/o/r/issues/2", title: "Issue two" },
                    { url: "https://github.com/o/r/issues/3", title: "Issue three" },
                  ],
                },
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          })
        );
        return;
      }
      assert.equal(req.url, "/firecrawl/search");
      assert.deepEqual(body.includeDomains, ["github.com"]);
      res.end(
        JSON.stringify({
          success: true,
          data: {
            web: [
              { title: "Leaked blog", url: "https://blog.example/leak", description: "off domain" },
              { title: "Gist", url: "https://gist.github.com/x", description: "in domain" },
            ],
          },
        })
      );
    });
  },
  async (_server, port) => {
    const searchResult = await runNode(
      ["scripts/search.js", "--extra", "2", "--max-sources", "4", "--responses-allowed-domains", "github.com", "mock query"],
      baseGrokEnv(port, { FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl` })
    );
    assert.equal(searchResult.code, 0);
    const output = parseJson(searchResult.stdout);
    assert.equal(output.sources.total, 5);
    assert.deepEqual(
      output.sources.items.map((source) => source.url),
      ["https://github.com/o/r/issues/1", "https://github.com/o/r/issues/2", "https://github.com/o/r/issues/3", "https://gist.github.com/x"]
    );
    // The marker title on the citation was replaced by the listing's real title.
    assert.equal(output.sources.items[0].title, "Issue one");
    assert.equal(output.sources.items[0].source_type, "citation");
    assert.equal(output.diagnostics.options.extra_domain_filter, "pushed");
    const firecrawlAttempt = output.diagnostics.provider_attempts.find((attempt) => attempt.provider === "firecrawl");
    assert.equal(firecrawlAttempt.off_domain, 1);
  }
);

// A Firecrawl quota failure during fetch leaves a cooldown behind, and the very next search
// skips the Firecrawl extra channel instead of paying for the same 429 again.
{
  const cooldownState = await mkdtemp(path.join(tmpdir(), "grok-search-cooldown-state-"));
  await withServer(
    (req, res) => {
      req.resume();
      if (req.url === "/firecrawl/scrape") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error: "You've hit Firecrawl's keyless free tier rate limit.",
            reason: "credits",
            retry_after_seconds: 86361,
          })
        );
        return;
      }
      if (req.url === "/firecrawl/search") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("must not be called during cooldown");
        return;
      }
      if (req.url === "/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responsesPayload("Cooldown answer.")));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>Direct after quota</title><p>Direct content</p>");
    },
    async (_server, port) => {
      const fetchResult = await runNode(["scripts/fetch.js", `http://127.0.0.1:${port}/page`], {
        FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
        GROK_STATE_DIR: cooldownState,
      });
      assert.equal(fetchResult.code, 0);
      let output = parseJson(fetchResult.stdout);
      assert.equal(output.diagnostics.provider, "direct");
      const firecrawlAttempt = output.diagnostics.provider_attempts.find((attempt) => attempt.provider === "firecrawl");
      assert.equal(firecrawlAttempt.ok, false);
      assert.equal(firecrawlAttempt.requests, 1);
      const cooldown = JSON.parse(await readFile(path.join(cooldownState, "firecrawl-cooldown.json"), "utf8"));
      assert.equal(cooldown.reason, "credits");
      assert.equal(cooldown.auth_mode, "keyless");

      const searchResult = await runNode(["scripts/search.js", "--extra", "2", "mock query"], baseGrokEnv(port, {
        FIRECRAWL_API_URL: `http://127.0.0.1:${port}/firecrawl`,
        GROK_STATE_DIR: cooldownState,
      }));
      assert.equal(searchResult.code, 0);
      output = parseJson(searchResult.stdout);
      assert.equal(output.answer.text, "Cooldown answer.");
      assert.deepEqual(output.diagnostics.options.extra_allocation, { tavily: 0, firecrawl: 0 });
      const skipped = output.diagnostics.provider_attempts.find((attempt) => attempt.provider === "firecrawl");
      assert.equal(skipped.skipped, true);
      assert.match(skipped.error, /cooldown until/);
      assert.equal(output.diagnostics.warnings.some((warning) => /cooldown until/.test(warning)), true);
    }
  );
}

function manySourcesPayload(count) {
  return {
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Many sources answer.",
            annotations: [{ url: "https://official.example/cite", title: "Cited" }],
          },
        ],
      },
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "many sources",
          sources: Array.from({ length: count }, (_item, index) => ({
            url: `https://searched.example/${index + 1}`,
            title: `Searched ${index + 1}`,
          })),
        },
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

await withServer(
  (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(manySourcesPayload(20)));
  },
  async (_server, port) => {
    const defaultCap = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port));
    assert.equal(defaultCap.code, 0);
    let output = parseJson(defaultCap.stdout);
    assert.equal(output.sources.total, 21);
    assert.equal(output.sources.returned, 12);
    assert.equal(output.sources.omitted, 9);
    assert.equal(output.sources.items.length, 12);
    assert.equal(output.sources.items[0].source_type, "citation");
    assert.equal(typeof output.sources.raw_path, "string");
    const rawPayload = JSON.parse(await readFile(output.sources.raw_path, "utf8"));
    assert.equal(rawPayload.sources.grok.length, 21);
    assert.equal(rawPayload.sources.items.length, 21);
    assert.equal(rawPayload.sources.omitted, 9);
    assert.equal(rawPayload.grok_tool_calls.length, 1);
    assert.equal(rawPayload.grok_tool_calls[0].query, "many sources");

    const explicitCap = await runNode(["scripts/search.js", "--no-extra", "--max-sources", "3", "mock query"], baseGrokEnv(port));
    output = parseJson(explicitCap.stdout);
    assert.equal(output.sources.returned, 3);
    assert.equal(output.sources.omitted, 18);
    assert.equal(output.diagnostics.options.max_sources, 3);

    // GROK_RUN_LOG=off keeps the disk untouched; --full-sources / GROK_DEBUG_RAW keep the raw body.
    const noLog = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port, { GROK_RUN_LOG: "off" }));
    output = parseJson(noLog.stdout);
    assert.equal(output.sources.raw_path, null);
    const withRaw = await runNode(["scripts/search.js", "--no-extra", "mock query"], baseGrokEnv(port, { GROK_DEBUG_RAW: "1" }));
    output = parseJson(withRaw.stdout);
    const rawRecord = JSON.parse(await readFile(output.sources.raw_path, "utf8"));
    assert.equal(rawRecord.grok_raw.output.length, 2);
  }
);

await withServer(
  (req) => {
    // Never respond; the command-level deadline must fire first.
    req.resume();
  },
  async (_server, port) => {
    const searchResult = await runNode(["scripts/search.js", "--no-extra", "--deadline", "1", "mock query"], baseGrokEnv(port, {
      GROK_RETRY_MAX_ATTEMPTS: "1",
    }));
    assert.equal(searchResult.code, 1);
    const output = parseJson(searchResult.stdout);
    assertCommandErrorSchema(output, "searched_at", "DEADLINE_EXCEEDED");
    // The deadline exit path still leaves a record of what was asked and why it stopped.
    const record = JSON.parse(await readFile(output.diagnostics.run_path, "utf8"));
    assert.equal(record.kind, "search");
    assert.equal(record.query, "mock query");
    assert.equal(record.error.code, "DEADLINE_EXCEEDED");
  }
);

{
  const badConfigHome = await mkdtemp(path.join(tmpdir(), "grok-search-bad-config-"));
  await mkdir(path.join(badConfigHome, ".config", "grok-search"), { recursive: true });
  await writeFile(path.join(badConfigHome, ".config", "grok-search", "config.json"), "{ bad json", "utf8");
  result = await runNode(["scripts/fetch.js", "--provider", "direct", "https://example.com/"], {
    HOME: badConfigHome,
    USERPROFILE: badConfigHome,
  });
  assert.equal(result.code, 1);
  assertCommandErrorSchema(parseJson(result.stdout), "fetched_at", "CONFIG_FILE_INVALID");
}

result = await runNode(["scripts/fetch.js", "--provider", "direct", "https://example.com/"], { GROK_PROXY: "not-a-url" });
assert.equal(result.code, 1);
assertCommandErrorSchema(parseJson(result.stdout), "fetched_at", "PROXY_CONFIG_INVALID");

console.log("argv fixtures ok");
