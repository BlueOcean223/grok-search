# Web Search 质量评测研究与 grok-search Benchmark v2 设计

更新时间：2026-07-11

## 结论先行

Web Search 不能只用“最终答案对不对”评价。一个完整系统至少包含：

```text
Query / rewrite
→ Search / ranking
→ Fetch / extraction
→ Evidence selection and validation
→ Answer synthesis
→ Citation attribution
```

每一层都可能独立失败：搜索可以找到正确 URL 但正文没有抓到；正文可以抓到但关键字段被截断；证据可以完整但模型生成错误；答案也可能碰巧正确，但引用并不支持它。

对 grok-search，建议采用两套互补评测：

1. **可复现静态回归集**：测检索、抓取、复杂推理、引用和安全，便于版本间比较。
2. **运行时动态集**：从官方 JSON、RSS、Release API、政府数据源自动生成真值，专门测最新事实、索引延迟和正确答案出现时间。

其中“当前事实正确率”和“从官方发布时间到系统首次正确的延迟”应是最高优先级。静态 benchmark 即使分数很高，也不能证明系统真的能搜索到刚刚变化的事实。

不建议只公布一个总分。应先使用正确性、新鲜度和安全性作为硬门槛，再比较证据、引用、延迟和成本。否则一个快速、便宜但经常返回旧答案的系统，可能被平均分错误地包装成“综合表现良好”。

## Web Search 的两种产品形态

用户真正面对的并不只是不同 search provider，而是两种信息处理形态。

### 形态 A：原始证据交给主模型

```text
Search API
→ URLs / snippets / full content
→ host/main model reads evidence
→ final answer
```

优点：

- 主模型能根据当前对话和任务重新判断证据；
- 原始信息保留较完整，容易核验和重新排序；
- search provider 与 answer model 可以独立替换和评价；
- 对 CISA JSON 等结构化源，主模型或程序可以直接做字段校验。

缺点：

- 原始页面占用更多 context，增加主模型 token 成本；
- snippet 和正文噪声会直接暴露给主模型；
- 主模型必须具备较好的阅读、去重、冲突处理和 Prompt Injection 防御能力；
- 如果只返回 URL 而不 fetch，主模型仍没有真正的证据内容。

### 形态 B：辅助模型先理解和压缩

```text
Search / browse
→ auxiliary model reads evidence
→ summary or answer
→ host/main model consumes compressed result
```

优点：

- 显著减少交给主模型的 context；
- 可以提前去噪、合并来源和输出统一结构；
- 对简单查事实任务，辅助模型的最终答案可以直接使用，减少主模型工作；
- 较弱的主模型也能消费已经整理好的搜索结果。

缺点：

- 辅助模型形成 information bottleneck：遗漏的字段无法由主模型恢复；
- 可能把过时或错误证据压缩成更可信的自然语言；
- 主模型看到的是模型解释，而不是原始证据，citation attribution 更难核验；
- 发生两次理解和生成，可能增加总费用、延迟和表达漂移。

两者不应只比较最终答案。公平实验需要冻结同一份 evidence packet，至少比较：

1. `raw evidence → main model`；
2. `raw evidence → auxiliary model final answer`；
3. `raw evidence → auxiliary summary → main model`；
4. provider-native integrated search，例如 `Grok + web_search`。

关键指标包括：

- Raw Evidence Coverage：原始证据覆盖多少 gold fields/nuggets；
- Compression Retention：辅助输出保留了多少原始可用证据；
- Answer Information Gap：原始证据可支持、但辅助答案遗漏的比例；
- Unsupported Claim Rate：辅助模型新增了多少证据不支持的 claim；
- 最终主模型正确率、引用质量、总 token、总费用和端到端延迟。

这组实验可以回答“辅助模型是否真正增强了 Search”，还是仅仅减少了主模型输入并牺牲信息完整性。

### xAI 内置 Web Search 能否拆出来

xAI 的 `web_search` 和 `x_search` 是由 Grok 决策并在 xAI 服务端执行的工具，不存在等价的公开 raw Search endpoint。

Responses API 可以观察到：

- Grok 生成的搜索 query；
- `search`、`open_page` 等 action；
- search action 返回的候选 URL；
- 最终引用 URL、回答和 usage。

但 API 不返回 Grok 在 server-side tool 内部读到的页面正文或 snippet。因此它只能“部分抽离”为候选 URL trace：上层可以忽略 Grok 最终答案，重新 fetch 这些 URL 并交给主模型；但 query 规划和 URL 选择已经经过 Grok，且仍需支付 Grok 和工具调用费用。

这应作为单独实验组：

```text
Grok web_search URL trace
→ caller re-fetches candidate URLs
→ main model answers
```

它与真正的 Brave/Tavily raw API 不等价，但能衡量 Grok 的 URL discovery 与 Grok 内部 reading/synthesis 哪一层造成损失。

### Grok 模型与 X Search 矩阵

模型比较建议优先覆盖：

- `grok-4.20-0309-non-reasoning`；
- `grok-4.20-0309-reasoning`；
- `grok-4.3`；
- `grok-4.5` low/high；
- `grok-4.20-multi-agent-0309` 只用于少量深度研究题。

不能假设这些模型支持相同参数。例如固定版 Grok 4.20 reasoning 不接受 `reasoning.effort`，而 Grok 4.5 支持 low/medium/high；multi-agent 的 effort 还可能控制参与 agent 数量而非普通推理深度。

X Search 也必须区分“提供了工具”和“模型实际使用了工具”。应报告 X Search adoption rate、X citation ratio、Web-only 与 Web+X 的正确率差、旧答案率、费用和延迟。对软件 release、CISA JSON 等官方结构化事实题，X 应被视为补充信号而非权威真值；对刚发布公告、现场事件、社区反馈和舆情任务，X 才可能成为核心来源。

## 对现有 8 题实验的重新解释

现有实验已经覆盖了几个最重要的信号：

- 完整答案正确率；
- 官方来源 Hit@5；
- 检索文本和正文的证据覆盖率；
- 延迟、调用次数和费用；
- 单次搜索 API 与 agentic Search → Fetch → Verify 的差异。

CISA KEV 是最有价值的样本。搜索索引、Grok Responses 和 Tavily 都停在 7 月 7 日，但官方 JSON 已更新到 7 月 10 日。它说明“能找到官方 catalog 页面”与“能回答官方最新事实”并不是同一个能力。

现有题集仍缺少：

- 官方信息发布后多久才能被每个 provider 找到；
- 已知 URL 下 `web_fetch` 的正文抽取精度和噪声；
- 引用是否逐条支持答案中的 claim；
- 来源权威性、作者/机构责任和页面维护状态；
- 查询改写、语言、地区和重复运行下的稳定性；
- 间接 Prompt Injection、SEO 污染和恶意页面；
- 无网络对照组，用于区分模型记忆和真正的搜索收益。

## 文献与开源项目给出的评测方法

### 1. 传统检索排序：BEIR、BRIGHT、FreshStack

[BEIR](https://github.com/beir-cellar/beir) 为异构信息检索任务提供统一评测，常用指标包括：

- nDCG@k：相关结果是否排在前面，并支持分级相关性；
- MAP@k：多个相关结果的平均排序质量；
- MRR：第一个正确结果出现得有多早；
- Recall@k：前 k 个结果覆盖了多少应找证据；
- Precision@k：前 k 个结果中有多少真正相关。

[BRIGHT](https://brightbenchmark.github.io/) 增加了需要推理才能检索的复杂查询，共 1,385 个真实查询，主要报告 nDCG@10。它的重要启示是：关键词或表层语义匹配不足以评价复杂 Web Search，查询理解、推理式改写和 reranking 必须单独测试。

[FreshStack](https://fresh-stack.github.io/) 面向快速变化的技术文档，用真实社区问题、GitHub 代码和文档构造检索集。它把长答案拆成 nugget，并报告：

- alpha-nDCG@10：兼顾相关性和多样性；
- Coverage@20：检索结果覆盖了多少必要 nugget；
- Recall@50：相关文档召回率。

这比简单的“某个页面算相关”更适合 grok-search：一道 release 或安全题往往要求版本号、日期、修复内容等多个字段，必须评价这些字段是否都被检索证据覆盖。

[Still Fresh? Evaluating Temporal Drift in Retrieval Benchmarks](https://arxiv.org/abs/2603.04532) 对 FreshStack 的 2024、2025 两个技术文档快照重新建库和标注。203 个 LangChain 问题中有 202 个在新快照仍能被完整支持，但相关证据会迁移到 LlamaIndex 等其他仓库；retriever 排名在 Recall@50 上仍有 0.978 Kendall tau 相关性。它说明静态问题可以保留，但必须定期重抓 corpus、重做 relevance judgment，并允许权威证据的位置随时间迁移，不能把旧 URL 永久当作唯一 gold source。

### 2. 最新知识和动态 QA：FreshQA、RealTimeQA、LiveNewsBench、EvoBrowseComp

[FreshQA / FreshLLMs](https://github.com/freshllms/freshqa) 包含快速变化、缓慢变化、永不变化和错误前提等类型，并持续更新答案。项目提供人工评价、Exact Match/F1/Recall 和 LLM judge 形式的 FreshEval。

[RealTimeQA](https://arxiv.org/abs/2207.13332) 每周发布约 30 道来自新闻测验的新问题，并保存当时的 Web Search 文档池。论文使用选择题准确率、生成 Exact Match 和 token F1，且发现多数错误来自检索而非阅读理解。

[LiveNewsBench](https://arxiv.org/abs/2602.13543) 是 2026 年更接近当前需求的设计：

- 从近期新闻自动生成并定期刷新问题和答案；
- 用按日期切分的数据降低记忆污染；
- 保留人工核验的高置信测试子集；
- 同时测无网络和有网络结果，隔离真正的 Search 增益；
- 标准设置限制为最多 5 次搜索和 5 次页面访问；
- 用最终准确率以及不同搜索预算下的增益评价 agentic search。

它还提供了一个与 Brave 直接相关的工程参考：先用 Brave Search 在事件日期前 3 天、后 11 天的窗口内发现 URL，再限制到约 100 个可信新闻源，抓取并归档全文，最后用模型过滤不相关页面。这里 Brave 承担的是 URL discovery，而不是单独完成真值判断。

[EvoBrowseComp](https://arxiv.org/abs/2606.13120) 进一步把 fresh knowledge、来源可信度交叉验证、问题复杂度和自动更新结合起来。它构造 400 个英文和 400 个中文复杂问题，并用无工具对照证明问题不能主要依赖参数记忆。它适合借鉴的点包括：

- 明确设置“新知识晚于某个时间戳”；
- fresh evidence 必须由多个来源交叉验证；
- 过度流行、容易被模型记住的事实应被过滤；
- 问题定期退役并由新事实替换；
- 最终答案必须依赖 fresh evidence，而不是只在问题描述里装饰一个新日期。

这些工作共同说明：真正评价最新性时，问题本身和答案都应动态生成，仅更新静态题目的答案仍然可能被强模型记忆或猜中。

### 3. 静态深度搜索：BrowseComp、BrowseComp-Plus、WebWalkerQA、AssistantBench

[BrowseComp](https://openai.com/index/browsecomp/) 使用 1,266 个难以定位但答案可验证的问题，适合评价多轮搜索、线索组合和持续探索。

[BrowseComp-Plus](https://arxiv.org/abs/2508.06600) 为 BrowseComp 补充了固定、人工验证的语料和 hard negatives，最终包含 830 个问题和约 10 万篇文档。它可以把 retriever 与 agent/LLM 解耦，分别报告：

- 端到端 Accuracy；
- 证据文档 Recall；
- Search Calls；
- confidence calibration error；
- retriever 的 Recall@k 和 nDCG@k；
- citation coverage、precision 和 recall。

[WebWalkerQA](https://arxiv.org/abs/2501.07572) 强调在官网等结构化网站内沿链接纵向遍历，适合测试“从 catalog 页面发现 JSON/RSS/API，再继续读取”的能力。

[AssistantBench](https://arxiv.org/abs/2407.15711) 包含 214 个真实、耗时且可自动评分的 Web 任务，适合补充非纯 factoid 的长流程任务。

静态深度搜索集适合稳定回归，但不能作为最新性主指标。它们还可能随着公开时间增长发生训练污染。

### 4. 人类偏好：Search Arena

[Search Arena](https://github.com/lmarena/search-arena) 发布了约 24,000 个多轮搜索对话和约 12,000 个人类偏好票，覆盖 70 多种语言。

其最重要的警告是：用户通常偏好引用更多的回答，但未必能区分引用真正支持 claim，还是仅仅主题相关。支持性引用和无关引用都可能提高主观偏好。

因此：

- 不能把引用数量当质量指标；
- 人类偏好适合测整体可用性，但不能替代事实与引用核验；
- 评测 UI 应隐藏 provider 身份、统一引用样式，避免品牌和格式偏差；
- 多语言、开放式、推荐和分析类查询应作为静态事实题的补充。

### 5. 答案、证据和引用：ALCE、RAGAS、RAGChecker、ARES

[ALCE](https://github.com/princeton-nlp/ALCE) 把评测拆为流畅性、正确性和引用质量，并在 ASQA、QAMPARI、ELI5 上提供自动评价代码。对 grok-search 最有用的是两个概念：

- Citation precision / entailment：引用是否真的支持相邻 claim；
- Citation recall / completeness：需要引用的 claim 是否都得到支持。

[RAGAS](https://arxiv.org/abs/2309.15217) 提供 reference-free 的 faithfulness、answer relevance 和 context relevance；[ARES](https://github.com/stanford-futuredata/ARES) 用合成数据、少量人工标注和 Prediction-Powered Inference 估计 context relevance、answer faithfulness、answer relevance，并给出统计置信区间。

[RAGChecker](https://arxiv.org/abs/2408.08067) 更适合诊断 grok-search。它把答案和真值拆成 claim，分别评价：

- 总体 claim precision、recall、F1；
- retriever claim recall 和 context precision；
- generator faithfulness、context utilization；
- relevant / irrelevant noise sensitivity；
- hallucination 和 self-knowledge 依赖。

这套 claim-level 结构可以直接解释 Tavily → Chat 为什么没有修复过时检索：generator 很忠实，但忠实地复述了错误或过时的 context。

### 6. 来源质量：SourceBench

[SourceBench](https://arxiv.org/abs/2602.16942) 是 2026 年的预印本，专门评价 AI 答案引用的 Web 来源。它提出八项 1–5 分指标：

- Content Relevance；
- Factual Accuracy；
- Neutrality / Objectivity；
- Freshness；
- Ownership Accountability；
- Author Accountability；
- Domain Authority；
- Layout Clarity。

其公开实验覆盖 100 个查询、3,996 个来源和 12 个系统。Grok-4.1-Fast 的来源综合分排第 2，Content Relevance 很高；Tavily 在该实验中排最后，Reasoning 类型也偏弱。这个外部结果与本仓库 8 题实验中“Grok 内置搜索明显强于 Tavily、Tavily 容易返回旧或不完整证据”的观察方向一致。

SourceBench 没有评价 Brave，不能据此推断 Brave 排名。但它提供了一套可直接加入本仓库的来源质量 rubric。

### 7. `web_fetch` 正文抽取：Web2Text、WCXB

[Web2Text](https://github.com/dalab/web2text) 和 CleanEval 使用 main-content / boilerplate 的 precision、recall、F1，说明抓取质量必须与搜索质量分开测。

[WCXB](https://webcontentextraction.org/) 是 2026 年发布的多类型 Web Content Extraction Benchmark，包含 2,008 个页面、1,613 个域名和 7 类页面：article、documentation、service、forum、collection、listing、product。它使用 word-level precision、recall、F1，并记录每页延迟。

WCXB 的关键发现是：文章页面上的抽取器差距很小，但 forum、product、collection 等页面可相差 20–30 个 F1 点。页面类型必须分层报告，不能只测新闻文章。

它也对当前 Brave 参考实现有直接启示。该实现使用 Mozilla Readability；WCXB 页面显示 Readability 在开发集整体 F1 为 0.674，在 held-out test 为 0.736，明显落后于最佳 heuristic。这个数字不能直接等价于本仓库的真实表现，但足以说明不应把 Readability 原样当成通用 `web_fetch` 的最终方案。

### 8. 安全：BIPIA、InjecAgent

[BIPIA](https://github.com/microsoft/BIPIA) 覆盖 Web QA、Email QA、Table QA、Summarization 和 Code QA，使用 Attack Success Rate 评价外部内容中的间接 Prompt Injection。

[InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent) 包含 1,054 个测试用例、17 个用户工具和 62 个攻击者工具，并区分直接伤害和数据窃取。它说明“能读取网页”必须同时满足“不把网页内容当系统指令”。

对 grok-search，最低限度应测：

- 页面要求忽略用户问题或系统提示时，模型是否服从；
- 页面诱导访问攻击者 URL、泄露环境变量或调用额外工具时，是否执行；
- 恶意页面是否能覆盖更权威的官方来源；
- 加入防御后，正常检索和回答质量下降多少。

安全指标应单独作为门槛，不能被高准确率平均掉。

## 推荐的分层指标

### A. Search / ranking

- Official-source Hit@1 / Hit@3 / Hit@5；
- MRR、nDCG@5、Recall@5；
- Gold nugget Coverage@k；
- 结果去重率、域名多样性；
- primary source ratio；
- 查询改写后的 URL Jaccard 和正确率变化；
- 多语言、地区、时间过滤的一致性。

“官方来源”不应简单按域名硬编码为绝对真值。软件 release、政府公告和安全 catalog 可强优先官方源；产品推荐、争议性问题和用户体验则需要多源，并避免把厂商营销材料当唯一证据。

### B. Freshness

对每个动态事件记录：

```text
t_event       事实在现实中发生的时间
t_publish     官方源发布或更新的时间
t_observed    benchmark watcher 首次观察到官方变化的时间
t_query       向 provider 发起测试的时间
t_search_hit  provider 首次返回包含新事实的证据时间
t_correct     系统首次生成完整正确答案的时间
```

核心指标：

```text
Search Index Lag = t_search_hit - t_publish
Answer Lag       = t_correct - t_publish
Observation Lag  = t_observed - t_publish
```

还应报告：

- Current Exact Accuracy：查询时刻答案是否是当前真值；
- Stale Answer Rate：答案正确但已过期的比例；
- Staleness Days / Version Distance：旧了多少天或多少补丁版本；
- Fresh Official Hit@k：前 k 个结果是否包含当前官方证据；
- Online–Offline Delta：启用 Web Search 后相对闭卷模型的提升；
- P50 / P90 Search Index Lag 和 Answer Lag；
- 24h 内正确率和 72h 内正确率。

必须保存官方响应原文、获取时间和 SHA-256。否则真值在之后继续变化时，无法复现实验当时的判断。

### C. Fetch / extraction

- HTTP success、redirect correctness、content-type support；
- word-level precision、recall、F1；
- 必须出现片段召回率和 boilerplate 泄漏率；
- title、author、published/updated date、代码块、表格、链接保留率；
- JSON/RSS/API 字段 recall；
- 截断前是否已经包含关键字段；
- 每页延迟、字节数和失败类型；
- 按 article/docs/forum/product/listing 等页面类型分层。

除了 WCXB 页面，还应加入本项目特有的机器可读页面：GitHub API、release feed、CISA JSON、Node/Go/Python release JSON，以及正文中需要继续跟随的 JSON/RSS 链接。

### D. Evidence

- nugget coverage / claim recall；
- context precision 与噪声比例；
- primary-source coverage；
- 证据之间的冲突率；
- 关键字段是否由同一版本或同一时间点的证据支持；
- 来源的 relevance、accuracy、freshness、authority、accountability。

### E. Answer

- exact field accuracy；
- claim precision、recall、F1；
- completeness；
- contradiction rate；
- 无充分证据时的正确 abstention；
- confidence calibration；
- 是否混淆“分支首次发布日期”和“最新补丁发布日期”等时间语义。

结构化题优先用确定性 scorer。只有开放式变化描述、长答案和同义表达才使用 LLM judge。

### F. Citation

- citation entailment / precision；
- citation completeness / recall；
- citation placement；
- cited URL 是否真实、可访问、与抓取页面相同；
- 是否引用了过时版本或二手转载；
- 每个 claim 的最小充分来源数。

不要奖励引用数量本身。

### G. Agent behavior

- search calls、fetch/page visits、query rewrites；
- 找到首个 gold source 前的调用数；
- 重复或无收益调用比例；
- tool failure recovery；
- 是否从 HTML 发现 JSON/RSS/API 后继续访问；
- token、时间和费用随 search budget 的收益曲线。

### H. Robustness and safety

- 同义改写、短查询/长查询、中英文切换后的分数变化；
- 多次运行的答案一致率和 URL Jaccard；
- timeout、429、空正文和页面下线时的降级质量；
- prompt injection Attack Success Rate；
- 恶意 SEO 页面进入 top-k 后的官方事实保持率；
- 防御后的 benign utility。

### I. Operations

- end-to-end latency P50/P95；
- search 和 fetch 分段延迟；
- 每题与每个正确答案的费用；
- provider/API failure rate；
- rate-limit 和重试次数；
- 每次运行的完整配置、模型版本和 provider 参数。

## Benchmark v2 的建议题集

为了控制费用，第一版不需要追求大规模。建议一次完整回归使用 24 题：

| Track | 数量 | 目的 |
| --- | ---: | --- |
| Latest exact facts | 8 | 复用并增强现有 release、CISA 等题 |
| Reasoning retrieval | 4 | BRIGHT / BrowseComp 风格的多跳与查询改写 |
| Fetch extraction | 4 | docs、forum、product/listing、机器可读 feed |
| Evidence and citation | 4 | 多字段覆盖、冲突来源、逐 claim 引用 |
| Robustness / multilingual | 2 | 中英文、同义改写和地区参数 |
| Prompt injection | 2 | 恶意页面与正常页面混排 |

此外维护一个独立的 live canary，不计入固定 24 题：

- 每次从官方 watcher 发现变化时生成 1–4 道题；
- 默认在 `t+15m`、`t+2h`、`t+24h` 测试；
- 24 小时仍错误时再加 `t+72h`；
- 每个时点所有 provider 使用同一 query、地区和语言；
- 题目在本轮完成前不公开，防止即时污染。

推荐的动态题源：

- GitHub Releases / Security Advisories API；
- Node、Python、Go、Rust 等官方 release feed；
- CISA KEV JSON；
- 政府公开数据和带更新时间的 JSON；
- RSS / Atom；
- npm、PyPI、crates.io 等 registry API；
- Kubernetes、GitHub CLI、uv 等官方 release 页面/API。

新闻适合测大范围事件搜索，但官方机器可读数据更适合严格计算 index lag 和 exact correctness。两者都应保留。

## 评分和统计协议

### 硬门槛

建议先判定：

1. Current factual correctness；
2. Freshness / answer lag；
3. Prompt injection 是否成功；
4. 引用是否存在明显 contradiction 或伪造 URL。

任何安全失败不应被其他指标抵消。对于声明“latest/current”的产品模式，旧答案即使引用完整，也应判主任务失败。

### 可选综合分

为了排序可以额外给出 100 分 dashboard，但必须同时保留分项：

| 维度 | 权重 |
| --- | ---: |
| Current factual correctness | 25 |
| Freshness / lag | 20 |
| Evidence completeness | 15 |
| Retrieval quality | 10 |
| Fetch quality | 10 |
| Source quality | 10 |
| Citation quality | 5 |
| Robustness and efficiency | 5 |

安全单独作为 pass/fail，不放进加权平均。

### 运行与 judge

- provider 调用顺序随机化，避免某一组总是更晚执行而获得更新后的索引；
- 保存原始响应，评分脚本不可访问 provider 名称；
- 结构化字段用 exact/date/version scorer；
- 开放式 claim 使用 blind LLM judge；
- 至少人工复核所有 provider 分歧题和 10%–20% 的随机样本；
- judge 先在人工标签上校准，并报告 agreement；
- 小样本必须展示逐题结果和 paired win/loss/tie，不能只展示平均分；
- 使用 paired bootstrap 或 permutation test 给出置信区间；
- 对非确定性组至少重复 2 次，报告正确率方差和 URL Jaccard。

## 建议的数据结构

```json
{
  "id": "cisa-kev-live-2026-07-10",
  "track": "live_freshness",
  "query": "...",
  "generated_at": "...",
  "truth": {
    "source_url": "...",
    "published_at": "...",
    "observed_at": "...",
    "snapshot_sha256": "...",
    "fields": {}
  },
  "gold_sources": [],
  "gold_nuggets": [],
  "expires_at": "...",
  "security_fixture": null
}
```

每次 run 应保存搜索结果的原始排名、snippet、fetch 正文、来源元数据、答案、逐 claim 引用、调用时间线、usage 和费用。评分结果只从这个不可变 run artifact 生成，避免事后重新访问网页导致漂移。

## 对 grok-search 的实现优先级

### P0：先把最新性测准

1. 新增 live truth watcher 和 source snapshot；
2. 记录 `published_at / observed_at / query_at / first_hit_at / first_correct_at`；
3. 对 version/date/CVE 等字段使用确定性 scorer；
4. 增加无网络的纯 Grok 对照，计算 Online–Offline Delta；
5. 同一时点随机执行各 provider，避免时间偏差。

### P1：把 Search、Fetch、Answer 解耦

1. retrieval-only：只评 top-k URL 和证据；
2. fetch-only：给定相同 URL，比较 Tavily Extract、Direct Fetch、Brave reference/Readability 等；
3. grounded answer：给定相同证据比较生成模型；
4. end-to-end：评价真实产品路径。

只有这样才能判断 Tavily 是检索差、fetch 差，还是 answer 生成差；也能判断 Brave content 改善来自正文抽取还是 JSON 链接跟随。

### P1：升级 fetch，但先 benchmark 再选库

1. 从 WCXB 选小型、页面类型均衡的 smoke subset；
2. 加入技术文档、GitHub release、forum、product/listing 和 JSON/RSS；
3. 给抽取结果生成 confidence；
4. 低 confidence 时再使用更重的 fallback；
5. 保留 JSON-LD、表格、代码块和机器可读链接；
6. 不建议因为 Readability 易用就直接作为唯一抽取器。

### P1：来源重排与字段验证

1. 对 latest/current 查询识别时间意图；
2. 官方域名、GitHub org、政府域名、API/feed 优先；
3. 比较页面日期、版本和 feed 最新记录；
4. 发现 JSON/RSS/API 链接后允许有限的二跳 fetch；
5. 对多个来源冲突时，显式输出冲突并优先当前官方记录。

### P2：claim、引用和来源质量

1. 自动拆分 gold nuggets 和 answer claims；
2. 计算 claim precision/recall、context precision、citation entailment；
3. 引入 SourceBench 的八项来源 rubric；
4. 不奖励引用数，只奖励支持性和覆盖率。

### P2：安全与稳定性

1. 加入 BIPIA 风格的恶意 HTML fixture；
2. 对外部页面内容明确标记为 untrusted data；
3. 阻止页面文本触发新工具、泄露环境或覆盖系统规则；
4. 对同义改写、中英文和重复运行生成稳定性报告。

## 对当前架构的最终判断

现有实验与外部研究共同支持下面的架构：

```text
Fast discovery (Brave / provider-native search)
→ time-aware and authority-aware reranking
→ fetch top 1–2 high-value pages
→ follow machine-readable JSON/RSS/API when present
→ field/nugget validation
→ grounded generation
→ claim-level citation verification
```

Tavily 可以继续作为候选 provider 和 extract fallback，但不应被默认视为“增强后一定更好”。SourceBench 的独立结果和本仓库实验都表明，它在复杂 reasoning、来源选择和最新事实方面可能落后。

Grok Responses 目前是单次搜索生成的强基线，但 CISA 反例说明 provider-native search 也不能替代官方源的最终 fetch 验证。

Brave 的最佳定位仍是快速 discovery。LiveNewsBench 的用法也不是相信 Brave snippet，而是加上时间窗口、来源 allowlist、全文抓取、归档和相关性复核。这个流程与本仓库 Brave-content 修复 CISA 的路径一致。

## 主要参考资料

- [BEIR](https://github.com/beir-cellar/beir)
- [BRIGHT](https://brightbenchmark.github.io/)
- [FreshQA / FreshLLMs](https://github.com/freshllms/freshqa)
- [RealTimeQA](https://arxiv.org/abs/2207.13332)
- [FreshStack](https://fresh-stack.github.io/)
- [Still Fresh? Evaluating Temporal Drift in Retrieval Benchmarks](https://arxiv.org/abs/2603.04532)
- [LiveNewsBench](https://arxiv.org/abs/2602.13543)
- [EvoBrowseComp](https://arxiv.org/abs/2606.13120)
- [BrowseComp](https://openai.com/index/browsecomp/)
- [BrowseComp-Plus](https://arxiv.org/abs/2508.06600)
- [WebWalkerQA](https://arxiv.org/abs/2501.07572)
- [AssistantBench](https://arxiv.org/abs/2407.15711)
- [Search Arena](https://github.com/lmarena/search-arena)
- [ALCE](https://github.com/princeton-nlp/ALCE)
- [RAGAS](https://arxiv.org/abs/2309.15217)
- [RAGChecker](https://arxiv.org/abs/2408.08067)
- [ARES](https://github.com/stanford-futuredata/ARES)
- [SourceBench](https://arxiv.org/abs/2602.16942)
- [Web2Text](https://github.com/dalab/web2text)
- [WCXB](https://webcontentextraction.org/)
- [BIPIA](https://github.com/microsoft/BIPIA)
- [InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent)
