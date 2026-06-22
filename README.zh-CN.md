# grok-search

[English](README.md) | **简体中文**

`grok-search` 是一个通用的 AI agent skill / 脚本包，用轻量 Node.js 脚本提供三类网络访问能力：

- **Search**：调用 Grok / OpenRouter / OpenAI 兼容接口进行联网搜索，并提取信源。
- **Fetch**：抓取指定 URL 的可读内容，优先使用 Tavily / Firecrawl，最后 fallback 到无 key 的 Direct Fetch。
- **Map**：发现站点内的候选页面 URL，优先使用 Tavily Map，最后 fallback 到轻量 Direct Map。

## 为什么是 Skill + scripts

- 不把搜索工具常驻塞进模型工具列表。
- 不依赖 MCP 会话状态，例如 `get_sources`。
- 使用一个聚焦的运行时依赖（`undici`）提供支持代理的 HTTP 传输。
- 每个脚本都稳定输出 JSON，便于 agent 解析。
- 同一套 `SKILL.md` + `scripts/` 可以用于 pi，也可以被其他支持 skill/shell 的 agent harness 复用。

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

然后编辑复制过去的文件，填入真实 key。环境变量仍然优先于配置文件，适合临时覆盖或 CI 使用。

本项目**不会自动加载 `.env` 文件**。如果你想用环境变量，请自己在 shell 里 export。

### 代理

Node 原生 `fetch` 默认不会可靠地读取终端代理变量。本项目会在检测到代理环境变量时自动安装 `undici` 的 `EnvHttpProxyAgent`，让所有出站请求走你的终端代理配置。

支持的变量：

- `HTTP_PROXY` / `http_proxy`
- `HTTPS_PROXY` / `https_proxy`
- `ALL_PROXY` / `all_proxy`
- `NO_PROXY` / `no_proxy`
- `GROK_PROXY`：显式给本工具指定一个代理 URL；设为 `GROK_PROXY=off` 可强制直连

`NO_PROXY` 会被尊重，并且会始终把回环地址（`localhost`、`127.0.0.1`、`::1`）加入绕过列表。

| 环境变量 | 配置文件 key | 是否必需 | 用途 | 说明 |
| --- | --- | --- | --- | --- |
| `GROK_API_URL` | `apiUrl` | search 必需 | `search.js` | 支持 `/chat/completions` 的 OpenAI 兼容 base URL。 |
| `GROK_API_KEY` | `apiKey` | search 必需 | `search.js` | `GROK_API_URL` 对应的 API key。 |
| `GROK_MODEL` | `model` | 否 | `search.js` | 默认 `grok-4-fast`。 |
| `GROK_DEFAULT_EXTRA` | `defaultExtra` | 否 | `search.js` | 配置 Tavily 或 Firecrawl 后的默认 extra source 数量。默认 `5`。 |
| `GROK_SOURCE_CHARS` | `sourceChars` | 否 | `search.js` | 每条 source stdout snippet 长度。默认 `400`；`0` 表示不输出 snippet。 |
| `TAVILY_API_KEY` | `tavilyApiKey` | 否 | `search.js`、`fetch.js`、`map.js` | 启用 Tavily Search/Extract/Map。没有它时，`fetch.js` 和 `map.js` 会走 direct fallback。 |
| `TAVILY_API_URL` | `tavilyApiUrl` | 否 | Tavily 路径 | 默认 `https://api.tavily.com`。 |
| `FIRECRAWL_API_KEY` | `firecrawlApiKey` | 否 | `search.js`、`fetch.js` | 启用 Firecrawl Scrape fallback 和额外搜索信源。 |
| `FIRECRAWL_API_URL` | `firecrawlApiUrl` | 否 | Firecrawl 路径 | 默认 `https://api.firecrawl.dev/v2`。 |
| `GROK_OUTPUT_DIR` | `outputDir` | 否 | 所有脚本 | 覆盖长输出落盘目录。默认 `~/.cache/grok-search/outputs/`。 |
| `GROK_DEBUG` | — | 否 | 所有脚本 | 仅环境变量。设为 `true` 时把重试/清理/代理调试日志写到 stderr。 |
| `GROK_PROXY` | — | 否 | 所有脚本 | 仅环境变量。显式代理 URL，或设为 `off`/`direct` 禁用代理。 |

如果 `GROK_API_URL` 包含 `openrouter`，模型名会自动追加 `:online`，除非模型名已经有这个后缀。

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
```

`search.js` 会以 `stream:false` 调用 `{GROK_API_URL}/chat/completions`，注入本地时间上下文，并返回：

- `answer.text`、`answer.chars`、`answer.original_chars`、`answer.truncated`、`answer.full_path`
- `sources.grok`、`sources.extra`、`sources.merged` 短 source card
- `sources.raw_path`，在完整 source/provider raw 落盘时出现
- `sources.raw`，仅在使用 `--full-sources` 时出现
- `diagnostics.warnings`、`diagnostics.provider_attempts`、`diagnostics.options`、`diagnostics.searched_at`

如果配置了 Tavily 或 Firecrawl，search 默认会自动补充小规模 extra sources；如果没有这些 key，默认 search 会保持安静，只返回 Grok answer/sources。Extra sources 是候选补充信源，不会改写 Grok 的回答。

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

Direct Fetch 是普通 HTTP(S) 文本页面的 best-effort fallback。它会做简单 HTML 清理、尽量格式化 JSON、记录重定向，并拒绝二进制/附件/超大响应。

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
- `sources.raw_path`：完整 source/provider raw 数据

## Smoke Tests

不需要 key：

```bash
./scripts/fetch.js --provider direct https://example.com
./scripts/map.js --provider direct https://example.com --limit 5
node tests/sources.test.js
node tests/proxy.test.js
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
- `TAVILY_API_KEY 未配置`：显式请求了 `--provider tavily`，但没有配置 Tavily key。
- Direct Fetch 返回二进制/附件错误：目标 URL 不是文本页面，或对 direct fallback 来说太大。
- Direct Map 返回很少或 0 个 URL：站点可能依赖 JavaScript、隐藏链接，或没有公开 sitemap。

## 范围

首版范围包括：

- `search.js`
- `search.js --extra N`
- 带 Direct Fetch fallback 的 `fetch.js`
- 带 Direct Map fallback 的 `map.js`
- 长输出 preview 和完整输出文件
- `SKILL.md`
- `references/planning.md`
- smoke/fixture tests

不在范围内：

- 浏览器渲染
- PDF/图片/压缩包解析
- Cookie、登录或反爬绕过
- MCP 会话状态，例如 `get_sources`
- CLI 打包或 build 流程

## 致谢与来源

本项目参考并改造自 [GuDaStudio/GrokSearch](https://github.com/GuDaStudio/GrokSearch/)：一个基于 Python / MCP 的 Grok Search server。

感谢 GuDaStudio 提供原始项目与思路。本项目在保留核心搜索/抓取/站点映射能力的基础上，重写为更适合 agent skill 分发的 **纯 JS、脚本直跑** 形态。

## 协议

本项目使用 MIT 协议发布，详见 [LICENSE](LICENSE)。

原项目同样使用 MIT 协议。我们在 `LICENSE` 中保留了原项目版权声明，以遵守 MIT 协议要求。
