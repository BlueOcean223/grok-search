#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveProxyConfig } from "../scripts/lib/proxy.js";

let config = resolveProxyConfig({ HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "example.com" });
assert.equal(config.enabled, true);
assert.equal(config.httpsProxy, "http://proxy.example:8080");
assert.equal(config.httpProxy, undefined);
assert.match(config.noProxy, /example\.com/);
assert.match(config.noProxy, /localhost/);
assert.match(config.noProxy, /127\.0\.0\.1/);

config = resolveProxyConfig({ HTTP_PROXY: "http://proxy.example:8080" });
assert.equal(config.enabled, true);
assert.equal(config.httpProxy, "http://proxy.example:8080");
assert.equal(config.httpsProxy, "http://proxy.example:8080");

config = resolveProxyConfig({ GROK_PROXY: "http://tool-proxy.example:7890", HTTPS_PROXY: "http://env-proxy.example:8080" });
assert.equal(config.enabled, true);
assert.equal(config.source, "GROK_PROXY");
assert.equal(config.httpProxy, "http://tool-proxy.example:7890");
assert.equal(config.httpsProxy, "http://tool-proxy.example:7890");

config = resolveProxyConfig({ GROK_PROXY: "off", HTTPS_PROXY: "http://env-proxy.example:8080" });
assert.equal(config.enabled, false);
assert.equal(config.disabled, true);

console.log("proxy fixtures ok");
