# Smoke Tests

These checks are manual because real provider calls require private API keys.

## No Key

```bash
node tests/sources.test.js
node tests/argv.test.js
node scripts/fetch.js --provider direct https://example.com
node scripts/map.js --provider direct https://example.com --limit 5
```

## Grok Search

```bash
export GROK_API_URL="https://your-openai-compatible-endpoint/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="grok-4-fast"
node scripts/search.js "What changed in the latest Node.js LTS?"
node scripts/search.js --platform GitHub "pi coding agent search skill"
```

## Extra Sources

```bash
export TAVILY_API_KEY="tvly-your-key"
node scripts/search.js --extra 5 "latest pi coding agent docs"

export FIRECRAWL_API_KEY="fc-your-key"
node scripts/search.js --extra 5 "latest pi coding agent docs"
```

`--extra` sources are supplemental references. They do not rewrite the Grok answer.

## Fetch Providers

```bash
export TAVILY_API_KEY="tvly-your-key"
node scripts/fetch.js https://example.com

export FIRECRAWL_API_KEY="fc-your-key"
node scripts/fetch.js --provider firecrawl https://example.com
```

## Map Providers

```bash
export TAVILY_API_KEY="tvly-your-key"
node scripts/map.js https://docs.example.com --limit 20
node scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

## Expected Shape

Every non-help command should write JSON to stdout. Failure JSON should include:

- `ok: false`
- `error`
- `warnings`
- a script-specific timestamp field: `fetched_at`, `searched_at`, or `mapped_at`

stderr should contain only a short human-readable summary and must not contain API keys.
