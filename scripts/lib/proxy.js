import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"];
const DISABLED_VALUES = new Set(["0", "false", "off", "no", "none", "direct", "disable", "disabled"]);

let configured = false;
let state = { mode: "unconfigured" };

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function maskUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? "***" : "";
      url.password = url.password ? "***" : "";
    }
    return url.toString();
  } catch {
    return String(value).replace(/\/\/[^/@\s]+@/, "//***@");
  }
}

function combineNoProxy(userNoProxy) {
  const seen = new Set();
  const items = [];
  for (const item of String(userNoProxy || "").split(/[\s,]+/).concat(LOOPBACK_NO_PROXY)) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    items.push(trimmed);
  }
  return items.join(",");
}

/**
 * The proxy to use: `proxy` (the configured value, GROK_PROXY by default) when set, else the
 * ambient http(s)_proxy / all_proxy variables; `off` and the like force direct connections.
 */
export function resolveProxyConfig(env = process.env, { proxy = envValue(env, "GROK_PROXY") } = {}) {
  const explicit = typeof proxy === "string" && proxy.trim() ? proxy.trim() : undefined;
  if (explicit && DISABLED_VALUES.has(explicit.toLowerCase())) {
    return { enabled: false, disabled: true, source: "GROK_PROXY" };
  }

  const allProxy = envValue(env, "all_proxy") || envValue(env, "ALL_PROXY");
  const httpProxy = explicit || envValue(env, "http_proxy") || envValue(env, "HTTP_PROXY") || allProxy;
  const httpsProxy = explicit || envValue(env, "https_proxy") || envValue(env, "HTTPS_PROXY") || httpProxy || allProxy;
  const noProxy = combineNoProxy(envValue(env, "no_proxy") || envValue(env, "NO_PROXY"));

  return {
    enabled: Boolean(httpProxy || httpsProxy),
    disabled: false,
    source: explicit ? "GROK_PROXY" : "env",
    httpProxy,
    httpsProxy,
    noProxy,
  };
}

function suppressUndiciEnvProxyWarning(fn) {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning, optionsOrType, ...rest) {
    const message = typeof warning === "string" ? warning : warning?.message || "";
    const code = typeof optionsOrType === "object" && optionsOrType ? optionsOrType.code : rest[0];
    if (code === "UNDICI-EHPA" || message.includes("EnvHttpProxyAgent is experimental")) return;
    return originalEmitWarning.call(process, warning, optionsOrType, ...rest);
  };

  try {
    return fn();
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

/**
 * Route global fetch through the proxy resolveProxyConfig finds, once per process. Must run
 * before the first outbound request; the command runner calls it right after loading config.
 */
export function configureProxy({ proxy, debug: debugEnabled = false } = {}, env = process.env) {
  if (configured) return state;
  configured = true;
  const debug = (message) => {
    if (debugEnabled) console.error(`[grok-search] ${message}`);
  };

  const config = resolveProxyConfig(env, { proxy });
  if (config.disabled) {
    state = { mode: "disabled", source: config.source };
    debug("proxy disabled by GROK_PROXY");
    return state;
  }
  if (!config.enabled) {
    state = { mode: "direct" };
    return state;
  }

  let undici;
  try {
    undici = require("undici");
  } catch (error) {
    state = { mode: "error", source: config.source, error: `undici 未安装，无法启用代理: ${error.message}` };
    debug(state.error);
    return state;
  }

  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher, fetch: undiciFetch } = undici;
    if (typeof EnvHttpProxyAgent !== "function" || typeof setGlobalDispatcher !== "function") {
      throw new Error("当前 undici 版本不支持 EnvHttpProxyAgent/setGlobalDispatcher");
    }

    const dispatcher = suppressUndiciEnvProxyWarning(
      () =>
        new EnvHttpProxyAgent({
          httpProxy: config.httpProxy,
          httpsProxy: config.httpsProxy,
          noProxy: config.noProxy,
        })
    );
    setGlobalDispatcher(dispatcher);

    // Use the same userland undici fetch that owns the dispatcher. This avoids
    // version/symbol mismatches between Node's bundled fetch and npm undici.
    if (typeof undiciFetch === "function") {
      globalThis.fetch = undiciFetch;
    }

    state = {
      mode: "proxy",
      source: config.source,
      httpProxy: maskUrl(config.httpProxy),
      httpsProxy: maskUrl(config.httpsProxy),
      noProxy: config.noProxy,
    };
    debug(
      `proxy enabled (${state.source}): http=${state.httpProxy || "(none)"}, https=${state.httpsProxy || "(none)"}, no_proxy=${state.noProxy}`
    );
    return state;
  } catch (error) {
    state = { mode: "error", source: config.source, error: error.message };
    debug(`proxy setup failed: ${error.message}`);
    return state;
  }
}

export function getProxyState() {
  return state;
}

// Explicit GROK_PROXY expresses intent to route through a proxy; silently
// falling back to a direct connection would defeat that intent, so fail
// closed. Ambient HTTP_PROXY/HTTPS_PROXY failures stay non-fatal.
export function assertProxyUsable() {
  if (state.mode === "error" && state.source === "GROK_PROXY") {
    const error = new Error(`GROK_PROXY 配置无效，已拒绝直连: ${state.error}`);
    error.code = "PROXY_CONFIG_INVALID";
    throw error;
  }
}
