# grok-search

[简体中文](README.md) | **English**

`grok-search` is a general-purpose AI agent skill / script bundle that provides three web access capabilities through small Node.js scripts:

- **Search**: use the Responses API with Grok / OpenRouter / Responses-compatible endpoints, plus independent Tavily / Firecrawl sources in parallel.
- **Fetch**: fetch readable content from a concrete URL, preferring Tavily / Firecrawl and falling back to keyless Direct Fetch.
- **Map**: discover candidate URLs on a website, preferring Tavily Map and falling back to lightweight Direct Map.

## Requirements

- Node.js `>=18.17`
- Run `npm install` once to install the `undici` transport dependency
- `GROK_API_URL` and `GROK_API_KEY` for `search.js`

## Quick Start

Install dependencies once, then run scripts from the project root:

```bash
npm install
./scripts/search.js "latest Node.js LTS"
./scripts/fetch.js https://example.com
./scripts/map.js https://docs.example.com --limit 20
```

## Use With pi (Example)

Clone or copy this directory into your pi skills location, then enable the skill through `SKILL.md`.

The commands are still direct script invocations:

```bash
./scripts/search.js "latest Node.js LTS"
./scripts/fetch.js https://example.com
./scripts/map.js https://docs.example.com --limit 20
```

Other agent harnesses can use the same pattern: read `SKILL.md`, then run `scripts/search.js`, `scripts/fetch.js`, or `scripts/map.js` when needed.

## Documentation

- [Architecture](docs/architecture.md)
- [Features](docs/features.md)
- [Responses search protocol](docs/responses-mode.md)
- [Smoke tests](docs/smoke-tests.md)
- [Public benchmark](docs/benchmark.md)
- [Evaluation methodology research](docs/web-search-evaluation-research.md)

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

Full configuration example:

```json
{
  "apiUrl": "https://api.x.ai/v1",
  "apiKey": "your-grok-api-key",
  "apiProvider": "xai",
  "model": "grok-4.3",
  "responsesMaxTurns": 3,
  "responsesReasoningEffort": "low",
  "responsesAllowedDomains": [],
  "responsesExcludedDomains": [],
  "responsesIncludeXSearch": false,
  "responsesAllowedXHandles": [],
  "responsesExcludedXHandles": [],
  "responsesOpenRouterEngine": "auto",
  "defaultExtra": 6,
  "sourceChars": 400,
  "tavilyApiKey": "",
  "tavilyApiUrl": "https://api.tavily.com",
  "firecrawlApiKey": "",
  "firecrawlApiUrl": "https://api.firecrawl.dev/v2",
  "outputDir": ""
}
```

Common configuration rules:

- `apiUrl` is the API base URL that supports `/responses`. The script requests `{apiUrl}/responses`, so do not include `/responses` itself.
- `apiProvider` accepts exactly one value:
  - `xai`: the official xAI endpoint, using `web_search` with optional `x_search`.
  - `openrouter`: the OpenRouter endpoint, using `openrouter:web_search`; `responsesOpenRouterEngine` selects its search engine.
  - `openai-compatible`: a relay, proxy, or compatible service that supports xAI-style Responses and the `web_search` tool. A Chat-Completions-only endpoint is not sufficient.
- When `apiProvider` is omitted, it is inferred from the URL: URLs containing `openrouter` use `openrouter`, URLs containing `api.x.ai` use `xai`, and all others use `openai-compatible`. Set it explicitly for relay services to avoid selecting the wrong request format.
- `model` must be an ID supported by that endpoint. `responsesMaxTurns` is an integer of at least 1. Common `responsesReasoningEffort` values are `low`, `medium`, and `high`, but support depends on the selected model and provider.
- `responsesAllowedDomains`, `responsesExcludedDomains`, `responsesAllowedXHandles`, and `responsesExcludedXHandles` are arrays and may contain multiple values, for example `["github.com", "docs.python.org"]`. The allowed and excluded forms of the same filter are mutually exclusive. In environment variables, separate multiple values with commas.
- `responsesOpenRouterEngine` accepts `auto`, `native`, `exa`, `firecrawl`, `parallel`, or `perplexity`, and only applies when `apiProvider` is `openrouter`.
- `tavilyApiKey` is optional. `firecrawlApiKey` may also be empty to use Firecrawl Keyless. An empty `outputDir` uses `~/.cache/grok-search/outputs/`.

For OpenRouter, replace the core fields with:

```json
{
  "apiUrl": "https://openrouter.ai/api/v1",
  "apiKey": "your-openrouter-api-key",
  "apiProvider": "openrouter",
  "model": "your-openrouter-model-id",
  "responsesOpenRouterEngine": "auto"
}
```

For a Responses-compatible relay, replace the core fields with:

```json
{
  "apiUrl": "https://your-endpoint.example/v1",
  "apiKey": "your-api-key",
  "apiProvider": "openai-compatible",
  "model": "the-model-id-supported-by-your-endpoint"
}
```

Then edit the copied file with your real keys. Environment variables still take priority over the config file, which is useful for one-off overrides and CI.

This project does **not** auto-load `.env` files. If you prefer env vars, export them in your shell yourself.

Related docs:

- [Architecture](docs/architecture.md)
- [Features](docs/features.md)
- [Responses search protocol](docs/responses-mode.md)
- [Smoke tests](docs/smoke-tests.md)

### Proxy

Node's native `fetch` does not reliably honor terminal proxy variables by default. These scripts install an `undici` `EnvHttpProxyAgent` automatically when proxy environment variables are present, so outbound requests use your terminal proxy setup.

Supported variables:

- `HTTP_PROXY` / `http_proxy`
- `HTTPS_PROXY` / `https_proxy`
- `ALL_PROXY` / `all_proxy`
- `NO_PROXY` / `no_proxy`
- `GROK_PROXY` to explicitly set one proxy URL for this tool, or `GROK_PROXY=off` to force direct connections

`NO_PROXY` is honored, and loopback hosts (`localhost`, `127.0.0.1`, `::1`) are always added to the bypass list.

| Environment variable | Config key | Required | Used by | Notes |
| --- | --- | --- | --- | --- |
| `GROK_API_URL` | `apiUrl` | Yes for search | `search.js` | Base URL that supports `/responses`. |
| `GROK_API_KEY` | `apiKey` | Yes for search | `search.js` | API key for `GROK_API_URL`. |
| `GROK_API_PROVIDER` | `apiProvider` | No | `search.js` | Selects the Responses tool request format, not an additional search source. Accepts `xai`, `openrouter`, or `openai-compatible`; inferred from the URL when omitted. |
| `GROK_MODEL` | `model` | No | `search.js` | Defaults to `grok-4.3`. |
| `GROK_RESPONSES_MAX_TURNS` | `responsesMaxTurns` | No | Responses | Responses agentic turn limit. Default: `3`. |
| `GROK_RESPONSES_REASONING_EFFORT` | `responsesReasoningEffort` | No | Responses | Default: `low`. |
| `GROK_RESPONSES_ALLOWED_DOMAINS` | `responsesAllowedDomains` | No | Responses | Comma-separated domain allow-list, max 5; mutually exclusive with excluded domains. |
| `GROK_RESPONSES_EXCLUDED_DOMAINS` | `responsesExcludedDomains` | No | Responses | Comma-separated domain deny-list, max 5; mutually exclusive with allowed domains. |
| `GROK_RESPONSES_INCLUDE_X_SEARCH` | `responsesIncludeXSearch` | No | Responses | Enables direct xAI `x_search`. Default: `false`. |
| `GROK_RESPONSES_ALLOWED_X_HANDLES` | `responsesAllowedXHandles` | No | Responses | X handle allow-list; mutually exclusive with excluded handles. |
| `GROK_RESPONSES_EXCLUDED_X_HANDLES` | `responsesExcludedXHandles` | No | Responses | X handle deny-list; mutually exclusive with allowed handles. |
| `GROK_RESPONSES_OPENROUTER_ENGINE` | `responsesOpenRouterEngine` | No | OpenRouter Responses | `auto`, `native`, `exa`, `firecrawl`, `parallel`, or `perplexity`. Default: `auto`. |
| `GROK_DEFAULT_EXTRA` | `defaultExtra` | No | `search.js` | Combined Tavily/Firecrawl source target. Default: `6`. |
| `GROK_SOURCE_CHARS` | `sourceChars` | No | `search.js` | Per-source stdout snippet limit. Default: `400`; `0` omits snippets. |
| `TAVILY_API_KEY` | `tavilyApiKey` | No | `search.js`, `fetch.js`, `map.js` | Enables Tavily Search/Extract/Map. Without it, search/fetch still use Firecrawl Keyless and map uses Direct Map. |
| `TAVILY_API_URL` | `tavilyApiUrl` | No | Tavily paths | Defaults to `https://api.tavily.com`. |
| `FIRECRAWL_API_KEY` | `firecrawlApiKey` | No | `search.js`, `fetch.js` | Optional. Uses Firecrawl Keyless when absent; a key provides account-scoped credits and higher rate limits. |
| `FIRECRAWL_API_URL` | `firecrawlApiUrl` | No | Firecrawl paths | Defaults to `https://api.firecrawl.dev/v2`. |
| `GROK_OUTPUT_DIR` | `outputDir` | No | all scripts | Overrides long-output storage. Default: `~/.cache/grok-search/outputs/`. |
| `GROK_DEBUG` | — | No | all scripts | Env only. `true` prints retry/cleanup/proxy debug logs to stderr. |
| `GROK_PROXY` | — | No | all scripts | Env only. Explicit proxy URL for this tool, or `off`/`direct` to disable proxy use. |

OpenRouter uses the `openrouter:web_search` server tool and does not append `:online` to model names.

## Output Schema

This version uses command-native JSON output. This is a **breaking change** from the older `ok`/`kind` style envelope.

On failure, every script returns:

```json
{
  "error": {
    "message": "...",
    "code": "FETCH_ERROR"
  },
  "diagnostics": {
    "warnings": [],
    "provider_attempts": []
  }
}
```

On success, provider attempts, warnings, timestamps, and command options live under `diagnostics`.

## Search

```bash
./scripts/search.js "What changed in the latest Node.js LTS?"
./scripts/search.js --platform GitHub "pi coding agent search skill"
./scripts/search.js --extra 10 "latest pi coding agent docs"
./scripts/search.js --no-extra "query"
./scripts/search.js --source-chars 200 "query"
./scripts/search.js --full-sources "debug provider raw"
./scripts/search.js --responses-openrouter-engine exa "strict web-only query"
./scripts/search.js --responses-x-search --responses-allowed-x-handles xai,OpenAI "query"
```

`search.js` is Responses-only. It calls `{GROK_API_URL}/responses` with `stream:false`, enables the provider-native web search tool, and returns:

- `answer.text`, `answer.chars`, `answer.original_chars`, `answer.truncated`, `answer.full_path`
- `sources.grok`, `sources.extra`, and `sources.merged` compact source cards
- `sources.raw_path` when full source/provider raw data is stored on disk
- `sources.raw` only when `--full-sources` is used
- `diagnostics.grok_endpoint`, `diagnostics.usage` / `diagnostics.cost_usd` when supplied by the provider, `diagnostics.responses_*`, `diagnostics.warnings`, `diagnostics.provider_attempts`, `diagnostics.options`, and `diagnostics.searched_at`

By default the command starts Grok Responses, Tavily Search when configured, and Firecrawl Search in parallel. Tavily and Firecrawl remain independent evidence channels and are never injected into Grok input.

`--extra N` is the combined Tavily/Firecrawl target, defaulting to `6`. Both providers split the target evenly, with odd counts favoring Tavily. Without a Tavily key, Firecrawl Keyless receives the full target. `--no-extra` strictly disables both external search channels.

When Grok explicitly reports exhausted quota and extra sources are available, the command returns a degraded success with `diagnostics.degraded: true`. The visible answer states that it contains raw Tavily/Firecrawl results, while `diagnostics.grok_error` preserves the redacted upstream quota error. Authentication, protocol, and generic service failures do not trigger this fallback.

Firecrawl Keyless includes 1,000 credits per month and additional undisclosed daily IP limits. A free API key keeps the same monthly credits but provides higher rate limits, account-scoped usage, and access to more endpoints.

Source cards intentionally do not include long `description` or `content` fields. They use short `snippet` fields, with full raw data available through `sources.raw_path`.

## Fetch

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider direct https://example.com
```

Default fetch output is a 12,000-character preview. Use `--max-chars 50000` only for an explicit deep read after the preview is useful.

```bash
./scripts/fetch.js --max-chars 50000 https://example.com
```

Provider order for `--provider auto`:

```text
Tavily Extract -> Firecrawl Scrape -> Direct Fetch
```

Direct Fetch is a best-effort fallback for normal HTTP(S) text pages. It strips simple HTML, formats JSON when possible, records redirects, and rejects binary/attachment/oversized responses.

Firecrawl Scrape uses Keyless without a key and automatically sends a Bearer token when `FIRECRAWL_API_KEY` is configured. The active mode is exposed as `diagnostics.firecrawl_auth_mode`.

Successful fetch output uses `content.text`, `content.chars`, `content.original_chars`, `content.truncated`, and `content.full_path`, with provider details under `diagnostics`.

## Map

```bash
./scripts/map.js https://docs.example.com --limit 20
./scripts/map.js --provider direct https://docs.example.com
./scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

Provider order for `--provider auto`:

```text
Tavily Map -> Direct Map
```

Without `TAVILY_API_KEY`, Tavily Map is unavailable and `map.js` falls back to Direct Map. Direct Map only checks same-site `/sitemap.xml`, then same-domain links on the homepage. It ignores `--instructions` and supports only `--max-depth 1`.

Successful map output uses `urls` for discovered URLs. Provider, response time, ignored instructions, warnings, attempts, and options live under `diagnostics`.

## Output Files

All scripts keep stdout as complete JSON. Long text fields are returned as previews, and the full content is written to:

```text
~/.cache/grok-search/outputs/
```

Set `GROK_OUTPUT_DIR` to override this path. Each run performs best-effort cleanup of `grok-search-*` files older than 30 days inside the output directory.

Read these paths only when the preview is not enough:

- `answer.full_path` for full search answers
- `content.full_path` for full fetched page text
- `sources.raw_path` for full source/provider raw data

## Smoke Tests

No key required:

```bash
./scripts/fetch.js --provider direct https://example.com
./scripts/map.js --provider direct https://example.com --limit 5
node tests/sources.test.js
node tests/proxy.test.js
node tests/responses.test.js
node tests/argv.test.js
```

Search requires Grok configuration:

```bash
export GROK_API_URL="https://your-openai-compatible-endpoint/v1"
export GROK_API_KEY="your-key"
./scripts/search.js "What changed in the latest Node.js LTS?"
```

## Common Errors

- `GROK_API_URL 未配置`: set `GROK_API_URL` before using `search.js`.
- `GROK_API_KEY 未配置`: set `GROK_API_KEY` before using `search.js`.
- `GROK_QUOTA_EXHAUSTED`: Grok quota is exhausted and extras are disabled, or neither Tavily nor Firecrawl produced a usable fallback result.
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
- Cookies, login, or anti-bot bypass
- MCP server state such as `get_sources`
- CLI packaging or build steps

## Acknowledgements And Origin

This project is based on and adapted from [GuDaStudio/GrokSearch](https://github.com/GuDaStudio/GrokSearch/), a Python / MCP Grok Search server.

Thanks to GuDaStudio for the original project and design. This project keeps the core search/fetch/site-map ideas, then rewrites them as **plain JS, directly runnable scripts** for agent skill distribution.

This project is shared with the [Linux.do community](https://linux.do/).

## License

This project is released under the MIT License. See [LICENSE](LICENSE).

The original project is also MIT-licensed. The original copyright notice is preserved in `LICENSE` to comply with the MIT License.
