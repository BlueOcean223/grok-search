# Responses 模式

`responses` 是 `search.js` 的可选搜索模式：

```bash
./scripts/search.js --search-mode responses "query"
```

默认仍然是 `chat`。只有在需要更强的 provider-native citation、更多官方源候选，或需要直接测试 `/responses` 行为时，才建议启用 Responses。

## 成本与默认值

Responses 可能明显比 Chat 更贵。为了控制成本，默认值是：

- `GROK_SEARCH_MODE=chat`
- `GROK_RESPONSES_MAX_TURNS=1`
- `GROK_RESPONSES_REASONING_EFFORT=low`
- `GROK_RESPONSES_INCLUDE_X_SEARCH=false`
- `GROK_RESPONSES_FALLBACK_CHAT=false`

如果 provider 返回费用信息，输出会包含：

- `diagnostics.cost_in_usd_ticks`
- `diagnostics.cost_usd`
- `diagnostics.usage`

## Provider

`GROK_API_PROVIDER` / `apiProvider` 支持：

```text
xai
openrouter
openai-compatible
```

未配置时按 `GROK_API_URL` 推断：

- URL 包含 `openrouter` -> `openrouter`
- URL 包含 `api.x.ai` -> `xai`
- 其他 -> `openai-compatible`

## Direct xAI

Direct xAI Responses 使用：

```json
{
  "tools": [{ "type": "web_search" }],
  "max_turns": 1,
  "reasoning": { "effort": "low", "summary": "concise" },
  "stream": false
}
```

启用 X search：

```bash
./scripts/search.js --search-mode responses --responses-x-search "query"
./scripts/search.js --search-mode responses --responses-x-search --responses-allowed-x-handles xai,OpenAI "query"
```

## OpenRouter

OpenRouter Responses 使用 provider-specific tool：

```json
{
  "tools": [
    {
      "type": "openrouter:web_search",
      "parameters": {
        "engine": "auto",
        "max_results": 5,
        "max_total_results": 10
      }
    }
  ],
  "stream": false
}
```

OpenRouter Responses 模式不会自动给模型名追加 `:online`。`GROK_RESPONSES_OPENROUTER_ENGINE` / `--responses-openrouter-engine` 可设为：

```text
auto | native | exa | firecrawl | parallel | perplexity
```

需要严格 web-only 时，优先使用：

```bash
./scripts/search.js --search-mode responses --responses-openrouter-engine exa "query"
```

## Filters

Domain filters：

```bash
./scripts/search.js --search-mode responses --responses-allowed-domains openai.com,docs.x.ai "query"
./scripts/search.js --search-mode responses --responses-excluded-domains reddit.com,facebook.com "query"
```

`allowed_domains` 与 `excluded_domains` 互斥，并且各自最多 5 个。

X handle filters：

```bash
./scripts/search.js --search-mode responses --responses-x-search --responses-allowed-x-handles xai,OpenAI "query"
./scripts/search.js --search-mode responses --responses-x-search --responses-excluded-x-handles noisy_account "query"
```

`allowed_x_handles` 与 `excluded_x_handles` 互斥。设置 X handle filter 会隐式启用 X search。

## Sources

Responses sources 写入 `sources.grok`，保持现有顶层 schema：

```json
{
  "provider": "grok-responses",
  "source_type": "citation",
  "tool": "web_search",
  "url": "https://example.com",
  "title": "Example",
  "snippet": "..."
}
```

`source_type` 的含义：

- `citation`：最终回答 inline citation annotation 或 top-level citation。
- `searched`：server-side search tool 返回的候选来源。

同一 URL 同时出现在 `citation` 和 `searched` 时，`citation` 优先。

## Extra Sources

Tavily / Firecrawl extra sources 仍是独立证据通道：

- 不注入 Chat prompt。
- 不注入 Responses prompt。
- 不改写 Grok 回答。
- 不代表 Grok 使用过这些来源。

输出仍然分为：

- `sources.grok`
- `sources.extra`
- `sources.merged`

## Fallback

默认情况下，Responses 失败会直接报错：

```bash
./scripts/search.js --search-mode responses "query"
```

显式启用 fallback 后，Responses 失败才会回退 Chat：

```bash
./scripts/search.js --search-mode responses --fallback-chat "query"
```

回退不会伪装成 Responses 成功。输出会包含：

- `diagnostics.grok_endpoint: "chat/completions"`
- `diagnostics.requested_grok_endpoint: "responses"`
- `diagnostics.fallback_chat: true`
- `diagnostics.responses_error`
- `diagnostics.options.search_mode: "responses"`
- `diagnostics.options.actual_search_mode: "chat"`

## 非目标

- 不提供正式 `both` 模式。
- 不把 Tavily / Firecrawl 结果喂给 Grok。
- 不把 Responses 设为默认。
- 不实现长期运行的 deep research。
