/**
 * Tavily Search and Firecrawl Search for the benchmark scripts. search.js ran them beside Grok
 * until 2026-10-19 (scripts/lib/tavily.js, firecrawl.js); they were removed from the skill then,
 * and these copies only keep deepseek-compare, search-extra-compare and supplement-compare
 * runnable. Each returns { ok, provider, error, raw, credits_used } with the provider's response
 * untouched in `raw`.
 */
import { authHeaders, requestJson } from "../../scripts/lib/http.js";

const domainLists = (filters) => ({
  allowed: (filters?.allowedDomains || []).filter(Boolean),
  excluded: (filters?.excludedDomains || []).filter(Boolean),
});

/** Tavily Search, advanced depth (2 credits), as search.js sent it. */
export async function tavilySearch(query, limit, config, filters = {}) {
  if (!config.tavilyApiKey) return { ok: false, provider: "tavily", skipped: true, error: "TAVILY_API_KEY is not set" };
  const { allowed, excluded } = domainLists(filters);
  try {
    const raw = await requestJson(`${config.tavilyApiUrl.replace(/\/+$/, "")}/search`, {
      headers: authHeaders(config.tavilyApiKey),
      body: {
        query,
        max_results: limit,
        search_depth: "advanced",
        include_raw_content: false,
        include_answer: false,
        ...(allowed.length ? { include_domains: allowed, include_domains_mode: "restrict" } : {}),
        ...(excluded.length ? { exclude_domains: excluded } : {}),
      },
      timeoutMs: 90_000,
      config,
      retry: true,
    });
    return { ok: true, provider: "tavily", raw };
  } catch (error) {
    return { ok: false, provider: "tavily", error: error.message };
  }
}

/** Firecrawl Search (2 credits per 10 results). */
export async function firecrawlSearch(query, limit, config, filters = {}) {
  const { allowed, excluded } = domainLists(filters);
  try {
    const raw = await requestJson(`${config.firecrawlApiUrl.replace(/\/+$/, "")}/search`, {
      headers: config.firecrawlApiKey ? authHeaders(config.firecrawlApiKey) : { "Content-Type": "application/json" },
      body: {
        query,
        limit,
        ...(allowed.length ? { includeDomains: allowed } : {}),
        ...(excluded.length ? { excludeDomains: excluded } : {}),
      },
      timeoutMs: 90_000,
      config,
      retry: true,
    });
    return { ok: true, provider: "firecrawl", raw, ...(Number.isFinite(raw?.creditsUsed) ? { credits_used: raw.creditsUsed } : {}) };
  } catch (error) {
    return { ok: false, provider: "firecrawl", error: error.message };
  }
}
