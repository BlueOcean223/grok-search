---
name: grok-search
description: Use when the user explicitly asks to search the web, check latest/current facts, fetch a URL, or discover pages on a website. Do not use for local code search or stable offline knowledge unless the user asks for live web access.
---

# Grok Search

Node scripts for web search, URL fetch, and lightweight site mapping. Run `npm install` once if dependencies are not installed, then run the scripts directly — there is no MCP server or extension to call.

## Choose The Script

Decide before running, by what the user already gave you:

- They gave a URL and asked what it says → `scripts/fetch.js`.
- They named a site but no URL, and want to know what is on it → `scripts/map.js`, then `fetch.js` on the URLs you pick.
- They want current/latest information, or the URL is unknown → `scripts/search.js`.

Do not chain map → fetch → search by default. Run the fewest commands that answer the question. If sub-questions are independent (different sites, unrelated facts), launch the commands in parallel instead of sequentially.

## Commands

```bash
./scripts/search.js "query"
./scripts/search.js --platform GitHub "query"
./scripts/search.js --extra 10 "query"
./scripts/search.js --no-extra "query"
./scripts/search.js --source-chars 200 "query"
```

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider direct https://example.com
```

Use `./scripts/fetch.js --max-chars 50000 URL` only for an explicit deep read after the preview shows the page is worth reading.

```bash
./scripts/map.js https://docs.example.com --limit 20
./scripts/map.js --provider direct https://docs.example.com
./scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

When `TAVILY_API_KEY` or `FIRECRAWL_API_KEY` is configured, `search.js` automatically adds a small extra source set by default. Add `--extra 10` only when the user wants a broader candidate-source sweep alongside Grok's answer. The Grok answer itself does not change — the extras are leads to verify, not citations Grok used.

## Reading Results

Each script writes a single JSON object to stdout. On failure it still writes JSON to stdout, a short message to stderr, and exits non-zero.

Check in this order:

- `error` — if present, read `error.message`, `error.code`, `error.preview` if present, and `diagnostics.provider_attempts`. Before retrying, change something: a sharper query, a different `--provider` (fetch/map), or a different `--model` (search). Do not rerun the same command.
- `diagnostics.warnings` and `diagnostics.provider_attempts` — these tell you which providers were skipped, failed, or produced content.
- Search success: read `answer.text`, then `sources.merged`. Source cards are short and use `snippet`, not `description` or `content`. Full source/provider raw is in `sources.raw_path`; read it in chunks only when needed.
- Fetch success: read `content.text`. If `content.truncated` is true and the preview is enough, stop. If more is needed, read `content.full_path` in chunks or rerun once with a deliberate larger `--max-chars`.
- Map success: read `urls`, choose the best candidates, then fetch only the few URLs you need.

Search and fetch are intentionally separated. Use search to discover and compare sources, then fetch a specific URL for deep reading. In one research turn, fetch 1-2 URLs by default; do not batch-fetch many pages unless the user explicitly asks.

## Providers And Limits

`fetch.js` provider order for `--provider auto`: Tavily Extract → Firecrawl Scrape → Direct Fetch.
`map.js` provider order for `--provider auto`: Tavily Map → Direct Map.

For search, missing Tavily/Firecrawl keys simply means no automatic extra sources and no noisy warning. For fetch/map, missing keys mean only direct providers run. The direct providers do not execute JavaScript, log in, use cookies, parse PDFs, or bypass anti-bot. Direct Map only reads `/sitemap.xml` and same-domain homepage links, ignores `--instructions`, and is limited to `--max-depth 1`.

## Proxy

The scripts automatically use terminal proxy environment variables via undici when present: `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and lowercase variants. `NO_PROXY` is honored, and loopback hosts are bypassed. Use `GROK_PROXY="http://127.0.0.1:7890"` to set a proxy just for this tool, or `GROK_PROXY=off` to force direct connections. If proxy debugging is needed, set `GROK_DEBUG=true`.

If `search.js` returns `GROK_API_URL 未配置` or `GROK_API_KEY 未配置`, the project itself is missing required setup — point the user at `README.md` instead of trying to work around it.

## When To Plan First

For multi-part research, conflicting sources, or anything that needs both site discovery and page content, read `references/planning.md` before running commands.
