# 功能说明

## Search

`search.js` 只使用 Responses API：

```bash
./scripts/search.js "latest Node.js LTS"
./scripts/search.js --platform GitHub "pi coding agent search skill"
./scripts/search.js --extra 10 "latest AI model release notes"
./scripts/search.js --no-extra "only use Grok Responses"
./scripts/search.js --responses-x-search --responses-allowed-x-handles xai,OpenAI "latest xAI news"
./scripts/search.js --responses-openrouter-engine exa "latest official release notes"
```

默认 Responses 参数：

- model：`grok-4.3`
- `max_turns=3`
- `reasoning.effort=low`
- xAI/openai-compatible：`web_search`
- OpenRouter：`openrouter:web_search`

Responses sources 写入 `sources.grok`，可能包含：

- `source_type: citation | searched`
- `tool: web_search | x_search | openrouter:web_search`

### 独立补充信源

默认还会并行执行：

- Tavily Advanced Search：仅在配置 `TAVILY_API_KEY` 时。
- Firecrawl Search：默认 Keyless，配置 `FIRECRAWL_API_KEY` 后使用 API key。

`--extra N` 是两家合计数量，默认 6。两家可用时 `N=6` 分为 3/3，`N=5` 分为 Tavily 3、Firecrawl 2。某一路失败后不追加第二轮补齐请求。

这些来源不会注入 Grok，也不代表 Grok 使用过它们。

### 额度降级

Grok 明确额度耗尽且 extra sources 可用时，输出仍成功，但：

- `answer.text` 开头有明显警告。
- 回答正文是 Tavily/Firecrawl 原始标题、URL、摘要列表。
- `diagnostics.degraded=true`。
- `diagnostics.grok_error.code=QUOTA_EXHAUSTED`。
- `sources.grok=[]`。

`--no-extra` 会禁止这种接管。认证、协议、5xx 和超时错误也不会触发额度降级。

## Fetch

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider firecrawl https://example.com
./scripts/fetch.js --provider direct https://example.com
./scripts/fetch.js --max-chars 50000 https://example.com
```

`auto` provider 顺序：

```text
Tavily Extract → Firecrawl Scrape → Direct Fetch
```

Firecrawl 无 key 时走 Keyless；带 key 时自动发送 Bearer token。当前模式写入 `diagnostics.firecrawl_auth_mode`。

## Map

```bash
./scripts/map.js https://docs.example.com --limit 20
./scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
```

`auto` provider 顺序：

```text
Tavily Map → Direct Map
```

Direct Map 只检查 `/sitemap.xml` 和首页同域链接。

## 核心配置

| 变量 | 用途 |
| --- | --- |
| `GROK_API_URL` | 支持 `/responses` 的 base URL |
| `GROK_API_KEY` | 对应 endpoint 的 API key |
| `GROK_API_PROVIDER` | `xai`、`openrouter` 或 `openai-compatible` |
| `GROK_MODEL` | 默认 `grok-4.3` |
| `GROK_RESPONSES_MAX_TURNS` | 默认 `3` |
| `GROK_RESPONSES_REASONING_EFFORT` | 默认 `low` |
| `GROK_RESPONSES_ALLOWED_DOMAINS` | Web Search allow-list，最多 5 个 |
| `GROK_RESPONSES_EXCLUDED_DOMAINS` | Web Search deny-list，最多 5 个 |
| `GROK_RESPONSES_INCLUDE_X_SEARCH` | 启用 xAI `x_search` |
| `GROK_RESPONSES_OPENROUTER_ENGINE` | OpenRouter search engine，默认 `auto` |
| `GROK_DEFAULT_EXTRA` | Tavily/Firecrawl 合计默认数量，默认 `6` |
| `TAVILY_API_KEY` | Tavily Search/Extract/Map |
| `FIRECRAWL_API_KEY` | 可选；提高 Firecrawl 限流并使用账户额度 |
| `GROK_OUTPUT_DIR` | 完整输出目录 |
| `GROK_PROXY` | 本工具专用代理 |

## 输出文件与边界

长输出通过 `answer.full_path`、`content.full_path`、`sources.raw_path` 引用。项目不实现登录、cookie 管理、CAPTCHA 绕过、代理池或本地浏览器自动化。

相关阅读：[Responses 搜索协议](responses-mode.md)、[架构说明](architecture.md)。
