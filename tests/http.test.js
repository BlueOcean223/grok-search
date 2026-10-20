#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getText, redactSecrets, requestJson } from "../scripts/lib/http.js";

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const options = { accept: "text/plain, */*;q=0.8", timeoutMs: 5000, maxBytes: 1000 };

// getText: text decoded by its declared charset, with the response described beside it.
await withServer(
  (req, res) => {
    if (req.url === "/gbk") {
      res.writeHead(200, { "content-type": "text/plain; charset=gbk", "content-length": "4" });
      res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    } else if (req.url === "/moved") {
      res.writeHead(302, { location: "/gbk" });
      res.end();
    } else if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<p>页面未找到，这一行比预览上限长</p>");
    } else if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2]));
    } else if (req.url === "/attachment") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=a.txt" });
      res.end("text");
    } else if (req.url === "/declared-large") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "2000" });
      res.end("x".repeat(2000));
    } else if (req.url === "/large") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(2000));
    } else if (req.url === "/slow") {
      req.resume();
    } else {
      res.writeHead(500);
      res.end();
    }
  },
  async (base) => {
    const text = await getText(`${base}/gbk`, options);
    assert.deepEqual(text, {
      ok: true,
      status: 200,
      final_url: `${base}/gbk`,
      redirected: false,
      content_type: "text/plain; charset=gbk",
      content_length: 4,
      content_disposition: null,
      text: "中文",
    });

    const moved = await getText(`${base}/moved`, options);
    assert.equal(moved.ok, true);
    assert.equal(moved.final_url, `${base}/gbk`);
    assert.equal(moved.redirected, true);

    // An error page's text is read only as far as asked: 12 bytes is the tag and three characters.
    const missing = await getText(`${base}/missing`, { ...options, previewBytes: 12 });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "http");
    assert.equal(missing.status, 404);
    assert.equal(missing.error, "HTTP 404: Not Found");
    assert.equal(missing.text, "<p>页面未");
    assert.equal((await getText(`${base}/missing`, options)).text, "");

    for (const path of ["/binary", "/attachment"]) {
      const got = await getText(`${base}${path}`, options);
      assert.equal(got.reason, "binary", path);
      assert.equal(got.text, undefined, path);
    }

    const declared = await getText(`${base}/declared-large`, options);
    assert.equal(declared.reason, "too_large");
    assert.equal(declared.cut, undefined);
    assert.equal(declared.content_length, 2000);
    const large = await getText(`${base}/large`, options);
    assert.equal(large.reason, "too_large");
    assert.equal(large.cut, true);

    const slow = await getText(`${base}/slow`, { ...options, timeoutMs: 200 });
    assert.equal(slow.reason, "timeout");
    assert.match(slow.error, /请求超时/);
    assert.equal(slow.status, undefined);
  }
);

const refused = await getText("http://127.0.0.1:1/", options);
assert.equal(refused.reason, "network");
assert.equal(refused.ok, false);

// Credentials reflected by an upstream must not reach HTTP or JSON-parse errors.
{
  const deepseekApiKey = "deepseek-redaction-fixture";
  const diagnostic = "trace=deepseek-redaction-test";
  const reflected = `Rejected ${deepseekApiKey}, repeated ${deepseekApiKey}; ${diagnostic}`;
  await withServer(
    (req, res) => {
      req.resume();
      if (req.url === "/long") {
        // The key straddles trimBody's 500-character cut.
        res.writeHead(401, { "content-type": "text/plain" });
        res.end(`${"x".repeat(490)}${deepseekApiKey}`);
        return;
      }
      const malformed = req.url === "/invalid-json";
      res.writeHead(malformed ? 200 : 401, { "content-type": "application/json" });
      res.end(malformed ? reflected : JSON.stringify({ error: { message: reflected } }));
    },
    async (base) => {
      const request = (route) =>
        requestJson(`${base}${route}`, {
          headers: {},
          body: {},
          timeoutMs: 5000,
          config: { deepseekApiKey, retryMaxWait: 0 },
        });
      for (const route of ["/error", "/invalid-json"]) {
        await assert.rejects(request(route), (error) => {
          assert.equal(error.message.includes(deepseekApiKey), false, `${route} exposed the credential`);
          assert.equal(error.message.includes(diagnostic), true, `${route} lost useful diagnostics`);
          if (route === "/error") assert.equal(error.upstreamMessage, `Rejected ***, repeated ***; ${diagnostic}`);
          return true;
        });
      }
      await assert.rejects(request("/long"), (error) => {
        assert.equal(error.message, `HTTP 401: ${"x".repeat(490)}***`);
        return true;
      });
    }
  );
}

// Any config field ending in ApiKey is a credential; other fields are left alone.
assert.equal(
  redactSecrets("url https://new.example key new-provider-secret", {
    newProviderApiKey: "new-provider-secret",
    newProviderApiUrl: "https://new.example",
  }),
  "url https://new.example key ***"
);
assert.equal(redactSecrets("text", null), "text");

console.log("http fixtures ok");
