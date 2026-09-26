# 81 · 搜索数据接口：SERP 与 AI 问答探测 v1

状态：**WP155 实现，待审**（2026-09-26）。本文说四件事：选哪家服务商、为什么（§1–§2）；
契约长什么样、WP154 怎么用（§3）；钱怎么收（§4）；本机与云端各做什么、key 怎么管（§5–§6）。

> 这是**内部设计文档**（写给我们自己和 Luoye 看）：里面点了服务商的名字。面向用户的界面与文档里，
> 官方那一侧仍只叫「Agents 工坊官方数据接口」（docs/75 §4），这份文档不在守卫测试的扫描名单上。

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
| `data.search.ai_answer` | **每个平台一次**（问 4 个平台 = 4 次） | **0.4 积分** | Perplexity 估 $0.01（接口 $0.0006 + sonar 模型费，**未核**）≈ ¥0.071 + ¥0.001 = **¥0.072**；ChatGPT / Gemini / AI 概览 $0.004 ≈ ¥0.0294 | Perplexity 82%；其余 92.6% |

**算法**（与 docs/77 §1 同一张式子）：

1. 我方成本（¥）= 服务商单价（美元）× 7.1（`fx` 快照）+ 云端摊销 ¥0.001（docs/77 §1.1，估高了十倍）；
2. 满足毛利 ≥ 80% 的最低价 = 成本 ÷ (1 − 0.8)，**向上取整到 0.1 积分**；
3. 一条能力对应几种成本的（AI 问答五个平台），**按最贵的那一种**定价，一个价通吃——界面上只用说一个数；
4. 毛利 = (售价 − 成本) ÷ 售价，与后台用量页同一个式子。

SERP：0.0294 ÷ 0.2 = 0.147 → **0.2**。AI 问答：0.072 ÷ 0.2 = 0.36 → **0.4**。
测试 `packages/metering/test/search-pricing.test.ts` 按成本表逐项算毛利，任何一项 < 80% 就红——改价或改成本表都得过它。

**四条规矩**（Luoye 09-21 定的那一套，与 docs/75 §2 红人数据一致）：

1. 先预扣再取数；**命中缓存与未命中收同样的钱**，命中时我方成本记 0（缓存 24 小时）；
2. **失败 / 超时 → 预扣整笔释放**；AI 问答里某几个平台失败或回了空回答，只收成功的那几个；
3. **搜到 0 条（也没有 AI 概览）不收钱**；
4. 我方成本照实进账本（`cost-table.json` 的 `unit_prices` 五条，`unverified: true`，等对账单）。

单次都在 1 积分以下，照 docs/75 的口径不弹二次确认；单价常显在连接页那一行（从云端状态读，不写死）。

**一个量级感**（假设的用量）：WP154 的每周 GEO 探测，10 个问题 × 4 个平台 = 40 次 × 0.4 = 16 积分 / 周 ≈ ¥64 / 月；
新页面选题前查一次 SERP 0.2 积分，一天几次可以忽略。GEO 那一笔不小——WP154 最好让用户在面板里看得到「这周问几个问题、
约多少积分」。

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

## 7. 要 Luoye 定的

1. **建议价**：SERP 0.2、AI 问答每个平台 0.4（§4）。定了填 `reviewed_at`。
2. **开通官方那一侧**：在 DataForSEO 充值（最低 $50）并**书面确认可以转售**；然后 `wrangler secret put AGENTSWS_SEARCH_DATA_KEY`。
3. **要不要补 Copilot**：官方那一侧加 Bright Data（要书面授权 / KYC）；或者先不做，界面照实说「官方探测不了 Copilot」。
4. **自带那一档列服务商名**与 docs/75 §4「不做任何平台预设」看起来相反——理由：这里接的是服务商**自己的**接口，
   不知道是哪家就拼不出请求（红人那张卡接的是工坊的通用格式 byo/v1，不需要知道）。请确认这一例外。
