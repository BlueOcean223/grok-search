# Smoke Tests

These checks are manual because real provider calls require private API keys.

## No Key

```bash
node tests/sources.test.js
node tests/proxy.test.js
node tests/argv.test.js
./scripts/fetch.js --provider direct https://example.com
./scripts/map.js --provider direct https://example.com --limit 5
```

## Proxy Transport

When `HTTP_PROXY` / `HTTPS_PROXY` is set, scripts should use the proxy without emitting undici warnings to stderr. The fetch check needs no key; the search check also requires Grok config.

```bash
HTTPS_PROXY=http://127.0.0.1:7890 ./scripts/fetch.js --provider direct https://example.com
GROK_DEBUG=true HTTPS_PROXY=http://127.0.0.1:7890 ./scripts/search.js "proxy smoke test"
```

Use `GROK_PROXY=off` to force a direct connection for comparison.

## Grok Search

```bash
export GROK_API_URL="https://your-openai-compatible-endpoint/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="grok-4-fast"
./scripts/search.js "What changed in the latest Node.js LTS?"
./scripts/search.js --platform GitHub "pi coding agent search skill"
```

## Extra Sources

```bash
export TAVILY_API_KEY="tvly-your-key"
./scripts/search.js --extra 5 "latest pi coding agent docs"

export FIRECRAWL_API_KEY="fc-your-key"
./scripts/search.js --extra 5 "latest pi coding agent docs"
```

`--extra` sources are supplemental references. They do not rewrite the Grok answer.

## Fetch Providers

```bash
export TAVILY_API_KEY="tvly-your-key"
./scripts/fetch.js https://example.com

export FIRECRAWL_API_KEY="fc-your-key"
./scripts/fetch.js --provider firecrawl https://example.com
```

## Map Providers

```bash
export TAVILY_API_KEY="tvly-your-key"
./scripts/map.js https://docs.example.com --limit 20
./scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

## Expected Shape

Every non-help command should write JSON to stdout. Failure JSON should include:

- `ok: false`
- `error`
- `warnings`
- a script-specific timestamp field: `fetched_at`, `searched_at`, or `mapped_at`

stderr should contain only a short human-readable summary and must not contain API keys.
