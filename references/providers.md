# Providers, Limits, And Run Records

Read this when a result mentions a skipped or failed provider, when configuration errors appear, or when you need the durable record of a run.

## Provider Order

- `search.js`: Grok Responses runs alongside independent Tavily Search (needs `TAVILY_API_KEY`) and Firecrawl Search (keyless by default, `FIRECRAWL_API_KEY` when set). Extras are never fed into Grok. The default combined extra target is 6; `--extra N` changes it, `--no-extra` disables both extras and the degraded fallback. On `--source x` extras are off unless `--extra N` is given (`extra_mode: "off-x-only"`).
- `fetch.js --provider auto`: Direct asks for Markdown first (`Accept: text/markdown`) and returns anything that is not HTML as served: negotiated Markdown, plain-text files, JSON. An HTML page goes to Firecrawl Scrape, then Tavily Extract, then falls back to Direct's text from the first request. Firecrawl comes first because, fetching 60 HTML pages both ways, Tavily lost body text on about 20 (all 11 GitHub issues lacked comments) and Firecrawl on 1. X post URLs validate Direct's page first, and X pages put Tavily before Firecrawl, which bills about 30 credits for one (`references/x-search.md`). A Firecrawl page whose target status is 400 or more counts as a failure. `final_url` / `redirected` show where the fetch ended; a deep URL that ends on the site's home page adds a warning, since the page is most likely gone.
- `map.js --provider auto`: Tavily Map → Direct Map. An empty Tavily list also falls through to Direct Map. Both keep to this site's pages at or under the URL's path (Tavily through `select_paths` and `allow_external: false`); map the site root for the whole site.
- `--responses-openrouter-engine exa` forces a web-only engine on OpenRouter.

Domain filters apply to all channels: `--responses-allowed-domains` / `--responses-excluded-domains` are pushed to Tavily (`include_domains`/`exclude_domains`) and Firecrawl (`includeDomains`/`excludeDomains`). Anything that still comes back off-domain is ranked after Grok's own results, not dropped. `diagnostics.options.extra_domain_filter` reports `pushed`, `demoted`, or `none`; extra attempts report `off_domain`.

Direct is this repo's own fallback: a plain HTTP GET through Node's `fetch` (undici, honoring the proxy settings) with a `grok-search-skill/0.1` user agent, following redirects, capped at 2 MB, rejecting binary and attachment responses, then stripping HTML to text with regexes (scripts, styles, nav noise are only partly removed). It does not execute JavaScript, log in, use cookies, parse PDFs, or bypass anti-bot; its text is noisier than Tavily's or Firecrawl's and can lose body content on some layouts. Direct Map reads the requested page's links and the site's sitemaps (declared in robots.txt, `/sitemap.xml`, `<path>/sitemap.xml`; indexes expanded, at most 10 files), keeps a URL with a path to that path and below (a warning says how many were left out), ignores `--instructions`, and is limited to `--max-depth 1`. Neither Direct nor the paid providers get anything useful from Reddit or YouTube pages.

## Firecrawl Quota And Cooldown

Firecrawl keyless has a rolling daily quota per IP. When it is exhausted the API answers 429 with `reason: credits` and a `retry_after_seconds` that is usually hours. The scripts then:

- stop retrying immediately (a `Retry-After` beyond the retry budget means "not now", not "wait a bit");
- write `<stateDir>/firecrawl-cooldown.json` (`until`, `auth_mode`, `reason`, `hit_at`), default `~/.cache/grok-search/`;
- skip Firecrawl in every later `auto` command until `until` passes. Skips appear in `diagnostics.provider_attempts` as `{ provider: "firecrawl", skipped: true, error: "cooldown until <ISO> (credits)" }`. For search, the slots go to Tavily when configured, otherwise extras are empty and a warning says so.

An explicit `--provider firecrawl` ignores the cooldown and clears it on success. The cooldown is scoped to `auth_mode`, so adding an API key takes effect immediately. Set `GROK_STATE_DIR` to move the state file.

Retry policy in general: HTTP 408/429/500/502/503/504 retry up to 3 times with backoff, honoring `Retry-After` (header or Firecrawl's `retry_after_seconds`) when it fits the budget. Bad JSON, `success:false` bodies, 4xx such as 403 "IP looks suspicious", and scrape timeouts are not retried. Attempts report `requests` (HTTP calls made) and `duration_ms`.

## Relay Behaviour

The Responses endpoint is usually reached through an OpenAI-compatible relay, and relays differ in ways that change cost and output: one served `grok-4.5-build` for every `grok-4.5` request (two to three times the tool calls and cost), one drops `parallel_tool_calls` (the parameter works against `api.x.ai` directly; `max_tool_calls` does not, anywhere), grok-4.5 through one relay returned its between-call narration as extra `message` items, while grok-4.6 and grok-4.7 return it glued to the answer in one text part, one returns X search as `custom_tool_call` items. `usage.cost_in_usd_ticks`, and so `diagnostics.cost_usd`, is whatever the endpoint reports: one relay reported 40% of xAI's own figure for identical token and call counts, so compare cost across providers by tokens and calls, not by this field. `diagnostics.responses_model` is the model the relay actually served; a warning is added when it differs from the requested one. Narration messages are dropped from `answer.text` (the last message is the answer; earlier ones stay only when long or cited). Narration glued to the answer is cut at the `<!-- answer -->` line the system prompt asks the model to open its answer with; without that line the text is kept whole.

grok-4.6 sometimes stops writing at its first inline citation: `answer.text` ends after a paragraph or two, carries no link, and covers only the first part of the request, while the response still reports `completed`. On 2026-10-10 this hit about one web search in six, on `api.x.ai` and on two relays alike; grok-4.7 did not do it in 15 runs. If an answer from grok-4.6 looks cut off like this, rerun it or switch the model to grok-4.7.

## Grok Failures

When Grok returns 402, a quota error code, or a 429 whose body talks about quota/credits/billing, `search.js` returns a visibly marked degraded answer built from raw Tavily/Firecrawl results: `diagnostics.degraded: true`, `diagnostics.grok_error.code: QUOTA_EXHAUSTED`. A plain 429 degrades the same way with `RATE_LIMITED`. Other Grok failures are errors. If `search.js` returns `GROK_API_URL 未配置` or `GROK_API_KEY 未配置`, the project is missing required setup; point the user at `README.md` rather than working around it.

## Source Cards

- `source_type`: `citation` (used in the answer: an inline citation, or a link or URL the answer text contains outside code), `searched` (listed by a search call), `extra` (Tavily/Firecrawl). When the answer has no inline citation, xAI attaches every page its searches returned as zero-span annotations; those count as `searched`. `opened: true` marks pages Grok actually read (from completed `open_page` actions; web only, X search has no trace). Over the card cap, Reciprocal Rank Fusion (k=60) picks from Grok's list (citation > opened > searched) and each extra provider's list; off-domain extras go last. Cited links that miss the cut are still in `answer.text`.
- Duplicate URLs across channels are merged into one card; `merged_from` lists the providers that contributed fields. A placeholder title such as `"1"` or `[2]` counts as missing: a real title replaces it, otherwise the card has no `title`.
- `diagnostics.responses_tool_calls` is `{ total, upstream: { web, x } | null, trace: { web, x }, by_action: { search, open_page, find_in_page }, failed? }`. `total` is the per-tool maximum of the billing usage and the trace; the two raw tallies stay visible because relays under-report either side. A failed call (an `open_page` on a dead or guessed URL) is listed under `failed` only: usage does not bill it, so it is left out of `trace`, `by_action`, and `total`, and its URL is not marked `opened`. `grok_tool_calls[].source_count` in the run record is a relay-cumulative value, not per call.
- Fetch `metadata`: `{ title, description, author, published_at, language, status, source_url }` from Firecrawl; Direct adds `status`, `content_type`, `content_length`, `content_disposition`.

## Run Records

Every command writes one JSON run record to the output directory (`~/.cache/grok-search/outputs/`, `GROK_OUTPUT_DIR` overrides). Search exposes it as `sources.raw_path` (always set), fetch and map as `diagnostics.run_path`. Records are also written on errors and on `DEADLINE_EXCEEDED`.

Search records hold `argv` (secrets redacted), `query`, `instructions`, `options`, the full `answer`, `answer_preamble` (text cut before the answer marker, null without one), `sources.grok` / `sources.extra` / `sources.items` (uncapped), `provider_attempts`, `grok_tool_calls`, and `diagnostics`. Fetch records hold the full content and `metadata`; map records hold `urls`. Records are written after the stdout cut: their warnings match what stdout said, and `printed_answer` / `printed_content` give what stdout carried (`chars`, `truncated`, `full_path`). `GROK_DEBUG_RAW=1` or `--full-sources` also embeds the redacted Grok response as `grok_raw`. `GROK_RUN_LOG=off` (or `runLog: false`) disables records; `raw_path` / `run_path` become null. Files older than 30 days are cleaned up on each run.

## Proxy

The scripts use terminal proxy variables via undici: `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` and lowercase variants; `NO_PROXY` is honored and loopback hosts bypass. `GROK_PROXY="http://127.0.0.1:7890"` sets a proxy for this tool only, `GROK_PROXY=off` forces direct connections, `GROK_DEBUG=true` prints proxy and retry debug lines to stderr.
