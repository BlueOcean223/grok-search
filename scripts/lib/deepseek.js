import { authHeaders, requestJson } from "./http.js";

/**
 * DeepSeek Fetch (`POST /v1/tools/fetch`, opened 2026-10-17) returns a page as Markdown with
 * every ASCII punctuation character backslash-escaped, code included: `Rust 1\.99`,
 * `include\_domains\_mode`, `\#\# Posts`, a literal backslash as `\\`. Dropping one backslash
 * before each punctuation character undoes it exactly. Code fences are not in its output at all.
 */
export function unescapeDeepSeekMarkdown(text) {
  return String(text || "").replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/**
 * Billed per successful request ($0.75 per 1000 on 2026-10-19); failures are free. It refuses
 * whole domains within about 0.1s with a 404 (Wikipedia, Hacker News, X, YouTube, Reddit, arXiv
 * PDFs, Zhihu, 36kr on 2026-10-19), fetches other pages live in 5-20s the first time and from its
 * cache in about 0.1s after that. A 504 is its own crawler timing out after about 30s; the page
 * often lands in that cache anyway, so it is retried once.
 */
export async function deepseekFetch(url, config, { timeoutMs = 45_000 } = {}) {
  if (!config.deepseekApiKey) {
    return { ok: false, provider: "deepseek", skipped: true, error: "DEEPSEEK_API_KEY 未配置" };
  }
  const stats = { requests: 0 };
  try {
    const data = await requestJson(`${config.deepseekApiUrl.replace(/\/+$/, "")}/v1/tools/fetch`, {
      headers: authHeaders(config.deepseekApiKey),
      body: { url },
      timeoutMs,
      config: { ...config, retryMaxAttempts: Math.min(config.retryMaxAttempts ?? 2, 2) },
      retry: true,
      retryOnTimeout: false,
      stats,
    });
    const content = unescapeDeepSeekMarkdown(data?.content).trim();
    if (!content) return { ok: false, provider: "deepseek", error: "DeepSeek Fetch 返回空内容", requests: stats.requests };
    const title = unescapeDeepSeekMarkdown(data?.title).trim();
    return { ok: true, provider: "deepseek", content, metadata: title ? { title } : {}, requests: stats.requests };
  } catch (error) {
    return { ok: false, provider: "deepseek", error: error.message, requests: stats.requests };
  }
}
