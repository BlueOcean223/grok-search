# 功能说明

## Search

`search.js` 只使用 Responses API：

```bash
node scripts/search.js "Node.js 当前最新的 LTS 是哪个完整版本号？哪天发布的？"
node scripts/search.js --instructions "只要官方 changelog 原文和日期" "Node.js 最新 LTS 的 changelog 改了什么？"
node scripts/search.js --responses-allowed-domains github.com "有哪些给 pi coding agent 用的搜索 skill？"
node scripts/search.js --platform GitHub "有哪些给 pi coding agent 用的搜索 skill？"
node scripts/search.js --responses-openrouter-engine exa "latest official release notes"
```

query 只发给 Grok，写成要问的问题。`--instructions` 可选，交代怎么回答，追加到 Grok 的 user message 末尾。`--responses-allowed-domains` / `--responses-excluded-domains` 作为 `filters` 传给 Grok 的 `web_search`。

默认 Responses 参数：

- model：`grok-4.3`
- `max_turns=3`
- `reasoning.effort=low`
- xAI/openai-compatible：按 `--source` 挂 `web_search` / `x_search`，默认只挂 `web_search`
- OpenRouter：`openrouter:web_search`

### 检索源

```bash
node scripts/search.js --source x "X 上怎么评价 grok-4.6"
node scripts/search.js --source both "grok-4.6 发布后的反响"
node scripts/search.js --source x --x-from-date 2026-08-01 "query"
node scripts/search.js --responses-x-search "query"   # 等价 --source both
```

`web` / `x` / `both` 三档决定挂哪些工具。启用 X 时会追加一条 X 证据准则 system message（署名 handle + 日期、区分声称与证实、热度不等于真实性、约 4 次 X 检索预算），基础 prompt 仍是第一条以保持 cache 前缀稳定。详见 `responses-mode.md`。

Grok 的来源去重后写入 `sources.items`（默认最多 12 条，`--max-sources` 可调；`sources.omitted` 标记裁剪量），每条可能包含：

- `source_type: citation | searched`。`citation` 是回答里引用的来源：行内引用，或回答正文里写出的链接 / 裸 URL（代码里的不算）。回答没有行内引用时，xAI 会把检索到的全部页面作为起止位置为 0、标题就是 URL 的 annotation 附上，这批算 `searched`
- `opened: true`（Grok 通过 `open_page` 成功读过的页面；只有 web 路径有 trace）
- `tool: web_search | x_search | openrouter:web_search`
- `x_handle` / `x_post_id`（X 来源专有，从 URL 解析；同一条 X 帖子的 `/i/status/<id>` 与 `/<handle>/status/<id>` 按帖子 id 合并成一张卡片，handle 补到卡片上）

超出上限时按 citation > opened > searched 挑选，同类按响应里的顺序，输出保持原顺序。序号标题（`"1"`、`[2]`）视为缺失，由 Grok 检索列表里的真标题替换；没有真标题时不输出 `title`。

### 已删除：Tavily / Firecrawl 补充信源

2026-10-19 之前，Tavily Search 与 Firecrawl Search 会用同一个 query 与 Grok 并行检索，结果作为额外卡片合并进 `sources.items`，Grok 额度耗尽时还会降级成它们的原始结果。一个月的真实会话（245 次搜索）里，agent 只用到 10 个只来自它们的网址，降级一次都没发生，它们每月还占约 470 Firecrawl credits。删掉之后 `--extra` / `--no-extra` 成为未知参数，Grok 失败一律报错（额度耗尽 `GROK_QUOTA_EXHAUSTED`，限流 `GROK_RATE_LIMITED`）。

## Fetch

```bash
node scripts/fetch.js https://example.com
node scripts/fetch.js --provider firecrawl https://example.com
node scripts/fetch.js --provider direct https://example.com
node scripts/fetch.js --offset 12000 https://example.com
```

`auto` provider 顺序：

```text
Direct（请求 Markdown）→ Firecrawl Scrape → Tavily Extract → 第一步的 Direct 文本 → DeepSeek Fetch（仅当 Direct 没拿到页面）
```

Firecrawl 无 key 时走 Keyless；带 key 时自动发送 Bearer token。当前模式写入 `diagnostics.firecrawl_auth_mode`。

第一步 Direct 带 `Accept: text/markdown` 请求，返回的不是 HTML 就原样采用，包括内容协商得到的 Markdown、纯文本文件（按声明的字符集解码；解码不成的交给后面的 provider）和 JSON（重新缩进）（记录里 153 个 HTML URL 有 45 个返回了 Markdown）。这一步超时 15 秒（同天对比的 60 个 HTML 页面里 Direct 最慢 6.3 秒）。HTML 页先给 Firecrawl，失败、限流或目标页状态码 ≥ 400 时再给 Tavily。Firecrawl 在前的依据是 60 页对比：人工核对后 Tavily 约 20 页缺正文（GitHub issue 页全部缺评论），Firecrawl 1 页。X 页面让 Tavily 在前，因为 Firecrawl 抓一条约 30 credits。

Direct 请求失败或只拿到标题时，最后再试 DeepSeek Fetch（需 `DEEPSEEK_API_KEY`，X 跳过）。60 个真实 HTML 页面的对比里它拿到正文 32 页、Direct 42 页，另有 11 页只给登录页或标题，中位 6 秒，所以只做最后一道；`--provider deepseek` 可直接用，例如微信公众号文章。它的 Markdown 转义了全部 ASCII 标点，脚本会还原。

Firecrawl 返回的目标页状态码 ≥ 400 时按失败处理，交给下一个 provider（记录在案的 7 次都是错误页）。`final_url` / `redirected` 来自 Firecrawl 的 `metadata.url` 或 Direct 的最终响应；带路径的 URL 落在站点首页时，`content.text` 开头和 warnings 里都会写明（gov.cn 用脚本把已删除的页面跳回首页，Firecrawl 跟过去后报 200）。

预览默认 12000 字符。正文被截断时，`content.text` 最后一行是 `[grok-search]` 提示，给出下一段的 `--offset` 和全文路径；跳到首页、Direct 只拿到标题、X 页面未通过校验也会在 `content.text` 开头写一行 `[grok-search]`。这些提示同时保留在 `diagnostics.warnings` 里，因为 agent 常常只打印 `content.text`。

同一 URL 15 分钟内再抓读本地缓存（`<stateDir>/fetch-cache/`），不请求 provider：`auto` 只复用 `auto` 的结果，显式 provider 复用该 provider 的结果；失败和回退结果（Firecrawl 或 Tavily 失败后才拿到的结果、两家都失败后用的 Direct 文本）都不缓存，`--no-cache` 强制重抓，命中时有 `diagnostics.cache`。截断提示写缓存剩余分钟数，续读复用第一次写出的全文文件；`--offset` 用在新抓取上时，开头提示偏移量可能对不上。

X 原帖在 `auto` 下不论 key 都先走 Direct（校验 handle、日期、正文；只有主帖）；要 thread、ISO 时间戳、互动数时显式 `--provider firecrawl`（约 30 credits）。单次 `credits_used >= 10` 会在 warnings 中说明成本。额度耗尽后进入冷却，auto 模式跳过 Firecrawl 直到 `retry_after_seconds` 到期。

`metadata` 归一为 `{ title, description, author, published_at, language, status, source_url }`；运行记录路径在 `diagnostics.run_path`。

## Map

```bash
node scripts/map.js https://docs.example.com --limit 20
node scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
node scripts/map.js --provider direct https://docs.example.com --direct-timeout 10   # Direct Map 每个请求的超时，独立于 Tavily 的 --timeout
```

`auto` provider 顺序：

```text
Tavily Map → Direct Map
```

两个 provider 都只返回本站、URL 路径及其下的页面（Firecrawl crawl 的默认范围）：Tavily 传 `select_paths` 和 `allow_external: false`，Direct 自己过滤。URL 指向文件（如 `/docs/index.html`）时取所在目录；页面跳到别的主机或路径时，Direct 按跳转后的地址确定范围。要整站就 map 站点根。

Tavily Map 返回空列表时 `auto` 也交给 Direct Map；显式 `--provider tavily` 原样返回并写 warning。Direct Map 取请求页面的链接和站点 sitemap（robots.txt 声明的、`/sitemap.xml`、`<路径>/sitemap.xml`，索引展开）。2026-10-10 map www.compshare.cn/docs 时，旧做法返回整站 sitemap 的前 200 个，179 个在 /images、4 个在 /docs；现在返回 /docs 下的 5 个，并提示另有 888 个站内 URL 被排除。

## 核心配置

| 变量 | 用途 |
| --- | --- |
| `GROK_API_URL` | 支持 `/responses` 的 base URL |
| `GROK_API_KEY` | 对应 endpoint 的 API key |
| `GROK_API_PROVIDER` | `xai`、`openrouter` 或 `openai-compatible` |
| `GROK_MODEL` | 默认 `grok-4.3` |
| `GROK_RESPONSES_MAX_TURNS` | 默认 `3` |
| `GROK_RESPONSES_REASONING_EFFORT` | 默认 `low` |
| `GROK_RESPONSES_PARALLEL_TOOL_CALLS` | `true` / `false`，默认不发；`false` 在透传的中转上把 X 搜索压到每 turn 一次 |
| `GROK_RESPONSES_ALLOWED_DOMAINS` | Web Search allow-list，最多 5 个 |
| `GROK_RESPONSES_EXCLUDED_DOMAINS` | Web Search deny-list，最多 5 个 |
| `GROK_SEARCH_SOURCE` | 默认检索源 `web` / `x` / `both`，默认 `web` |
| `GROK_RESPONSES_INCLUDE_X_SEARCH` | 已移除；为 `true` 时报 `CONFIG_OPTION_REMOVED`，改用 `GROK_SEARCH_SOURCE=both` |
| `GROK_RESPONSES_ALLOWED_X_HANDLES` | X handle allow-list，最多 20 个 |
| `GROK_RESPONSES_EXCLUDED_X_HANDLES` | X handle deny-list，最多 20 个 |
| `GROK_X_IMAGE_UNDERSTANDING` | 分析 X 帖子图片，按 token 计费 |
| `GROK_X_VIDEO_UNDERSTANDING` | 分析 X 帖子视频，按 token 计费 |
| `GROK_RESPONSES_OPENROUTER_ENGINE` | OpenRouter search engine，默认 `auto` |
| `TAVILY_API_KEY` | Tavily Extract/Map |
| `DEEPSEEK_API_KEY` | DeepSeek Fetch（auto 最后一道、`--provider deepseek`） |
| `FIRECRAWL_API_KEY` | 可选；提高 Firecrawl 限流并使用账户额度 |
| `GROK_OUTPUT_DIR` | 完整输出与运行记录目录 |
| `GROK_STATE_DIR` | 冷却状态和 fetch 缓存目录，默认 `~/.cache/grok-search/` |
| `GROK_RUN_LOG` | 默认开；`off` 关闭运行记录 |
| `GROK_DEBUG_RAW` | `1` 时运行记录附带脱敏 Grok 原始响应 |
| `GROK_PROXY` | 本工具专用代理 |

## 输出文件与边界

长输出通过 `answer.full_path`、`content.full_path` 引用；整个 stdout JSON 不超过 45KB（`STDOUT_BUDGET_BYTES`，按 UTF-8 字节算，pi 的 bash 工具只保留最后 50KB），超出时截短 `answer.text` / `content.text`，正文末尾写一行 `[grok-search]` 提示并写 warning；每次调用的运行记录通过 `sources.raw_path`（search）或 `diagnostics.run_path`（fetch / map）引用。项目不实现登录、cookie 管理、CAPTCHA 绕过、代理池或本地浏览器自动化。

相关阅读：[Responses 搜索协议](responses-mode.md)、[架构说明](architecture.md)。
