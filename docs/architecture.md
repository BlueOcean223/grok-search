# 架构说明

`grok-search` 用三个独立脚本给 agent 提供网络访问能力：

1. **Search**：Responses API 搜索型问答，加独立多源信源。
2. **Fetch**：抓取明确 URL 的可读正文。
3. **Map**：从站点发现候选 URL。

## 组件

```text
scripts/search.js
  ├─ lib/grok-responses.js  Responses 请求、tool trace 与 citation 解析
  ├─ lib/context.js         本地时间和 platform 上下文
  ├─ lib/providers.js       fetch / map 编排：provider 顺序、X 原帖 Direct 优先、失败接力；re-export 下面四个适配器
  ├─ lib/http.js            requestJson：重试与退避、Retry-After、脱敏、代理初始化
  ├─ lib/tavily.js          Tavily Extract / Search / Map
  ├─ lib/firecrawl.js       Firecrawl Scrape / Search、metadata、额度判断与冷却记录
  ├─ lib/direct.js          Direct fetch / map：HTML 转文本、X 原帖校验、sitemap 与链接解析
  ├─ lib/cooldown.js        Firecrawl 额度耗尽后的跨命令冷却状态
  ├─ lib/sources.js         信源压缩、规范化、字段合并去重、域名过滤降级
  ├─ lib/output.js          JSON、preview、完整输出与运行记录落盘
  ├─ lib/prompts.js         system prompt 与软预算常量
  └─ lib/config.js          环境变量和配置文件

scripts/fetch.js
  └─ Direct（请求 Markdown，非 HTML 直接返回）→ Firecrawl Scrape → Tavily Extract → Direct 文本

scripts/map.js
  └─ Tavily Map → Direct Map
```

生产代码与公开 benchmark 均不包含 Chat Completions；历史 Chat 对照实验仅保存在本地私有档案中。

## Search 数据流

```text
query
  ├─ Grok Responses
  │    └─ provider-native web_search / x_search（由 --source 决定挂载哪些）
  ├─ Tavily Search（配置 key 时）
  └─ Firecrawl Search（Keyless 或 API key）
       ↓ 三路并行
  result JSON
       ├─ answer
       ├─ sources.items（合并去重；超出上限时按 RRF 合并 Grok 与各 extra provider 的列表后裁剪，域外 extra 最后，默认 12 条）
       ├─ sources.returned / total / omitted
       ├─ sources.raw_path（总是指向本次运行记录）
       └─ diagnostics
```

Tavily 与 Firecrawl 永远是独立证据通道，不进入 Grok input。`--extra N` 是两家合计的目标数；默认 6，两家可用时均分，奇数优先 Tavily。两家都只搜网页，所以 `--source x` 下默认不跑（`extra_mode: off-x-only`），`--extra N` 可强制；`--source both` 仍默认跑。`--responses-allowed-domains` / `--responses-excluded-domains` 会下推给两家（Tavily `include_domains` / `exclude_domains`，Firecrawl `includeDomains` / `excludeDomains`），仍漏进来的域外结果降到最后一档而不丢弃。`--instructions` 只进 Grok 的 user message，两家只收 query。

Firecrawl 处于额度冷却期（`<stateDir>/firecrawl-cooldown.json`，见下）时 search 直接跳过它：有 Tavily 则名额全给 Tavily，否则 extra 为空并写 warning。

### Grok 额度降级

当 Grok 明确返回 402、额度类错误码，或正文带 quota/credit/billing 信号的 429 时归为 `QUOTA_EXHAUSTED`；其余 429 归为 `RATE_LIMITED`。两者处理相同：

- extra sources 有结果：构造确定性的原始结果列表，`diagnostics.degraded=true`，`grok_error.code` 如实区分两类。
- `--no-extra` 或两家均无结果：返回 `GROK_QUOTA_EXHAUSTED` / `GROK_RATE_LIMITED`。
- 401/403、404/422、5xx、超时、空 Responses 不触发这种降级。

## Fetch 数据流

```text
URL
  ├─ Tavily Extract（配置 key 时）
  ├─ Firecrawl Scrape（Keyless 或 API key）
  └─ Direct Fetch
```

这是主备链，不会每次同时消耗 Tavily 与 Firecrawl credits。Firecrawl Keyless 能处理 JavaScript 页面和常见文档；Direct Fetch 只做普通 HTTP 文本/HTML 的 best-effort 清理。

例外：`x.com/<handle>/status/<id>` 不论 key 都先走 Direct，页面含 `@handle`（按重定向后的真实 handle）、日期、非登录页正文三项校验通过才算成功（只有主帖）；不过再回主备链，主备链也不可用则按原样返回 Direct 内容并写 warning。Firecrawl 冷却期内 auto 直接跳过它。

### Firecrawl 重试与冷却

`requestJson` 负责 HTTP 层重试（408/429/5xx 最多 3 次），`Retry-After`（header 或 body 的 `retry_after_seconds`）在预算内照等、超预算即停。`firecrawlScrape` 外层只对"HTTP 200 且 markdown 为空"（SPA 未渲染完）重试并递增 `waitFor`；坏 JSON、`success:false`、403、超时一次即止。额度耗尽（402 或 `reason: credits`）写入 `lib/cooldown.js` 管理的 `<stateDir>/firecrawl-cooldown.json`（`until` 取 `retry_after_seconds`，上限 24h，缺失时 15 分钟；按 `auth_mode` 区分），之后所有 auto 命令跳过 Firecrawl，显式 `--provider firecrawl` 成功后清除。

## Map 数据流

```text
site URL
  ├─ Tavily Map（配置 key 时）
  └─ Direct Map（URL 带路径时只保留该路径及其下的 URL）
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
- `options.extra_domain_filter`（`pushed` / `demoted` / `none`）、`options.instructions_chars`、`options.responses_parallel_tool_calls`（设置时）
- `responses_model`——中转实际返回的模型，与请求不同时告警
- `degraded` 与 `grok_error`（仅额度降级）
- `firecrawl_auth_mode: keyless | api_key`

长文本在 stdout 中返回 preview，完整内容按需写入输出目录。preview 先按 `--max-chars`（字符）截，再按 `STDOUT_BUDGET_BYTES`（45KB，整个 JSON 的 UTF-8 字节）截：pi 的 bash 工具只保留最后 50KB 的整行，单行的长正文超限会连同它上面的行一起丢掉；`--full-sources` 时其余字段已超预算，不截。每次调用另写一份运行记录（`schema_version: 2`，成功 / 失败 / deadline 都写；成功时在 stdout 截断之后写，带 `printed_answer` / `printed_content`），search 通过 `sources.raw_path`、fetch / map 通过 `diagnostics.run_path` 引用；`GROK_RUN_LOG=off` 关闭。`grok_tool_calls[].source_count` 是中转挂在每个 call 上的累积值，不能做逐次归因。

## Provider 边界

- xAI 与 openai-compatible 使用 `web_search` / `x_search` Responses tools，可按 `--source` 单独挂载。
- OpenRouter 使用 `openrouter:web_search`，不追加 `:online`；`x_search` 由 OpenRouter 自动附加在 native 检索上，只能通过顶层 `x_search_filter` 过滤，因此 `--source` 在该路径下不被强制执行并会告警。
- Tavily/Firecrawl 与 Grok 之间不传递证据正文。
- Fetch、Map 是内容获取/发现工具，不生成回答。
- Firecrawl Keyless 受按 IP 的月度与每日限制；配置 key 后使用账户额度和更高限流。X 原帖一次约 30 credits，是 keyless 日额度的三分之一。

## 边界

Direct provider 不处理登录、cookie、CAPTCHA、反爬绕过或代理池。Firecrawl 自身支持的动态渲染和文档提取由其云服务负责，但本仓库不实现浏览器自动化框架。
