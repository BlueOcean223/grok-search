# 架构说明

`grok-search` 是一个轻量级 skill / 脚本包，用于给 coding agent 提供网络访问能力。项目刻意把三类职责拆开：

1. **Search**：向配置好的 Grok / OpenAI 兼容模型请求一个面向搜索的问题回答。
2. **Fetch**：抓取某个明确 URL 的可读正文。
3. **Map**：从某个站点发现候选 URL。

这些脚本面向能够执行 shell 命令并解析 JSON stdout 的 agent harness。

## 组件

```text
scripts/search.js
  ├─ lib/grok.js        Grok / OpenAI 兼容 chat 请求
  ├─ lib/grok-responses.js
  │                    xAI / OpenRouter / openai-compatible Responses 请求与解析
  ├─ lib/providers.js   Tavily / Firecrawl provider 调用和 direct HTTP 辅助函数
  ├─ lib/sources.js     信源提取、压缩、去重
  ├─ lib/output.js      JSON 输出、preview、完整输出落盘
  └─ lib/config.js      环境变量 / 配置文件解析

scripts/fetch.js
  └─ Tavily Extract → Firecrawl Scrape → Direct Fetch

scripts/map.js
  └─ Tavily Map → Direct Map
```

## Search 数据流

```text
query
  ├─ Grok 通道（二选一）
  │    ├─ chat：调用配置好的 /chat/completions endpoint
  │    ├─ responses：调用配置好的 /responses endpoint 和 server-side search tool
  │    ├─ 提取 answer text
  │    └─ 提取 Grok sources
  │         ├─ chat：从回答文本中的 sources/references 解析
  │         └─ responses：从 inline citation annotations 和 tool searched sources 解析
  │
  ├─ 可选 extra source 通道
  │    └─ Tavily / Firecrawl 独立发现补充信源
  │
  └─ result JSON
       ├─ answer
       ├─ sources.grok
       ├─ sources.extra
       ├─ sources.merged
       └─ diagnostics
```

Extra sources 是独立参考信息。它们不会注入 Chat prompt，也不会注入 Responses prompt；不会改写 Grok 的回答，也不代表 Grok 的推理过程使用了这些来源。

Search 没有正式 `both` 模式。需要比较 Chat 与 Responses 时，应分别运行两次命令并由调用方比较结果。

## Fetch 数据流

```text
URL
  ├─ Tavily Extract（如果已配置）
  ├─ Firecrawl Scrape（如果已配置，且 Tavily 失败）
  └─ Direct Fetch fallback
```

Direct Fetch 是一个 best-effort 的 HTTP 文本 / HTML fallback。它不会执行 JavaScript，不会登录，不使用 cookie，不解析 PDF，也不会绕过反爬。

## Map 数据流

```text
site URL
  ├─ Tavily Map（如果已配置）
  └─ Direct Map fallback
       ├─ /sitemap.xml
       └─ 首页同域链接
```

Direct Map 是刻意保持浅层的 fallback，并且会忽略自然语言过滤指令。

## 输出约定

每个脚本都会向 stdout 写出一个完整 JSON 对象。

常见 diagnostics 字段：

- `diagnostics.grok_endpoint`
- `diagnostics.warnings`
- `diagnostics.provider_attempts`
- `diagnostics.options.search_mode`
- 脚本对应的时间戳，例如 `searched_at`、`fetched_at`、`mapped_at`

Responses 模式还可能包含：

- `diagnostics.responses_web_search_calls`
- `diagnostics.responses_x_search_calls`
- `diagnostics.responses_tool_calls`
- `diagnostics.usage`
- `diagnostics.cost_in_usd_ticks`
- `diagnostics.cost_usd`

长文本字段会在 stdout 中返回 preview，并可按需把完整内容写到配置的输出目录。

## Provider 边界

- Grok 回答和 Tavily / Firecrawl extra sources 是不同证据通道。
- 通道之间的冲突会被保留，由调用方 agent 自行判断。
- `chat` 是默认搜索模式；`responses` 是显式高成本模式。
- OpenRouter Chat 模式保留 `:online` 兼容；OpenRouter Responses 模式使用 `openrouter:web_search`，不追加 `:online`。
- Fetch 和 Map 是内容获取 / 发现工具，不是回答生成工具。

## 传输与代理

脚本使用 `undici`，检测到终端代理环境变量时会自动安装代理处理：

- `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`
- 对应的小写变量
- `NO_PROXY`
- `GROK_PROXY`：仅针对本工具的代理覆盖

回环地址会被自动绕过。

## 边界

本项目不打算演变成浏览器或爬虫框架，因此不包含：

- 浏览器渲染
- 登录 / 会话处理
- cookie 管理
- CAPTCHA / 反爬绕过
- 代理池 / 代理轮换
- PDF 解析
- stealth crawling

这些能力需要单独的安全、依赖和产品设计。
