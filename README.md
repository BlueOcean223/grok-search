# grok-search

**English** | [简体中文](README.zh-CN.md)

`grok-search` is a general-purpose AI agent skill / script bundle that provides three web access capabilities through zero-dependency Node.js scripts:

- **Search**: call Grok / OpenRouter / OpenAI-compatible APIs for web search and source extraction.
- **Fetch**: fetch readable content from a concrete URL, preferring Tavily / Firecrawl and falling back to keyless Direct Fetch.
- **Map**: discover candidate URLs on a website, preferring Tavily Map and falling back to lightweight Direct Map.

## Why Skill + Scripts

- Keeps search tools out of the always-on model tool list.
- Avoids MCP session state such as `get_sources`.
- Requires no runtime dependency installation; Node.js 18+ is enough.
- Every script returns stable JSON for agent parsing.
- The same `SKILL.md` + `scripts/` layout can be used by pi and by other agent harnesses that support skills or shell commands.

## Requirements

- Node.js `>=18`
- No `npm install` required
- `GROK_API_URL` and `GROK_API_KEY` for `search.js`

## Quick Start

The scripts assume they are run from the project root:

```bash
node scripts/search.js "latest Node.js LTS"
node scripts/fetch.js https://example.com
node scripts/map.js https://docs.example.com --limit 20
```

## Use With pi (Example)

Clone or copy this directory into your pi skills location, then enable the skill through `SKILL.md`.

The commands are still direct script invocations:

```bash
node scripts/search.js "latest Node.js LTS"
node scripts/fetch.js https://example.com
node scripts/map.js https://docs.example.com --limit 20
```

Other agent harnesses can use the same pattern: read `SKILL.md`, then run `scripts/search.js`, `scripts/fetch.js`, or `scripts/map.js` when needed.

## Configuration

Recommended: keep long-lived keys in:

```text
~/.config/grok-search/config.json
```

Copy the example config first:

```bash
mkdir -p ~/.config/grok-search
cp config.example.json ~/.config/grok-search/config.json
chmod 600 ~/.config/grok-search/config.json
```

Then edit the copied file with your real keys. Environment variables still take priority over the config file, which is useful for one-off overrides and CI.

This project does **not** auto-load `.env` files. If you prefer env vars, export them in your shell yourself.

| Environment variable | Config key | Required | Used by | Notes |
| --- | --- | --- | --- | --- |
| `GROK_API_URL` | `apiUrl` | Yes for search | `search.js` | OpenAI-compatible base URL that supports `/chat/completions`. |
| `GROK_API_KEY` | `apiKey` | Yes for search | `search.js` | API key for `GROK_API_URL`. |
| `GROK_MODEL` | `model` | No | `search.js` | Defaults to `grok-4-fast`. |
| `TAVILY_API_KEY` | `tavilyApiKey` | No | `search.js --extra`, `fetch.js`, `map.js` | Enables Tavily Search/Extract/Map. Without it, `fetch.js` and `map.js` use direct fallbacks. |
| `TAVILY_API_URL` | `tavilyApiUrl` | No | Tavily paths | Defaults to `https://api.tavily.com`. |
| `FIRECRAWL_API_KEY` | `firecrawlApiKey` | No | `fetch.js`, `search.js --extra` | Enables Firecrawl Scrape fallback and extra search sources. |
| `FIRECRAWL_API_URL` | `firecrawlApiUrl` | No | Firecrawl paths | Defaults to `https://api.firecrawl.dev/v2`. |
| `GROK_OUTPUT_DIR` | `outputDir` | No | all scripts | Overrides long-output storage. Default: `~/.cache/grok-search/outputs/`. |
| `GROK_DEBUG` | — | No | all scripts | Env only. `true` prints retry/cleanup debug logs to stderr. |

If `GROK_API_URL` contains `openrouter`, the model automatically gets `:online` unless it already has that suffix.

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
node tests/sources.test.js
node tests/argv.test.js
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

## Acknowledgements And Origin

This project is based on and adapted from [GuDaStudio/GrokSearch](https://github.com/GuDaStudio/GrokSearch/), a Python / MCP Grok Search server.

Thanks to GuDaStudio for the original project and design. This project keeps the core search/fetch/site-map ideas, then rewrites them as **plain JS, zero-dependency, directly runnable scripts** for agent skill distribution.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).

The original project is also MIT-licensed. The original copyright notice is preserved in `LICENSE` to comply with the MIT License.
