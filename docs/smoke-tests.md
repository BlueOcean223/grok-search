# Smoke Tests

## 本地 fixture

```bash
npm test
```

覆盖 Responses body/解析、Keyless/API-key、额度与限流错误区分、source schema（序号标题、opened、卡片选取）、Firecrawl 重试 / Retry-After / 冷却、X 原帖 Direct 校验、运行记录、代理与 fetch/map fallback。

## 无 Grok key

```bash
node scripts/fetch.js --provider firecrawl https://example.com
node scripts/fetch.js --provider direct https://example.com
node scripts/map.js --provider direct https://example.com --limit 5
```

第一条验证 Firecrawl Keyless；输出应含 `diagnostics.firecrawl_auth_mode: keyless`，`metadata.title` 非空，`diagnostics.run_path` 指向一份 `kind: "fetch"` 的运行记录。

### X 原帖（keyless）

```bash
node scripts/fetch.js https://x.com/xai/status/2087942296721559607
node scripts/fetch.js --provider firecrawl https://x.com/xai/status/2087942296721559607   # 约 30 credits
```

期望：第一条 `diagnostics.provider` 为 `direct`，`provider_attempts[0]` 带 `x_validated: true`，不消耗 Firecrawl credits；第二条 `credits_used >= 10` 且 `diagnostics.warnings` 里有成本提示，正文含 thread。

### Firecrawl 冷却

```bash
cat > ~/.cache/grok-search/firecrawl-cooldown.json <<'EOF2'
{"until":"2099-01-01T00:00:00.000Z","auth_mode":"keyless","reason":"credits","hit_at":"2026-09-08T00:00:00.000Z"}
EOF2
node scripts/fetch.js https://example.com
node scripts/fetch.js --provider firecrawl https://example.com
rm -f ~/.cache/grok-search/firecrawl-cooldown.json
```

期望：第一条 provider attempts 里 Firecrawl 为 `skipped: true`、`error` 以 `cooldown until` 开头，fetch 落到 Tavily 或 Direct；第二条显式指定仍会真打，成功后冷却文件被删除。

## Direct xAI

```bash
export GROK_API_PROVIDER="xai"
export GROK_API_URL="https://api.x.ai/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="grok-4.3"

node scripts/search.js "xAI 文档里 grok-4.3 的价格是多少？"
```

期望：

- `diagnostics.grok_endpoint` 为 `responses`；
- 默认 `responses_max_turns` 为 3；
- `diagnostics.options.search_source` 为 `web`，且请求体只挂 `web_search`；
- `sources.items` 可含 `citation` / `searched`，`sources.omitted` 标记裁剪；
- `sources.items` 的 provider 都是 `grok-responses`，`diagnostics.provider_attempts` 只有 Grok 一条；
- `sources.raw_path` 非空，文件含 `schema_version: 3`、`query`、`answer`、`sources.items`、`grok_tool_calls`；
- `diagnostics.responses_tool_calls` 含 `upstream` / `trace` / `by_action`，`diagnostics.search_budget.enforced` 为 `false`。

### 域名限定

```bash
node scripts/search.js --responses-allowed-domains github.com "有哪些给 pi coding agent 用的搜索 skill？"
```

期望：`diagnostics.options.responses_allowed_domains` 为 `["github.com"]`；`sources.items` 的 host 都在 github.com 内。

### 研究指令

```bash
node scripts/search.js --instructions "只要官方文档原文和日期，中文回答，找不到就明说" "codex context window"
```

期望：`answer.text` 为中文且不含配置建议；`diagnostics.options.instructions_chars` 等于指令长度；`raw_path` 记录里 `instructions` 为全文。

## X 检索

```bash
node scripts/search.js --source x "X 上大家怎么评价 grok-4.6"
node scripts/search.js --source both --responses-allowed-x-handles xai "latest xAI news"
node scripts/search.js --source x --x-from-date 2026-08-01 "query"
```

期望：

- `diagnostics.options.search_source` 为 `x`，请求体 `tools` 只有 `x_search`；
- `diagnostics.responses_x_search_calls` 大于 0，且不小于 `usage.server_side_tool_usage_details.x_search_calls` 与 `output[]` 里 `x_search_call` item 数中的任一个（两侧都有中转会漏报，此处须是真实次数，不能是 0）；
- `sources.items` 中 X 来源带 `tool: x_search`、`title: "@handle"`、`x_handle`、`x_post_id`，且不出现 `"1"` / `"2"` 这类序号标题；
- `answer.text` 对每条 X 论据署名到 handle 与日期；
- `diagnostics.search_budget.prompt_x` 为 4，`used_x` 等于 `responses_x_search_calls`。

时间线题（同一话题存在 3 月与 8 月两种说法）：

```bash
node scripts/search.js --source x --x-from-date 2026-07-01 "codex 1M context availability"
```

期望：结果里的帖子日期都不早于 2026-07-01；`answer.text` 对新旧说法分别标注日期，不把旧 issue 当现状。

错误路径：

```bash
node scripts/search.js --source twitter "query"                        # SEARCH_SOURCE_INVALID，退出码 2
node scripts/search.js --source web --x-from-date 2026-08-01 "query"   # SEARCH_SOURCE_CONFLICT
node scripts/search.js --x-from-date 08/01/2026 "query"                # ARGUMENT_ERROR
node scripts/search.js --x-from-date 2026-02-30 "query"                # ARGUMENT_ERROR（溢出日期不滚动）
```

配置里已有 `responsesAllowedDomains` 时（命令行只能收紧）：

```bash
node scripts/search.js --responses-allowed-domains 清单外域名 "query"   # RESPONSES_FILTER_FORBIDDEN
node scripts/search.js --responses-excluded-domains 清单内全部域名 "query"  # RESPONSES_FILTER_EMPTY
```

## OpenRouter

```bash
export GROK_API_PROVIDER="openrouter"
export GROK_API_URL="https://openrouter.ai/api/v1"
export GROK_API_KEY="your-key"
export GROK_MODEL="x-ai/grok-4.1-fast"

node scripts/search.js --responses-openrouter-engine exa "latest OpenAI docs"
```

期望 tool 为 `openrouter:web_search`，模型名没有自动 `:online`。

## Fetch 主备链

```bash
node scripts/fetch.js https://example.com
node scripts/fetch.js --provider firecrawl https://example.com
node scripts/fetch.js --provider direct https://example.com
```

顺序为：Direct（请求 Markdown，非 HTML 直接返回）→ Firecrawl（无 key 时走 Keyless）→ Tavily（配置了 key 才有）→ 第一步的 Direct 文本。

## 输出安全

所有非 help 命令都应向 stdout 写 JSON。stderr 只放简短摘要，不得包含 API key。额度降级必须在 `answer.text` 和 `diagnostics.grok_error` 两处都可见。
