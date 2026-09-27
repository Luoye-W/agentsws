# 81 · 搜索数据接口：SERP 与 AI 问答探测 v1

状态：**WP155 实现，待审**（2026-09-26）。本文说四件事：选哪家服务商、为什么（§1–§2）；
契约长什么样、WP154 怎么用（§3）；钱怎么收（§4）；本机与云端各做什么、key 怎么管（§5–§6）。

> 这是**内部设计文档**（写给我们自己和 Luoye 看）：里面点了服务商的名字。面向用户的界面与文档里，
> 官方那一侧仍只叫「Agents 工坊官方数据接口」（docs/75 §4），这份文档不在守卫测试的扫描名单上。

> **WP159 更新（Luoye 09-27 定）**：**不再考虑 Perplexity**（用的人少、在走弱）。GEO 默认只探测
> ChatGPT、Gemini、Google AI 概览；官方那一侧的状态口不再列 Perplexity（DataForSEO 适配器里那段代码留着，
> 登记为不用：`unused_platforms`；契约枚举值 `perplexity` 不删）。去掉它以后最贵的一家成本约 $0.004 / 次，
> `data.search.ai_answer` 建议价从 0.4 降到 **0.2 积分 / 平台·次**；每周默认 6 个问题 × 3 个平台 = **3.6 积分**。
> 下文 §1–§3 的调研原样保留（包括 Perplexity 那几格），§4 与 §7 已按新价改。

> **WP166 更新（Luoye 09-27 定）**：SERP 与 AI 问答探测**按用户产品的目标市场**来——只选了美国就只探美国；
> 选了多个市场，就**每个目标市场分别探**。目标市场只有一处真源：公司档案里的 `WorkspaceProfile.markets`
> （初始化时从官网 / Amazon 链接推一份、店铺连上后按店里配的市场校正一次、用户在向导档案卡与设置页都能增删）；
> 档案里没写才退回品牌的默认国家（服务端缺省 `us`，界面写明「按默认」）。每周探测按「问题 × 平台 × 市场」算，
> 面板的每周估算跟着乘、明示「N 个市场」，可以在面板上关掉某个市场的探测（只关探测，不改档案）。**价目不变**
> （0.2 / 次），扣费与缓存规矩照旧，缓存键里带市场（国家码统一小写）。见 §4「按市场」与 §6。

## 0. 一句话

**网页搜索与 AI 平台问答都用第三方（Luoye 09-26 定）。首选 DataForSEO：一把 key 同时拿到 Google / Bing
的搜索结果（带 AI 概览与「大家还在问」）和 ChatGPT / Gemini / Perplexity 的回答，按量付费、条款里没禁止转售。
Copilot 它没有，备选 Bright Data 能补上，但转售要先拿书面授权。**

## 1. 服务商对比

调研日期 2026-09-26，只读各家公开的官方文档、价目页与条款页；没注册、没调任何付费接口、没用任何 key。
读不到官方出处的格子写「未核实」。正式签约前请人工把条款原文再核一遍（摘录是工具读页面时摘的）。

### 1.1 覆盖面

| 服务商 | 搜索引擎 | AI 平台（接口） | 出处 |
|---|---|---|---|
| **DataForSEO** | Google、Bing（另有 Baidu 等） | **LLM Scraper**（网页端用户真看到的回答）：ChatGPT、Gemini。**LLM Responses**（调官方模型 API）：ChatGPT、Claude、Gemini、Perplexity（sonar，仅 Live）。**Google AI Mode**。**Google AI 概览**：SERP 结果里的 `ai_overview` 项。**没有 Copilot** | [AI Optimization 总览](https://docs.dataforseo.com/v3/ai_optimization-overview/)、[产品页](https://dataforseo.com/ai-optimization-api)、[Bing SERP 价目](https://dataforseo.com/pricing/serp/bing-organic-serp-api) |
| **SerpApi** | google、bing、baidu、yandex 等 200 多个 | `google_ai_overview`、`google_ai_mode`、`bing_copilot`。**没有 ChatGPT / Perplexity / Gemini** | [引擎清单](https://serpapi.com/search-engine-apis)、[Bing Copilot API](https://serpapi.com/bing-copilot-api) |
| **Serper** | 只有 Google（网页、图片、新闻、购物等） | 官方页没提任何 AI 平台，也没提 AI 概览 | [serper.dev](https://serper.dev/) |
| **Bright Data**（AI 回答抓取） | SERP API：Google、Bing 能结构化解析 | ChatGPT、Perplexity、Gemini（欧洲国家除外）、**Copilot**、Google AI Mode；Google AI 概览走 SERP 的 `brd_ai_overview=2` | [AI Scrapers](https://docs.brightdata.com/products/scrapers/scrapers-library/ai-scrapers)、[SERP 参数](https://docs.brightdata.com/scraping-automation/serp-api/query-parameters/google) |
| **SE Ranking**（专做 AI 可见度） | —— | ChatGPT、Gemini、Perplexity、AI Mode、AI 概览——但它是**预先采集的库**（2550 万+ 条问题），**不能随时问任意问题** | [AI Visibility API](https://seranking.com/ai-visibility-api.html)、[快速上手](https://seranking.com/api/data/quickstarts/assess-ai-search-visibility/) |

### 1.2 按国家 / 语言 / 设备

| 服务商 | 怎么指定 | 出处 |
|---|---|---|
| DataForSEO | SERP 与 AI Mode：`location_code` / `location_name`、`language_code`、`device`（desktop / mobile）、`os`；LLM Scraper：`location_code` + `language_code`；Perplexity 的 LLM Responses：`web_search_country_iso_code` | [Google Organic Live Advanced](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/)、[AI Mode](https://docs.dataforseo.com/v3/serp/google/ai_mode/live/advanced/)、[ChatGPT LLM Scraper](https://docs.dataforseo.com/v3/ai_optimization-chat_gpt-llm_scraper-live-advanced/)、[Perplexity LLM Responses](https://docs.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live/) |
| SerpApi | Google：`gl`、`hl`、`location`、`device`（desktop / tablet / mobile）；Bing：`mkt` 或 `cc`（二选一）+ `device`；`bing_copilot` 文档里没列地区参数 | [Search API](https://serpapi.com/search-api)、[Bing](https://serpapi.com/bing-search-api)、[Bing Copilot](https://serpapi.com/bing-copilot-api) |
| Serper | 官方 FAQ 说能按国家与语言；具体参数名与设备参数：**未核实**（playground 要登录） | [serper.dev FAQ](https://serper.dev/) |
| Bright Data | SERP：`gl`、`hl`、`uule`，设备 `brd_mobile`；AI Scrapers 按国家定向；语言参数：**未核实** | [SERP 参数](https://docs.brightdata.com/scraping-automation/serp-api/query-parameters/google)、[AI Scrapers](https://docs.brightdata.com/products/scrapers/scrapers-library/ai-scrapers) |

### 1.3 单价（美元，每千次）

| 服务商 | SERP | AI 回答 | 计费方式 | 出处 |
|---|---|---|---|---|
| DataForSEO | Google Organic：Standard $0.6 / Priority $1.2 / **Live $2**（前 10 条）；Bing 同价。异步 AI 概览每次另加 $0.002（拿不到退） | AI Mode $1.2 / $2.4 / $4；**LLM Scraper（ChatGPT / Gemini）Live $4**；LLM Responses Live 每次 $0.0006 + 模型本身的钱 | 按量付费，最低充值 $50，额度不过期 | [Google Organic 价目](https://dataforseo.com/pricing/serp/google-organic-serp-api)、[AI Mode 价目](https://dataforseo.com/pricing/serp/google-ai-mode-serp-api)、[LLM Scraper 价目](https://dataforseo.com/pricing/ai-optimization/llm-scraper)、[LLM Responses 价目](https://dataforseo.com/pricing/ai-optimization/llm-responses)、[FAQ](https://dataforseo.com/faq) |
| SerpApi | 只有包月：$25 含 1k（$25/千）… $2,750 含 50 万（$5.5/千）；命中它自己的缓存不计次 | 与 SERP 同价，一次算一次 | 只有订阅；免费档 250 次 / 月 | [价目](https://serpapi.com/pricing) |
| Serper | 充值包 $50 买 5 万次（$1/千）… 最低 $0.30/千；额度 6 个月有效 | 不提供 | 充值，最低 $50 | [serper.dev](https://serper.dev/) |
| Bright Data | 按量 $1.5/千 | ChatGPT、Perplexity、Google AI Mode 各 $1.5/千；Gemini、Copilot 的单价：**未核实** | 按量或订阅，只收成功的 | [SERP 价目](https://brightdata.com/pricing/serp)、[ChatGPT](https://brightdata.com/products/web-scraper/chatgpt)、[Perplexity](https://brightdata.com/products/web-scraper/perplexity) |
| SE Ranking | —— | 充值「$50 起 / 25 万 credits」，每次调用扣多少：**未核实** | 按量 + 订阅 | [AI Visibility API](https://seranking.com/ai-visibility-api.html) |

### 1.4 AI 概览与「大家还在问」

| 服务商 | AI 概览字段 | 同一次调用？ | 大家还在问 | 出处 |
|---|---|---|---|---|
| DataForSEO | item `type: "ai_overview"`（元素级与顶层都有 `references`） | 同一次；要加 `load_async_ai_overview: true`（+$0.002） | `people_also_ask` | [Google Organic Live Advanced](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/) |
| SerpApi | `ai_overview`（`text_blocks` + `references`） | 有时内嵌，有时只给 `page_token`，要一分钟内再打一次 `engine=google_ai_overview`（第二次算不算一次额度：**未核实**） | `related_questions` | [AI Overview](https://serpapi.com/ai-overview)、[Google AI Overview API](https://serpapi.com/google-ai-overview-api) |
| Serper | 官方页面没有 | —— | `peopleAlsoAsk` | [serper.dev](https://serper.dev/) |
| Bright Data | `brd_ai_overview=2` 后返回 `ai_overview`，慢 5–10 秒 | 同一次 | **未核实** | [SERP 参数](https://docs.brightdata.com/scraping-automation/serp-api/query-parameters/google) |

### 1.5 条款：能不能当我们的官方数据接口转售

| 服务商 | 结论 | 出处 |
|---|---|---|
| DataForSEO | 条款里**没找到禁止转售的字样**，营销页主动说是 white-label 数据；唯一限制是不得用来与搜索引擎竞争。**没有正面授权**——上线前让对方书面确认「按次计费转售」没问题 | [条款](https://dataforseo.com/terms-of-service)、[SERP 数据页](https://dataforseo.com/google-serp-api-data)、[AI Optimization 页](https://dataforseo.com/ai-optimization-api) |
| SerpApi | **未经书面许可不得转售**（条款原文有 "sell, resell"） | [legal](https://serpapi.com/legal) |
| Serper | 没有明确的转售条款，只禁止原样镜像 | [条款](https://serper.dev/terms) |
| Bright Data | **未经书面授权不得转售**，部分服务要先过 KYC | [license](https://brightdata.com/license) |
| SE Ranking | 有给代理商的 White Label 产品，API 数据能否转售：**未核实** | [AI Visibility API](https://seranking.com/ai-visibility-api.html) |

### 1.6 数据保留

| 服务商 | 保留 | GDPR | 出处 |
|---|---|---|---|
| DataForSEO | 任务结果保留 30 天；存储数据超过 365 天永久删除 | 有 DPA（适用时自动并入），用标准合同条款 | [FAQ](https://dataforseo.com/faq)、[隐私政策](https://dataforseo.com/privacy-policy) |
| SerpApi | 搜索数据 31 天自动过期；可开 ZeroTrace 完全不存 | DPA 要发邮件索取；官方说还在「走向 GDPR 合规」 | [security](https://serpapi.com/security)、[legal](https://serpapi.com/legal) |
| Serper | 个人数据保留到注销；查询结果与日志存多久：**未核实** | 隐私政策列了 GDPR 权利 | [隐私政策](https://serper.dev/privacy) |
| Bright Data | 数据集只保留一段「有限的审阅期」；条款写它可以保留客户采集的数据自用 | 自称符合 GDPR / CCPA，有 SOC 2、ISO 27001 | [license](https://brightdata.com/license) |

### 1.7 中国大陆能不能直连

几家的官方页面都**没有**「大陆能否直连 API」的说法——全部**未核实**（我们的官方数据接口是云端打服务商，不受这一条影响；只有「自带 key」那一档是用户本机直连）。
能核到的：DataForSEO 的受限国家名单里没有中国，支付宝可以联系客服开通（[条款](https://dataforseo.com/terms-of-service)、[FAQ](https://dataforseo.com/faq)）；
Bright Data 有中文站与中文文档、收支付宝（[付款方式](https://docs.brightdata.com/general/account/billing-and-pricing/payment-methods)、[中文文档](https://docs.brightdata.com/cn/introduction)）；
Serper 只收信用卡与 PayPal（[serper.dev FAQ](https://serper.dev/)）；SerpApi：**未核实**。

### 1.8 另外看过的

- **SearchAPI.io**：一把 key 覆盖 Google、Bing、ChatGPT、Perplexity、Gemini、Bing Copilot、AI Mode 与 AI 概览，订阅 $1–4/千；但转售要书面许可（[价目](https://www.searchapi.io/pricing)、[ChatGPT API](https://www.searchapi.io/chatgpt-api)、[条款](https://www.searchapi.io/legal/terms)）。
- **Oxylabs**：有 ChatGPT、Perplexity、Gemini、AI Mode 的抓取目标；价目页**未核实**（[文档](https://developers.oxylabs.io/scraping-solutions/web-scraper-api/targets/chatgpt)）。
- **Profound、Peec AI**：看板产品，要先在他们平台配好问题，不适合按次转售；Profound 的公开 API 与价格：**未核实**。
- **SerpApi 的额外风险**：Google 已起诉它（它 2026-01-23 发文回应，[博客](https://serpapi.com/blog/google-v-serpapi-threatening-access-to-public-data/)），案件进展：**未核实**。

## 2. 推荐

**首选：DataForSEO（官方数据接口用它；用户也可以自带它的 key）**

- 一把 key 拿到：Google 与 Bing 的结果页（AI 概览、大家还在问同一次调用返回）、ChatGPT 与 Gemini 网页端的回答
  （带来源、按国家定向）、Perplexity（sonar 模型 + 联网，带引用）——五个平台里覆盖四个；
- 按量付费、最低 $50、额度不过期，和我们「按次扣积分」的收法对得上；价也最低（SERP $2/千、AI 回答 $4/千，Live 档）；
- 几家里唯一条款没禁止转售、还主动说 white-label 的；结果保留 30 天、有 DPA；支付宝能找客服开。
- **要做的一件事**：条款没有正面授权转售——正式开通前请 Luoye 发邮件让对方书面确认「作为按次计费的数据接口转售」没问题。

**它覆盖不到的**：Microsoft Copilot 完全没有（它的 Bing 结果页里有一块 `ai_overview`，文档配图文件名叫
`copilot_search.png`，**推断**是 Copilot Search 的回答块，**未核实**，这一版不拿它冒充 Copilot）；Perplexity
拿的是 sonar 模型 API 的回答，和网页端看到的可能不一样；Claude / Grok 不在派工单的五个平台里。

**备选：Bright Data**——正好补上 Copilot 与 Perplexity 网页端，也有 Google / Bing 结果页，按量 $1.5/千、只收成功的、
收支付宝、有中文站。缺点：转售要先拿书面授权、可能要过 KYC。这一版**没写它的适配器**（官方那一侧先只接一家；
要补 Copilot 时再加，加一家 = 一个适配器文件 + 登记一行，见 §5）。

**自带 key 那一档能选的三家**：DataForSEO、SerpApi（Google / Bing + AI 概览 + Copilot；它自己的条款不许转售，
所以只能给用户自带、不能当官方）、Serper（只有 Google 网页结果，最便宜）。SerpApi 正被 Google 起诉，用户自带
是用户自己的选择；官方那一侧不碰它。

**不推荐**：SE Ranking（预采集的库，问不了任意问题）、SearchAPI.io / Oxylabs（覆盖面好但转售要书面许可，价目没核到）。

## 3. 接口形状（适配器照这些写，替身响应也从这些页面的示例截）

| 服务商 · 动作 | 请求 | 我们取什么 | 出处 |
|---|---|---|---|
| DataForSEO · SERP | `POST /v3/serp/{google,bing}/organic/live/advanced`，Basic（`login:password`），体 `[{ keyword, location_name, language_code, device, depth: 10, load_async_ai_overview }]`（最后一格只 Google） | `organic` / `video` / `short_videos` / `shopping` / `popular_products` / `discussions_and_forums` → items；`people_also_ask[].items[].title`；`ai_overview` 的元素 `text` + 两处 `references[].url` | [Google](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/)、[Bing](https://docs.dataforseo.com/v3/serp/bing/organic/live/advanced/)、[错误码](https://docs.dataforseo.com/v3/appendix/errors/) |
| DataForSEO · ChatGPT / Gemini | `POST /v3/ai_optimization/{chat_gpt,gemini}/llm_scraper/live/advanced`，体 `[{ keyword, location_name, language_code }]` | `markdown`（没有就拼 `items[].markdown`）；`sources[].url` + `search_results[].url` | [ChatGPT Scraper](https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced/)、[Gemini Scraper](https://docs.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/live/advanced/) |
| DataForSEO · Perplexity | `POST /v3/ai_optimization/perplexity/llm_responses/live`，体 `[{ user_prompt, model_name: "sonar", web_search_country_iso_code }]` | `items[type=message].sections[].text`；`annotations[].url`（Gemini 那家认 `direct_url`） | [Perplexity LLM Responses](https://docs.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live/) |
| DataForSEO · 测试连接 | `GET /v3/appendix/user_data`（账户信息，不花钱） | 状态码 20000 = 通 | **未核实**（调研时没读到这一页，按惯例写的；审核 / 真冒烟时核一下） |
| SerpApi · SERP | `GET /search.json?engine=google&q&gl&hl&device&num=10&api_key`；Bing：`engine=bing&mkt=<语言>-<国家>` | `organic_results` / `inline_videos` / `shopping_results`（`product_link`）/ `discussions_and_forums`；`related_questions[].question`；`ai_overview` 只给 `page_token` 时马上再打 `engine=google_ai_overview` | [Search API](https://serpapi.com/search-api)、[AI Overview](https://serpapi.com/ai-overview)、[Bing](https://serpapi.com/bing-search-api)、[错误码](https://serpapi.com/api-status-and-error-codes) |
| SerpApi · Copilot | `GET /search.json?engine=bing_copilot&q`（没有地区参数） | `header` + `text_blocks`（段落 / 列表可多层）；`references[].link` | [Bing Copilot API](https://serpapi.com/bing-copilot-api) |
| SerpApi · 测试连接 | `GET /account.json?api_key`（不算搜索次数） | 200 = 通 | **未核实**（同上） |
| Serper · SERP | `POST https://google.serper.dev/search`，头 `X-API-KEY`，体 `{ q, gl, hl, num: 10 }` | `organic[]`；`peopleAlsoAsk[].question` | [serper.dev](https://serper.dev/)（没有正式文档，照首页示例） |

几处坑（都在适配器里处理了，测试钉住）：DataForSEO 的错误在**信封里的 `status_code`**（20000 才是成；40102 = 没有结果，
是正常回答不是错）；SerpApi「没有结果」时 HTTP 200、`status: Success` 却带一个 `error` 键——不能一见 `error` 就当失败；
DataForSEO 文档里 Bing 的完整示例 JSON 本身不合法（引号没转义），替身是手修过的；Perplexity 的官方示例里 `text` 是 null
——那种回答我们当「空回答」（不收钱、不判断）。

## 4. 钱怎么收（建议价，待 Luoye 定）

两条能力，都在 `data` 块、按次（`packages/metering/src/pricing.json`，`reviewed_at` 留空 = 后台挂「未核」）：

| 能力 | 什么算一次 | 建议价 | 我方成本（一次，最贵的那档） | 毛利 |
|---|---|---|---|---|
| `data.search.serp` | 查一次结果页（前 10 条 + AI 概览 + 大家还在问） | **0.2 积分** | Google $0.002 + 异步 AI 概览 $0.002 = $0.004 ≈ ¥0.0284，加摊销 ¥0.001 = **¥0.0294** | 85.3%（Bing 只有 $0.002，92%） |
| `data.search.ai_answer` | **每个平台一次**（问 3 个平台 = 3 次） | **0.2 积分**（WP159；原 0.4） | ChatGPT / Gemini 网页端 $0.004；AI 概览 = 一次 Google 结果页 $0.004 → ¥0.0284 + ¥0.001 = **¥0.0294**（Perplexity 不再探测，不参与定价） | 85.3%（三个平台一样） |

**算法**（与 docs/77 §1 同一张式子）：

1. 我方成本（¥）= 服务商单价（美元）× 7.1（`fx` 快照）+ 云端摊销 ¥0.001（docs/77 §1.1，估高了十倍）；
2. 满足毛利 ≥ 80% 的最低价 = 成本 ÷ (1 − 0.8)，**向上取整到 0.1 积分**；
3. 一条能力对应几种成本的（AI 问答五个平台），**按最贵的那一种**定价，一个价通吃——界面上只用说一个数；
4. 毛利 = (售价 − 成本) ÷ 售价，与后台用量页同一个式子。

SERP：0.0294 ÷ 0.2 = 0.147 → **0.2**。AI 问答（WP159，去掉 Perplexity 后）：0.0294 ÷ 0.2 = 0.147 → **0.2**（WP155 按 Perplexity 估的 ¥0.072 算是 0.4）。
测试 `packages/metering/test/search-pricing.test.ts` 按成本表逐项算毛利，任何一项 < 80% 就红——改价或改成本表都得过它。

**四条规矩**（Luoye 09-21 定的那一套，与 docs/75 §2 红人数据一致）：

1. 先预扣再取数；**命中缓存与未命中收同样的钱**，命中时我方成本记 0（缓存 24 小时）；
2. **失败 / 超时 → 预扣整笔释放**；AI 问答里某几个平台失败或回了空回答，只收成功的那几个；
3. **搜到 0 条（也没有 AI 概览）不收钱**；
4. 我方成本照实进账本（`cost-table.json` 的 `unit_prices` 五条，`unverified: true`，等对账单）。

单次都在 1 积分以下，照 docs/75 的口径不弹二次确认；单价常显在连接页那一行（从云端状态读，不写死）。

**一个量级感**（假设的用量）：WP154 的每周 GEO 探测，默认 6 个问题 × 3 个平台 = 18 次 × 0.2 = **3.6 积分 / 周 / 市场**（WP159；拉满 10 个问题也只有 6 积分）；
新页面选题前查一次 SERP 0.2 积分，一天几次可以忽略。GEO 那一笔不小——面板上看得到「这周问几个问题、几个平台、
几个市场，约多少积分」。

**按市场**（WP166）：每个目标市场分别探，所以花费跟着乘市场数——卖美国、英国、德国三个市场，默认一周
6 × 3 × 3 × 0.2 = **10.8 积分**。单价不变；面板那一行写成「每周问 6 个 × 3 个平台 × 3 个市场，约 10.8 积分」，
每个市场一个勾，不想探的市场可以勾掉（只关探测、不改公司档案）。每日判断里新页面选题前的 SERP 也按市场各查一次，
一天的次数上限（5 次）按**每个市场**算。缓存键 = 服务商 + 引擎 + **国家** + 语言 + 设备 + 查询（AI 问答是平台 + 国家 +
语言 + 问题）；美国的结果不会拿去当英国的，`US` 与 `us` 是同一个市场。

## 5. 路由与 key

照 WP126（docs/75 §1）的思路，但这里只有三档（没有「用户自己的官方平台 key」那一级——搜索引擎没有给个人的官方 key）：

| 档 | 谁付钱 | 怎么走 | key 在哪 |
|---|---|---|---|
| 官方 | 用户付积分 | 本机 → 云端 `/v1/data/search/{status,serp,ai-answers}`（令牌要 `data` 动作集）→ 服务商 | **云上**：`AGENTSWS_SEARCH_DATA_KEY`（Luoye 用 `wrangler secret put` 自己敲，不经 AI；DataForSEO 填 `login:password`）；服务商名是 `[vars]` 的 `AGENTSWS_SEARCH_DATA_PROVIDER`（默认 `dataforseo`，认不出的名字当没开通） |
| 自带 key | 用户对服务商付 | 本机直连服务商，不扣积分 | **本机加密库** `search.byo.key`（连接页原生表单填，品牌各一份）；设置文件 `search-data.json` 里只有档位、服务商与时间 |
| 不接 | —— | `status().configured === false` + 一句人话 | —— |

- 连接页「搜索数据」一行：官方（用积分）/ 自带 key / 不接。**没选过（auto）**按派工单的顺序：关联了云账号 → 官方；
  没关联但填过自带 key → 自带；都没有 → 不接。填了自带 key 会自动拨到「自带」。
- **配了但报错不换档**：自带 key 失败照实报错，不偷偷去花积分；官方失败也不会偷偷用用户的 key。
- 官方那一侧的错误信息里**不出现服务商名**（适配器的原话带着服务商名，云端入口一律换成「工坊官方数据接口」的说法），
  `source` 固定写 `official`；自带那一侧 `source` 写 `byo:<服务商>`、错误原话带回（是用户自己选的服务商）。
- key 不进日志、响应、错误信息：适配器只在拼请求那一行用它，服务商回显的错误原文过一遍 `redact`；测试钉住
  「数据目录里所有明文文件都找不到 key」。
- Workers 形态里 `/v1/data/search/*` 走钱那一层（`WalletDO(org)`）：预扣、打服务商、结算在同一个对象里做完，
  与 `/v1/ai/*` 同一条路（`isWalletPath`）。缓存是那个对象的内存（对象睡着就没了——只影响我们的成本）。

加一家服务商：`packages/cloud-entry/src/search/providers/<名字>.ts` 写一个 `SearchProviderAdapter`（拼请求 + 翻响应 +
测试连接 + 成本键）→ `providers/index.ts` 登记一行 → 契约的 `SearchDataProvider` 加一个名字（只加）→ 成本表加几条。

## 6. WP154 怎么用

- 进程内：`brand.searchData`（`BrandModuleSet.searchData`，实现了契约的 `SearchDataPort`）。
  先 `status()`：`configured === false` 就跳过 SERP 检查与 GEO 探测，卡上说一句 `status.reason`（或「搜索数据接口还没接」）；
  `status.platforms` 是这条路能探测的平台（官方那一侧没有 `copilot`），不在里面的平台 `aiAnswers` 会跳过。
- HTTP（SDK / 工具用）：`POST /v1/search-data/serp`、`POST /v1/search-data/ai-answers`（权限 `analytics.read`，
  所有者与「内容与搜索」职责都够得着）。
- 失败抛 `SearchDataError`（`code` 是契约的 `SearchDataErrorCode`）：`not_configured` → 跳过 + 说一句；
  `insufficient_credits` → 给充值入口；其余当「这次没查成」。
- `AiAnswerProbe.competitors`（可选）给了才能填 `competitors_mentioned`——我们不猜谁是竞品；不给就是空数组。
- 结果上的 `credits` / `cached`（可选）可以拿来在面板上显示「这次花了多少」。
- **国家从哪来（WP166）**：`SerpQuery.country` / `AiAnswerProbe.country` 一律取自公司档案的目标市场
  （`WorkspaceProfile.markets`，每个市场一跳；面板上关掉的市场 `GeoSettings.markets_off` 不查）；档案里没写才用品牌默认国家。
  结果按市场分开：`GeoProbeRow.market`、`GeoGap.market`、周报 `SeoWeeklyGeoPayload.markets`（每个市场一行：问了几个、
  几个提到或引用了我们、缺位几个）；每日选题的 `SeoPick.serp_markets` 是每个市场各看一眼的结论——**有一个市场人群对就能写，
  每个市场都不对才划掉**。可见度不跨市场混算。
- 语言仍按品牌的语言（没有按市场换语言：问题是按品牌语言生成的，换成别的语言问反而对不上）。

## 7. 要 Luoye 定的

1. **建议价**：SERP 0.2、AI 问答每个平台 0.2（§4，WP159 从 0.4 降下来）。定了填 `reviewed_at`。
2. **开通官方那一侧**：在 DataForSEO 充值（最低 $50）并**书面确认可以转售**；然后 `wrangler secret put AGENTSWS_SEARCH_DATA_KEY`。
3. **要不要补 Copilot**：官方那一侧加 Bright Data（要书面授权 / KYC）；或者先不做，界面照实说「官方探测不了 Copilot」。
4. **自带那一档列服务商名**与 docs/75 §4「不做任何平台预设」看起来相反——理由：这里接的是服务商**自己的**接口，
   不知道是哪家就拼不出请求（红人那张卡接的是工坊的通用格式 byo/v1，不需要知道）。请确认这一例外。

## 补充（09-27 调研）：Semrush / Ahrefs / Similarweb、AI 可见度看板类、Cloudflare AEO

> Luoye 09-27：不考虑 Perplexity；AI 可见度只比 ChatGPT、Gemini、Google AI 概览 / AI Mode、Copilot。以下只读官方页面，没注册、没用 key；「未核实」= 官方页没读到。

**结论**：Semrush、Ahrefs、Similarweb 条款都**禁止转售**，只能做「用户自带账号」接入；官方数据源继续用 **DataForSEO**，缺的 Copilot 用 **Bright Data Copilot 抓取接口**补（约 $1.5 / 千次）。两家上线前都先拿到书面的按次转售授权。

| 服务商 | 实时 SERP | ChatGPT | Gemini | AI 概览 / AI Mode | Copilot | API 门槛 | 单次 / 起步价 | 转售 | 自带账号 |
|---|---|---|---|---|---|---|---|---|---|
| DataForSEO（现用） | ✓ | ✓ | ✓ | ✓ / ✓ | ✗ | 按量，最低充 $50 | 抓取 $4 / 千次，SERP $2 / 千次 | 条款未禁，需书面确认 | ✓ |
| Bright Data | ✓ | ✓ | ✓ | AI Mode ✓ | ✓ | 按量，每月 5k 免费 | Copilot / Gemini $1.5 / 千次 | 需书面授权 | ✓ |
| Semrush | 自有库 | 看板 | 看板 | 看板 | 未列 | API 要 Business 档再买单位（价不公开）；AI 可见度 API 仅 Enterprise | AI 工具包 $99/月/域名 | ✗（ToS §3.3） | 只能走官方 MCP（条款禁止把输出喂给非官方集成的 AI） |
| Ahrefs | SERP Overview 前 100 | ✓ | ✓ | ✓ / ✓ | ✓ | API v3 从 Lite 起 | Lite $129/月；Brand Radar $199/月 | ✗（Connect §6(v)） | 用户自己的 MCP key 可以；OAuth 正式接入要我们买 Enterprise $1,499/月 |
| Similarweb | ✗ | 看板 | 看板 | 看板 | 只统计 AI 带来的流量 | API 只在定制套餐 | AEO $99/月（不含 API） | ✗（§6(i)(iv)） | 小卖家基本拿不到 API |
| Otterly.AI / Peec AI / Profound / SE Ranking | ✗（SE Ranking 有 SEO API） | ✓ | ✓/加购 | ✓ | Otterly ✓ | 看板型，API 多在高档 | $29–189/月起 | 未核实 | 只能读它平台上配好的问题 |

**自带账号接入顺序（以后做）**：① Ahrefs（唯一用 API 拿得到四个平台 AI 可见度，走用户自己的 MCP key，上线前问一下 Ahrefs）；② Semrush（只能官方 MCP）；③ Similarweb（最后，API 要找销售）。三家起步 $99–455/月，多数小卖家不会订，优先级低于官方档。

**Cloudflare AEO Visibility Dashboard**（AEO Suite，2026-08-06 发布，早期体验）：自己生成买家问题去问 Claude 与 GPT，给被引用率 / 被提及率 / 显眼程度 / 声量占比，另有 AI 抓取与带回访客数据。没有 Gemini / Copilot / AI 概览、问题不能自定义、没找到 API → **替代不了我们的探测，但「AI 抓了多少、带回多少访客」只有它有**，写进教程给用 Cloudflare 的用户自己申请。

**DataForSEO 背景**：2011 年起做内部工具、2016 年成立（爱沙尼亚），自称 3 万+ 客户、99.95% 可用率；Trustpilot 4.5（58 条）。「很多大 SEO 工具背后用它」业内流传但未找到大工具官方公开写明（未核实）。

出处：Semrush [ToS](https://www.semrush.com/company/legal/terms-of-service/) · [API](https://www.semrush.com/kb/5-api) · [MCP](https://developer.semrush.com/api/introduction/semrush-mcp/)；Ahrefs [API v3](https://help.ahrefs.com/en/articles/6559232-about-api-v3) · [Connect 条款](https://docs.ahrefs.com/ahrefs-connect/docs/terms-of-service.md) · [MCP](https://docs.ahrefs.com/mcp/docs/introduction.md)；Similarweb [条款](https://www.similarweb.com/corp/legal/terms/) · [AI Search 价目](https://www.similarweb.com/packages/ai-search/)；[Bright Data Copilot](https://brightdata.com/products/web-scraper/microsoft-copilot)；Cloudflare [博客](https://blog.cloudflare.com/aeo/) · [新闻稿](https://www.cloudflare.com/press/press-releases/2026/cloudflare-adds-aeo-visibility-dashboard-to-its-aeo-suite-showing-brands-whether-ai-assistants-are-recommending-them/)；DataForSEO [关于](https://dataforseo.com/about-us)。

## 补充（09-27）：AIsa 与 Apify

- **AIsa 不能当官方转售数据源**：[AIsa Services Agreement](https://aisa.one/TOS)（2026-08-24 版）§2.5(a) 禁止 service bureau / pass-through，§2.5(g) 禁止转售或分发服务的任何部分；上游条款照样约束（§3.2D）。要转售得先找 developer@aisa.one 签书面协议。它转接 DataForSEO 按上游成本 ×2 计价，比直连贵一倍。
- **AIsa 适合「自带 key」档**：一把 key、按次付费、无月费，覆盖 Semrush 19 / Similarweb 23 / Ahrefs 2 / DataForSEO 445 / Apollo 54 个接口，另有 TikHub 的 TikTok、YouTube、Instagram、LinkedIn（逐端点价格见 [openapi.yaml](https://aisa.one/openapi.yaml)）。没有 Copilot、没有海关数据；邮箱查找 / 验证全是「Coming Soon」。公司：AIPAY INC.，2026-07 种子轮 $6.5M（阿里巴巴、Tribe Capital 领投）。
- **Apify 适合红人与 B2B 官方档**：[通用条款](https://docs.apify.com/legal/general-terms-and-conditions) §5.8 与 [Actor 条款](https://docs.apify.com/legal/actor-terms-and-conditions) §4.3 规定输出数据归用户，没有禁止商用或转售输出（平台本身不能转授 §5.2）；抓取合法性由用户自负（§11.1）。Google Search Scraper 能补 Copilot（付费档每次 $0.003–0.005）；LinkedIn 资料 $0.004–0.01；Google 地图单个地点 $0.0015–0.004。Similarweb 网页抓取类 Actor 违反 Similarweb 条款，不用。
- **值得跟进**：AIsa 上 Oxylabs 的 AI 回答探测最便宜（Google AI 概览 / AI Mode $0.001，ChatGPT / Gemini $0.00145），Oxylabs 直签的转售条款未核实。
