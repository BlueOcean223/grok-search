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
- Agent-facing: [SKILL.md](SKILL.md) (read every turn, kept under 5k chars) plus the on-demand [references/x-search.md](references/x-search.md), [references/providers.md](references/providers.md), and [references/planning.md](references/planning.md)

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
  "responsesAllowedXHandles": [],
  "responsesExcludedXHandles": [],
  "responsesOpenRouterEngine": "auto",
  "defaultExtra": 6,
  "sourceChars": 400,
  "tavilyApiKey": "",
  "tavilyApiUrl": "https://api.tavily.com",
  "firecrawlApiKey": "",
  "firecrawlApiUrl": "https://api.firecrawl.dev/v2",
  "outputDir": "",
  "stateDir": "",
  "runLog": true
}
```

Common configuration rules:

- `apiUrl` is the API base URL that supports `/responses`. The script requests `{apiUrl}/responses`, so do not include `/responses` itself.
- `apiProvider` accepts exactly one value:
  - `xai`: the official xAI endpoint, using `web_search` and `x_search` according to `searchSource`.
  - `openrouter`: the OpenRouter endpoint, using `openrouter:web_search`; `responsesOpenRouterEngine` selects its search engine.
  - `openai-compatible`: a relay, proxy, or compatible service that supports xAI-style Responses and the `web_search` tool. A Chat-Completions-only endpoint is not sufficient.
- When `apiProvider` is omitted, it is inferred from the URL: URLs containing `openrouter` use `openrouter`, URLs containing `api.x.ai` use `xai`, and all others use `openai-compatible`. Set it explicitly for relay services to avoid selecting the wrong request format.
- `model` must be an ID supported by that endpoint. `responsesMaxTurns` is an integer of at least 1. Common `responsesReasoningEffort` values are `low`, `medium`, and `high`, but support depends on the selected model and provider.
- `responsesAllowedDomains`, `responsesExcludedDomains`, `responsesAllowedXHandles`, and `responsesExcludedXHandles` are arrays and may contain multiple values, for example `["github.com", "docs.python.org"]`. The allowed and excluded forms of the same filter are mutually exclusive. Domains are capped at 5, X handles at 20. In environment variables, separate multiple values with commas.
- `searchSource` accepts `web`, `x`, or `both` and selects which search tools are attached by default; the `--source` flag takes precedence. X date windows vary per query and are only available as `--x-from-date` / `--x-to-date`, with no config counterpart.
- The old `responsesIncludeXSearch` / `GROK_RESPONSES_INCLUDE_X_SEARCH` option has been removed (deprecated 2026-08, removed 2026-09). A `true` value now fails with `CONFIG_OPTION_REMOVED` instead of silently dropping X search; switch to `searchSource: "both"`. `false` or absent is unaffected.
- Precedence is CLI > environment > config file > built-in default. Note that you write the config file while the agent invoking this tool writes the CLI args: scalar settings such as `searchSource` are **defaults** the agent may override, and the value actually used is always recorded in `diagnostics.options`. Configured **restrictions**, however, are never silently discarded — allow-lists and deny-lists are both restrictions, and CLI values may only narrow them. Stepping outside one raises `RESPONSES_FILTER_FORBIDDEN`, emptying an allow-list raises `RESPONSES_FILTER_EMPTY`, and two deny-lists are merged rather than replaced. See [docs/responses-mode.md](docs/responses-mode.md#配置与命令行的优先级).
- `responsesOpenRouterEngine` accepts `auto`, `native`, `exa`, `firecrawl`, `parallel`, or `perplexity`, and only applies when `apiProvider` is `openrouter`.
- `tavilyApiKey` is optional. `firecrawlApiKey` may also be empty to use Firecrawl Keyless. An empty `outputDir` uses `~/.cache/grok-search/outputs/`; an empty `stateDir` uses `~/.cache/grok-search/` for the Firecrawl cooldown state and the fetch cache. `runLog: false` disables the per-run record files.

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
- `GROK_PROXY` to explicitly set one proxy URL for this tool, or `GROK_PROXY=off` to force direct connections. An invalid explicit `GROK_PROXY` fails the command (`PROXY_CONFIG_INVALID`) instead of silently falling back to a direct connection; failures of ambient proxy variables stay non-fatal and surface via `diagnostics.options.proxy_mode` on search

`NO_PROXY` is honored, and loopback hosts (`localhost`, `127.0.0.1`, `::1`) are always added to the bypass list.

| Environment variable | Config key | Required | Used by | Notes |
| --- | --- | --- | --- | --- |
| `GROK_API_URL` | `apiUrl` | Yes for search | `search.js` | Base URL that supports `/responses`. |
| `GROK_API_KEY` | `apiKey` | Yes for search | `search.js` | API key for `GROK_API_URL`. |
| `GROK_API_PROVIDER` | `apiProvider` | No | `search.js` | Selects the Responses tool request format, not an additional search source. Accepts `xai`, `openrouter`, or `openai-compatible`; inferred from the URL when omitted. |
| `GROK_MODEL` | `model` | No | `search.js` | Defaults to `grok-4.3`. Avoid `grok-4.6`: in about one web search in six it stops writing at its first inline citation and returns only the opening of the answer (reproduced on `api.x.ai` and relays, 2026-10-10); `grok-4.7` does not. |
| `GROK_RESPONSES_MAX_TURNS` | `responsesMaxTurns` | No | Responses | Responses agentic turn limit; a hard cap for X search only, web search is not bound by it. Default: `3`. |
| `GROK_RESPONSES_REASONING_EFFORT` | `responsesReasoningEffort` | No | Responses | Default: `low`. |
| `GROK_RESPONSES_PARALLEL_TOOL_CALLS` | `responsesParallelToolCalls` | No | Responses | `true` / `false`; not sent unless set. `false` makes Grok run one server-side tool call per turn; `api.x.ai` and relays that pass it through echo `false` and X search drops to one call per turn, so `max_turns` becomes a hard cap (2026-09-08: grok-4.5 via a relay went from 7–14 calls to 3 at a third of the cost; grok-4.6, direct or via the same relay, runs 3–4 calls on its own and gained nothing, so add it when `responses_tool_calls.total` is above 6). Relays that ignore it echo `true`. `max_tool_calls` is ignored by xAI and by relays, so it is not wired. CLI: `--responses-parallel-tool-calls false`. |
| `GROK_RESPONSES_ALLOWED_DOMAINS` | `responsesAllowedDomains` | No | Responses | Comma-separated domain allow-list, max 5; mutually exclusive with excluded domains. |
| `GROK_RESPONSES_EXCLUDED_DOMAINS` | `responsesExcludedDomains` | No | Responses | Comma-separated domain deny-list, max 5; mutually exclusive with allowed domains. |
| `GROK_SEARCH_SOURCE` | `searchSource` | No | Responses | Default search source: `web`, `x`, or `both`. Default: `web`. |
| `GROK_RESPONSES_ALLOWED_X_HANDLES` | `responsesAllowedXHandles` | No | Responses | X handle allow-list, max 20; mutually exclusive with excluded handles. |
| `GROK_RESPONSES_EXCLUDED_X_HANDLES` | `responsesExcludedXHandles` | No | Responses | X handle deny-list, max 20; mutually exclusive with allowed handles. |
| `GROK_X_IMAGE_UNDERSTANDING` | `xImageUnderstanding` | No | Responses | Analyze images inside X posts; billed as extra tokens. Default: `false`. |
| `GROK_X_VIDEO_UNDERSTANDING` | `xVideoUnderstanding` | No | Responses | Analyze videos inside X posts; billed as extra tokens. Default: `false`. |
| `GROK_RESPONSES_OPENROUTER_ENGINE` | `responsesOpenRouterEngine` | No | OpenRouter Responses | `auto`, `native`, `exa`, `firecrawl`, `parallel`, or `perplexity`. Default: `auto`. |
| `GROK_DEFAULT_EXTRA` | `defaultExtra` | No | `search.js` | Combined Tavily/Firecrawl source target. Default: `6`. |
| `GROK_SOURCE_CHARS` | `sourceChars` | No | `search.js` | Per-source stdout snippet limit. Default: `400`; `0` omits snippets. |
| `GROK_MAX_SOURCES` | `maxSources` | No | `search.js` | Cap on source cards returned on stdout. Default: `12`; the untruncated list is stored at `sources.raw_path`. |
| `GROK_DEADLINE_SECONDS` | `deadlineSeconds` | No | all scripts | Whole-command deadline in seconds. Default: `240`, `0` disables; on expiry the command prints a `DEADLINE_EXCEEDED` JSON envelope before exiting. |
| `TAVILY_API_KEY` | `tavilyApiKey` | No | `search.js`, `fetch.js`, `map.js` | Enables Tavily Search/Extract/Map. Without it, search/fetch still use Firecrawl Keyless and map uses Direct Map. |
| `TAVILY_API_URL` | `tavilyApiUrl` | No | Tavily paths | Defaults to `https://api.tavily.com`. |
| `FIRECRAWL_API_KEY` | `firecrawlApiKey` | No | `search.js`, `fetch.js` | Optional. Uses Firecrawl Keyless when absent; a key provides account-scoped credits and higher rate limits. |
| `FIRECRAWL_API_URL` | `firecrawlApiUrl` | No | Firecrawl paths | Defaults to `https://api.firecrawl.dev/v2`. |
| `GROK_OUTPUT_DIR` | `outputDir` | No | all scripts | Overrides long-output and run-record storage. Default: `~/.cache/grok-search/outputs/`. |
| `GROK_STATE_DIR` | `stateDir` | No | all scripts | Cross-command state directory (Firecrawl quota cooldown file `firecrawl-cooldown.json`, the 15-minute fetch cache `fetch-cache/`). Default: `~/.cache/grok-search/`. |
| `GROK_RUN_LOG` | `runLog` | No | all scripts | Default `true`: every command writes one run-record JSON. `off` / `false` disables it, and `sources.raw_path` / `diagnostics.run_path` become null. |
| `GROK_DEBUG_RAW` | — | No | `search.js` | Env only. `1` embeds the redacted full Grok response as `grok_raw` in the run record (`--full-sources` does the same). |
| `GROK_DEBUG` | — | No | all scripts | Env only. `true` prints retry/cleanup/proxy debug logs to stderr. |
| `GROK_PROXY` | `proxy` | No | all scripts | Explicit proxy URL for this tool, or `off`/`direct` to disable proxy use. |

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
./scripts/search.js --instructions "Quote the official changelog with dates; say so if not found" "node lts changelog"
./scripts/search.js --platform GitHub "pi coding agent search skill"
./scripts/search.js --responses-allowed-domains github.com "pi coding agent search skill"
./scripts/search.js --extra 10 "latest pi coding agent docs"
./scripts/search.js --no-extra "query"
./scripts/search.js --source-chars 200 "query"
./scripts/search.js --max-sources 8 "query"
./scripts/search.js --deadline 120 "query"
./scripts/search.js --full-sources "debug provider raw"
./scripts/search.js --responses-openrouter-engine exa "strict web-only query"
./scripts/search.js --source x --responses-parallel-tool-calls false "query"   # one tool call per turn, cheaper
```

`--instructions TEXT` separates "what to return" from "what to search". The query is the keyword string Tavily and Firecrawl search verbatim; the instructions are appended to the user message sent to Grok only (the system-prompt prefix is unchanged, so prompt caching is unaffected). With instructions present the query gets a `# Search query` header, otherwise a short query can be read as a stray line of the time context (Grok answered "no topic was specified" in a 2026-09-08 test). `diagnostics.options.instructions_chars` records the length and the run record stores the text; there is no config default.

`--responses-allowed-domains` / `--responses-excluded-domains` apply to all three channels: Grok `web_search` filters, Tavily `include_domains` / `exclude_domains`, and Firecrawl `includeDomains` / `excludeDomains`. Off-domain extras that still come back are kept but ranked after every Grok result; `diagnostics.options.extra_domain_filter` is `pushed`, `demoted`, or `none`, and extra provider attempts carry an `off_domain` count.

### Search sources

`--source` selects which Grok server-side tools are attached. The default is `web`:

```bash
./scripts/search.js --source x "what is X saying about grok-4.6"   # X only
./scripts/search.js --source both "reaction to the grok-4.6 release" # Grok routes
./scripts/search.js --source x --responses-allowed-x-handles xai,OpenAI "query"
./scripts/search.js --source x --x-from-date 2026-08-01 --x-to-date 2026-08-16 "query"
./scripts/search.js --source x --x-images "query"                  # analyze post images
```

- `x_search` supports handle allow/deny lists (mutually exclusive, max 20 each), `--x-from-date` / `--x-to-date` (`YYYY-MM-DD`), and `--x-images` / `--x-videos` (off by default, billed as extra tokens; `--no-x-images` / `--no-x-videos` turn off what the config enabled).
- A **command-line** X filter promotes an unspecified `--source` to `both`; combining one with an explicit `--source web` raises `SEARCH_SOURCE_CONFLICT`. X filters in the config file only apply once X search is on — they never switch it on by themselves.
- `--responses-x-search` remains an alias for `--source both`.
- X search is billed at $5 per 1k calls, the same rate as web search. See `diagnostics.responses_x_search_calls` for the actual count.
- Tavily and Firecrawl extras only search the web, never X. On `--source x` they are off by default (`diagnostics.options.extra_mode` is `off-x-only`); `--extra N` turns them on, and `--source both` keeps them on.
- OpenRouter attaches `x_search` to native web search automatically, so `--source` is only a hint there; whatever is not enforced is reported in `diagnostics.warnings`.

X citations arrive as bare URLs whose `title` is only the inline citation marker, so source cards recover attribution from the URL:

```json
{
  "provider": "grok-responses",
  "source_type": "citation",
  "tool": "x_search",
  "url": "https://x.com/xai/status/2087942296721559607",
  "title": "@xai",
  "x_handle": "xai",
  "x_post_id": "2087942296721559607"
}
```

Post text and dates are not in the card; `answer.text` attributes each X claim by handle and date.

`search.js` is Responses-only. It calls `{GROK_API_URL}/responses` with `stream:false`, enables the provider-native web search tool, and returns:

- `answer.text`, `answer.chars`, `answer.original_chars`, `answer.truncated`, `answer.full_path`
- `sources.items`: one deduplicated, merged list of compact source cards, capped at `12` by default (`--max-sources`). Over the cap, Reciprocal Rank Fusion (RRF, k=60) picks the cards from Grok's list and each extra provider's: Grok's list runs `citation` > `opened: true` (pages Grok read via a completed `open_page`) > `searched`, Tavily and Firecrawl keep their own order, a URL several lists returned scores in each, and off-domain extras go last. When an answer cites many links, some `citation` URLs appear only in `answer.text`. A URL seen on several channels becomes one card with `merged_from` listing the providers that contributed fields; placeholder titles such as `"1"` or `[2]` count as missing: a real title replaces them, otherwise `title` is omitted
- `sources.returned` / `sources.total` / `sources.omitted` so callers always know whether the list was truncated
- `sources.raw_path`: always set (unless `GROK_RUN_LOG=off`), pointing at the run record for this call: redacted argv, query, instructions, effective options, the full answer, the uncapped source lists, `grok_tool_calls`, and diagnostics. Errors and `DEADLINE_EXCEEDED` write one too
- `sources.raw` only when `--full-sources` is used
- `diagnostics.responses_model`: the model the relay actually served; a warning is added when it differs from the requested one (on 2026-09-08 one relay answered every `grok-4.5` request with `grok-4.5-build`, at two to three times the tool calls and cost)
- `diagnostics.grok_endpoint`, `diagnostics.usage` / `diagnostics.cost_usd` when supplied by the provider, `diagnostics.responses_*` (`responses_tool_calls` is a `{ total, upstream: { web, x } | null, trace: { web, x }, by_action, failed? }` summary; failed calls appear only under `failed` and are left out of the other counts; the full list lives in `raw_path`), `diagnostics.search_budget` (the prompt's advisory budget next to the calls actually made, `enforced: false`; `used_web` / `used_x` / `used_total` are billed calls including page reads, while `exceeded` compares only the searches, `used_searches` / `used_x_searches`), `diagnostics.warnings`, `diagnostics.provider_attempts`, `diagnostics.options`, `diagnostics.duration_ms`, and `diagnostics.searched_at`

By default the command starts Grok Responses, Tavily Search when configured, and Firecrawl Search in parallel. Tavily and Firecrawl remain independent evidence channels and are never injected into Grok input.

`--extra N` is the combined Tavily/Firecrawl target, defaulting to `6`. Both providers split the target evenly, with odd counts favoring Tavily. Without a Tavily key, Firecrawl Keyless receives the full target. `--no-extra` strictly disables both external search channels.

When Grok explicitly reports exhausted quota (402, a quota error code, or a 429 whose body mentions quota / credits / billing) and extra sources are available, the command returns a degraded success with `diagnostics.degraded: true` and `grok_error.code: QUOTA_EXHAUSTED`. A plain 429 degrades the same way with `RATE_LIMITED`. The visible answer states that it contains raw Tavily/Firecrawl results, while `diagnostics.grok_error` preserves the redacted upstream error. Authentication, protocol, and generic service failures do not trigger this fallback.

Firecrawl Keyless includes 1,000 credits per month and additional undisclosed daily IP limits. A free API key keeps the same monthly credits but provides higher rate limits, account-scoped usage, and access to more endpoints.

When the quota is exhausted Firecrawl answers 429 with `reason: credits` and a `retry_after_seconds` that is usually hours. The scripts stop retrying and write `{ until, auth_mode, reason, hit_at }` to `<stateDir>/firecrawl-cooldown.json`. During the cooldown, `search.js` and `fetch.js --provider auto` skip Firecrawl (the provider attempt reads `skipped: true` with `cooldown until <ISO>`); search gives the slots to Tavily, or leaves extras empty with a warning when Tavily is not configured. An explicit `--provider firecrawl` still makes the request and clears the cooldown on success. Cooldowns are scoped by `auth_mode`, so adding an API key takes effect immediately.

General retry rule: 408 / 429 / 5xx retry up to 3 times. A `Retry-After` (header or Firecrawl's `retry_after_seconds`) within the retry budget is honored as-is; one beyond the budget stops retrying instead of being clamped. Bad JSON, `success:false` bodies, 4xx such as 403, and scrape timeouts are requested once. Provider attempts carry `requests` (HTTP calls made) and `duration_ms`.

Source cards intentionally do not include long `description` or `content` fields. They use short `snippet` fields, with full raw data available through `sources.raw_path`.

## Fetch

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider direct https://example.com
```

Default fetch output is a 12,000-character preview (`--max-chars` changes it). When the text is cut, the last line of `content.text` is a `[grok-search]` notice saying which characters are shown, which `--offset` gives the next part, and which file has the full text. To read on, continue with `--offset` rather than raising `--max-chars` and printing the start again. Whatever `--max-chars` says, the whole JSON output stays under 45KB (pi's bash tool keeps only the last 50KB of output, so an oversized one-line text would be dropped whole): when the text does not fit, `content.text` is cut further, `content.truncated` is true, and the full text is in `content.full_path`. Search `answer.text` works the same way; a cut answer ends with a line naming the full file.

```bash
./scripts/fetch.js --offset 12000 https://example.com
```

Fetching the same URL again within 15 minutes reads a local cache (`<stateDir>/fetch-cache/`) instead of calling a provider, after Claude Code WebFetch's 15-minute cache. `auto` reuses only what an earlier `auto` fetch returned; an explicit provider reuses results that provider produced, so switching provider still asks the new one. A hit sets `diagnostics.cache` to `{ hit, fetched_at, age_seconds }` and leaves `provider_attempts` empty. Failures are not cached, and neither are fallbacks (a result obtained after Firecrawl or Tavily failed, or the Direct text used after both did), since the failure may be over by the next call; `--no-cache` fetches anew. The hint on a cut text says how many minutes the cached copy has left, and a continuation reuses the full-text file the first run wrote. `--offset` on a new fetch (the cache expired, or `--no-cache`) opens the text with a line saying the offset may not line up with the earlier copy. The reason: in the sessions up to 2026-10-09, 12 of the 109 URLs fetched in a session were fetched again within about three minutes, because the agent filtered the same page with another script or wanted to see past the preview.

Notices that change how the text should be read also open `content.text`: the page redirected to the site's home page, Direct got nothing beyond the title, an X page came back unvalidated. They stay in `diagnostics.warnings` too. Agents often print only `content.text`: up to 2026-10-09, Claude Code printed `diagnostics.warnings` once in about 105 calls.

Provider order for `--provider auto`:

```text
Direct (asks for Markdown) -> Firecrawl Scrape -> Tavily Extract -> the Direct text from the first step
```

The first step requests the page with `Accept: text/markdown, text/html;q=0.9, */*;q=0.8`, and anything that is not HTML is taken as served (decoded by the charset the response declares, JSON re-indented; text with no declared charset that does not decode as UTF-8 goes on to the next provider). Sites that negotiate content send the page as Markdown without navigation, for example code.claude.com, platform.openai.com and sites on Cloudflare's Markdown for Agents. Plain-text files and JSON APIs are also fetched in this step. Tried on 153 HTML URLs from the run records on 2026-10-10, 45 answered with Markdown. This step only probes, with a 15-second timeout (the slowest of the 60 HTML pages compared that day took Direct 6.3 s), so a stalled site does not hold up the providers after it.

An HTML page goes to Firecrawl. If Firecrawl errors, reports a target status of 400 or more, returns nothing or is rate-limited (429), the page goes to Tavily. If both fail, the Direct text from the first step is returned without fetching again.

Firecrawl comes before Tavily because of a comparison on 2026-10-10: 60 HTML pages from the run records, fetched by both at the same time and checked by hand.
- Tavily lost body text on about 20 of them: the comments of all 11 GitHub issue pages, arXiv abstracts and others.
- Firecrawl lost body text on 1: the list on an article listing page.
- Cost: Firecrawl charges 1 credit a page, Tavily basic 1 credit per 5 pages. Median time is 3.5 s for Firecrawl and 1.9 s for Tavily.
- Volume: at the last 25 days' rate, about 146 fetches a month would reach Firecrawl.

Direct Fetch strips simple HTML, formats JSON when possible, records redirects, and rejects binary, attachment and oversized responses; plain text comes back as served, decoded by its declared charset.

Firecrawl reports the target page's status with its markdown: a page with a status of 400 or more counts as a failure and goes to the next provider (all seven on record from 2026-09-15 to 10-06 were 404/503 error pages). Firecrawl and Direct both report where the fetch ended in `final_url` / `redirected`; a URL with a path that ends on the site's home page is noted at the start of `content.text` and in `diagnostics.warnings`, because the page has most likely been removed (gov.cn, for one, sends removed pages to its home page by script).

Firecrawl Scrape uses Keyless without a key and automatically sends a Bearer token when `FIRECRAWL_API_KEY` is configured. The active mode is exposed as `diagnostics.firecrawl_auth_mode`.

X posts (`x.com/<handle>/status/<id>`) under `--provider auto` try Direct first regardless of keys, and count as success only when the page names the handle, carries a date, and has non-boilerplate text (main post only). If validation fails, Tavily runs and then Firecrawl (X pages keep Tavily first, since Firecrawl bills about 30 credits for one); if that is unavailable too, the Direct text is returned with a warning. The 2026-09-08 side-by-side is the reason: Tavily is fast and free but returned one of three posts without a date and timed out on another; Firecrawl costs about 30 credits and 10+ seconds per post in exchange for ISO timestamps, engagement counts and the thread. Use `--provider firecrawl` explicitly when you need the thread. Any fetch with `credits_used >= 10` adds a cost warning to `diagnostics.warnings`.

X redirects `/<anyhandle>/status/<id>` to the real handle; validation uses the redirected URL.

Successful fetch output uses `content.text`, `content.offset`, `content.chars` (page text only, not notices), `content.original_chars`, `content.truncated`, and `content.full_path`. `metadata` is normalized to `{ title, description, author, published_at, language, status, source_url }` from Firecrawl plus Direct's `status / content_type / content_length / content_disposition`. Provider details live under `diagnostics`, and the run record path under `diagnostics.run_path`.

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

Both providers return only this site's pages at or under the URL's path, the scope Firecrawl's crawl uses by default; map the site root for the whole site. Tavily gets `select_paths` (such as `^/docs(/.*)?$`) and `allow_external: false` for this: on 2026-09-28, docs.fiat24.com/user mapped to 20 URLs, 4 under /products and /legal and 2 on gitbook.com; with the two parameters on 10-10 it gave the 14 under /user. A URL that names a file (such as `/docs/index.html`) maps its directory.

Without `TAVILY_API_KEY`, Tavily Map is unavailable and `map.js` falls back to Direct Map; it also falls back when Tavily Map returns an empty list (with an explicit `--provider tavily` the empty list is returned with a warning). Direct Map takes the links on the requested page, then the site's sitemaps (those robots.txt declares, `/sitemap.xml`, and `<path>/sitemap.xml` for a URL with a path; sitemap indexes are expanded, up to 10 files). It filters to the scope above and a warning counts what was left out. When the requested page redirects to another host or path (example.com to www.example.com), the scope is where it landed, with a warning. It ignores `--instructions` and supports only `--max-depth 1`.

`--timeout` (default 150s) is the crawl budget handed to Tavily Map; Direct Map's own requests for robots.txt, the sitemaps and the page use a separate `--direct-timeout` (default 30s), so one stalled request cannot consume most of the command deadline. Both values are recorded in `diagnostics.options`.

Successful map output uses `urls` for discovered URLs. Provider, response time, ignored instructions, warnings, attempts, and options live under `diagnostics`, with the run record path under `diagnostics.run_path`.

## Output Files

All scripts keep stdout as complete JSON. Long text fields are returned as previews, and the full content is written to:

```text
~/.cache/grok-search/outputs/
```

Set `GROK_OUTPUT_DIR` to override this path. Each run performs best-effort cleanup of `grok-search-*` files older than 30 days inside the output directory.

Besides overflow files, every command writes one run record `grok-search-<ts>-run-<kind>-<label>-<rand>.json` (`schema_version: 2`, mode 0600) on success, error, and `DEADLINE_EXCEEDED`; `GROK_RUN_LOG=off` or `runLog: false` disables it. Search records hold redacted argv, query, instructions, effective options, the full answer, `answer_preamble` (narration cut before the answer marker; null when there was no marker), uncapped sources, `grok_tool_calls`, and diagnostics; fetch records hold the full content, metadata, and provider attempts; map records hold urls. A record is written after the stdout cut, so it holds the warnings the agent got, and `printed_answer` / `printed_content` give the length stdout carried, whether it was cut, and where the full text went. `GROK_DEBUG_RAW=1` or `--full-sources` adds `grok_raw`.

Read these paths only when the preview is not enough:

- `answer.full_path` for full search answers
- `content.full_path` for full fetched page text
- `sources.raw_path` for the search run record (full source lists / provider raw)
- `diagnostics.run_path` for the fetch / map run record

## Smoke Tests

No key required:

```bash
./scripts/fetch.js --provider direct https://example.com
./scripts/map.js --provider direct https://example.com --limit 5
npm test
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
- `GROK_RATE_LIMITED`: Grok returned a plain 429 (no quota signal) and no fallback result was available.
- A provider attempt with `skipped: true` and `cooldown until …`: Firecrawl is in its post-quota cooldown. Delete `<stateDir>/firecrawl-cooldown.json` or pass `--provider firecrawl` explicitly to force a retry.
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
