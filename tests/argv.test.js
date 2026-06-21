#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runNode(args, env = {}) {
  try {
    const result = await execFileAsync("node", args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function assertErrorSchema(output, timestampField) {
  assert.equal(output.ok, false);
  assert.equal(typeof output.error, "string");
  assert.equal(Array.isArray(output.warnings), true);
  assert.equal(typeof output[timestampField], "string");
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
assertErrorSchema(parseJson(result.stdout), "fetched_at");

result = await runNode(["scripts/search.js"], { GROK_API_KEY: "secret-search-key" });
assert.equal(result.code, 1);
assert.equal(result.stdout.includes("secret-search-key"), false);
assert.equal(result.stderr.includes("secret-search-key"), false);
assertErrorSchema(parseJson(result.stdout), "searched_at");

result = await runNode(["scripts/map.js", "ftp://example.com"]);
assert.equal(result.code, 1);
assertErrorSchema(parseJson(result.stdout), "mapped_at");

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
    assert.equal(output.ok, true);
    assert.equal(output.provider, "direct");
    assert.match(output.content, /Hello/);
    assert.equal(fetchResult.stderr, "");
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
    assert.equal(output.ok, true);
    assert.deepEqual(output.results, [`http://127.0.0.1:${port}/a`]);
    assert.equal(mapResult.stderr, "");
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
    assert.equal(output.ok, true);
    assert.equal(output.sources_count, 1);
    assert.equal(searchResult.stderr, "");
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
  }
);

console.log("argv fixtures ok");
