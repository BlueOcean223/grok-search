# grok-search

`grok-search` is a pi skill built from zero-dependency Node scripts for web search, URL fetch, and lightweight site mapping.

It is not an MCP server, extension, or packaged CLI. The intended use is for an agent to load `SKILL.md` only when web access is needed, then run the scripts directly with `node`.

## Why Scripts Instead Of MCP

- Keeps search tools out of the always-on tool list.
- Avoids MCP session state such as `get_sources`.
- Runs with plain Node.js and no install step.
- Returns machine-readable JSON from every script.

## Requirements

- Node.js `>=18`
- No `npm install` required
- `GROK_API_URL` and `GROK_API_KEY` for `search.js`

## Install As A pi Skill

Clone or copy this directory into your pi skills location, then enable the skill by referencing `SKILL.md`.

The scripts assume they are run from the project root:

```bash
node scripts/search.js "latest Node.js LTS"
node scripts/fetch.js https://example.com
node scripts/map.js https://docs.example.com --limit 20
```

## Configuration

Environment variables take priority over `~/.config/grok-search/config.json`.

| Variable | Required | Used by | Notes |
| --- | --- | --- | --- |
| `GROK_API_URL` | Yes for search | `search.js` | OpenAI-compatible base URL that supports `/chat/completions`. |
| `GROK_API_KEY` | Yes for search | `search.js` | API key for `GROK_API_URL`. |
| `GROK_MODEL` | No | `search.js` | Defaults to `grok-4-fast`. |
| `TAVILY_API_KEY` | No | `search.js --extra`, `fetch.js`, `map.js` | Enables Tavily Search/Extract/Map. Without it, `fetch.js` and `map.js` use direct fallbacks. |
| `TAVILY_API_URL` | No | Tavily paths | Defaults to `https://api.tavily.com`. |
| `FIRECRAWL_API_KEY` | No | `fetch.js`, `search.js --extra` | Enables Firecrawl Scrape fallback and extra search sources. |
| `FIRECRAWL_API_URL` | No | Firecrawl paths | Defaults to `https://api.firecrawl.dev/v2`. |
| `GROK_OUTPUT_DIR` | No | all scripts | Overrides long-output storage. Default: `~/.cache/grok-search/outputs/`. |
| `GROK_DEBUG` | No | all scripts | `true` prints retry/cleanup debug logs to stderr. |

If `GROK_API_URL` contains `openrouter`, the model automatically gets `:online` unless it already has that suffix.

Example config file:

```json
{
  "apiUrl": "https://your-openai-compatible-endpoint/v1",
  "apiKey": "your-grok-key",
  "model": "grok-4-fast",
  "tavilyApiKey": "tvly-your-key",
  "firecrawlApiKey": "fc-your-key"
}
```

## Search

```bash
node scripts/search.js "What changed in the latest Node.js LTS?"
node scripts/search.js --platform GitHub "pi coding agent search skill"
node scripts/search.js --extra 5 "latest pi coding agent docs"
node scripts/search.js --model grok-4-fast --max-chars 50000 "query"
```

`search.js` calls `{GROK_API_URL}/chat/completions` with `stream:false`, injects local time context, and returns:

- `answer`
- `sources`
- `sources_count`
- `warnings`
- `extra_tried` when `--extra` is used
- truncation fields when the answer is long

Extra sources are supplemental. They are added to `sources`, but they do not rewrite the Grok answer.

## Fetch

```bash
node scripts/fetch.js https://example.com
node scripts/fetch.js --provider direct https://example.com
node scripts/fetch.js --max-chars 50000 https://example.com
```

Provider order for `--provider auto`:

```text
Tavily Extract -> Firecrawl Scrape -> Direct Fetch
```

Direct Fetch is a best-effort fallback for normal HTTP(S) text pages. It strips simple HTML, formats JSON when possible, records redirects, and rejects binary/attachment/oversized responses.

## Map

```bash
node scripts/map.js https://docs.example.com --limit 20
node scripts/map.js --provider direct https://docs.example.com
node scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

Provider order for `--provider auto`:

```text
Tavily Map -> Direct Map
```

Without `TAVILY_API_KEY`, Tavily Map is unavailable and `map.js` falls back to Direct Map. Direct Map only checks same-site `/sitemap.xml`, then same-domain links on the homepage. It ignores `--instructions` and supports only `--max-depth 1`.

## Output Files

All scripts keep stdout as complete JSON. Long text fields are returned as previews, and the full content is written to:

```text
~/.cache/grok-search/outputs/
```

Set `GROK_OUTPUT_DIR` to override this path. Each run performs best-effort cleanup of `grok-search-*` files older than 30 days inside the output directory.

When JSON contains `full_output_path`, read that file if the full text is needed.

## Smoke Tests

No key required:

```bash
node scripts/fetch.js --provider direct https://example.com
node scripts/map.js --provider direct https://example.com --limit 5
node scripts/test-sources.js
```

Search requires Grok configuration:

```bash
export GROK_API_URL="https://your-openai-compatible-endpoint/v1"
export GROK_API_KEY="your-key"
node scripts/search.js "What changed in the latest Node.js LTS?"
```

## Common Errors

- `GROK_API_URL 未配置`: set `GROK_API_URL` before using `search.js`.
- `GROK_API_KEY 未配置`: set `GROK_API_KEY` before using `search.js`.
- `TAVILY_API_KEY 未配置`: explicit `--provider tavily` was requested without a Tavily key.
- Direct Fetch returns binary/attachment errors: the URL is not a text page or is too large for the direct fallback.
- Direct Map returns few or zero URLs: the site may rely on JavaScript, hide links, or have no public sitemap.

## Scope

First-version scope includes:

- `search.js`
- `search.js --extra N`
- `fetch.js` with Direct Fetch fallback
- `map.js` with Direct Map fallback
- long-output previews and full-output files
- `SKILL.md`
- `references/planning.md`
- smoke/fixture tests

Out of scope:

- Browser rendering
- PDF/image/archive parsing
- Cookies, login, proxy, or anti-bot bypass
- MCP server state such as `get_sources`
- CLI packaging or build steps
