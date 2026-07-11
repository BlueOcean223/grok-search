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
  ├─ lib/providers.js       Tavily、Firecrawl 与 direct HTTP provider
  ├─ lib/sources.js         信源压缩、规范化、去重
  ├─ lib/output.js          JSON、preview 与完整输出落盘
  └─ lib/config.js          环境变量和配置文件

scripts/fetch.js
  └─ Tavily Extract → Firecrawl Scrape → Direct Fetch

scripts/map.js
  └─ Tavily Map → Direct Map
```

生产代码与公开 benchmark 均不包含 Chat Completions；历史 Chat 对照实验仅保存在本地私有档案中。

## Search 数据流

```text
query
  ├─ Grok Responses
  │    └─ provider-native web_search / x_search
  ├─ Tavily Search（配置 key 时）
  └─ Firecrawl Search（Keyless 或 API key）
       ↓ 三路并行
  result JSON
       ├─ answer
       ├─ sources.grok
       ├─ sources.extra
       ├─ sources.merged
       └─ diagnostics
```

Tavily 与 Firecrawl 永远是独立证据通道，不进入 Grok input。`--extra N` 是两家合计的目标数；默认 6，两家可用时均分，奇数优先 Tavily。

### Grok 额度降级

当 Grok 明确返回 402，或带 quota/credit/billing/rate-limit 信号的 429 时：

- extra sources 有结果：构造确定性的原始结果列表，`diagnostics.degraded=true`。
- `--no-extra` 或两家均无结果：返回 `GROK_QUOTA_EXHAUSTED`。
- 401/403、404/422、5xx、超时、空 Responses 不触发这种降级。

## Fetch 数据流

```text
URL
  ├─ Tavily Extract（配置 key 时）
  ├─ Firecrawl Scrape（Keyless 或 API key）
  └─ Direct Fetch
```

这是主备链，不会每次同时消耗 Tavily 与 Firecrawl credits。Firecrawl Keyless 能处理 JavaScript 页面和常见文档；Direct Fetch 只做普通 HTTP 文本/HTML 的 best-effort 清理。

## Map 数据流

```text
site URL
  ├─ Tavily Map（配置 key 时）
  └─ Direct Map
       ├─ /sitemap.xml
       └─ 首页同域链接
```

Direct Map 刻意保持浅层，不执行 JavaScript，并忽略自然语言过滤指令。

## 输出约定

每个脚本向 stdout 写一个完整 JSON。常见 diagnostics：

- `warnings`
- `provider_attempts`
- `options`
- `searched_at` / `fetched_at` / `mapped_at`
- `usage`、`cost_in_usd_ticks`、`cost_usd`
- `responses_web_search_calls`、`responses_x_search_calls`、`responses_tool_calls`
- `degraded` 与 `grok_error`（仅额度降级）
- `firecrawl_auth_mode: keyless | api_key`

长文本在 stdout 中返回 preview，完整内容按需写入输出目录。

## Provider 边界

- xAI 与 openai-compatible 使用 `web_search` / `x_search` Responses tools。
- OpenRouter 使用 `openrouter:web_search`，不追加 `:online`。
- Tavily/Firecrawl 与 Grok 之间不传递证据正文。
- Fetch、Map 是内容获取/发现工具，不生成回答。
- Firecrawl Keyless 受按 IP 的月度与每日限制；配置 key 后使用账户额度和更高限流。

## 边界

Direct provider 不处理登录、cookie、CAPTCHA、反爬绕过或代理池。Firecrawl 自身支持的动态渲染和文档提取由其云服务负责，但本仓库不实现浏览器自动化框架。
