# Smoke Tests

## 本地 fixture

```bash
npm test
```

覆盖 Responses body/解析、三路并发、Keyless/API-key、额度降级、source schema、代理与 fetch/map fallback。

## 无 Grok key

```bash
./scripts/fetch.js --provider firecrawl https://example.com
./scripts/fetch.js --provider direct https://example.com
./scripts/map.js --provider direct https://example.com --limit 5
```

第一条验证 Firecrawl Keyless；输出应含 `diagnostics.firecrawl_auth_mode: keyless`。

## Direct xAI

```bash
export GROK_API_PROVIDER="xai"
export GROK_API_URL="https://api.x.ai/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="grok-4.3"

./scripts/search.js "latest xAI docs"
./scripts/search.js --responses-x-search "latest xAI news"
./scripts/search.js --no-extra "only Grok Responses"
```

期望：

- `diagnostics.grok_endpoint` 为 `responses`；
- 默认 `responses_max_turns` 为 3；
- `sources.grok` 可含 `citation` / `searched`；
- 默认 extra allocation 在没有 Tavily key 时全部给 Firecrawl。

## OpenRouter

```bash
export GROK_API_PROVIDER="openrouter"
export GROK_API_URL="https://openrouter.ai/api/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="x-ai/grok-4.1-fast"

./scripts/search.js --responses-openrouter-engine exa "latest OpenAI docs"
```

期望 tool 为 `openrouter:web_search`，模型名没有自动 `:online`。

## Tavily + Firecrawl

```bash
export TAVILY_API_KEY="tvly-your-key"
./scripts/search.js "latest pi coding agent docs"
./scripts/search.js --extra 10 "latest pi coding agent docs"

export FIRECRAWL_API_KEY="fc-your-key"
./scripts/search.js "latest pi coding agent docs"
```

默认 `extra=6` 时应分配 Tavily 3 / Firecrawl 3。移除 Firecrawl key 后仍应成功，auth mode 变为 `keyless`。

## Fetch 主备链

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider firecrawl https://example.com
./scripts/fetch.js --provider direct https://example.com
```

配置 Tavily 时顺序为 Tavily → Firecrawl → Direct；未配置 Tavily 时 Firecrawl Keyless → Direct。

## 输出安全

所有非 help 命令都应向 stdout 写 JSON。stderr 只放简短摘要，不得包含 API key。额度降级必须在 `answer.text` 和 `diagnostics.grok_error` 两处都可见。
