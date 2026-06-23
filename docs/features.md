# 功能说明

本文档总结 `grok-search` 当前公开行为。

## Search

`search.js` 会向配置好的 Grok / OpenAI 兼容 endpoint 请求一个面向搜索的问题回答，并返回结构化 JSON。

示例：

```bash
./scripts/search.js "latest Node.js LTS"
./scripts/search.js --platform GitHub "pi coding agent search skill"
./scripts/search.js --extra 10 "latest AI model release notes"
./scripts/search.js --no-extra "OpenAI official website"
./scripts/search.js --search-mode responses "latest official release notes"
```

Search 输出包括：

- `answer.text`：Grok 回答 preview
- `sources.grok`：从 Grok 输出中解析出的来源（如果存在）
- `sources.extra`：可选 Tavily / Firecrawl 补充来源
- `sources.merged`：去重后的来源列表
- `diagnostics`：warnings、provider attempts、options、timestamp 等

### 搜索模式

Search 支持两个生产模式：

- `chat`：默认模式，调用 `/chat/completions`。OpenRouter Chat 兼容路径会自动给模型追加 `:online`。
- `responses`：显式模式，调用 `/responses` 并启用 provider 的 server-side search tool。OpenRouter Responses 使用 `openrouter:web_search`，不追加 `:online`。

`responses` 模式默认 `max_turns=1`、`reasoning.effort=low`。它可能返回更多 citation / searched source 结构，也可能明显比 Chat 更贵。费用字段会尽量写入 `diagnostics.cost_in_usd_ticks` 和 `diagnostics.cost_usd`。

Responses sources 会进入 `sources.grok`，并带有：

- `provider: "grok-responses"`
- `source_type: "citation"` 或 `"searched"`
- `tool: "web_search"`、`"x_search"` 或 `"openrouter:web_search"`

本项目没有正式 `both` 模式。需要对比时分别运行 `chat` 和 `responses`。

### Extra sources

配置 Tavily 或 Firecrawl key 后，search 可以附加补充来源。

Extra sources 是独立参考：

- 不改写 Grok 的回答。
- 不注入 Chat prompt。
- 不注入 Responses prompt。
- 不代表 Grok 的回答一定参考了它们。
- 主要用于主 agent 做置信度判断、冲突检测和来源补充。

## Fetch

`fetch.js` 用于抓取某个明确 URL 的可读内容。

示例：

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider direct https://example.com
./scripts/fetch.js --max-chars 50000 https://example.com
```

`auto` 模式下 provider 顺序：

```text
Tavily Extract → Firecrawl Scrape → Direct Fetch
```

Direct Fetch 是普通 HTTP(S) 文本 / HTML 页面的轻量 fallback。

## Map

`map.js` 用于从站点发现候选 URL。

示例：

```bash
./scripts/map.js https://docs.example.com --limit 20
./scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

`auto` 模式下 provider 顺序：

```text
Tavily Map → Direct Map
```

Direct Map 只检查 `/sitemap.xml` 和首页同域链接。

## 配置

长期配置推荐放在：

```text
~/.config/grok-search/config.json
```

环境变量优先于配置文件，适合 CI 或一次性覆盖。

核心变量：

| 变量 | 用途 |
| --- | --- |
| `GROK_API_URL` | OpenAI 兼容 base URL |
| `GROK_API_KEY` | 对应 endpoint 的 API key |
| `GROK_API_PROVIDER` | `xai`、`openrouter` 或 `openai-compatible`；未配置时按 URL 推断 |
| `GROK_MODEL` | 默认模型 |
| `GROK_SEARCH_MODE` | `chat` 或 `responses`；默认 `chat` |
| `GROK_RESPONSES_MAX_TURNS` | Responses turn 上限；默认 `1` |
| `GROK_RESPONSES_REASONING_EFFORT` | Responses reasoning effort；默认 `low` |
| `GROK_RESPONSES_ALLOWED_DOMAINS` | Responses web search domain allow-list，最多 5 个 |
| `GROK_RESPONSES_EXCLUDED_DOMAINS` | Responses web search domain deny-list，最多 5 个 |
| `GROK_RESPONSES_INCLUDE_X_SEARCH` | 是否启用 direct xAI `x_search`；默认 `false` |
| `GROK_RESPONSES_ALLOWED_X_HANDLES` | X handle allow-list |
| `GROK_RESPONSES_EXCLUDED_X_HANDLES` | X handle deny-list |
| `GROK_RESPONSES_OPENROUTER_ENGINE` | OpenRouter Responses web search engine；默认 `auto` |
| `GROK_RESPONSES_FALLBACK_CHAT` | Responses 失败后是否回退 Chat；默认 `false` |
| `TAVILY_API_KEY` | 启用 Tavily search / extract / map 路径 |
| `FIRECRAWL_API_KEY` | 启用 Firecrawl search / scrape fallback |
| `GROK_OUTPUT_DIR` | 完整输出文件目录 |
| `GROK_PROXY` | 本工具专用代理覆盖 |

## 输出文件

长输出会在 stdout 中返回 preview。完整内容可能写入配置的输出目录，并通过以下字段引用：

- `answer.full_path`
- `content.full_path`
- `sources.raw_path`

## Diagnostics

`diagnostics` 是公开 JSON 输出的一部分，供 agent 读取。

常用字段：

- `diagnostics.warnings`
- `diagnostics.provider_attempts`
- `diagnostics.options`
- `diagnostics.searched_at`
- `diagnostics.fetched_at`
- `diagnostics.mapped_at`

## 当前边界

`grok-search` 目前保持轻量，不执行：

- 浏览器渲染
- 登录流程
- cookie 浏览
- CAPTCHA 处理
- 反爬绕过
- 代理轮换
- PDF 解析

## 相关阅读

- [Responses 模式](responses-mode.md)
- [架构说明](architecture.md)
