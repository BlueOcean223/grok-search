#!/usr/bin/env node
import { loadConfig } from "./lib/config.js";
import { fetchUrl } from "./lib/providers.js";

function usage() {
  return `Usage: node scripts/fetch.js [--provider auto|tavily|firecrawl] <url>

Fetch a web page as Markdown using Tavily Extract, falling back to Firecrawl Scrape.

Environment:
  TAVILY_API_KEY       Tavily key used by the primary provider
  TAVILY_API_URL       Default: https://api.tavily.com
  FIRECRAWL_API_KEY    Firecrawl key used as fallback
  FIRECRAWL_API_URL    Default: https://api.firecrawl.dev/v2
  GROK_RETRY_*         Retry tuning shared with grok-search scripts
`;
}

function parseArgs(argv) {
  const args = [...argv];
  let provider = "auto";
  let url;

  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--provider") {
      provider = args.shift();
      continue;
    }
    if (arg?.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`未知参数: ${arg}`);
    }
    if (url) {
      throw new Error(`只能提供一个 URL，多余参数: ${arg}`);
    }
    url = arg;
  }

  if (!url) throw new Error("缺少 URL");
  if (!["auto", "tavily", "firecrawl"].includes(provider)) {
    throw new Error("--provider 只能是 auto、tavily 或 firecrawl");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL 无效: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL 必须使用 http 或 https 协议");
  }

  return { url: parsed.toString(), provider };
}

function publicResult(url, result) {
  const ok = Boolean(result.ok);
  const content = ok ? result.content : undefined;
  return {
    ok,
    url,
    provider: result.provider,
    content,
    content_length: content ? content.length : 0,
    error: ok ? undefined : result.error || "提取失败: 所有提取服务均未能获取内容",
    tried: result.tried || [],
    fetched_at: new Date().toISOString(),
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const config = await loadConfig({ requireGrok: false });
  const result = await fetchUrl(args.url, config, { provider: args.provider });
  const output = publicResult(args.url, result);

  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    console.error(output.error);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exitCode = 2;
}
