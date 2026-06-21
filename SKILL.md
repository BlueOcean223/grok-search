---
name: grok-search
description: Use when the user explicitly asks to search the web, check latest/current facts, fetch a URL, or discover pages on a website. Do not use for local code search or stable offline knowledge unless the user asks for live web access.
---

# Grok Search

This skill provides web access through zero-dependency Node scripts. Use the scripts directly; do not assume an MCP server or extension is available.

## Choose The Script

- Use `scripts/search.js` when the user asks to search, verify current/latest information, or find sources for an unknown URL/topic.
- Use `scripts/fetch.js` when the user provides a concrete URL and wants the page content.
- Use `scripts/map.js` when the user wants to know what pages/docs exist on a site before fetching specific URLs.

Do not default to search for every task. If the user gives a URL and asks what it says, fetch it. If the user gives a documentation root and asks what pages exist, map it first.

## Commands

```bash
node scripts/search.js "query"
node scripts/search.js --platform GitHub --extra 5 "query"
node scripts/search.js --model grok-4-fast "query"
node scripts/search.js --max-chars 50000 "query"
```

```bash
node scripts/fetch.js https://example.com
node scripts/fetch.js --provider direct https://example.com
node scripts/fetch.js --max-chars 50000 https://example.com
```

```bash
node scripts/map.js https://docs.example.com --limit 20
node scripts/map.js --provider direct https://docs.example.com
node scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

## Configuration

Required for `search.js`:

- `GROK_API_URL`: OpenAI-compatible base URL
- `GROK_API_KEY`

Optional:

- `GROK_MODEL`: default model, otherwise `grok-4-fast`
- `TAVILY_API_KEY`: extra sources for search, Tavily Extract for fetch, Tavily Map for map
- `FIRECRAWL_API_KEY`: fetch fallback and extra sources for search
- `GROK_OUTPUT_DIR`: where full outputs are written when previews are truncated

If `GROK_API_URL` contains `openrouter`, models automatically get `:online` unless already present.

## Reading Results

Every script writes JSON to stdout. On failure it still writes JSON to stdout, writes a short human-readable error to stderr, and exits non-zero.

Common fields:

- `ok`: true or false
- `warnings`: non-fatal limitations
- `tried` / `extra_tried`: provider attempts
- `truncated`: whether the returned text is only a preview
- `full_output_path`: local file path for the full text when truncated

When `full_output_path` is present, read that file in chunks if the full content is needed.

## Limits

Direct Fetch and Direct Map are best-effort fallbacks. They do not execute JavaScript, bypass anti-bot systems, log in, use cookies, parse PDFs, or crawl deeply. For broad site discovery with instructions or deeper traversal, prefer Tavily Map when configured.

For complex searches involving multiple sub-questions, read `references/planning.md` before running commands.
