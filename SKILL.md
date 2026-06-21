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
./scripts/search.js --platform GitHub --extra 5 "query"
./scripts/search.js --model grok-4-fast --max-chars 50000 "query"
```

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider direct https://example.com
./scripts/fetch.js --max-chars 50000 https://example.com
```

```bash
./scripts/map.js https://docs.example.com --limit 20
./scripts/map.js --provider direct https://docs.example.com
./scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

Add `--extra N` to `search.js` only when the user wants more sources alongside Grok's answer. The Grok answer itself does not change — the extras are leads to verify, not citations Grok used.

## Reading Results

Each script writes a single JSON object to stdout. On failure it still writes JSON to stdout, a short message to stderr, and exits non-zero.

Check in this order:

- `ok` — if false, read `error`, `warnings`, and any provider attempts (`tried` for fetch/map, `extra_tried` for search) to see what went wrong. Before retrying, change something: a sharper query, a different `--provider` (fetch/map), or a different `--model` (search). Do not rerun the same command.
- `truncated` — if true and the preview is enough, stop. If you need more, read `full_output_path` in chunks; do not rerun the command.
- `warnings`, `tried`, `extra_tried`, `provider` — these tell you which providers were skipped, which failed, and which actually produced the content. `search.js` returns `extra_tried` and `model` instead of `tried`/`provider`.

## Providers And Limits

`fetch.js` provider order for `--provider auto`: Tavily Extract → Firecrawl Scrape → Direct Fetch.
`map.js` provider order for `--provider auto`: Tavily Map → Direct Map.

Without `TAVILY_API_KEY` / `FIRECRAWL_API_KEY`, only the direct providers run. The direct providers do not execute JavaScript, log in, use cookies, parse PDFs, or bypass anti-bot. Direct Map only reads `/sitemap.xml` and same-domain homepage links, ignores `--instructions`, and is limited to `--max-depth 1`.

## Proxy

The scripts automatically use terminal proxy environment variables via undici when present: `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and lowercase variants. `NO_PROXY` is honored, and loopback hosts are bypassed. Use `GROK_PROXY="http://127.0.0.1:7890"` to set a proxy just for this tool, or `GROK_PROXY=off` to force direct connections. If proxy debugging is needed, set `GROK_DEBUG=true`.

If `search.js` returns `GROK_API_URL 未配置` or `GROK_API_KEY 未配置`, the project itself is missing required setup — point the user at `README.md` instead of trying to work around it.

## When To Plan First

For multi-part research, conflicting sources, or anything that needs both site discovery and page content, read `references/planning.md` before running commands.
