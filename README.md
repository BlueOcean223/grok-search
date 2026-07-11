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
  "responsesIncludeXSearch": false,
  "responsesAllowedXHandles": [],
  "responsesExcludedXHandles": [],
  "responsesOpenRouterEngine": "auto",
  "defaultExtra": 6,
  "sourceChars": 400,
  "tavilyApiKey": "",
  "tavilyApiUrl": "https://api.tavily.com",
  "firecrawlApiKey": "",
  "firecrawlApiUrl": "https://api.firecrawl.dev/v2",
  "outputDir": ""
}
```

常见填写规则：

- `apiUrl` 填支持 `/responses` 的 API base URL；脚本会请求 `{apiUrl}/responses`，不要把 `/responses` 本身写进去。
- `apiProvider` 一次只能填写一个值：
  - `xai`：xAI 官方接口，使用 `web_search`，并可启用 `x_search`。
  - `openrouter`：OpenRouter 接口，改用 `openrouter:web_search`；可通过 `responsesOpenRouterEngine` 选择搜索引擎。
  - `openai-compatible`：支持 xAI 风格 Responses 与 `web_search` tool 的中转、反代或兼容服务。仅支持 Chat Completions 的接口不能使用。
- `apiProvider` 省略时会按 URL 推断：包含 `openrouter` 视为 `openrouter`，包含 `api.x.ai` 视为 `xai`，其他 URL 视为 `openai-compatible`。中转服务建议显式填写，避免请求格式判断错误。
- `model` 必须填写该 endpoint 实际支持的模型 ID；`responsesMaxTurns` 是不小于 1 的整数。`responsesReasoningEffort` 常见值为 `low`、`medium`、`high`，但是否支持取决于具体模型与 provider。
- `responsesAllowedDomains`、`responsesExcludedDomains`、`responsesAllowedXHandles`、`responsesExcludedXHandles` 都是数组，可以填写多个值，例如 `["github.com", "docs.python.org"]`；同一组 allowed 与 excluded 不能同时使用。环境变量中的多值使用逗号分隔。
- `responsesOpenRouterEngine` 可选 `auto`、`native`、`exa`、`firecrawl`、`parallel` 或 `perplexity`，仅在 `apiProvider` 为 `openrouter` 时生效。
- `tavilyApiKey` 可留空；`firecrawlApiKey` 也可留空并使用 Firecrawl Keyless。`outputDir` 留空时使用默认目录 `~/.cache/grok-search/outputs/`。

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
- `GROK_PROXY`：显式给本工具指定一个代理 URL；设为 `GROK_PROXY=off` 可强制直连

`NO_PROXY` 会被尊重，并且会始终把回环地址（`localhost`、`127.0.0.1`、`::1`）加入绕过列表。

| 环境变量 | 配置文件 key | 是否必需 | 用途 | 说明 |
| --- | --- | --- | --- | --- |
| `GROK_API_URL` | `apiUrl` | search 必需 | `search.js` | 支持 `/responses` 的 base URL。 |
| `GROK_API_KEY` | `apiKey` | search 必需 | `search.js` | `GROK_API_URL` 对应的 API key。 |
| `GROK_API_PROVIDER` | `apiProvider` | 否 | `search.js` | 选择 Responses tool 请求格式，而不是额外的搜索源；可选 `xai`、`openrouter` 或 `openai-compatible`。未配置时按 URL 推断。 |
| `GROK_MODEL` | `model` | 否 | `search.js` | 默认 `grok-4.3`。 |
| `GROK_RESPONSES_MAX_TURNS` | `responsesMaxTurns` | 否 | Responses | 默认 `3`，控制 Responses agentic turn 上限。 |
| `GROK_RESPONSES_REASONING_EFFORT` | `responsesReasoningEffort` | 否 | Responses | 默认 `low`。 |
| `GROK_RESPONSES_ALLOWED_DOMAINS` | `responsesAllowedDomains` | 否 | Responses | 逗号分隔 domain allow-list，最多 5 个；与 excluded 互斥。 |
| `GROK_RESPONSES_EXCLUDED_DOMAINS` | `responsesExcludedDomains` | 否 | Responses | 逗号分隔 domain deny-list，最多 5 个；与 allowed 互斥。 |
| `GROK_RESPONSES_INCLUDE_X_SEARCH` | `responsesIncludeXSearch` | 否 | Responses | 是否启用 direct xAI `x_search`。默认 `false`。 |
| `GROK_RESPONSES_ALLOWED_X_HANDLES` | `responsesAllowedXHandles` | 否 | Responses | X handle allow-list；与 excluded 互斥。 |
| `GROK_RESPONSES_EXCLUDED_X_HANDLES` | `responsesExcludedXHandles` | 否 | Responses | X handle deny-list；与 allowed 互斥。 |
| `GROK_RESPONSES_OPENROUTER_ENGINE` | `responsesOpenRouterEngine` | 否 | OpenRouter Responses | `auto`、`native`、`exa`、`firecrawl`、`parallel` 或 `perplexity`。默认 `auto`。 |
| `GROK_DEFAULT_EXTRA` | `defaultExtra` | 否 | `search.js` | Tavily 与 Firecrawl 合计的默认 extra source 数量。默认 `6`。 |
| `GROK_SOURCE_CHARS` | `sourceChars` | 否 | `search.js` | 每条 source stdout snippet 长度。默认 `400`；`0` 表示不输出 snippet。 |
| `TAVILY_API_KEY` | `tavilyApiKey` | 否 | `search.js`、`fetch.js`、`map.js` | 启用 Tavily Search / Extract / Map。没有它时，search/fetch 仍可使用 Firecrawl Keyless，map 使用 Direct Map。 |
| `TAVILY_API_URL` | `tavilyApiUrl` | 否 | Tavily 路径 | 默认 `https://api.tavily.com`。 |
| `FIRECRAWL_API_KEY` | `firecrawlApiKey` | 否 | `search.js`、`fetch.js` | 可选。未配置时使用 Firecrawl Keyless；配置后使用独立账户额度和更高限流。 |
| `FIRECRAWL_API_URL` | `firecrawlApiUrl` | 否 | Firecrawl 路径 | 默认 `https://api.firecrawl.dev/v2`。 |
| `GROK_OUTPUT_DIR` | `outputDir` | 否 | 所有脚本 | 覆盖长输出落盘目录。默认 `~/.cache/grok-search/outputs/`。 |
| `GROK_DEBUG` | — | 否 | 所有脚本 | 仅环境变量。设为 `true` 时把重试 / 清理 / 代理调试日志写到 stderr。 |
| `GROK_PROXY` | — | 否 | 所有脚本 | 仅环境变量。显式代理 URL，或设为 `off` / `direct` 禁用代理。 |

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
./scripts/search.js --platform GitHub "pi coding agent search skill"
./scripts/search.js --extra 10 "latest pi coding agent docs"
./scripts/search.js --no-extra "query"
./scripts/search.js --source-chars 200 "query"
./scripts/search.js --full-sources "debug provider raw"
./scripts/search.js --responses-openrouter-engine exa "strict web-only query"
./scripts/search.js --responses-x-search --responses-allowed-x-handles xai,OpenAI "query"
```

`search.js` 只使用 Responses 协议，以 `stream:false` 调用 `{GROK_API_URL}/responses`，启用 provider-native web search，并返回：

- `answer.text`、`answer.chars`、`answer.original_chars`、`answer.truncated`、`answer.full_path`
- `sources.grok`、`sources.extra`、`sources.merged` 短 source card
- `sources.raw_path`，在完整 source / provider raw 落盘时出现
- `sources.raw`，仅在使用 `--full-sources` 时出现
- `diagnostics.grok_endpoint`、`diagnostics.usage` / `diagnostics.cost_usd`（provider 返回时）、`diagnostics.responses_*`、`diagnostics.warnings`、`diagnostics.provider_attempts`、`diagnostics.options`、`diagnostics.searched_at`

默认会同时发起 Grok Responses、Tavily Search（配置 key 时）和 Firecrawl Search。三路并行，Tavily/Firecrawl 结果始终作为独立补充信源，不会注入 Grok input。

`--extra N` 表示 Tavily 与 Firecrawl 合计的结果目标数，默认 `6`。两家都可用时平均分配，奇数优先给 Tavily；没有 Tavily key 时全部交给 Firecrawl Keyless。`--no-extra` 会严格关闭两个外部搜索通道。

当 Grok 明确返回额度耗尽，而 extra sources 可用时，命令会返回标记为 `diagnostics.degraded: true` 的降级结果。`answer.text` 会明确说明当前仅为 Tavily/Firecrawl 原始搜索结果，`diagnostics.grok_error` 保留脱敏后的额度错误。其他认证、协议或服务错误不会被伪装成额度降级。

Firecrawl Keyless 提供每月 1,000 credits，并受按 IP 的每日限额约束。配置 `FIRECRAWL_API_KEY` 不会增加免费计划的月度 credits，但能获得更高限流、独立账户额度和更多 API 能力。

Source card 不再输出长 `description` 或 `content` 字段，只输出短 `snippet`。完整 raw 数据可通过 `sources.raw_path` 按需读取。

## Fetch

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider direct https://example.com
```

fetch 默认只返回 12,000 字符 preview。`--max-chars 50000` 应作为看过 preview 后的显式深读使用，不是常规默认。

```bash
./scripts/fetch.js --max-chars 50000 https://example.com
```

`--provider auto` 的 provider 顺序：

```text
Tavily Extract -> Firecrawl Scrape -> Direct Fetch
```

Direct Fetch 是普通 HTTP(S) 文本页面的 best-effort fallback。它会做简单 HTML 清理、尽量格式化 JSON、记录重定向，并拒绝二进制 / 附件 / 超大响应。

Firecrawl Scrape 无 key 时会使用 Keyless；配置 `FIRECRAWL_API_KEY` 后会自动发送 Bearer token。当前认证模式写入 `diagnostics.firecrawl_auth_mode`。

fetch 成功输出使用 `content.text`、`content.chars`、`content.original_chars`、`content.truncated`、`content.full_path`，provider 相关信息放在 `diagnostics`。

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

没有 `TAVILY_API_KEY` 时，Tavily Map 不可用，`map.js` 会 fallback 到 Direct Map。Direct Map 只检查同站点 `/sitemap.xml`，然后提取首页同域名链接。它会忽略 `--instructions`，且只支持 `--max-depth 1`。

map 成功输出使用 `urls` 表示发现的 URL。provider、response time、ignored instructions、warnings、attempts 和 options 都放在 `diagnostics`。

## 输出文件

所有脚本都会保证 stdout 是完整 JSON。长文本字段会以 preview 形式返回，完整内容写入：

```text
~/.cache/grok-search/outputs/
```

设置 `GROK_OUTPUT_DIR` 可以覆盖该路径。每次运行都会 best-effort 清理输出目录中超过 30 天的 `grok-search-*` 文件。

只有 preview 不够时才读取这些路径：

- `answer.full_path`：完整 search answer
- `content.full_path`：完整 fetch 页面正文
- `sources.raw_path`：完整 source / provider raw 数据

## Smoke Tests

不需要 key：

```bash
./scripts/fetch.js --provider direct https://example.com
./scripts/map.js --provider direct https://example.com --limit 5
node tests/sources.test.js
node tests/proxy.test.js
node tests/responses.test.js
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
