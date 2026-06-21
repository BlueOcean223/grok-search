const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimBody(text, max = 500) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function retryAfterMs(headers) {
  const value = headers.get("retry-after");
  if (!value) return null;

  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export function backoffMs(config, attemptIndex) {
  const maxWaitMs = config.retryMaxWait * 1000;
  const computed = config.retryMultiplier * 1000 * 2 ** attemptIndex;
  return Math.min(maxWaitMs, computed);
}

export function debugLog(config, message) {
  if (config.debug) console.error(`[grok-search] ${message}`);
}

export async function requestJson(url, { headers, body, timeoutMs, config, retry = false }) {
  const maxAttempts = retry ? config.retryMaxAttempts : 1;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      clearTimeout(timer);

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${trimBody(text)}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs(response.headers);
        throw error;
      }

      try {
        return text ? JSON.parse(text) : {};
      } catch (cause) {
        const error = new Error(`响应不是有效 JSON: ${trimBody(text)}`);
        error.cause = cause;
        throw error;
      }
    } catch (error) {
      clearTimeout(timer);
      if (error.name === "AbortError") {
        lastError = new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
        lastError.retryable = true;
      } else {
        lastError = error;
      }

      const canRetry =
        attempt < maxAttempts - 1 &&
        (lastError.retryable || !lastError.status || RETRYABLE_STATUS.has(lastError.status));
      if (!canRetry) break;

      const waitMs = lastError.retryAfterMs ?? backoffMs(config, attempt);
      debugLog(config, `retry ${attempt + 1}/${maxAttempts - 1} after ${Math.round(waitMs)}ms: ${lastError.message}`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

export function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export async function tavilyExtract(url, config) {
  if (!config.tavilyApiKey) {
    return { ok: false, provider: "tavily", skipped: true, error: "TAVILY_API_KEY 未配置" };
  }

  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/extract`;
  try {
    const data = await requestJson(endpoint, {
      headers: authHeaders(config.tavilyApiKey),
      body: { urls: [url], format: "markdown" },
      timeoutMs: 60_000,
      config,
      retry: true,
    });

    const result = Array.isArray(data?.results) ? data.results[0] : undefined;
    const content = result?.raw_content || result?.content || "";
    if (content.trim()) {
      return { ok: true, provider: "tavily", content, raw: data };
    }

    const failed = Array.isArray(data?.failed_results) ? data.failed_results[0] : undefined;
    return {
      ok: false,
      provider: "tavily",
      error: failed?.error || failed?.message || "Tavily Extract 返回空内容",
      raw: data,
    };
  } catch (error) {
    return { ok: false, provider: "tavily", error: error.message };
  }
}

export async function firecrawlScrape(url, config) {
  if (!config.firecrawlApiKey) {
    return { ok: false, provider: "firecrawl", skipped: true, error: "FIRECRAWL_API_KEY 未配置" };
  }

  const endpoint = `${config.firecrawlApiUrl.replace(/\/+$/, "")}/scrape`;
  let lastError = "Firecrawl Scrape 返回空内容";

  for (let attempt = 0; attempt < config.retryMaxAttempts; attempt += 1) {
    try {
      const data = await requestJson(endpoint, {
        headers: authHeaders(config.firecrawlApiKey),
        body: {
          url,
          formats: ["markdown"],
          timeout: 60_000,
          waitFor: (attempt + 1) * 1500,
        },
        timeoutMs: 90_000,
        config,
        retry: false,
      });

      const content = data?.data?.markdown || data?.markdown || "";
      if (content.trim()) {
        return { ok: true, provider: "firecrawl", content, raw: data, attempts: attempt + 1 };
      }

      lastError = "Firecrawl Scrape 返回空内容";
      debugLog(config, `Firecrawl empty markdown, retry ${attempt + 1}/${config.retryMaxAttempts}`);
    } catch (error) {
      lastError = error.message;
      if (error.status && !RETRYABLE_STATUS.has(error.status)) break;
      debugLog(config, `Firecrawl error, retry ${attempt + 1}/${config.retryMaxAttempts}: ${error.message}`);
    }

    if (attempt < config.retryMaxAttempts - 1) {
      await sleep(backoffMs(config, attempt));
    }
  }

  return { ok: false, provider: "firecrawl", error: lastError };
}

function summarizeFetchFailure(tried, fallback) {
  if (tried.length && tried.every((item) => item.skipped)) {
    const providers = tried.map((item) => item.provider);
    if (providers.includes("tavily") && providers.includes("firecrawl")) {
      return "配置错误: TAVILY_API_KEY 和 FIRECRAWL_API_KEY 均未配置";
    }
  }

  const details = tried
    .filter((item) => item.error)
    .map((item) => `${item.provider}: ${item.error}`)
    .join("; ");
  return details ? `提取失败: ${details}` : fallback || "提取失败: 所有提取服务均未能获取内容";
}

export async function fetchUrl(url, config, { provider = "auto" } = {}) {
  const tried = [];

  if (provider === "auto" || provider === "tavily") {
    const result = await tavilyExtract(url, config);
    tried.push({ provider: result.provider, ok: result.ok, skipped: Boolean(result.skipped), error: result.error });
    if (result.ok || provider === "tavily") return { ...result, tried };
  }

  if (provider === "auto" || provider === "firecrawl") {
    const result = await firecrawlScrape(url, config);
    tried.push({ provider: result.provider, ok: result.ok, skipped: Boolean(result.skipped), error: result.error });
    if (result.ok || provider === "firecrawl") return { ...result, tried };
    return { ...result, tried, error: summarizeFetchFailure(tried, result.error) };
  }

  return { ok: false, provider, tried, error: `未知 provider: ${provider}` };
}
