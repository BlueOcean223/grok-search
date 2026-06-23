# Smoke Tests

这些检查需要手动运行，因为真实 provider 调用需要私有 API key。

## 无 key 检查

```bash
node tests/sources.test.js
node tests/proxy.test.js
node tests/responses.test.js
node tests/argv.test.js
./scripts/fetch.js --provider direct https://example.com
./scripts/map.js --provider direct https://example.com --limit 5
```

## 代理传输

设置 `HTTP_PROXY` / `HTTPS_PROXY` 时，脚本应该走代理，并且 stderr 不应出现 undici 警告。

Fetch 检查不需要 key；Search 检查需要 Grok 配置。

```bash
HTTPS_PROXY=http://127.0.0.1:7890 ./scripts/fetch.js --provider direct https://example.com
GROK_DEBUG=true HTTPS_PROXY=http://127.0.0.1:7890 ./scripts/search.js "proxy smoke test"
```

使用 `GROK_PROXY=off` 可以强制直连，用于对照。

## Grok Search

```bash
export GROK_API_URL="https://your-openai-compatible-endpoint/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="grok-4-fast"
./scripts/search.js "What changed in the latest Node.js LTS?"
./scripts/search.js --platform GitHub "pi coding agent search skill"
```

## Responses Search

Responses 模式需要真实 Grok / OpenRouter 配置。默认仍建议先测 Chat，再显式测 Responses。

Direct xAI：

```bash
export GROK_API_PROVIDER="xai"
export GROK_API_URL="https://api.x.ai/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="grok-4-fast"
./scripts/search.js --search-mode responses "latest xAI docs"
./scripts/search.js --search-mode responses --responses-x-search "latest xAI news"
```

OpenRouter：

```bash
export GROK_API_PROVIDER="openrouter"
export GROK_API_URL="https://openrouter.ai/api/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="x-ai/grok-4.1-fast"
./scripts/search.js --search-mode responses "latest OpenAI docs"
./scripts/search.js --search-mode responses --responses-openrouter-engine exa "latest OpenAI docs"
```

期望：

- `diagnostics.grok_endpoint` 为 `responses`
- `diagnostics.options.search_mode` 为 `responses`
- `sources.grok` 可包含 `source_type: "citation"` 或 `"searched"`
- 如果 provider 返回费用，`diagnostics.cost_usd` 有值
- Tavily / Firecrawl extra sources 仍在 `sources.extra`，不会注入 Grok prompt

## Extra Sources

```bash
export TAVILY_API_KEY="tvly-your-key"
./scripts/search.js "latest pi coding agent docs"
./scripts/search.js --extra 10 "latest pi coding agent docs"

export FIRECRAWL_API_KEY="fc-your-key"
./scripts/search.js --extra 10 "latest pi coding agent docs"
```

配置 Tavily 或 Firecrawl key 后，默认 search 会自动补充一个小规模 extra source 集合。`--extra 10` 用于更宽的候选来源扫描。Extra sources 是补充参考，不会改写 Grok 的回答。

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

## 期望输出形状

每个非 help 命令都应该向 stdout 写出 JSON。

失败 JSON 应包含：

- `error.message`
- `error.code`
- `diagnostics.warnings`
- `diagnostics.provider_attempts`
- diagnostics 下的脚本时间戳字段：`diagnostics.fetched_at`、`diagnostics.searched_at` 或 `diagnostics.mapped_at`

成功 JSON 使用各命令自己的字段：

- search：`answer.text`、`sources.merged`、可选 `sources.raw_path`、`diagnostics`
- fetch：`content.text`、可选 `content.full_path`、`diagnostics`
- map：`urls`、`diagnostics`

stderr 只应包含简短的人类可读摘要，不得包含 API key。
