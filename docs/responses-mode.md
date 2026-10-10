# Responses 搜索协议

`search.js` 的唯一生产搜索协议是 Responses API：

```bash
./scripts/search.js "query"
```

它不支持 Chat Completions，也没有模式切换或 Chat fallback。

## Direct xAI / openai-compatible

请求发送到：

```text
{GROK_API_URL}/responses
```

核心 body：

```json
{
  "model": "grok-4.3",
  "input": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "tools": [{ "type": "web_search" }],
  "max_turns": 3,
  "reasoning": { "effort": "low", "summary": "concise" },
  "stream": false
}
```

域名过滤放在 tool 的 `filters`：

```json
{
  "type": "web_search",
  "filters": { "allowed_domains": ["docs.x.ai"] }
}
```

固定推理模型或名称包含 `non-reasoning` 的模型不会发送可配置 reasoning 字段。

## 检索源（`--source`）

`--source` 决定挂哪些 Grok 服务端工具，默认 `web`：

| 模式 | tools | 用途 |
| --- | --- | --- |
| `web` | `web_search` | 默认；网页与官方文档 |
| `x` | `x_search` | 只查 X 帖子、账号、thread |
| `both` | `web_search` + `x_search` | 由 Grok 自行路由 |

```bash
./scripts/search.js --source x "X 上怎么评价 grok-4.6"
./scripts/search.js --source both "grok-4.6 发布后的反响"
./scripts/search.js --source x --responses-allowed-x-handles xai,elonmusk "query"
./scripts/search.js --source x --x-from-date 2026-08-01 --x-to-date 2026-08-16 "query"
```

`x_search` 的过滤参数放在 tool 对象上（不是 `filters`）：

```json
{
  "type": "x_search",
  "allowed_x_handles": ["xai"],
  "from_date": "2026-08-01",
  "to_date": "2026-08-16",
  "enable_image_understanding": true,
  "enable_video_understanding": true
}
```

- `allowed_x_handles` 与 `excluded_x_handles` 互斥，各自上限 20。
- 日期必须是 `YYYY-MM-DD`，且 `from` 不得晚于 `to`；`2026-02-30` 这类溢出日期会被拒绝而不是滚到下个月。
- `--x-images` / `--x-videos` 默认关闭，按 token 额外计费；`--no-x-images` / `--no-x-videos` 可关掉配置里打开的开关。
- **命令行**的 X 过滤参数会把未显式指定的 `--source` 提升为 `both`；显式 `--source web` 与它们同时出现会报 `SEARCH_SOURCE_CONFLICT`。配置文件里的 handle 清单与媒体开关不会提升档位——它们是「X 检索运行时该怎么过滤」的偏好，不是开启一条额外计费检索通道的请求。
- 启用 X 时会追加第二条 system message（X 证据准则），基础 prompt 仍是第一条，保持 prompt cache 前缀稳定。
- `--responses-x-search` / `--responses-include-x-search` 保留为 `--source both` 的别名。
- 配置项 `responsesIncludeXSearch` / `GROK_RESPONSES_INCLUDE_X_SEARCH` 已移除（2026-08-16 弃用，2026-09-08 删除）。值为 `true` 时 `loadConfig` 直接报 `CONFIG_OPTION_REMOVED`：忽略它会静默丢掉 X 检索，所以宁可失败；`false` 或缺失从来等价于不存在，不受影响。改用 `searchSource: "both"`。

X 检索计费为 $5 / 1k calls，与 web search 同价；实际调用次数见 `diagnostics.responses_x_search_calls`。

## OpenRouter

OpenRouter 使用：

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
  ]
}
```

可选 engine：

```text
auto | native | exa | firecrawl | parallel | perplexity
```

```bash
./scripts/search.js --responses-openrouter-engine exa "query"
```

模型名不会自动追加 `:online`。

OpenRouter 对 xAI 模型会**自动**把 `x_search` 挂在 native web search 上，既不能单独关闭也不能只用 X，唯一控制面是顶层 `x_search_filter`：

```json
{
  "x_search_filter": {
    "allowed_x_handles": ["xai"],
    "from_date": "2026-08-01",
    "enable_image_understanding": true
  }
}
```

因此 `--source` 在 OpenRouter 上只是提示。`--source x` 与 `--source web` 都会写入 `diagnostics.warnings` 说明未被强制执行；engine 非 `auto`/`native` 时 native 检索被替换，`x_search` 及其过滤器不会运行，也会告警。

## 配置与命令行的优先级

优先级从高到低：`--source` 等命令行参数 > 环境变量 > 配置文件 > 兜底默认。

需要注意 **配置文件由使用者书写，命令行参数由调用本工具的 agent 书写**，两者作者不同。因此：

- `searchSource` 等标量配置是**默认值**语义，命令行可以覆盖（包括把 `x` / `both` 覆盖回 `web`）。实际生效值始终记录在 `diagnostics.options`，可事后审计。
- 但配置中的**限制**不会被命令行静默抹掉。allow-list 与 deny-list 都是限制：deny-list 去掉列举的值，allow-list 去掉没列举的一切。命令行只能收紧，不能放宽。

| 配置 | 命令行 | 结果 |
| --- | --- | --- |
| deny-list | allow-list | 允许（deny 自动满足）；若显式请求了已排除的值，报 `RESPONSES_FILTER_FORBIDDEN` |
| deny-list | deny-list | 合并去重；超过上限（domain 5 / handle 20）报 `RESPONSES_FILTER_LIMIT` |
| allow-list | allow-list | 必须是配置清单的子集，否则报 `RESPONSES_FILTER_FORBIDDEN` |
| allow-list | deny-list | 从配置清单里减掉；减空报 `RESPONSES_FILTER_EMPTY`（空 allow-list 对 API 等于「不限制」，与配置意图相反） |

比较一律不区分大小写。

本工具目前没有"命令行完全不可覆盖"的硬策略层。若确有此需求，请提 issue 说明场景。

## Responses sources

解析器收集：

- output text annotations 与 top-level citations；起止位置都为 0、标题为空或等于 URL 的 annotation 是检索结果清单，记为 `searched`；
- 最终回答正文里的 Markdown 链接和裸 URL（跳过代码块和行内代码），按出现顺序记为 `citation`；
- `web_search_call`、`x_search_call` 的 action/query/url/source；
- usage 与费用字段。

解析出的每条 source 形如：

```json
{
  "provider": "grok-responses",
  "source_type": "citation",
  "tool": "web_search",
  "url": "https://example.com"
}
```

同一 URL 同时是 `citation` 和 `searched` 时，citation 优先。

X citation 只带裸 URL，且 `title` 就是 inline citation 序号（`"1"`、`"2"`）。解析器从 URL 还原署名，并丢掉这个无意义的序号标题：

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

只有 `/<handle>/status/<id>` 这种形式带署名；`https://x.com/i/status/...`、`https://x.com/i/web/status/...` 只填 `x_post_id`，并且不保留序号标题。

citation 本身不带产出工具信息，所以 `tool` 是推断的：**挂了 `x_search` 时**（`--source x` / `both`，以及 OpenRouter——那里 `x_search` 必然随行）X 链接标为 `x_search`；`--source web` 下不标，因为 web search 本来就会索引 x.com 页面，标成 `x_search` 等于报告一次没发生的检索。URL 还原出的 `x_handle` / `x_post_id` 与挂了哪个工具无关，始终保留。

## Tavily 与 Firecrawl

它们与 Responses 请求并行，但不进入 `input`：

```text
Grok Responses ──────────────┐
Tavily Search（有 key）───────┼─ sources.items（去重合并 + 上限裁剪）
Firecrawl Search（Keyless/key）┘
```

默认合计 6 条；两家可用时 3/3。Firecrawl provider attempt 会包含 `auth_mode`、`requests`、`duration_ms`，可能包含 `credits_used`；冷却期内为 `skipped: true`。域名过滤会下推给两家，域外结果在排序时降到最后并计入 `off_domain`。`--instructions` 不会传给两家。

## 额度错误

只有明确额度信号触发 degraded success：

- HTTP 402；
- HTTP 429 且正文包含 quota、credit、balance、billing、额度、余额等信号；
- `insufficient_quota`、`credits_exhausted` 等错误码。

不带额度信号的 429 归为 `RATE_LIMITED`，降级行为相同但 `grok_error.code` 与 warning 文案如实区分。降级输出同时包含人类可见警告和结构化 `diagnostics.grok_error`。`--no-extra` 时返回 `GROK_QUOTA_EXHAUSTED` / `GROK_RATE_LIMITED`。401/403、404/422、5xx、超时和空响应仍是普通错误。

## Diagnostics

重点字段：

- `grok_endpoint: responses`
- `responses_max_turns`
- `search_source`（`web` / `x` / `both`）
- `responses_web_search_calls`
- `responses_x_search_calls`
- `responses_tool_calls`

工具调用次数取 `usage.server_side_tool_usage_details`（计费口径）与 `output[]` 里 `*_call` item 统计的**逐工具较大值**。两边都不可单独信任：部分中转会计费 `x_search` 却不吐 `x_search_call` item（只看 `output[]` 会报 0），另一些会把该字段填成全 0（只看 usage 同样报 0）。`responses_tool_calls` 摘要为 `{ total, upstream: { web, x } | null, trace: { web, x }, by_action: { search, open_page, find_in_page }, failed? }`：`total` 用较大值口径，`upstream` / `trace` 保留两侧原始计数，因此 `total` 可能大于 `raw_path` 里记录的 tool call 明细条数。`status` 不是 `completed` 的调用（例如对打不开或 Grok 猜出来的 URL 做 `open_page`）只列在 `failed`：usage 不计费，`trace`、`by_action`、`total` 也都不算它，它的 URL 不标 `opened`。
- `search_budget`：`{ prompt_total: 6, prompt_x: 0|4, used_web, used_x, used_total, exceeded, enforced: false }`。prompt 里的预算是给模型的建议，不是上限：`max_turns` 限的是 agentic turn，一个 turn 可含多次检索，而且它只对 X 搜索是硬上限、web 搜索不受它约束，所以 `enforced` 恒为 false。请求侧能压次数的只有 `parallel_tool_calls: false`（`--responses-parallel-tool-calls false`，默认不发）：官方与透传的中转上每 turn 一次调用，但只在 `responses_tool_calls.total` 常超 6 时才省钱，grok-4.6 自然只跑 3–5 次、加了不省。`max_tool_calls` 官方与中转都不生效，未接入。模型本身是最大的费用杠杆（同题 grok-4.6 的调用是 grok-4.5 的 1/3–1/4）。`cost_usd` 是端点报的 `usage.cost_in_usd_ticks`，中转与官方对同一 usage 报的数可差一倍多，跨供应商不可比。实验过程与数据见 `.agent/tool-call-cap-2026-09-08.md`。
- `responses_model`：中转实际返回的 `model`；与请求不同时写 warning。第一个中转对每次 `grok-4.5` 请求都返回 `grok-4.5-build`，这才是它 2–3 倍调用次数的来源
- grok-4.6 的回答截断：模型写到第一个行内引用就停止输出，`status` 仍是 `completed`、没有 `incomplete_details`，回答只剩开头一两段、没有链接，随后附上起止位置为 0 的检索结果清单。2026-10-10 在官方 `api.x.ai` 和两家中转上都复现，历史 run record 里约六分之一的 web 搜索中招；同一批问题 grok-4.7 跑 15 次没有出现。解析器无法补回缺失内容，也不自动重试（grok-4.7 不用行内引用时也会给出完整但没有链接的回答，按"无链接"判断截断会误报）
- 中转差异还包括：X 搜索以 `custom_tool_call`（`x_keyword_search` / `x_thread_fetch` …）形式返回，解析器按 `x_search` 计数并把 `by_action` 写成 `keyword_search` / `thread_fetch`；每个 turn 的过场 message（"I'll search X…"）被丢弃，`answer.text` 只取最后一条，除非前面的 message 很长或带 citation
- xAI 的引用渲染标记偶尔漏进正文：私用区字符包着的 `\ue200render_inline_citation speecheo_citation_id="10"\ue201`（grok-4.6，2026-10-08），或链接后裸露的 `show render_inline_citation with citation_id="2"`（grok-4.6-build，2026-09-17）。解析器删掉这两种标记，周围的正文和链接不动
- `options.instructions_chars`（传了 `--instructions` 时）
- `extra_allocation`
- `firecrawl_auth_mode`
- `degraded` / `grok_error`
- `usage` / `cost_usd`
