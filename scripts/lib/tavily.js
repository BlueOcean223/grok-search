import { authHeaders, requestJson } from "./http.js";
import { domainFilters, mapScope } from "./sources.js";

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

function sourceFromTavily(result) {
  const url = typeof result?.url === "string" ? result.url.trim() : "";
  if (!url) return null;
  return {
    url,
    provider: "tavily",
    ...(result.title ? { title: String(result.title).trim() } : {}),
    ...(result.content ? { description: String(result.content).trim() } : {}),
    ...(result.published_date ? { published_date: String(result.published_date).trim() } : {}),
    ...(Number.isFinite(result.score) ? { score: result.score } : {}),
  };
}

export async function tavilySearch(query, limit, config, filters = {}) {
  if (!config.tavilyApiKey) {
    return { ok: false, provider: "tavily", skipped: true, error: "TAVILY_API_KEY 未配置", sources: [] };
  }

  const { allowed, excluded } = domainFilters(filters);
  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/search`;
  try {
    const data = await requestJson(endpoint, {
      headers: authHeaders(config.tavilyApiKey),
      body: {
        query,
        max_results: limit,
        search_depth: "advanced",
        include_raw_content: false,
        include_answer: false,
        // Tavily: include_domains (max 300) / exclude_domains (max 150); "filter" restricts
        // results to the list, "boost" would only rank them higher.
        ...(allowed.length ? { include_domains: allowed, include_domains_mode: "filter" } : {}),
        ...(excluded.length ? { exclude_domains: excluded } : {}),
      },
      timeoutMs: 90_000,
      config,
      retry: true,
    });
    const sources = (Array.isArray(data?.results) ? data.results : []).map(sourceFromTavily).filter(Boolean);
    return { ok: true, provider: "tavily", sources, raw: data };
  } catch (error) {
    return { ok: false, provider: "tavily", error: error.message, sources: [] };
  }
}

export async function tavilyMap(url, options, config) {
  if (!config.tavilyApiKey) {
    return { ok: false, provider: "tavily", skipped: true, error: "TAVILY_API_KEY 未配置", results: [] };
  }

  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/map`;
  // The scope Direct Map keeps to: this site's pages, at or under the URL's path. By default
  // Tavily returns other paths and other sites too; docs.fiat24.com/user gave 20 URLs on
  // 2026-09-28, 4 under /products and /legal and 2 on gitbook.com.
  const scope = mapScope(url);
  const body = {
    url,
    max_depth: options.maxDepth,
    max_breadth: options.maxBreadth,
    limit: options.limit,
    timeout: options.timeout,
    allow_external: false,
    ...(scope ? { select_paths: [`^${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/.*)?$`] } : {}),
  };
  if (options.instructions) body.instructions = options.instructions;

  try {
    const data = await requestJson(endpoint, {
      headers: authHeaders(config.tavilyApiKey),
      body,
      timeoutMs: (options.timeout + 10) * 1000,
      config,
      retry: true,
    });
    return {
      ok: true,
      provider: "tavily",
      base_url: data?.base_url || new URL(url).origin,
      results: Array.isArray(data?.results) ? data.results.filter((item) => typeof item === "string") : [],
      response_time: data?.response_time ?? null,
      raw: data,
    };
  } catch (error) {
    return { ok: false, provider: "tavily", error: error.message, results: [] };
  }
}
