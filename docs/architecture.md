# 架构说明

`grok-search` 用三个独立脚本给 agent 提供网络访问能力：

1. **Search**：Responses API 搜索型问答，加独立多源信源。
2. **Fetch**：抓取明确 URL 的可读正文。
3. **Map**：从站点发现候选 URL。

## 组件

```text
scripts/search.js           一张选项表 + runCommand（选项表与 runSearch 在 lib/search.js）
scripts/fetch.js            一张选项表 + runCommand；Direct（请求 Markdown，非 HTML 直接返回）→ Firecrawl Scrape → Tavily Extract → Direct 文本 → DeepSeek Fetch（Direct 没拿到页面时）
scripts/map.js              一张选项表 + runCommand；Tavily Map → Direct Map

lib/cli.js                  三条命令共用的运行器：按选项表解析 argv、生成 usage、套用配置默认值、代理、deadline、错误封装与退出码
lib/config.js               配置表（CONFIG_OPTIONS）：环境变量 > 配置文件 > 默认值
lib/proxy.js                代理 URL 解析与 undici dispatcher 设置
lib/search.js               Search 命令：选项表、runSearch（Grok 通道、卡片选取、输出、运行记录）；Grok 通道可注入
lib/grok-responses.js       Responses 请求、tool trace 与 citation 解析、最终诊断（grokSearchResult）
lib/context.js              本地时间和 platform 上下文
lib/prompts.js              system prompt 与软预算常量
lib/usage.js                usage 与费用字段
lib/providers.js            fetch / map 编排：provider 顺序、X 原帖 Direct 优先、失败接力、fallback 判定
lib/provider-result.js      每次 provider 调用的计时与 attempt 记录（timed / attemptFrom / skippedResult）
lib/http.js                 requestJson（POST JSON：重试与退避、Retry-After、脱敏）与 getText（GET 文本：超时、字节上限、charset 解码、附件判断）
lib/tavily.js               Tavily Extract / Map
lib/firecrawl.js            Firecrawl Scrape、metadata、额度判断与冷却记录
lib/deepseek.js             DeepSeek Fetch 与它的 Markdown 反转义
lib/direct-fetch.js         Direct Fetch：按 content-type 原样返回或 HTML 转文本、X 原帖校验与 Direct 优先判定
lib/direct-map.js           Direct Map：页面链接与 sitemap（robots.txt、常规位置、索引展开）
lib/html.js                 无解析器的 HTML 读取：实体、链接、可读文本
lib/map-scope.js            map 的范围：URL 的目录路径、范围判断、Tavily select_paths
lib/cooldown.js             Firecrawl 额度耗尽后的跨命令冷却状态
lib/fetch-cache.js          fetch 结果的 15 分钟跨命令缓存
lib/sources.js              来源卡片：统一构造器 sourceCard、去重键 sourceKey、压缩、按 citation > opened > searched 选取
lib/output.js               emitText（preview、[grok-search] 提示行、stdout 预算、全文落盘）、JSON 输出与运行记录
```

三条命令的结构相同：一张选项表（每个 flag 的类型、默认值、帮助文本、分组，以及它对应的配置键）加一个 `run(args, config)`。`lib/cli.js` 的 `runCommand` 负责其余所有事：解析、`--help`、加载配置、代理、把带 `config` 键的 flag 补上配置值、清理输出目录、deadline、把异常变成 `{ error: { code, message } }` 和退出码（参数错误 2，其余 1）、失败时也写运行记录。例外是 Search 的 X 媒体开关和 handle 列表：命令行给出时隐含开启 X 搜索，配置里的只是偏好，所以它们不走表默认值，在 `resolveSearchOptions` 里显式合并。

Search 的逻辑都在 `lib/search.js` 的 `runSearch(args, config, adapters)`：Grok 通道是参数，测试传假的，CLI 不传。

生产代码与公开 benchmark 均不包含 Chat Completions；历史 Chat 对照实验仅保存在本地私有档案中。

## Search 数据流

```text
query
  └─ Grok Responses
       └─ provider-native web_search / x_search（由 --source 决定挂载哪些）
  result JSON
       ├─ answer
       ├─ sources.items（Grok 的来源，每页一张；超出上限时按 citation > opened > searched 挑，默认 12 条）
       ├─ sources.returned / total / omitted
       ├─ sources.raw_path（总是指向本次运行记录）
       └─ diagnostics
```

2026-10-19 之前 Tavily Search 与 Firecrawl Search 和 Grok 三路并行，结果作为额外卡片合并（RRF 选取）、Grok 额度耗尽时降级为它们的原始结果。一个月真实会话里 agent 只用到 10 个只来自它们的网址、降级一次都没发生，它们每月还占约 470 Firecrawl credits，于是删掉，Tavily / Firecrawl 只留给 fetch 和 map（数据见 `.agent/extras-review-2026-10-19.md` 与 `benchmarks/search-extra-compare.mjs`、`supplement-compare.mjs`）。

### Grok 失败

Grok 失败一律报错。402、额度类错误码，或正文带 quota/credit/billing 信号的 429 报 `GROK_QUOTA_EXHAUSTED`；其余重试后仍然 429 的报 `GROK_RATE_LIMITED`；两者在 `diagnostics.grok_error` 里写 `QUOTA_EXHAUSTED` / `RATE_LIMITED`。401/403、404/422、5xx、超时、空 Responses 保留上游信息。

## Fetch 数据流

```text
URL
  ├─ Direct（Accept: text/markdown；非 HTML 直接返回）
  ├─ Firecrawl Scrape（Keyless 或 API key）
  ├─ Tavily Extract（配置 key 时）
  ├─ 第一步的 Direct 文本（有正文时）
  └─ DeepSeek Fetch（配置 key、Direct 没拿到页面时；X 跳过）
```

这是主备链，不会每次同时消耗几家的 credits。DeepSeek 只做最后一道：60 个真实 HTML 页面里它拿到正文 32 页、Direct 42 页，另有 11 页只给登录页或标题，排在前面会盖掉 Direct 的文本（`benchmarks/fetch-fallback-compare.mjs`，2026-10-19）。Firecrawl Keyless 能处理 JavaScript 页面和常见文档；Direct Fetch 只做普通 HTTP 文本/HTML 的 best-effort 清理。

例外：`x.com/<handle>/status/<id>` 不论 key 都先走 Direct，页面含 `@handle`（按重定向后的真实 handle）、日期、非登录页正文三项校验通过才算成功（只有主帖）；不过再回主备链，主备链也不可用则按原样返回 Direct 内容并写 warning。Firecrawl 冷却期内 auto 直接跳过它。

### Firecrawl 重试与冷却

`requestJson` 负责 HTTP 层重试（408/429/5xx 最多 3 次），`Retry-After`（header 或 body 的 `retry_after_seconds`）在预算内照等、超预算即停。`firecrawlScrape` 外层只对"HTTP 200 且 markdown 为空"（SPA 未渲染完）重试并递增 `waitFor`；坏 JSON、`success:false`、403、超时一次即止。额度耗尽（402 或 `reason: credits`）写入 `lib/cooldown.js` 管理的 `<stateDir>/firecrawl-cooldown.json`（`until` 取 `retry_after_seconds`，上限 24h，缺失时 15 分钟；按 `auth_mode` 区分），之后所有 auto 命令跳过 Firecrawl，显式 `--provider firecrawl` 成功后清除。

## Map 数据流

```text
site URL（两个 provider 都只返回本站、该路径及其下的 URL）
  ├─ Tavily Map（配置 key 时；select_paths + allow_external: false）
  └─ Direct Map
       ├─ 请求页面上的同域链接
       └─ sitemap：robots.txt 声明的、/sitemap.xml、<路径>/sitemap.xml，索引展开（最多 10 个文件）
```

Direct Map 刻意保持浅层，不执行 JavaScript，并忽略自然语言过滤指令。

## 输出约定

每个脚本向 stdout 写一个完整 JSON。常见 diagnostics：

- `warnings`
- `provider_attempts`
- `options`
- `searched_at` / `fetched_at` / `mapped_at`
- `usage`、`cost_in_usd_ticks`、`cost_usd`
- `search_source`（`web` / `x` / `both`）
- `responses_web_search_calls`、`responses_x_search_calls`、`responses_tool_calls`——次数取 `usage.server_side_tool_usage_details`（计费口径）与 `output[]` 里 `*_call` item 统计的逐工具较大值；两侧都有中转会漏报，任一单独取值都会报成 0。`responses_tool_calls` 摘要为 `{ total, upstream, trace, by_action, failed? }`，两侧原始计数并列可见
- `search_budget`——prompt 里的软预算（`prompt_total: 6`，挂 X 时 `prompt_x: 4`）与实际次数并列，`enforced: false`。`used_web` / `used_x` 是计费调用数（含 open_page / find_in_page），`used_searches` / `used_x_searches` 只数检索，`exceeded` 按后者判断（trace 里看不到的计费调用按检索算）；按计费数判断时 199 次里有 47 次被误标超标（2026-09-14 至 10-10）。预算不是硬限制：`max_turns` 限的是 agentic turn，一个 turn 可含多次检索，且只对 X 搜索是硬上限、web 搜索不受它约束，预算只是给模型的建议；`max_tool_calls` 官方直连与两个中转都不生效（2026-09-08 实测，直连 `max_tool_calls: 1` 仍跑 4 次）；`parallel_tool_calls: false` 官方有效、部分中转丢弃，由 `--responses-parallel-tool-calls` 显式发送
- `options.instructions_chars`、`options.responses_parallel_tool_calls`（设置时）
- `responses_model`——中转实际返回的模型，与请求不同时告警
- `grok_error`（仅 search 报 `GROK_QUOTA_EXHAUSTED` / `GROK_RATE_LIMITED` 时）
- `firecrawl_auth_mode: keyless | api_key`（fetch）
- `cache`（仅 fetch 命中缓存时）：`{ hit, fetched_at, age_seconds }`

长文本在 stdout 中返回 preview，完整内容按需写入输出目录。preview 先按 `--max-chars`（字符，fetch 从 `--offset` 起算）截，再按 `STDOUT_BUDGET_BYTES`（45KB，整个 JSON 的 UTF-8 字节）截：pi 的 bash 工具只保留最后 50KB 的整行，单行的长正文超限会连同它上面的行一起丢掉；`--full-sources` 时其余字段已超预算，不截。会改变正文读法的 warning 同时以 `[grok-search]` 开头的行写进正文（`lib/output.js` 的 `emitText`，search 的 answer 和 fetch 的 content 都经它输出）：截断写在末尾，fetch 给出下一段的 `--offset` 和全文路径；跳到首页、Direct 只拿到标题、X 页面未通过校验写在开头。`fitTextToStdoutBudget` 截短时只截正文、保留这些行，`chars` 只算正文。原因是 agent 常常只打印 `content.text` / `answer.text`（截至 2026-10-09，Claude Code 约 105 次调用只打印过 1 次 warnings）。每次调用另写一份运行记录（`schema_version: 3`，成功 / 失败 / deadline 都写；成功时在 stdout 截断之后写，带 `printed_answer` / `printed_content`），search 通过 `sources.raw_path`、fetch / map 通过 `diagnostics.run_path` 引用；`GROK_RUN_LOG=off` 关闭。`grok_tool_calls[].source_count` 是中转挂在每个 call 上的累积值，不能做逐次归因。

fetch 成功结果在 `<stateDir>/fetch-cache/` 保留 15 分钟（`lib/fetch-cache.js`，与 Claude Code WebFetch 的缓存时长相同）：每个 URL 一个文件，按 sha256 命名，写临时文件再 rename；`auto` 只复用 `auto` 的结果，显式 provider 复用该 provider 产出的结果；只存正文、元数据、warnings 和 notices，不存 `credits_used` 等成本字段，命中时 `provider_attempts` 为空；失败和回退结果都不缓存（`fellBack`：提取器失败之后才拿到的结果、复用的 Direct 文本），条目记下截断页面的 `full_path` 供续读复用，过期文件在下次写入时清理；`--no-cache` 跳过读取。

## Provider 边界

- xAI 与 openai-compatible 使用 `web_search` / `x_search` Responses tools，可按 `--source` 单独挂载。
- OpenRouter 使用 `openrouter:web_search`，不追加 `:online`；`x_search` 由 OpenRouter 自动附加在 native 检索上，只能通过顶层 `x_search_filter` 过滤，因此 `--source` 在该路径下不被强制执行并会告警。
- Tavily/Firecrawl 与 Grok 之间不传递证据正文。
- Fetch、Map 是内容获取/发现工具，不生成回答。
- Firecrawl Keyless 受按 IP 的月度与每日限制；配置 key 后使用账户额度和更高限流。X 原帖一次约 30 credits，是 keyless 日额度的三分之一。

## 边界

Direct provider 不处理登录、cookie、CAPTCHA、反爬绕过或代理池。Firecrawl 自身支持的动态渲染和文档提取由其云服务负责，但本仓库不实现浏览器自动化框架。
