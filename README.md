# grok-search

**简体中文** | [English](README.en.md)

`grok-search` 是一个通用 AI agent skill / 脚本包，用轻量 Node.js 脚本提供三类网络访问能力：

- **Search**：通过 Responses API 调用 Grok / OpenRouter / Responses-compatible 接口，并行返回 Tavily / Firecrawl 独立信源。
- **Fetch**：抓取指定 URL 的可读内容，优先使用 Tavily / Firecrawl，最后 fallback 到无 key 的 Direct Fetch。
- **Map**：发现站点内的候选页面 URL，优先使用 Tavily Map，最后 fallback 到轻量 Direct Map。

## 要求

- Node.js `>=18.17`
- 需要先运行一次 `npm install` 安装 `undici` 传输依赖
- `search.js` 需要配置 `GROK_API_URL` 和 `GROK_API_KEY`

## 快速开始

先安装依赖一次，然后从项目根目录运行脚本：

```bash
npm install
./scripts/search.js "latest Node.js LTS"
./scripts/fetch.js https://example.com
./scripts/map.js https://docs.example.com --limit 20
```

## 在 pi 中使用（示例）

把本目录 clone 或复制到你的 pi skills 位置，然后通过 `SKILL.md` 启用这个 skill。

示例命令仍然是直接运行脚本：

```bash
./scripts/search.js "latest Node.js LTS"
./scripts/fetch.js https://example.com
./scripts/map.js https://docs.example.com --limit 20
```

其他 agent harness 也可以采用同样方式：读取 `SKILL.md`，再按需运行 `scripts/search.js`、`scripts/fetch.js`、`scripts/map.js`。

## 文档

- [架构说明](docs/architecture.md)
- [功能说明](docs/features.md)
- [Responses 搜索协议](docs/responses-mode.md)
- [Smoke Tests](docs/smoke-tests.md)
- [公开 Benchmark](docs/benchmark.md)
- [评测方法研究](docs/web-search-evaluation-research.md)
- Agent 侧说明：[SKILL.md](SKILL.md)（每轮都读，≤5k 字）与按需阅读的 [references/x-search.md](references/x-search.md)、[references/providers.md](references/providers.md)、[references/planning.md](references/planning.md)

## 配置

推荐把长期使用的 key 放到：

```text
~/.config/grok-search/config.json
```

可以从示例文件复制：

```bash
mkdir -p ~/.config/grok-search
cp config.example.json ~/.config/grok-search/config.json
chmod 600 ~/.config/grok-search/config.json
```

完整配置示例：

```json
{
  "apiUrl": "https://api.x.ai/v1",
  "apiKey": "your-grok-api-key",
  "apiProvider": "xai",
  "model": "grok-4.3",
  "responsesMaxTurns": 3,
  "responsesReasoningEffort": "low",
  "responsesAllowedDomains": [],
  "responsesExcludedDomains": [],
  "responsesAllowedXHandles": [],
  "responsesExcludedXHandles": [],
  "responsesOpenRouterEngine": "auto",
  "defaultExtra": 6,
  "sourceChars": 400,
  "tavilyApiKey": "",
  "tavilyApiUrl": "https://api.tavily.com",
  "firecrawlApiKey": "",
  "firecrawlApiUrl": "https://api.firecrawl.dev/v2",
  "outputDir": "",
  "stateDir": "",
  "runLog": true
}
```

常见填写规则：

- `apiUrl` 填支持 `/responses` 的 API base URL；脚本会请求 `{apiUrl}/responses`，不要把 `/responses` 本身写进去。
- `apiProvider` 一次只能填写一个值：
  - `xai`：xAI 官方接口，按 `searchSource` 使用 `web_search` 与 `x_search`。
  - `openrouter`：OpenRouter 接口，改用 `openrouter:web_search`；可通过 `responsesOpenRouterEngine` 选择搜索引擎。
  - `openai-compatible`：支持 xAI 风格 Responses 与 `web_search` tool 的中转、反代或兼容服务。仅支持 Chat Completions 的接口不能使用。
- `apiProvider` 省略时会按 URL 推断：包含 `openrouter` 视为 `openrouter`，包含 `api.x.ai` 视为 `xai`，其他 URL 视为 `openai-compatible`。中转服务建议显式填写，避免请求格式判断错误。
- `model` 必须填写该 endpoint 实际支持的模型 ID；`responsesMaxTurns` 是不小于 1 的整数。`responsesReasoningEffort` 常见值为 `low`、`medium`、`high`，但是否支持取决于具体模型与 provider。
- `responsesAllowedDomains`、`responsesExcludedDomains`、`responsesAllowedXHandles`、`responsesExcludedXHandles` 都是数组，可以填写多个值，例如 `["github.com", "docs.python.org"]`；同一组 allowed 与 excluded 不能同时使用。domain 上限 5 个，X handle 上限 20 个。环境变量中的多值使用逗号分隔。
- `searchSource` 可选 `web`、`x` 或 `both`，决定默认挂载哪些检索工具；命令行 `--source` 优先。X 的日期窗口是按查询变化的，只能用 `--x-from-date` / `--x-to-date` 传入，没有对应配置项。
- 旧配置项 `responsesIncludeXSearch` / `GROK_RESPONSES_INCLUDE_X_SEARCH` 已移除（2026-08 弃用，2026-09 删除）。值为 `true` 时命令直接报 `CONFIG_OPTION_REMOVED` 而不是静默丢掉 X 检索，请改为 `searchSource: "both"`；`false` 或缺失不受影响。
- 优先级为 命令行 > 环境变量 > 配置文件 > 默认值。注意配置文件由你书写、命令行参数由调用本工具的 agent 书写：标量配置（如 `searchSource`）是**默认值**，agent 可以覆盖，实际生效值见 `diagnostics.options`；但配置里的**限制**不会被静默抹掉——allow-list 与 deny-list 都是限制，命令行只能收紧不能放宽。越界报 `RESPONSES_FILTER_FORBIDDEN`，把 allow-list 减空报 `RESPONSES_FILTER_EMPTY`，两个 deny-list 合并而非替换。规则见 [docs/responses-mode.md](docs/responses-mode.md#配置与命令行的优先级)。
- `responsesOpenRouterEngine` 可选 `auto`、`native`、`exa`、`firecrawl`、`parallel` 或 `perplexity`，仅在 `apiProvider` 为 `openrouter` 时生效。
- `tavilyApiKey` 可留空；`firecrawlApiKey` 也可留空并使用 Firecrawl Keyless。`outputDir` 留空时使用默认目录 `~/.cache/grok-search/outputs/`；`stateDir` 留空时使用 `~/.cache/grok-search/`，存放 Firecrawl 冷却状态和 fetch 缓存；`runLog: false` 关闭每次调用的运行记录落盘。

如果使用 OpenRouter，核心字段可改为：

```json
{
  "apiUrl": "https://openrouter.ai/api/v1",
  "apiKey": "your-openrouter-api-key",
  "apiProvider": "openrouter",
  "model": "your-openrouter-model-id",
  "responsesOpenRouterEngine": "auto"
}
```

如果使用 Responses-compatible 中转服务，核心字段可改为：

```json
{
  "apiUrl": "https://your-endpoint.example/v1",
  "apiKey": "your-api-key",
  "apiProvider": "openai-compatible",
  "model": "the-model-id-supported-by-your-endpoint"
}
```

然后编辑复制过去的文件，填入真实 key。环境变量仍然优先于配置文件，适合临时覆盖或 CI 使用。

本项目**不会自动加载 `.env` 文件**。如果你想用环境变量，请自己在 shell 里 export。

### 代理

Node 原生 `fetch` 默认不会可靠读取终端代理变量。本项目会在检测到代理环境变量时自动安装 `undici` 的 `EnvHttpProxyAgent`，让所有出站请求走你的终端代理配置。

支持的变量：

- `HTTP_PROXY` / `http_proxy`
- `HTTPS_PROXY` / `https_proxy`
- `ALL_PROXY` / `all_proxy`
- `NO_PROXY` / `no_proxy`
- `GROK_PROXY`：显式给本工具指定一个代理 URL；设为 `GROK_PROXY=off` 可强制直连。显式配置无效时命令会直接失败（`PROXY_CONFIG_INVALID`），不会静默退回直连；环境继承的代理失败则继续运行，并通过 search 的 `diagnostics.options.proxy_mode` 暴露状态

`NO_PROXY` 会被尊重，并且会始终把回环地址（`localhost`、`127.0.0.1`、`::1`）加入绕过列表。

| 环境变量 | 配置文件 key | 是否必需 | 用途 | 说明 |
| --- | --- | --- | --- | --- |
| `GROK_API_URL` | `apiUrl` | search 必需 | `search.js` | 支持 `/responses` 的 base URL。 |
| `GROK_API_KEY` | `apiKey` | search 必需 | `search.js` | `GROK_API_URL` 对应的 API key。 |
| `GROK_API_PROVIDER` | `apiProvider` | 否 | `search.js` | 选择 Responses tool 请求格式，而不是额外的搜索源；可选 `xai`、`openrouter` 或 `openai-compatible`。未配置时按 URL 推断。 |
| `GROK_MODEL` | `model` | 否 | `search.js` | 默认 `grok-4.3`。不建议用 `grok-4.6`：它约六分之一的 web 搜索会在第一个行内引用处停止输出，回答只剩开头（2026-10-10 官方与中转都复现），`grok-4.7` 没有这个问题。 |
| `GROK_RESPONSES_MAX_TURNS` | `responsesMaxTurns` | 否 | Responses | 默认 `3`，控制 Responses agentic turn 上限；只对 X 搜索是硬上限，web 搜索不受它约束。 |
| `GROK_RESPONSES_REASONING_EFFORT` | `responsesReasoningEffort` | 否 | Responses | 默认 `low`。 |
| `GROK_RESPONSES_PARALLEL_TOOL_CALLS` | `responsesParallelToolCalls` | 否 | Responses | `true` / `false`；默认不发送。`false` 让 Grok 每个 turn 只做一次服务端工具调用，官方 `api.x.ai` 与透传的中转都回显 `false`，X 搜索被压到每 turn 一次、`max_turns` 成为硬上限（2026-09-08 实测：grok-4.5 经中转 7–14 次降到 3 次、费用约三分之一；grok-4.6 无论官方还是中转自然只 3–4 次，降到 3 次费用持平，`responses_tool_calls.total` 超过 6 再加）；不透传的中转会回显 `true`。`max_tool_calls` 官方与中转都不生效，未接入。命令行 `--responses-parallel-tool-calls false`。 |
| `GROK_RESPONSES_ALLOWED_DOMAINS` | `responsesAllowedDomains` | 否 | Responses | 逗号分隔 domain allow-list，最多 5 个；与 excluded 互斥。 |
| `GROK_RESPONSES_EXCLUDED_DOMAINS` | `responsesExcludedDomains` | 否 | Responses | 逗号分隔 domain deny-list，最多 5 个；与 allowed 互斥。 |
| `GROK_SEARCH_SOURCE` | `searchSource` | 否 | Responses | 默认检索源：`web`、`x` 或 `both`。默认 `web`。 |
| `GROK_RESPONSES_ALLOWED_X_HANDLES` | `responsesAllowedXHandles` | 否 | Responses | X handle allow-list，最多 20 个；与 excluded 互斥。 |
| `GROK_RESPONSES_EXCLUDED_X_HANDLES` | `responsesExcludedXHandles` | 否 | Responses | X handle deny-list，最多 20 个；与 allowed 互斥。 |
| `GROK_X_IMAGE_UNDERSTANDING` | `xImageUnderstanding` | 否 | Responses | 分析 X 帖子中的图片，按 token 额外计费。默认 `false`。 |
| `GROK_X_VIDEO_UNDERSTANDING` | `xVideoUnderstanding` | 否 | Responses | 分析 X 帖子中的视频，按 token 额外计费。默认 `false`。 |
| `GROK_RESPONSES_OPENROUTER_ENGINE` | `responsesOpenRouterEngine` | 否 | OpenRouter Responses | `auto`、`native`、`exa`、`firecrawl`、`parallel` 或 `perplexity`。默认 `auto`。 |
| `GROK_DEFAULT_EXTRA` | `defaultExtra` | 否 | `search.js` | Tavily 与 Firecrawl 合计的默认 extra source 数量。默认 `6`。 |
| `GROK_SOURCE_CHARS` | `sourceChars` | 否 | `search.js` | 每条 source stdout snippet 长度。默认 `400`；`0` 表示不输出 snippet。 |
| `GROK_MAX_SOURCES` | `maxSources` | 否 | `search.js` | stdout 返回的 source card 数量上限。默认 `12`；被裁剪的完整列表落盘到 `sources.raw_path`。 |
| `GROK_DEADLINE_SECONDS` | `deadlineSeconds` | 否 | 所有脚本 | 单条命令总耗时上限（秒）。默认 `240`，`0` 表示禁用；超时会先输出 `DEADLINE_EXCEEDED` JSON 再退出。 |
| `TAVILY_API_KEY` | `tavilyApiKey` | 否 | `search.js`、`fetch.js`、`map.js` | 启用 Tavily Search / Extract / Map。没有它时，search/fetch 仍可使用 Firecrawl Keyless，map 使用 Direct Map。 |
| `TAVILY_API_URL` | `tavilyApiUrl` | 否 | Tavily 路径 | 默认 `https://api.tavily.com`。 |
| `FIRECRAWL_API_KEY` | `firecrawlApiKey` | 否 | `search.js`、`fetch.js` | 可选。未配置时使用 Firecrawl Keyless；配置后使用独立账户额度和更高限流。 |
| `FIRECRAWL_API_URL` | `firecrawlApiUrl` | 否 | Firecrawl 路径 | 默认 `https://api.firecrawl.dev/v2`。 |
| `GROK_OUTPUT_DIR` | `outputDir` | 否 | 所有脚本 | 覆盖长输出与运行记录的落盘目录。默认 `~/.cache/grok-search/outputs/`。 |
| `GROK_STATE_DIR` | `stateDir` | 否 | 所有脚本 | 跨命令状态目录（Firecrawl 额度冷却文件 `firecrawl-cooldown.json`、15 分钟的 fetch 缓存 `fetch-cache/`）。默认 `~/.cache/grok-search/`。 |
| `GROK_RUN_LOG` | `runLog` | 否 | 所有脚本 | 默认 `true`，每次调用写一份运行记录 JSON；`off` / `false` 关闭后 `sources.raw_path` / `diagnostics.run_path` 为 null。 |
| `GROK_DEBUG_RAW` | — | 否 | `search.js` | 仅环境变量。设为 `1` 时把脱敏后的完整 Grok 响应作为 `grok_raw` 写进运行记录（`--full-sources` 亦然）。 |
| `GROK_DEBUG` | — | 否 | 所有脚本 | 仅环境变量。设为 `true` 时把重试 / 清理 / 代理调试日志写到 stderr。 |
| `GROK_PROXY` | `proxy` | 否 | 所有脚本 | 显式代理 URL，或设为 `off` / `direct` 禁用代理。 |

OpenRouter 使用 `openrouter:web_search` server tool，不会给模型名追加 `:online`。

## 输出 schema

当前版本使用命令原生 JSON 输出。这是相对旧版 `ok` / `kind` envelope 的 **breaking change**。

失败时每个脚本都会返回：

```json
{
  "error": {
    "message": "...",
    "code": "FETCH_ERROR"
  },
  "diagnostics": {
    "warnings": [],
    "provider_attempts": []
  }
}
```

成功时，provider attempts、warnings、时间戳和命令选项都放在 `diagnostics` 下。

## Search

```bash
./scripts/search.js "What changed in the latest Node.js LTS?"
./scripts/search.js --instructions "只要官方 changelog 的原文和日期，找不到就说" "node lts changelog"
./scripts/search.js --platform GitHub "pi coding agent search skill"
./scripts/search.js --responses-allowed-domains github.com "pi coding agent search skill"
./scripts/search.js --extra 10 "latest pi coding agent docs"
./scripts/search.js --no-extra "query"
./scripts/search.js --source-chars 200 "query"
./scripts/search.js --max-sources 8 "query"
./scripts/search.js --deadline 120 "query"
./scripts/search.js --full-sources "debug provider raw"
./scripts/search.js --responses-openrouter-engine exa "strict web-only query"
./scripts/search.js --source x --responses-parallel-tool-calls false "query"   # 每 turn 一次工具调用，省费用
```

`--instructions TEXT` 把"要什么"和"搜什么"分开：query 是 Tavily / Firecrawl 原样检索的关键词，指令只追加到发给 Grok 的 user message 末尾（system prompt 前缀不变，prompt cache 不受影响）；带指令时 query 前会加一行 `# Search query` 标题，否则短 query 会被当成时间上下文的一行而丢失（2026-09-08 实测 Grok 回答"未指定主题"）。`diagnostics.options.instructions_chars` 记录长度，运行记录保存全文；没有配置项默认值。

`--responses-allowed-domains` / `--responses-excluded-domains` 同时作用于三个通道：Grok 的 `web_search` filters、Tavily 的 `include_domains` / `exclude_domains`、Firecrawl 的 `includeDomains` / `excludeDomains`。上游仍漏进来的域外 extra 不丢弃，但排到所有 Grok 结果之后；`diagnostics.options.extra_domain_filter` 取 `pushed` / `demoted` / `none`，extra 的 provider attempt 带 `off_domain` 计数。

### 检索源

`--source` 选择挂载哪些 Grok 服务端工具，默认 `web`：

```bash
./scripts/search.js --source x "X 上怎么评价 grok-4.6"          # 只查 X
./scripts/search.js --source both "grok-4.6 发布后的反响"        # Grok 自行路由
./scripts/search.js --source x --responses-allowed-x-handles xai,OpenAI "query"
./scripts/search.js --source x --x-from-date 2026-08-01 --x-to-date 2026-08-16 "query"
./scripts/search.js --source x --x-images "query"               # 分析帖子中的图片
```

- `x_search` 支持 handle allow/deny（互斥，各上限 20）、`--x-from-date` / `--x-to-date`（`YYYY-MM-DD`）、`--x-images` / `--x-videos`（默认关闭，按 token 额外计费；`--no-x-images` / `--no-x-videos` 可关掉配置里打开的开关）。
- **命令行**的 X 过滤参数会把未显式指定的 `--source` 提升为 `both`；与显式 `--source web` 同时出现则报 `SEARCH_SOURCE_CONFLICT`。配置文件里的 X 过滤项只在 X 检索开启时生效，不会自己把档位提升上去。
- `--responses-x-search` 保留为 `--source both` 的别名。
- X 检索计费 $5 / 1k calls，与 web search 同价，实际次数见 `diagnostics.responses_x_search_calls`。
- Tavily / Firecrawl extra 源只搜网页，不搜 X。`--source x` 下两家默认关闭（`diagnostics.options.extra_mode` 为 `off-x-only`），显式 `--extra N` 可开启；`--source both` 仍默认开启。
- OpenRouter 会自动把 `x_search` 挂在 native web search 上，`--source` 在该路径下只是提示，未被强制执行时会写入 `diagnostics.warnings`。

X citation 只返回裸 URL、且 `title` 是 inline citation 序号，因此 source card 会从 URL 还原署名：

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

帖子正文与日期不在 card 中，而在 `answer.text` 里按 handle + 日期署名。

`search.js` 只使用 Responses 协议，以 `stream:false` 调用 `{GROK_API_URL}/responses`，启用 provider-native web search，并返回：

- `answer.text`、`answer.chars`、`answer.original_chars`、`answer.truncated`、`answer.full_path`
- `sources.items`：单份去重合并后的短 source card 列表，默认最多 `12` 条（`--max-sources` 可调）。超出上限时用 Reciprocal Rank Fusion（RRF，k=60）合并 Grok 与各 extra provider 的结果列表再取前 N 条：Grok 列表内按 `citation` > `opened: true`（Grok 用 `open_page` 成功读过的页面）> `searched` 排，Tavily、Firecrawl 各按自己返回的顺序；多路都返回的 URL 每一路都计分；域外 extra 排在最后。答案引用的链接很多时，有些 `citation` 只出现在 `answer.text` 里。同一 URL 跨通道出现时合并成一张卡，`merged_from` 列出补充了字段的 provider；`"1"`、`[2]` 这类序号标题视为缺失：有真标题就替换，没有就不输出 `title`
- `sources.returned` / `sources.total` / `sources.omitted`：让调用方明确知道是否被截断
- `sources.raw_path`：总是有值（除非 `GROK_RUN_LOG=off`），指向本次调用的运行记录：脱敏 argv、query、instructions、生效 options、完整 answer、未裁剪的 source 列表、`grok_tool_calls`、diagnostics；失败与 `DEADLINE_EXCEEDED` 也会写
- `sources.raw`，仅在使用 `--full-sources` 时出现
- `diagnostics.responses_model`：中转实际返回的模型；与请求的不同时 `warnings` 里会有一条（2026-09-08 发现某中转对每次 `grok-4.5` 请求都返回 `grok-4.5-build`，调用次数和费用是 2–3 倍）
- `diagnostics.grok_endpoint`、`diagnostics.usage` / `diagnostics.cost_usd`（provider 返回时）、`diagnostics.responses_*`（`responses_tool_calls` 为 `{ total, upstream: { web, x } | null, trace: { web, x }, by_action, failed? }` 摘要，失败的调用只列在 `failed`、不计入其余计数，完整列表在 `raw_path` 中）、`diagnostics.search_budget`（prompt 里的软预算与实际次数并列，`enforced: false`；`used_web` / `used_x` / `used_total` 是计费调用数，含打开页面，`exceeded` 只比较 `used_searches` / `used_x_searches` 这两个检索次数）、`diagnostics.warnings`、`diagnostics.provider_attempts`、`diagnostics.options`、`diagnostics.duration_ms`、`diagnostics.searched_at`

默认会同时发起 Grok Responses、Tavily Search（配置 key 时）和 Firecrawl Search。三路并行，Tavily/Firecrawl 结果始终作为独立补充信源，不会注入 Grok input。

`--extra N` 表示 Tavily 与 Firecrawl 合计的结果目标数，默认 `6`。两家都可用时平均分配，奇数优先给 Tavily；没有 Tavily key 时全部交给 Firecrawl Keyless。`--no-extra` 会严格关闭两个外部搜索通道。

当 Grok 明确返回额度耗尽（402、额度类错误码、正文提到 quota / credits / billing 的 429），而 extra sources 可用时，命令会返回标记为 `diagnostics.degraded: true` 的降级结果，`grok_error.code` 为 `QUOTA_EXHAUSTED`；普通 429 限流同样降级，但 code 是 `RATE_LIMITED`。`answer.text` 会明确说明当前仅为 Tavily/Firecrawl 原始搜索结果，`diagnostics.grok_error` 保留脱敏后的上游错误。其他认证、协议或服务错误不会被伪装成降级。

Firecrawl Keyless 提供每月 1,000 credits，并受按 IP 的每日限额约束。配置 `FIRECRAWL_API_KEY` 不会增加免费计划的月度 credits，但能获得更高限流、独立账户额度和更多 API 能力。

额度耗尽时 Firecrawl 返回 429 与 `reason: credits`、`retry_after_seconds`（通常数小时）。脚本不再重试，而是把 `{ until, auth_mode, reason, hit_at }` 写进 `<stateDir>/firecrawl-cooldown.json`；冷却期内 `search.js` 与 `fetch.js --provider auto` 直接跳过 Firecrawl（provider attempt 记 `skipped: true` 与 `cooldown until <ISO>`），search 的名额转给 Tavily，没有 Tavily 时 extra 为空并写 warning。显式 `--provider firecrawl` 仍会真打，成功后清除冷却。冷却按 `auth_mode` 区分，换上 API key 立即生效。

通用重试规则：408 / 429 / 5xx 最多重试 3 次，`Retry-After`（header 或 Firecrawl 的 `retry_after_seconds`）在重试预算内照等，超出预算即停止而不是截短后继续；坏 JSON、`success:false`、403 等 4xx、scrape 超时都只请求一次。provider attempt 带 `requests`（实际 HTTP 次数）与 `duration_ms`。

Source card 不再输出长 `description` 或 `content` 字段，只输出短 `snippet`。完整 raw 数据可通过 `sources.raw_path` 按需读取。

## Fetch

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider direct https://example.com
```

fetch 默认只返回 12,000 字符 preview（`--max-chars` 调整）。正文被截断时，`content.text` 最后一行是 `[grok-search]` 开头的提示，写明显示的是第几到第几个字符、下一段用哪个 `--offset`、全文在哪个文件。要往下读，用 `--offset` 接着读，不要加大 `--max-chars` 把开头重新打印一遍。不管 `--max-chars` 设多大，整个 JSON 输出都不超过 45KB（pi 的 bash 工具只保留输出最后 50KB，超长的单行正文会整行丢掉）：放不下时 `content.text` 再截短，`content.truncated` 为 true，全文在 `content.full_path`。search 的 `answer.text` 同理，被截断时最后一行写明全文路径。

```bash
./scripts/fetch.js --offset 12000 https://example.com
```

同一个 URL 在 15 分钟内再抓，直接读本地缓存（`<stateDir>/fetch-cache/`），不再请求 provider，参照 Claude Code WebFetch 的 15 分钟缓存。`auto` 只复用之前 `auto` 抓到的结果；显式指定 provider 时，复用该 provider 产出的结果，所以换 provider 重抓仍会真的去请求新的 provider。命中时 `diagnostics.cache` 为 `{ hit, fetched_at, age_seconds }`，`provider_attempts` 为空。失败的结果不缓存，回退得到的结果也不缓存（Firecrawl 或 Tavily 失败之后才拿到的结果，以及两家都失败后用的 Direct 文本），因为失败可能下一次就恢复了；`--no-cache` 强制重抓。截断提示里写的是缓存还剩几分钟，续读时复用第一次写出的全文文件。`--offset` 用在一次新抓取上时（缓存已过期，或用了 `--no-cache`），正文开头会提示这个偏移量可能和之前那份文本对不上。依据：截至 2026-10-09 的会话里，各会话抓过的 109 个 URL 中有 12 个在约三分钟内又被抓了一次，原因是 agent 用不同的脚本过滤同一页，或者想看 preview 之后的内容。

会改变正文读法的提示也写进 `content.text` 开头：跳到站点首页、Direct 只拿到标题、X 页面未通过校验就原样返回。这些提示同时保留在 `diagnostics.warnings` 里。原因是 agent 常常只打印 `content.text`：截至 2026-10-09，Claude Code 里约 105 次调用只打印过 1 次 `diagnostics.warnings`。

`--provider auto` 的 provider 顺序：

```text
Direct（请求 Markdown）-> Firecrawl Scrape -> Tavily Extract -> 第一步拿到的 Direct 文本
```

第一步 Direct 用 `Accept: text/markdown, text/html;q=0.9, */*;q=0.8` 请求页面，返回的不是 HTML 就原样采用（按响应声明的字符集解码，JSON 重新缩进；没声明字符集、又解码不成 UTF-8 的文本交给后面的 provider）。支持内容协商的站点会直接给出不带导航的 Markdown，例如 code.claude.com、platform.openai.com，以及接入 Cloudflare Markdown for Agents 的站点。纯文本文件、JSON 接口也在这一步拿到。2026-10-10 用记录里的 153 个 HTML URL 试过，45 个返回了 Markdown。这一步只是探测，超时 15 秒（同一天对比的 60 个 HTML 页面里，Direct 最慢 6.3 秒），卡住的站点不会拖住后面的 provider。

返回 HTML 的页面交给 Firecrawl。它出错、目标页状态码 ≥ 400、内容为空或被限流（429）时，再交给 Tavily。两家都失败时，用第一步已经拿到的 Direct 文本，不再重复请求。

Firecrawl 排在 Tavily 前面，依据是 2026-10-10 的对比：从运行记录里选了 60 个 HTML 页面，同一时间用两家各抓一遍，再人工核对。
- Tavily 约 20 页缺正文：11 个 GitHub issue 页全部缺评论，arXiv 页缺摘要等。
- Firecrawl 只有 1 页缺正文：一个文章列表页的列表被删了。
- 代价：Firecrawl 每页 1 credit，Tavily basic 每 5 页 1 credit；耗时中位数 Firecrawl 3.5 秒，Tavily 1.9 秒。
- 用量：按过去 25 天的调用量估算，每月约 146 次抓取会走到 Firecrawl。

Direct Fetch 会做简单的 HTML 清理、尽量格式化 JSON、记录重定向，并拒绝二进制、附件和超大响应；纯文本按声明的字符集解码后原样返回。

Firecrawl 会把目标页的状态码一并返回：状态码 ≥ 400 的页面按失败处理，交给下一个 provider（2026-09-15 至 10-06 记录在案的 7 次全是 404 / 503 错误页）。Firecrawl 和 Direct 都会把最终 URL 写进 `final_url` / `redirected`；带路径的 URL 最终落在站点首页时，`content.text` 开头和 `diagnostics.warnings` 里都会写明，这种情况多半是页面已删除（例如 gov.cn 用脚本把已删除的页面跳回首页）。

Firecrawl Scrape 无 key 时会使用 Keyless；配置 `FIRECRAWL_API_KEY` 后会自动发送 Bearer token。当前认证模式写入 `diagnostics.firecrawl_auth_mode`。

X 原帖（`x.com/<handle>/status/<id>`）在 `--provider auto` 下不论是否配置 key 都先走 Direct，校验页面含 `@handle`、日期与非登录页正文才算成功（只有主帖）；校验不过再依次走 Tavily、Firecrawl（X 页面让 Tavily 在前，因为 Firecrawl 抓一条约 30 credits），都不可用时按原样返回 Direct 内容并写 warning。这样定的依据是 2026-09-08 的对照：Tavily 快且免费但三条里一条不带日期、另有一次超时；Firecrawl 每条约 30 credits、10 秒以上，换来 ISO 时间戳、互动数和 thread。需要 thread 时显式 `--provider firecrawl`。任何一次 `credits_used >= 10` 都会在 `diagnostics.warnings` 里说明成本。

X 会把 `/<任意handle>/status/<id>` 重定向到真实 handle，校验按重定向后的 URL 进行。

fetch 成功输出使用 `content.text`、`content.offset`、`content.chars`（只算正文，不含提示行）、`content.original_chars`、`content.truncated`、`content.full_path`，`metadata` 归一为 `{ title, description, author, published_at, language, status, source_url }`（Firecrawl）加 Direct 的 `status / content_type / content_length / content_disposition`，provider 相关信息放在 `diagnostics`，运行记录路径在 `diagnostics.run_path`。

## Map

```bash
./scripts/map.js https://docs.example.com --limit 20
./scripts/map.js --provider direct https://docs.example.com
./scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

`--provider auto` 的 provider 顺序：

```text
Tavily Map -> Direct Map
```

两个 provider 都只返回本站、URL 路径及其下的页面，与 Firecrawl crawl 的默认范围一致；要整站就 map 站点根。Tavily 为此传 `select_paths`（如 `^/docs(/.*)?$`）和 `allow_external: false`：2026-09-28 map docs.fiat24.com/user 返回的 20 个里，4 个在 /products、/legal 下，2 个在 gitbook.com；10-10 加上这两个参数后返回 /user 下的 14 个。URL 指向文件时（如 `/docs/index.html`）取它所在的目录。

没有 `TAVILY_API_KEY` 时，Tavily Map 不可用，`map.js` 会 fallback 到 Direct Map；Tavily Map 返回空列表时也一样（显式 `--provider tavily` 时原样返回空列表并写 warning）。Direct Map 先取请求页面上的链接，再读站点 sitemap（robots.txt 声明的、`/sitemap.xml`，URL 带路径时加上 `<路径>/sitemap.xml`；sitemap 索引会展开，最多读 10 个文件）。按上述范围过滤后，被排除的数量写进 warning。请求的页面跳到别的主机或路径时（如 example.com 跳到 www.example.com），按跳转后的地址确定范围，并写 warning。它会忽略 `--instructions`，且只支持 `--max-depth 1`。

`--timeout`（默认 150 秒）是交给 Tavily Map 的远端 crawl 预算；Direct Map 自己抓 robots.txt、sitemap 和页面时每个请求用独立的 `--direct-timeout`（默认 30 秒），一个卡住的请求不会吃掉整条命令的 deadline。两个值都记录在 `diagnostics.options`。

map 成功输出使用 `urls` 表示发现的 URL。provider、response time、ignored instructions、warnings、attempts 和 options 都放在 `diagnostics`，运行记录路径在 `diagnostics.run_path`。

## 输出文件

所有脚本都会保证 stdout 是完整 JSON。长文本字段会以 preview 形式返回，完整内容写入：

```text
~/.cache/grok-search/outputs/
```

设置 `GROK_OUTPUT_DIR` 可以覆盖该路径。每次运行都会 best-effort 清理输出目录中超过 30 天的 `grok-search-*` 文件。

除 preview 溢出文件外，每次调用还会写一份运行记录 `grok-search-<ts>-run-<kind>-<label>-<rand>.json`（`schema_version: 2`，权限 0600），成功、失败、`DEADLINE_EXCEEDED` 都写；`GROK_RUN_LOG=off` 或 `runLog: false` 关闭。search 记录含脱敏 argv、query、instructions、生效 options、完整 answer、`answer_preamble`（答案标记前被切掉的过场话，没有标记时为 null）、未裁剪 sources、`grok_tool_calls`、diagnostics；fetch 记录含正文全文、metadata、provider_attempts；map 记录含 urls。记录在 stdout 截断之后才写，所以带着 agent 实际看到的 warnings，`printed_answer` / `printed_content` 记下 stdout 里正文的长度、是否截断和全文路径。`GROK_DEBUG_RAW=1` 或 `--full-sources` 时再附 `grok_raw`。

只有 preview 不够时才读取这些路径：

- `answer.full_path`：完整 search answer
- `content.full_path`：完整 fetch 页面正文
- `sources.raw_path`：search 的运行记录（完整 source 列表 / provider raw）
- `diagnostics.run_path`：fetch / map 的运行记录

## Smoke Tests

不需要 key：

```bash
./scripts/fetch.js --provider direct https://example.com
./scripts/map.js --provider direct https://example.com --limit 5
npm test
node tests/argv.test.js
```

搜索需要 Grok 配置：

```bash
export GROK_API_URL="https://your-openai-compatible-endpoint/v1"
export GROK_API_KEY="your-key"
./scripts/search.js "What changed in the latest Node.js LTS?"
```

## 常见错误

- `GROK_API_URL 未配置`：使用 `search.js` 前需要设置 `GROK_API_URL`。
- `GROK_API_KEY 未配置`：使用 `search.js` 前需要设置 `GROK_API_KEY`。
- `GROK_QUOTA_EXHAUSTED`：Grok 额度耗尽且 extra 被关闭，或 Tavily/Firecrawl 都没有返回可用降级结果。
- `GROK_RATE_LIMITED`：Grok 返回普通 429 限流（非额度信号），且没有可用降级结果。
- provider attempt 出现 `skipped: true` 与 `cooldown until …`：Firecrawl 额度耗尽后的冷却期，删除 `<stateDir>/firecrawl-cooldown.json` 或显式 `--provider firecrawl` 可强制再试。
- `TAVILY_API_KEY 未配置`：显式请求了 `--provider tavily`，但没有配置 Tavily key。
- Direct Fetch 返回二进制 / 附件错误：目标 URL 不是文本页面，或对 direct fallback 来说太大。
- Direct Map 返回很少或 0 个 URL：站点可能依赖 JavaScript、隐藏链接，或没有公开 sitemap。

## 项目边界

当前范围包括：

- `search.js`
- `search.js --extra N`
- 带 Direct Fetch fallback 的 `fetch.js`
- 带 Direct Map fallback 的 `map.js`
- 长输出 preview 和完整输出文件
- `SKILL.md`
- `references/planning.md`
- smoke / fixture tests

不在范围内：

- 浏览器渲染
- PDF / 图片 / 压缩包解析
- Cookie、登录或反爬绕过
- MCP 会话状态，例如 `get_sources`
- CLI 打包或 build 流程

## 致谢与来源

本项目参考并改造自 [GuDaStudio/GrokSearch](https://github.com/GuDaStudio/GrokSearch/)：一个基于 Python / MCP 的 Grok Search server。

感谢 GuDaStudio 提供原始项目与思路。本项目在保留核心搜索 / 抓取 / 站点映射能力的基础上，重写为更适合 agent skill 分发的 **纯 JS、脚本直跑** 形态。

本项目分享于[Linuxdo社区](https://linux.do/)。

## 协议

本项目使用 MIT 协议发布，详见 [LICENSE](LICENSE)。

原项目同样使用 MIT 协议。我们在 `LICENSE` 中保留了原项目版权声明，以遵守 MIT 协议要求。
