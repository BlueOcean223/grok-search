# 功能说明

## Search

`search.js` 只使用 Responses API：

```bash
./scripts/search.js "latest Node.js LTS"
./scripts/search.js --instructions "只要官方 changelog 原文和日期" "node lts changelog"
./scripts/search.js --responses-allowed-domains github.com "pi coding agent search skill"
./scripts/search.js --platform GitHub "pi coding agent search skill"
./scripts/search.js --extra 10 "latest AI model release notes"
./scripts/search.js --no-extra "only use Grok Responses"
./scripts/search.js --responses-openrouter-engine exa "latest official release notes"
```

`--instructions` 把研究指令与检索关键词分开：query 由 Tavily / Firecrawl 原样检索，指令只追加到 Grok 的 user message 末尾。`--responses-allowed-domains` / `--responses-excluded-domains` 同时约束 Grok、Tavily、Firecrawl，域外 extra 降到最后一档。

默认 Responses 参数：

- model：`grok-4.3`
- `max_turns=3`
- `reasoning.effort=low`
- xAI/openai-compatible：按 `--source` 挂 `web_search` / `x_search`，默认只挂 `web_search`
- OpenRouter：`openrouter:web_search`

### 检索源

```bash
./scripts/search.js --source x "X 上怎么评价 grok-4.6"
./scripts/search.js --source both "grok-4.6 发布后的反响"
./scripts/search.js --source x --x-from-date 2026-08-01 "query"
./scripts/search.js --responses-x-search "query"   # 等价 --source both
```

`web` / `x` / `both` 三档决定挂哪些工具。启用 X 时会追加一条 X 证据准则 system message（署名 handle + 日期、区分声称与证实、热度不等于真实性、约 4 次 X 检索预算），基础 prompt 仍是第一条以保持 cache 前缀稳定。详见 `responses-mode.md`。

Responses sources 与 extra sources 去重合并后写入 `sources.items`（默认最多 12 条，`--max-sources` 可调；`sources.omitted` 标记裁剪量），每条可能包含：

- `source_type: citation | searched`（extra provider 的结果没有该字段）。`citation` 是回答里引用的来源：行内引用，或回答正文里写出的链接 / 裸 URL（代码里的不算）。回答没有行内引用时，xAI 会把检索到的全部页面作为起止位置为 0、标题就是 URL 的 annotation 附上，这批算 `searched`
- `opened: true`（Grok 通过 `open_page` 成功读过的页面；只有 web 路径有 trace）
- `merged_from`（同一 URL 跨通道合并时列出补充字段的 provider；同一条 X 帖子的 `/i/status/<id>` 与 `/<handle>/status/<id>` 按帖子 id 合并成一张卡片，handle 补到卡片上）
- `tool: web_search | x_search | openrouter:web_search`
- `x_handle` / `x_post_id`（X 来源专有，从 URL 解析）

超出上限时用 Reciprocal Rank Fusion（RRF，k=60）合并 Grok 与 Tavily、Firecrawl 的结果列表后取前 N 条。Grok 列表内按 citation > opened > searched 排，两家各按自己返回的顺序；多路都返回的 URL 每一路都计分；域外 extra 排在最后。原先 Grok 的卡片一律排在 extra 前面，2026-10-10 统计运行记录：182 次带 extra 的搜索里有 44 次 extra 一张都没进卡片，多数是答案引用了 12 个以上链接，而这些链接本来就在 `answer.text` 里。改用 RRF 后这类情况为 0 次，卡片 JSON 平均多约 0.7KB，最大值不变。序号标题（`"1"`、`[2]`）视为缺失，由检索列表里的真标题替换；没有真标题时不输出 `title`。

### 独立补充信源

默认还会并行执行：

- Tavily Advanced Search：仅在配置 `TAVILY_API_KEY` 时。
- Firecrawl Search：默认 Keyless，配置 `FIRECRAWL_API_KEY` 后使用 API key。

`--extra N` 是两家合计数量，默认 6。两家可用时 `N=6` 分为 3/3，`N=5` 分为 Tavily 3、Firecrawl 2。某一路失败后不追加第二轮补齐请求。Firecrawl 处于额度冷却期时被跳过（attempt 记 `skipped: true`），名额转给 Tavily。`--source x` 下两家默认关闭（`extra_mode: off-x-only`），显式 `--extra N` 开启。

这些来源不会注入 Grok，也不代表 Grok 使用过它们。

### 额度降级

Grok 明确额度耗尽且 extra sources 可用时，输出仍成功，但：

- `answer.text` 开头有明显警告。
- 回答正文是 Tavily/Firecrawl 原始标题、URL、摘要列表。
- `diagnostics.degraded=true`。
- `diagnostics.grok_error.code=QUOTA_EXHAUSTED`（普通 429 限流为 `RATE_LIMITED`）。
- `sources.items` 中只有 Tavily/Firecrawl 结果。

`--no-extra` 会禁止这种接管。认证、协议、5xx 和超时错误也不会触发额度降级。

## Fetch

```bash
./scripts/fetch.js https://example.com
./scripts/fetch.js --provider firecrawl https://example.com
./scripts/fetch.js --provider direct https://example.com
./scripts/fetch.js --offset 12000 https://example.com
```

`auto` provider 顺序：

```text
Direct（请求 Markdown）→ Firecrawl Scrape → Tavily Extract → 第一步的 Direct 文本
```

Firecrawl 无 key 时走 Keyless；带 key 时自动发送 Bearer token。当前模式写入 `diagnostics.firecrawl_auth_mode`。

第一步 Direct 带 `Accept: text/markdown` 请求，返回的不是 HTML 就原样采用，包括内容协商得到的 Markdown、纯文本文件（逐字节保留）和 JSON（重新缩进）（记录里 153 个 HTML URL 有 45 个返回了 Markdown）。HTML 页先给 Firecrawl，失败、限流或目标页状态码 ≥ 400 时再给 Tavily。Firecrawl 在前的依据是 60 页对比：人工核对后 Tavily 约 20 页缺正文（GitHub issue 页全部缺评论），Firecrawl 1 页。X 页面让 Tavily 在前，因为 Firecrawl 抓一条约 30 credits。

Firecrawl 返回的目标页状态码 ≥ 400 时按失败处理，交给下一个 provider（记录在案的 7 次都是错误页）。`final_url` / `redirected` 来自 Firecrawl 的 `metadata.url` 或 Direct 的最终响应；带路径的 URL 落在站点首页时，`content.text` 开头和 warnings 里都会写明（gov.cn 用脚本把已删除的页面跳回首页，Firecrawl 跟过去后报 200）。

预览默认 12000 字符。正文被截断时，`content.text` 最后一行是 `[grok-search]` 提示，给出下一段的 `--offset` 和全文路径；跳到首页、Direct 只拿到标题、X 页面未通过校验也会在 `content.text` 开头写一行 `[grok-search]`。这些提示同时保留在 `diagnostics.warnings` 里，因为 agent 常常只打印 `content.text`。

同一 URL 15 分钟内再抓读本地缓存（`<stateDir>/fetch-cache/`），不请求 provider：`auto` 只复用 `auto` 的结果，显式 provider 复用该 provider 的结果；失败不缓存，`--no-cache` 强制重抓，命中时有 `diagnostics.cache`。

X 原帖在 `auto` 下不论 key 都先走 Direct（校验 handle、日期、正文；只有主帖）；要 thread、ISO 时间戳、互动数时显式 `--provider firecrawl`（约 30 credits）。单次 `credits_used >= 10` 会在 warnings 中说明成本。额度耗尽后进入冷却，auto 模式跳过 Firecrawl 直到 `retry_after_seconds` 到期。

`metadata` 归一为 `{ title, description, author, published_at, language, status, source_url }`；运行记录路径在 `diagnostics.run_path`。

## Map

```bash
./scripts/map.js https://docs.example.com --limit 20
./scripts/map.js https://docs.example.com --instructions "only API reference pages" --max-depth 2
./scripts/map.js --provider direct https://docs.example.com --direct-timeout 10   # Direct Map 每个请求的超时，独立于 Tavily 的 --timeout
```

`auto` provider 顺序：

```text
Tavily Map → Direct Map
```

两个 provider 都只返回本站、URL 路径及其下的页面（Firecrawl crawl 的默认范围）：Tavily 传 `select_paths` 和 `allow_external: false`，Direct 自己过滤。要整站就 map 站点根。

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
| `GROK_DEFAULT_EXTRA` | Tavily/Firecrawl 合计默认数量，默认 `6` |
| `TAVILY_API_KEY` | Tavily Search/Extract/Map |
| `FIRECRAWL_API_KEY` | 可选；提高 Firecrawl 限流并使用账户额度 |
| `GROK_OUTPUT_DIR` | 完整输出与运行记录目录 |
| `GROK_STATE_DIR` | 冷却状态和 fetch 缓存目录，默认 `~/.cache/grok-search/` |
| `GROK_RUN_LOG` | 默认开；`off` 关闭运行记录 |
| `GROK_DEBUG_RAW` | `1` 时运行记录附带脱敏 Grok 原始响应 |
| `GROK_PROXY` | 本工具专用代理 |

## 输出文件与边界

长输出通过 `answer.full_path`、`content.full_path` 引用；整个 stdout JSON 不超过 45KB（`STDOUT_BUDGET_BYTES`，按 UTF-8 字节算，pi 的 bash 工具只保留最后 50KB），超出时截短 `answer.text` / `content.text`，正文末尾写一行 `[grok-search]` 提示并写 warning；每次调用的运行记录通过 `sources.raw_path`（search）或 `diagnostics.run_path`（fetch / map）引用。项目不实现登录、cookie 管理、CAPTCHA 绕过、代理池或本地浏览器自动化。

相关阅读：[Responses 搜索协议](responses-mode.md)、[架构说明](architecture.md)。
