# 99 · SEO 与 GEO 监测 v1（WP307，只调研 + 方案）

状态：**方案，待 Luoye 定**（2026-10-13）。不改业务代码；实现按 §7 拆单另派。

> 这是**内部设计文档**：里面点了批发商名（DataForSEO、Apify 等），给我们自己与 Luoye 看。
> 面向用户的界面、卡片、AI 回答、教程里**一律不提批发商名**，只叫「Agents 工坊官方数据接口」；
> 只有数据真来自 Semrush / Ahrefs / Similarweb（用户自带账号）时才对用户说来源（Luoye 10-13，WP300 已执行）。

> 依据：派工单 `docs/briefs/WP307-seo-geo-research.md`；`docs/81`（搜索数据接口）、`docs/96`（卡片流与组件化）、
> `docs/77`（积分价目，1 积分 = ¥1、毛利 ≥ 80%、向上取整到 0.1）、`docs/67`（付费三块）；
> 开源仓代码与私有云 `~/Documents/agentsws-cloud`（只读，`packages/data-hub`、`packages/metering`）。
> 外部资料只读公开文档 / 价目页 / 条款页与 open-seo 源码，**没注册、没调任何付费接口、没用任何 key**；读的日期都是 2026-10-13。

## 0. 一句话

**接口基本够，缺的是「存下来、看得出变化」那一层。** 现在每周已经在问 ChatGPT、Gemini、Google AI 概览，但只判「提没提我们」、
只留 600 字的节选、不存历史；没有 Claude，没有关注词排名，没有品牌词搜索量趋势。DataForSEO 一家就能补齐：ChatGPT / Gemini
用网页端抓取（带回答全文 + 引用来源），**Claude 只能用它的模型接口 + 强制联网**（claude.ai 网页端谁都抓不了），排名用排队档的 SERP，
搜索量用已接的关键词概况。Apify 现在不用接。方案：每个品牌一份「关注设置」，每周把**回答全文与引用**都存进历史表，
按 open-seo 的办法算提及率 / 位次 / 声量份额 / 趋势，报表全用 docs/96 组件，变化大才出卡。
**难点是钱**：Claude 一次约 $0.10，是另外几家的 25 倍，默认一个品牌一个市场约 155 积分 / 月，其中 Claude 占八成（决策 462 / 463）。

## 1. Luoye 10-13 的需求，对照现状

| Luoye 要的 | 现在 | 方案 |
|---|---|---|
| SEO 报表：关键词排名 | 只有 Search Console 平均排名（自家站、准），没有指定词的排名追踪 | 关注词每周查 Google 前 20（§5.2），和 GSC 真实排名并排 |
| SEO 报表：品牌词搜索量 | 没有（关键词概况 WP300 已接，但没带逐月数） | 每月一次逐月搜索量 + Search Console 品牌词周曝光 |
| SEO 报表：SERP（搜索结果什么样） | 只在选题时抽查、不留 | 每周随排名一起存：AI 概览有没有我们、大家还在问、购物 / 视频块 |
| GEO a：品牌在各搜索平台的结果 | Google / Bing 结果页能查；AI 概览能查 | 并进排名追踪；AI Mode 第二期 |
| GEO b：设定关注的 Prompt | 有（品牌档案套句 + GSC 问句，默认 6 个） | 收进「关注设置」；加 AI 推荐 5–10 条（不塞品牌名）；改字 = 归档 + 新建 |
| GEO b：重点 Gemini、ChatGPT、**Claude** | ChatGPT、Gemini 有；**Claude 没有** | Claude 走 DataForSEO 模型接口 + 强制联网（§3.1） |
| GEO b：提到没有 / 第几 / 怎么说 / 引用了谁 / 竞品出没出现 | 只有「提到没有、引没引我们、引用网址」；竞品永远空 | 全部补齐（§5.3）；情感由模型判、附原话 |
| GEO（10-13 补充）：回答全文与引用资料都存、按时间留历史、能反查最常被引的域名 / 页面 | 都没存 | §5.5 数据表 + 反查视图 + 前后对比；§5.6 界面 |
| 数据接口：open-seo / DataForSEO / Apify 有没有 | —— | open-seo 全靠 DataForSEO（§4）；DataForSEO 够用（§3.1）；Apify 不需要（§3.2） |

## 2. 我们现在有什么（10-13 盘点）

### 2.1 开源仓：「内容与搜索」职责（WP154 / 155 / 158 / 159 / 160 / 166 / 169）

| 件 | 在哪 | 现在能做什么 | 缺什么（相对本需求） |
|---|---|---|---|
| 职责模板 `dtc.content`「内容与搜索」 | `packages/roles/roles/dtc/content.yml` | SEO 与 GEO 都并在这一条职责里；连接 Search Console（推荐）、GA4（可选） | 没有「关注设置」这一层（品牌词 / 竞品 / 关键词清单） |
| SEO 判断规则 | `packages/seo-core`（`signals.ts`、`picks.ts`、`daily.ts`） | 每天读 Search Console，只算六个信号（排名 3–20 的非品牌词、曝光高点击低、点击周降 30%、没一页专写、意图不符、长尾问句），出「今天值得动的 5 件事」 | **排名来自 Search Console 的平均排名**（自家站、准、免费），没有「指定关键词 × 市场」的排名追踪；没有品牌词搜索量 |
| SERP 抽查 | `packages/seo-core/src/serp.ts`，每日新页面选题前查一次 | 判断「这个词的结果页人群对不对」；每个市场每天最多 5 次 | 只用于选题判断，**不落历史**，不是排名报表 |
| GEO 每周探测 | `packages/seo-core/src/geo.ts` + `apps/server/src/seo-service.ts` `weeklyGeo()`（周一 08:30） | 问题清单（品牌档案套句 + Search Console 里像问句的查询，人改过的永远赢，默认 6 个、最多 10 个）× 平台（**ChatGPT、Gemini、Google AI 概览**）× 每个目标市场（按市场语言自动翻译）；判三件事：提没提品牌、引没引我们的域名、提到了哪些竞品（**竞品名单目前没人传**，所以永远是空）；缺位分两条路：改页面 / 交公关 | **没有 Claude**；没有「排第几」「怎么说（情感）」；**不存历史**——面板只读最近一周的 `seo_report` 卡，没有提及率趋势；竞品出现永远空 |
| 契约 | `packages/contracts/src/search-data.ts`（`AiPlatform` = chatgpt / perplexity / gemini / google_ai_overview / copilot）、`seo.ts`（`GeoQuestion`、`GeoProbeRow`、`GeoSettings`、`SeoWeeklyGeoPayload`） | 只加不删 | `AiPlatform` 里**没有 `claude`**、没有 `google_ai_mode`；`GeoProbeRow` 没有位次 / 情感 / 引用全文 |
| 看板组件 | `packages/deck/src/blocks.ts`：`seo.today`、`seo.page_revenue`、`seo.geo_visibility`（都是表格） | GEO 一张表：每个问题「N / M 个平台提到」+ 建议 | 注册表只有数字 / 表格 / 折线 / 时间线 / 键值 / 文字；没有趋势、对比、简报（docs/96 阶段 3 才补） |
| 面板 | `apps/workstation/src/components/seo/geo-questions.tsx`（职责页上「买家会问的问题」） | 开关、问几个、每周约多少积分、每个市场勾选、「现在跑一轮」 | 手写面板，不在组件目录里 |
| 技能 | `packages/skills/bundled/seo-judgment/SKILL.md` | 怎么写标题 / 小节；已改编 open-seo 的判断规矩（WP160，MIT，`NOTICE` 已署名） | —— |
| 搜索数据接口（本机侧） | `packages/search-providers`（DataForSEO / SerpApi / Serper 三个适配器）+ `packages/api/src/routes/search-data.ts` | 官方（积分）/ 自带 key / 不接三档；DataForSEO 适配器：SERP 走 `/v3/serp/{google,bing}/organic/live/advanced`（Google 带异步 AI 概览），ChatGPT / Gemini 走 `/v3/ai_optimization/{chat_gpt,gemini}/llm_scraper/live/advanced`，Perplexity 那段代码留着登记为不用 | 没有 Claude；没有关键词搜索量 |
| 价目 | `packages/metering/src/pricing.json` | `data.search.serp` 0.2 积分 / 次；`data.search.ai_answer` 0.2 积分 / 平台·次（09-27 定） | 成本按 07-01 涨价前的价算的，要复核（§3.1） |
| 教程 | `docs/help/search-data.md` | 三档说明 | 还写着「ChatGPT、Gemini、Perplexity」——Perplexity 09-27 已不探测，**文字过时**（小修，并进 §7 的开源单） |

### 2.2 私有云：接口中台（`packages/data-hub`，只读看）

| 能力 | 走哪家 · 什么接口 | 上游成本（按最贵记） | 积分价 | 状态 |
|---|---|---|---|---|
| `serp.google` / `serp.bing` | DataForSEO（包开源适配器，`adapters/search.ts`）· SERP Organic Live Advanced | 成本表 $0.004 / 次（Google 结果页 + 异步 AI 概览）；回包 `cost` 记实价（WP303） | 0.2（`data.search.serp`） | 渠道 `dataforseo-env` 开着；**账户现在只有试用额度 $1、暂不充值**（决策 435） |
| `ai_answer.chatgpt` / `ai_answer.gemini` | 同上 · AI Optimization **LLM Scraper** Live Advanced（网页端回答） | $0.004 / 次 | 0.2（`data.search.ai_answer`） | 同上 |
| `ai_answer.google_ai_overview` | 同上 · 一次 Google SERP 里取 `ai_overview` | $0.004 / 次 | 0.2 | 同上 |
| `seo.backlinks` / `seo.domain_rating` | Ahrefs 骨架（`adapters/ahrefs.ts`） | —— | **不定价 = 不卖**（条款不许转售） | 与新能力并存（决策 415） |
| `seo.keyword_overview` 关键词概况（搜索量 / CPC / 竞争度 / 难度 / 意图） | DataForSEO 直连（`adapters/dataforseo_seo.ts`，WP300）· Labs `keyword_overview/live`，一次 ≤ 100 词 | $0.024 / 次 | 0.88 | 后台新增能力（不在开源契约目录里）；不缓存（决策 411） |
| `seo.related_keywords` 相关词 | 同上 · Labs `related_keywords/live`（`depth: 2`，≤ 100 条） | $0.024 | 0.88 | 同上 |
| `seo.domain_overview` 域名概况 | 同上 · Labs `domain_rank_overview/live` | $0.01212 | 0.44 | 同上 |
| `seo.backlink_summary` 外链概况 | 同上 · Backlinks `summary/live` | $0.024036 | 0.88 | 同上 |
| Apify 各项（地图、Instagram、TikTok、Amazon、LinkedIn、Reddit） | Apify actor 白名单（`adapters/apify.ts`） | —— | 各自定价 | **没有任何 AI 回答 / AI 搜索类 actor**；渠道默认关 |

结论：**SERP、ChatGPT、Gemini、Google AI 概览的「问一次」接口都已经有了；关键词搜索量也有了（WP300）。缺的是：Claude、
排名追踪（指定关键词的历史）、品牌词搜索量的月度趋势、GEO 的位次 / 情感 / 历史趋势，以及把这些放进报表的那一层。**

## 3. 数据源能不能满足（10-13 读官方公开页，没调付费接口）

### 3.1 DataForSEO（现用批发商）

**AI 相关接口一览**

| 接口 | 能问哪些 AI | 回答从哪来 | 引用资料拿得到吗、长什么样 | 单价（每次） | 出处 |
|---|---|---|---|---|---|
| **LLM Scraper**（现在 ChatGPT / Gemini 用的就是它） | **只有 ChatGPT、Gemini**（价目页原话：目前只支持这两家） | 抓网页端，用户真看到的回答；不能指定模型（回包里带模型名） | **能**。`sources[]`：url、domain、title、snippet、publication_date（Gemini 还有 source_name、thumbnail）；ChatGPT 另有 `search_results[]`（它搜到的全部结果）、`brand_entities`（回答里的品牌实体）、`fan_out_queries`；正文 `markdown` 全文 | 排队 $0.0012 / 优先 $0.0024 / **即时 $0.004** | [价目](https://dataforseo.com/pricing/ai-optimization/llm-scraper)、[ChatGPT](https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced/)、[Gemini](https://docs.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/live/advanced/) |
| **LLM Responses** | ChatGPT、**Claude**、Gemini、Perplexity | 调各家官方模型接口（不是网页端）；`model_name` 必填，模型清单接口免费 | **能**（要开 `web_search`）。`sections[].annotations[]`：title、url（Claude 的 start / end_index、text 为空；Gemini 的 url 是跳转链接，原址在 `direct_url`）。文档写明：开了联网也可能拿到空引用；`force_web_search`（Claude、ChatGPT 有）也「不保证有引用」 | 排队 $0.0002 + 预扣 $0.01（多退，最长 72 小时出结果）/ 即时 $0.0006，**另加模型本身的钱**（原价转嫁，回包 `money_spent`） | [价目](https://dataforseo.com/pricing/ai-optimization/llm-responses)、[Claude](https://docs.dataforseo.com/v3/ai_optimization/claude/llm_responses/live/)、[Claude 模型清单](https://docs.dataforseo.com/v3/ai_optimization/claude/llm_responses/models/) |
| Google AI 概览 | —— | Google Organic SERP + `load_async_ai_overview` | 能。`ai_overview` 的 `references[]` | 一页的基础价 × 2：排队 $0.0012 / 即时 $0.004 | [Organic 价目](https://dataforseo.com/pricing/serp/google-organic-serp-api) |
| Google AI Mode | —— | SERP 的 AI Mode | 能（`references`） | 排队 $0.0012 / 即时 $0.004 | [AI Mode 价目](https://dataforseo.com/pricing/serp/google-ai-mode-serp-api) |
| LLM Mentions | 只有 Google AI 概览、ChatGPT（ChatGPT 仅美国英文） | **预先采集的库**（自称 2.8 亿条问答），问不了任意 Prompt | 有 `sources[]`（url、domain、rank） | $0.10 + $0.001 / 行；最低月消费已于 07-07 取消 | [价目](https://dataforseo.com/pricing/ai-optimization/llm-mentions)、[公告](https://dataforseo.com/update/extended-llm-mentions-api-release) |
| AI Keyword Data | 不分平台 | 「AI 搜索量」估算 | —— | $0.01 + $0.0001 / 词 | [价目](https://dataforseo.com/pricing/ai-optimization/ai-keyword-search-volume) |

**Claude 怎么问**：LLM Responses，`claude-sonnet-5`（模型清单里还有 sonnet-4-6 / 4-5、opus-5 / 4-x、haiku-4-5、fable-5 / 5-1，都标了支持联网），
`web_search: true` + `force_web_search: true`，`web_search_country_iso_code` 按市场（36 个国家），`user_prompt` ≤ 500 字符，`max_output_tokens` ≤ 4096（默认 2048；联网时可能超）。
**claude.ai 网页端谁都抓不了**：要登录，Anthropic 消费者条款也禁止自动化访问（[条款](https://www.anthropic.com/legal/consumer-terms)）；Apify 上声称做 Claude 的都是调 API。
所以 Claude 只能拿「Claude 联网回答」，和 claude.ai 上看到的会有出入——界面在问号里照实说一句。

**Claude 一次多少钱（估）**：模型价 Sonnet 5 输入 $2 / 输出 $10 每百万 token；联网搜索 $10 / 千次（一次回答常搜 1–3 次）；
搜到的网页按输入 token 计（约 1.5–3 万）。open-seo 实测 Sonnet 4.5（$3 / $15）带联网、输出上限 4096 时 $0.142 / 次。
按 Sonnet 5、输出上限 1024 估：搜索 $0.01–0.03 + 输入 $0.03–0.06 + 输出 ≈ $0.01 → **约 $0.05–0.10 / 次，按 $0.10 定价**——是 ChatGPT / Gemini 的 25 倍。
（[Anthropic 网页搜索工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)；Sonnet 5 单价取自 claude-api 技能 10-06 缓存的价目表）

**SEO 相关**

| 需要 | 接口 | 单价 | 备注 |
|---|---|---|---|
| 关注词排名 | Google Organic SERP，`depth: 20` + 异步 AI 概览 | 基础价每 10 条一份：排队 $0.0006 × 2 + AI 概览 $0.0006 = **$0.0018 / 词**（即时 $0.006） | 排队任务可设 `postback_url` / `pingback_url`，一次 ≤ 100 个任务；**没有内置定时**，定时归我们（[SERP 总览](https://docs.dataforseo.com/v3/serp/overview/)） |
| 品牌词逐月搜索量 | Labs `keyword_overview`（WP300 已接，≤ 700 词，我们限 100）：`keyword_info.monthly_searches`（过去 12 个月逐月）+ `search_volume_trend`（月 / 季 / 年变化 %） | $0.012 + $0.00012 / 词（100 词 $0.024） | **现在适配器没带回逐月数**，加两格即可（[文档](https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live/)） |
| 同上（更长历史） | Keywords Data Google Ads `search_volume`：`monthly_searches[]` 最多 4 年 | 排队 $0.06 / 即时 $0.09 每次（≤ 1000 词） | 要更长历史再用（[文档](https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/)） |
| Google Trends 相对热度 | Keywords Data Google Trends | $0.0027 / $0.011 每次（≤ 5 词） | 可选，不进默认 |

**价目要复核**：pricing.json 里 `data.search.*` 的成本是按 09-27 的即时价算的（SERP $0.004、ChatGPT / Gemini $0.004），10-13 核对公开价没变；
定时任务改走排队档后我方成本降到 $0.0012，0.2 积分的毛利从 85% 升到约 95%（见决策 469）。

### 3.2 Apify

我们的 Apify 渠道（`adapters/apify.ts`）里**没有任何 AI 回答类 actor**。商店里相关的（10-13 页面数字）：

| Actor | 平台 | 单价 | 用量 / 成功率 | 引用 | 取数方式 |
|---|---|---|---|---|---|
| [apify/chatgpt-search-scraper](https://apify.com/apify/chatgpt-search-scraper)（官方） | ChatGPT | $3 / 千次 | 500 用户，99.9% | `sources[]`（url、title、分 citations / attached / more） | 浏览器抓网页端 |
| [apify/google-ai-mode-scraper](https://apify.com/apify/google-ai-mode-scraper)（官方） | Google AI Mode | $2 / 千次 | 244，99.9% | `sources[]` | 抓取 |
| [apify/google-ai-overviews-scraper](https://apify.com/apify/google-ai-overviews-scraper)（官方） | Google AI 概览 | $1 / 千次 | 428，99.9% | `sources[]` | 抓取 |
| [apify/perplexity-search-scraper](https://apify.com/apify/perplexity-search-scraper)（官方） | Perplexity | $9 / 千次 | 361，100% | `sources[]` | 抓取（不再探测） |
| [khadinakbar/ai-search-brand-monitor](https://apify.com/khadinakbar/ai-search-brand-monitor)（社区） | ChatGPT、Gemini、Claude、Perplexity | $0.08 / 次检查 | 258，100% | `cited_urls` | 像是走 API，用谁的 key 未核实 |
| [desvela/brand-watch](https://apify.com/desvela/brand-watch)（社区） | 同上 | $0.08 / 次 + 启动 $0.02 | 5 用户 | 有 | 自称用作者自己的 API key |
| [inovaflow/ai-brand-monitoring](https://apify.com/inovaflow/ai-brand-monitoring)（社区） | AI 概览、AI Mode、Gemini、Perplexity、ChatGPT、Copilot | 启动 $0.20 + 平台用量 | 52，**85.7%** | 有 | 内部再调抓取 actor |

- **没有官方的 Gemini 网页端 actor**，**没有任何能抓 claude.ai 的 actor**（[Claude Prompt Actor](https://apify.com/automation_nerd/claude-prompt-actor) 要用户自带 Anthropic key）。
- 条款：Apify 条款写明输出归用户、合法性用户自负（[通用条款](https://docs.apify.com/legal/general-terms-and-conditions) §5.8、§11.1）；抓网页端违反 OpenAI / Google / Anthropic 的使用条款（[Google 条款](https://policies.google.com/terms)；OpenAI 条款原文页返回 403，未核实当前版本）。用 DataForSEO 的抓取也是同一类风险，只是由批发商去抓。
- 结论：**Apify 现在不需要接**；以后要做「同一能力多渠道、失败换下一家」时，官方 ChatGPT / AI Mode / AI 概览三个 actor 可作备用渠道（价与 DataForSEO 同一量级）。社区 actor 不用（不透明、用作者的 key）。

### 3.3 直连各家官方 API（对照）

| 厂商 | 联网怎么开 | 引用字段 | 价 | 出处 |
|---|---|---|---|---|
| Anthropic | `web_search` 工具（可设 `user_location`、`max_uses`） | `text.citations[]`，类型 `web_search_result_location`：url、title、`cited_text`（≤ 150 字）——**能知道哪句话引的哪条** | $10 / 千次搜索 + 搜到的内容按输入 token 计；出错不收 | [web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) |
| OpenAI | Responses API `web_search` 工具 | `annotations[]` 类型 `url_citation`：url、title、start / end_index；完整来源要加 `include: ["web_search_call.action.sources"]` | $10 / 千次 + 内容 token | [定价](https://developers.openai.com/api/docs/pricing)、[web search](https://developers.openai.com/api/docs/guides/tools-web-search) |
| Google | Gemini 「Grounding with Google Search」 | `url_citation`（url、title、start / end_index）；`groundingMetadata` 的字段名未核实 | Gemini 3：每月 5000 次免费，之后 $14 / 千次 | [定价](https://ai.google.dev/gemini-api/docs/pricing)、[grounding](https://ai.google.dev/gemini-api/docs/google-search) |

- 走 API 拿到的是「模型 + 联网」的回答，和 ChatGPT / Gemini 网页端看到的不一样；**ChatGPT / Gemini 继续用网页端抓取**（更接近买家真实看到的）。
- Claude 两条路钱差不多（DataForSEO 只多 $0.0006 手续费），DataForSEO 一个账户、对账已做（WP303）；直连 Anthropic 的好处是引用带 `cited_text`。**第一期走 DataForSEO**，直连留作备用渠道（决策 461）。

### 3.4 其它（只作对比）

- **Treg**（[用例页](https://treg.to/use-cases/how-ai-answers-mention-your-brand)，10-13 读）：AI 可见度货架上 cloro 的 Perplexity 回答 $0.0024、DataForSEO 的提及指标 $0.00586；**Gemini、Claude 不在货架上**。不用。
- **Semrush / Ahrefs / Similarweb / Otterly / Peec / Profound**：见 docs/81 补充（09-27）——条款禁止转售或只能看板，只适合以后「用户自带账号」；那时界面才写来源。
- **Cloudflare AEO**：只问 Claude 与 GPT、问题不能自定义、没 API（docs/81）。

## 4. open-seo 是怎么做的（读源码，commit `89e5a00`，2026-10-08，v0.1.12）

[every-app/open-seo](https://github.com/every-app/open-seo)：MIT（Copyright (c) 2026 Ben Senescu），10-13 约 2.3 万星；TanStack Start + Cloudflare Workers / Workflows / D1，
**所有 SEO 数据都来自 DataForSEO**；托管版 openseo.so（免费额度外 $10 / 月，加价 28%），也可自托管自带 DataForSEO key。
我们 WP160（`seo-judgment` 技能）与 WP300（`dataforseo_seo` 字段映射）已经借过它，`NOTICE` 已署名。

### 4.1 AI 可见度（AI visibility tracking）

| 方面 | 它的做法 | 出处（仓内路径） |
|---|---|---|
| 引擎 | ChatGPT、Gemini → DataForSEO **LLM Scraper**（网页端回答）；Google AI 概览 → Google Organic SERP + `load_async_ai_overview`；**Claude、Perplexity → LLM Responses**（调模型 API，DataForSEO 没有这两家的网页端抓取）；没接 AI Mode | `src/shared/ai-visibility.ts`、`src/server/lib/dataforseo/ai-tracking.ts`、`ai.ts` |
| 模型与联网 | 模型名从免费的 `/llm_responses/models` 目录取（缓存 1 小时）并在发请求前校验——**模型名写错的失败任务 DataForSEO 照样收钱**；联网默认开；**Claude 额外加 `force_web_search`**（注释：`web_search: true` 只是「允许」，模型常常不搜、于是没有引用）；输出上限 4096 token；按项目国家定位联网搜索 | `src/server/lib/dataforseo/llm-models.ts`、`ai.ts` 约 276–325 行 |
| 定时 vs 手动 | 定时：`task_post`（每批 ≤ 100）+ 免费的 `task_get` 轮询（间隔递增、最长 30 分钟）；手动与首次基线：Live，并发 6 | `AiVisibilityWorkflow.ts` |
| Prompt 从哪来 | 人录入、按主题分组（≤ 100 条、≤ 30 个主题）；**Prompt 文本不可改**——改 = 归档旧的、新建一条，历史永远对得上原句；AI 按网站资料一次生成「1 个主题 + 5 条买家视角提问」，**要求不在 Prompt 里塞品牌名**；另有「Prompt 调研」：`llm_mentions/search/live` 按 AI 搜索量取 100 条 + SERP，缓存 24 小时 | `aiVisibilityConfiguration.ts`、`aiPromptSuggestions.ts`、`aiPromptResearch.ts` |
| 提及 / 引用 | 品牌名或域名出现在正文 = 提及（Unicode 词边界正则，先屏蔽 URL 与邮箱，先删 `[1]` 这类引用标记）；引用了品牌域名或子域名 = 被引用；记首次提及的字符位置。注释自认：品牌名太通用会误判、不消歧 | `services/aiVisibilityMatching.ts`、`providers/dataforseoEvidence.ts` |
| 位次 | 同一条回答里各品牌按**首次提及先后**排 1、2、3…；汇总取平均名次 | `src/shared/ai-visibility-results.ts` |
| 提及率 / 引用率 | **分母只算拿到回答的**（失败 / 空回答不算「没提到」） | 同上 |
| 竞品差距 | 自家既没提及也没引用、但有竞品出现的回答 | `aiVisibilityResults.ts` |
| 趋势 | 以「Prompt × 引擎 × 市场 × 品牌」为单元，**只比两期都有数的单元**；任一期覆盖率 < 90% 就不显示变化 | `aiVisibilityTrend.ts` |
| 品牌词 / 非品牌词 | `aiPromptIsBranded`：Prompt 里带不带品牌名，分开看 | 同上 |
| 情感 / 声量份额 | **都没有**（全仓搜不到 sentiment；只有各品牌提及 / 引用汇总） | —— |
| 存什么 | `ai_trackers`（每项目一行：五个引擎开关、市场、频率 daily / weekly / monthly 默认 weekly、`next_check_at`）→ `ai_prompts` → `ai_runs`（baseline / scheduled / manual，同一时间只许一个）→ `ai_observations`（每次 × Prompt × 引擎一行，存回答 markdown）→ `ai_sources`（引用 url / 域名 / 标题 / 位置）、`ai_matches`（每品牌 mentioned / cited / first_mention，**品牌名与域名快照存下**，改名不影响历史）；保留 13 个月 | `src/db/ai-visibility.schema.ts` |
| 调度 | Cron 每 5 分钟认领到期的追踪器；单次 ≤ 1000 条回答（避开 DataForSEO 每分钟 2000 次） | `scheduledAiVisibility.ts`、`wrangler.jsonc` |
| 成本 | 写死单价：排队 $0.0012 / 条、Live $0.004 / 条；**模型 API 实测**（4096 输出上限）：Claude 带搜索估 **$0.18 / 条**（实测 claude-sonnet-4-5 $0.142）、ChatGPT API $0.09、Gemini API $0.11、Perplexity $0.04；先给预估与月度成本，手动跑超出用户批准的 `maxCostUsd` 就拒；计费请求遇 5xx 不重试 | `shared/ai-visibility.ts`、`pricing.ts` 约 120–135 行、`aiVisibilityRuns.ts`、`ai-tracking.ts` |

### 4.2 排名追踪（rank tracking）

- 接口：Google Organic `task_post` + `task_get/advanced`（定时），`live/advanced`（手动、排队失败兜底）；本地排名另用 Maps / Local Finder。
- 配置：设备 desktop / mobile / 两者；深度 10–100（10 的倍数）；国家、可选城市；频率 daily / weekly / monthly / manual；每个配置 ≤ 1000 个词。
- 排名取 `rank_group`（只在自然结果里数第几，不把 SERP 特征算进去），子域名也算我们。
- 存 `rank_snapshots`：每次 × 词 × 设备一行（位置，没找到 = null；落地 url；`serp_features` JSON）。
- 变化：1 / 7 / 30 / 90 天四个对比期，取目标日期前最近一次快照，没有就用最早那次当基线。
- 搜索量 / 难度 / CPC：Google Ads `search_volume/live` 与 Labs `keyword_overview/live` 二选一（查城市时两个都调再合并）。

### 4.3 我们借什么、不借什么

**借（做法，不搬代码；要搬的话照 MIT 署名，`NOTICE` 已有）**：
1. 按引擎分开取数：有网页端抓取的用抓取（用户真看到的回答），没有的退回模型 API；定时走排队（便宜），手动走 Live。
2. 发请求前校验模型名；**计费请求不重试**。
3. **历史不可变**：Prompt 改字 = 归档旧的 + 新建；品牌名 / 域名在匹配时快照。
4. 提及率分母只算拿到回答的；趋势只比两期都有数的单元，覆盖率 < 90% 不出变化。
5. 品牌词 Prompt / 非品牌词 Prompt 分开看；「竞品差距」视图。
6. 存储分层：追踪设置 → Prompt → 运行 → 观测（回答原文）→ 引用 / 品牌匹配。
7. Claude 用 `force_web_search`，否则常常没有引用。

**不借 / 补上它的短板**：它没有情感、没有声量份额、没有 AI Mode、品牌匹配不认别名；每个 Prompt 每次只采 1 个样本（AI 回答有随机性）——我们补别名、情感（模型判，§5.3）、声量份额。
**不装 open-seo 应用**（决策 398）。

## 5. 方案

总原则：**不新建职责、不新造卡种、不新造页面区块**。全在「内容与搜索」职责里做；信息走 docs/96 组件目录，
只有「要人定」的才出卡（改页面 = 改东西家族，交公关 = 接 / 交家族，这两条路 WP154 已经有）。

### 5.1 对象：每个品牌一份「关注设置」

现在散在 `seo-state.json`（问题清单、GEO 开关）和公司档案（市场）里，收成一份（按品牌，品牌是顶层，docs/52）：

| 项 | 内容 | 默认从哪来 | 人怎么改 |
|---|---|---|---|
| 我们 | 品牌名 + **别名**（简称、常见拼错、主推商品名）+ 自家域名 | 品牌档案 + 店铺商品名（取前 3） | 设置里增删 |
| 竞品 | 3–5 个：名字 + 别名 + 域名 | AI 推荐：品牌档案品类 + SERP 上和我们抢同一批词的域名（Labs `serp_competitors`）+ 上周 AI 回答里一起被点名最多的品牌 | 首次推荐出一张「改东西」卡（记下 / 改 / 不要）；之后在设置里改 |
| 关注的关键词（SEO） | 默认 20 个、上限 100：品牌词 2–3 个（「品牌名」「品牌名 + 品类」「品牌名 + reviews」）+ 品类核心词 | Search Console 曝光最多的非品牌词 + Labs 相关词按搜索量挑 + 品牌档案 | 同上（加 / 删 / 关） |
| 关注的 Prompt（GEO） | 默认 8 个、上限 20；分「带品牌名」与「不带品牌名」两类（不带的才是真实买家搜索的样子，默认占多数） | 沿用 WP154 的 `generateGeoQuestions`（品牌档案套句 + Search Console 里像问句的查询）+ **模型按品牌档案推荐 5–10 条买家视角提问**（不塞品牌名） | **改字 = 归档旧的 + 新建一条**（历史对得上原句，借 open-seo）；人改过的永远赢（WP154 规矩不变） |
| 市场 / 语言 | 公司档案 `WorkspaceProfile.markets`，每个市场按主要语言问（WP166 / 169 不变） | —— | 面板上可关掉某个市场的探测 |
| 关注的 AI | **ChatGPT、Gemini、Claude**（Luoye 点名的三家）+ Google AI 概览（已有、便宜，Google 搜索页上就有） | —— | 每个 AI 一个勾；Google AI Mode 先不进默认（见决策 464） |
| 频率 | 每周（周一早上，沿用现在的定时） | —— | 每周 / 每两周 / 每月 / 只手动 |

契约（只加）：`AiPlatform` 加 `claude`（以后要 AI Mode 再加 `google_ai_mode`）；新增 `BrandWatch`（上表）、`GeoQuestion` 加可选 `topic` / `branded` / `archived_at`。

### 5.2 监测：多久跑一次、每次跑什么

| 频率 | 跑什么 | 数据从哪来 |
|---|---|---|
| 每天（已有） | Search Console 六个信号 + 选题前 SERP 抽查 | GSC（免费）、官方 SERP |
| **每周**（默认，周一） | ① GEO：每个开着的 Prompt × 每个关注的 AI × 每个目标市场，各问一次；② 排名：每个关注的关键词 × 每个目标市场，查一次 Google 结果页前 20（同一次拿到 AI 概览、大家还在问、购物 / 视频等特征）；③ 品牌词在 Search Console 里的曝光 / 点击（免费、真实，作品牌热度的周度信号） | 官方数据接口；GSC |
| **每月**（1 号） | 品牌词 + 关注词的**月搜索量**（带过去 12 个月的逐月数，画趋势） | 官方数据接口（关键词概况一次 ≤ 100 个词） |
| 手动 | 「现在跑一轮」（已有按钮），跑前显示这一轮约多少积分 | —— |

几条规矩：
- **定时走排队、手动走即时**（排队档便宜，§3.1）；计费请求出错不自动重试（借 open-seo）。
- 一个 AI 某次失败 / 空回答：**不算「没提到」**，那一格这周记「没查成」、不收钱（与 docs/81 §4 规矩一致）。
- Claude 一定要强制联网（否则常常没有引用来源，§3.1）。
- 同一周同一格（Prompt × AI × 市场）只问一次；AI 回答有随机性，**看趋势不看单周**（4 周滚动）。

### 5.3 指标（怎么算，数不经模型手）

**SEO**

| 指标 | 算法 | 备注 |
|---|---|---|
| 关注词排名 | 结果页里**自然结果第几**（`rank_group`，SERP 特征不占位；子域名算我们）；前 20 没有 = 「20 名外」 | 每个市场分开；设备默认手机（见决策 466） |
| 排名变化 | 与上周、与 4 周前比；数「进前 10 / 掉出前 10」的词数 | 上一期没数的词不算变化 |
| 关注词平均排名 | 只平均进了前 20 的词，另报「20 名外几个」 | 不把 20 名外按 21 算，免得一个词把均值拖垮 |
| 品牌词搜索量趋势 | 品牌词逐月搜索量（12 个月）；同时并排 Search Console 里品牌词的周曝光 | 搜索量是**估算**（Google 只给区间），界面标「估算」，不写来源名 |
| SERP 特征 | 每个关注词：有没有 AI 概览、AI 概览里**提没提 / 引没引我们**、大家还在问、购物 / 视频块 | AI 概览随查随变，只看周度 |
| 对照：真实排名 | Search Console 的平均排名放在同一张表里作「真实」一列 | 第三方排名是一次抓取，GSC 是全量平均，两者不一致时以 GSC 为准 |

**GEO**（每条 Prompt × 每个 AI × 每个市场，一周一格）

| 指标 | 算法 | 备注 |
|---|---|---|
| 提到没有 | 回答正文出现品牌名 / 别名 / 域名（词边界匹配，先删引用标记、屏蔽网址）——沿用 `search-providers/analyze.ts` 的 `mentions`，加别名 | 规则判，不经模型 |
| 被引用 | 引用来源里有我们的域名（含子域名） | 规则判 |
| 第几位 | 回答里「我们 + 竞品」按**首次出现先后**排的名次；没提到 = 空 | 借 open-seo；只在已知品牌里排 |
| 竞品出现 | 竞品名单里谁被提到（名字 / 别名 / 域名）；另由模型从回答里抽「其他被推荐的品牌」，**只用来建议加竞品**，不进指标 | 修掉现在「竞品永远空」的问题 |
| 怎么说（情感） | 提到我们的那一段交给模型判「正面 / 中性 / 负面」+ 摘一句原话作依据 | 标「AI 判断」；没提到不判；拿不出原话就不出结论 |
| 被引用来源 | 去跟踪参数、去重后的网址与域名；按域名汇总「这周被各 AI 引用最多的 10 个站」，标出哪些是我们的 | 站外高频来源 → 交公关的线索（WP154 的 `pr_handoff`） |
| 提及率 | 提到我们的回答数 ÷ **拿到回答的**格数 | 失败 / 空回答不进分母 |
| 引用率 | 引用我们的回答数 ÷ 拿到回答的格数 | —— |
| 声量份额（SOV） | 我们被提到的次数 ÷（我们 + 各竞品被提到的次数） | 只在已知品牌里算 |
| 趋势 | 以上按周，按 AI、按市场、按「带 / 不带品牌名」分开；**只比两期都有数的格**；任一期覆盖 < 90% 不出变化 | 借 open-seo |

### 5.4 报表：按 docs/96 组件化

| 放在哪 | 组件 | 内容 | 出现 | 不出现 |
|---|---|---|---|---|
| 「内容与搜索」职责页看板 | **数字**（4 个） | AI 提及率、声量份额、关注词平均排名、品牌词月搜索量（各带小折线） | 有数据源、有数 | 没接搜索数据 → 不出（不出 0） |
| 同上 | **趋势**（多折线，2–4 条同单位） | 提及率按 AI 分三条（ChatGPT / Gemini / Claude）；或我们 vs 前两名竞品的声量份额 | ≥ 3 周有数 | 点不够 |
| 同上 | **表格** | ① Prompt × AI 方格：✓ 第几位 / ✗ / 没查成；② 关注词排名：排名、周变化、AI 概览里有没有我们、GSC 真实排名；③ 被引用最多的站 Top 10 | 有行 | 0 行 → 一句话 |
| 同上 | **对比**（柱状） | 我们 vs 竞品：提及次数 / 声量份额 | 有 ≥ 1 个竞品 | 没设竞品 |
| 首页 / 岗位页**简报** | 一行 | 「AI 里提到我们 38%（+5）· 关注词平均第 12（−1）」 | 每周一那份简报 | 没开监测、这周没跑成 |
| **卡片流** | 只出「要人定」的卡 | 改页面（改东西家族，WP154 已有）/ 交公关（接 / 交家族，已有）/ 首次推荐竞品与 Prompt（改东西）| **变化大才出**：某 AI 上提及率周跌 ≥ 15 个百分点；同一 Prompt 连续 2 周在 ≥ 2 个 AI 上缺位；关注词掉出前 10 且上周在前 5；新竞品在 ≥ 3 条回答里出现 | 没变化、只是数字波动；同一件事 14 天内交出去过（WP154 `HANDOFF_QUIET_DAYS`） |
| 问答（P4） | 一句话 + 组件 | 问「这周 Claude 提到我们没有」→ Prompt × AI 表格；「我们在 best X 排第几」→ 排名表 | 问了才出 | —— |

- 现在的周报卡 `seo_report` / `weekly_geo` 按决策 328 并进简报，具体决定才出卡；`seo.geo_visibility` 表格改读历史表、不再只读最近一张卡。
- **数据来源**：界面与 AI 回答只写「官方数据接口」或不写；搜索量 / 排名标「估算」，Claude 那一列在问号里说明「通过 Claude 联网回答取得，和 claude.ai 网页上看到的可能略有不同」；**不出现批发商名**。用户自带 Semrush / Ahrefs / Similarweb 账号时（以后）才写来源。
- 手写面板 `geo-questions.tsx` 收进设置里的「关注设置」，看板只留组件。

### 5.5 回答与引用：两样都存、按时间留历史（Luoye 10-13 补充，必须覆盖）

每条被追踪的 Prompt 在每个 AI（Gemini / ChatGPT / Claude，外加 Google AI 概览）、每个市场问出去之后，**两样都存**：

1. **回答全文**（markdown 原文 + 纯文本）：在它上面判「提没提我们、第几位、怎么说（情感 + 原话）、提到了哪些竞品」；
2. **回答下面列出的引用资料**：每条的网址 / 域名 / 标题 / 顺序；分出「我们的站 / 竞品站 / 电商平台 / 媒体评测 / 论坛社区 / 视频 / 其他」。

**判出来的结论可以重算，原文不能重来**——所以原文是真源，指标都从原文算；以后改了匹配规则（加别名、加竞品），
可以对历史原文**重算**，趋势不断档。

#### 数据表（本机品牌目录里的 SQLite；云上同构一份，见 §8 决策 467）

| 表 | 一行是什么 | 主要列 |
|---|---|---|
| `watch_settings` | 每品牌一行：关注设置（§5.1） | 品牌名 / 别名 / 域名、竞品 JSON（名字 / 别名 / 域名）、关注的 AI、市场、频率、`next_run_at`、开关 |
| `geo_prompts` | 一条 Prompt | `id`、`text`（**不可改**，改字 = 归档 + 新建）、`topic`、`branded`（带不带品牌名）、`origin`（brand / top_query / ai_suggest / human）、`enabled`、`created_at`、`archived_at` |
| `watch_runs` | 一轮监测 | `id`、`kind`（geo / rank / volume）、`trigger`（scheduled / manual / baseline）、`period`（周一日期或月份）、`status`、`planned`（格数）、`answered`、`credits` |
| `geo_answers` | 一次问答（Prompt × AI × 市场 × 那一轮） | `id`、`run_id`、`prompt_id`、`prompt_text`（快照）、`asked_text`（翻译后真问出去的那句）、`platform`、`model`（如 `claude-sonnet-…`；网页端抓取写 `web`）、`via`（`web_ui` 网页端 / `model_api` 模型接口带联网 / `serp` 结果页）、`market`、`language`、`status`（ok / empty / failed）、`answer_md`（**全文**）、`answer_hash`、`fetched_at`、`credits` |
| `geo_citations` | 回答里的一条引用 | `answer_id`、`position`（1 起，按回答里出现的顺序）、`url`（原样）、`url_norm`（去 utm / gclid 等跟踪参数、去 `www.`、去尾斜杠）、`domain`、`title`、`snippet`（有就存）、`where`（`inline` 正文里引用的 / `listed` 只列在来源里 / `searched` 只在搜索结果里）、`site_kind`（ours / competitor / marketplace / media / forum / video / other） |
| `geo_mentions` | 一条回答里一个品牌（我们 / 各竞品）的判定 | `answer_id`、`entity`（ours / 竞品 id）、`name_snapshot`、`alias_hit`、`mentioned`、`cited`、`first_offset`、`rank`（按首次出现先后，在已知品牌里排）、`sentiment`（positive / neutral / negative，只对我们判）、`sentiment_quote`（原话一句）、`rules_version` |
| `seo_rank_snapshots` | 一个关注词一次排名 | `run_id`、`keyword`、`market`、`device`、`rank`（20 名外 = null）、`url`、`serp_features`（JSON：ai_overview / paa / shopping / video）、`aio_mentions_us`、`aio_cites_us`、`fetched_at` |
| `seo_keyword_volume` | 一个词一个月的搜索量 | `keyword`、`market`、`month`、`search_volume`、`fetched_at`（同一月份新抓的覆盖旧的） |
| `domain_kinds` | 域名分类缓存 | `domain`、`site_kind`、`by`（rule / model / human）——先查内置表（reddit / quora / youtube / amazon / walmart / wikipedia…），认不出的交模型判一次并缓存，人可改 |

留存：回答全文与引用默认留 **13 个月**（借 open-seo；够做同比）；按周汇总的指标永久留。用户可以导出、可以删（docs/21 数据边界）。
量级：20 个 Prompt × 4 个 AI × 1 个市场 × 52 周 ≈ 4 千条回答 / 年，每条约 5 KB → 一年约 20 MB，本机与云上都不是负担。

#### 反查：哪些域名 / 页面最常被引用

- **按域名**：一段时间内（默认近 4 周）被引用的次数、出现在几条 Prompt、几个 AI 里、类型、和上一段比的变化（新冒出来的标「新」）；
- **按页面**（`url_norm`）：同上，粒度到页——「这篇 Reddit 帖子 / 这篇评测被 3 个 AI 引了 5 次」，就是公关该去的地方；
- **我们自己的页**：哪几页被引用、被哪个 AI 引——被引的页别乱改（改页面卡上提示「这页正被 ChatGPT 引用」）；
- **竞品的页**：竞品哪几页被引得多，是我们写对比页 / 补内容的参照。

这四个视图都是 `geo_citations` 上的分组查询（命名查询，docs/29），不经模型。

#### 前后对比

- 同一格（Prompt × AI × 市场）本周 vs 上周：提及从有到无 / 从无到有、名次变化、情感变化、**引用来源的增减**（新增了哪些站、哪些站不见了）；
- 只比两期都拿到回答的格（§5.3）。

### 5.6 界面：回答和引用怎么展示（少字，按 docs/96）

| 层 | 组件 | 长什么样 |
|---|---|---|
| 看板（职责页最上） | 表格：Prompt × AI 方格 | 每格一个符号：绿点 + 名次（「2」）= 提到了、蓝色链接角标 = 引用了我们、灰叉 = 没提到、空 = 没查成；行尾一个小箭头表示比上周升 / 降 |
| 同上 | 表格：被引用最多的站 Top 10 | 域名 · 类型小标（我们 / 竞品 / 论坛 / 媒体 / 电商）· 次数 · 几个 AI · 变化箭头；点开是这个站被引的页面清单 |
| 点方格的一格 → 右栏「依据」（docs/96 决策 335，不离开卡片流） | 「一条回答」组件 | 顶上一行：AI 名 · 市场 · 日期 · 情感小标；正文默认折叠成前 3 行，**品牌名高亮**（我们绿、竞品橙），点开看全文；下面是编号引用列表（1. 域名 · 标题，类型小标；我们的站排前面加粗）；底部一个切换「和上周比」：正文改用增删标色、引用列表标「新」「不见了」 |
| 同上 | 时间线 | 这一格过去 12 周：每周一个点（提到 / 没提到 / 没查成）+ 名次 |
| 卡片流 | 只在要人定时出卡 | 「改这页」卡的依据里附那几条回答与引用；「交公关」卡的依据里附被引最多、却没提我们的那几个站 / 页 |

文字纪律：界面不写「这是什么」的说明；AI 名用平台名（ChatGPT / Gemini / Claude / Google AI 概览），**不写取数方式与批发商名**；
Claude 那一列在问号里一句「通过 Claude 联网回答取得，与 claude.ai 网页上看到的可能略有不同」（如果走的是模型接口，§3）。

## 6. 成本：每个品牌每月多少积分（docs/77 口径：1 积分 = ¥1，汇率 7.1，加云端摊销 ¥0.001，毛利 ≥ 80%，向上取整到 0.1）

**单价**

| 能力 | 我方成本（一次，按贵的估） | 建议价 | 毛利 | 状态 |
|---|---|---|---|---|
| AI 问答 · ChatGPT / Gemini / Google AI 概览（`data.search.ai_answer`） | 即时 $0.004；定时改排队 $0.0012 | **0.2**（不变） | 85%（即时）/ 约 95%（排队） | 已上架 |
| AI 问答 · **Claude**（新，`ai_answer.claude`） | 约 $0.05–0.10，按 $0.10 → ¥0.711 | **3.6** | 80.3% | 新；真账单满 20 次后按实价重算（决策 462） |
| 关注词排名（新，`seo.rank_check`：Google 前 20 + AI 概览，排队） | $0.0018 → ¥0.0138 | **0.1** | 86% | 新（决策 465） |
| 关键词概况（逐月搜索量，≤ 100 词一次） | $0.024 | 0.88（决策 409 已定） | 80.5% | 已上架，适配器补两格 |
| 情感 / 域名分类 / Prompt 推荐 / 翻译 | 品牌自己的模型网关 | 照 AI 使用计 | —— | 不另收探测费 |

**默认一个品牌、一个市场**（8 个 Prompt × 4 个 AI，20 个关注词，每周；一个月按 4.33 周）

| 项 | 每周 | 每月 |
|---|---|---|
| ChatGPT + Gemini + AI 概览：8 × 3 × 0.2 | 4.8 | 20.8 |
| Claude：8 × 3.6 | 28.8 | **124.7** |
| 关注词排名：20 × 0.1 | 2.0 | 8.7 |
| 品牌词逐月搜索量：每月一次 | —— | 0.9 |
| **合计** | | **约 155 积分 ≈ ¥155** |
| 对照：Claude 改每两周一次 | | 约 93 |
| 对照：不开 Claude | | 约 30 |

- **Claude 占八成**。界面上「关注的 AI」那一行，Claude 的勾旁边直接写它一个月约多少积分（数由服务端算）。
- 多一个市场就多一份（与 docs/81 WP166 同口径）；多一个 Prompt 每月多约 18 积分（其中 Claude 约 15.6）。
- 我方成本：默认一品牌一市场约 **$2.7–3.8 / 月**（Claude $2.4–3.5 + 其余约 $0.3）。
- 对照：同类看板产品起步 $29 / 月（约 ¥206，docs/81 补充），且多半不含 Claude。
- 跑之前：面板与「现在跑一轮」都先显示这一轮约多少积分；单次 ≥ 1 积分（Claude 那几格）按 docs/75 口径**一轮合并确认一次**，不逐格弹。

## 7. 差距与拆单

**现在就能做（不用新接口）**：ChatGPT / Gemini / AI 概览的回答全文与引用（LLM Scraper 回包里本来就有，现在只留了 600 字节选和网址列表）、
引用的标题与顺序、位次、竞品、提及率 / 声量份额 / 趋势、历史表、报表组件、Search Console 品牌词周曝光、关键词概况的逐月搜索量（适配器补两格）。

**要新接**：Claude（LLM Responses）、关注词排名（SERP 排队档、深度 20、异步任务）、ChatGPT / Gemini 定时改排队档。

| 单 | 仓 | 内容 | 大小 | 依赖 |
|---|---|---|---|---|
| **C1** 云端：Claude 与排名追踪 | 私有云 | `ai_answer.claude`（LLM Responses 即时档——排队档最长 72 小时、只省 $0.0004；发请求前用免费模型清单校验模型名、`force_web_search`、输出上限 1024、读回包 `cost` 记实价、空引用照收但标出）；`seo.rank_check`（异步任务：`task_post` 批 ≤ 100 + `postback` / 轮询，深度 20 + AI 概览）；ChatGPT / Gemini / AI 概览加排队档的异步口（定时用，手动仍即时）；关键词概况带回 `monthly_searches` / `search_volume_trend`；`pricing.json` 两条 + 成本表；回包里的回答全文与结构化引用原样带回（不再只给节选）；替身与冒烟；计费请求不自动重试 | 中 | 无 |
| **O1** 契约与存储 | 开源 | 契约只加：`AiPlatform` 加 `claude`；`AiAnswerResult` 加可选 `answer_markdown`、`citations[]`（url / title / position / where）、`model`、`via`；`BrandWatch`；`GeoQuestion` 加 `topic` / `branded` / `archived_at`；能力目录加 `ai_answer.claude`、`seo.rank_check`；`search-providers` 的 DataForSEO 适配器加 Claude（自带 key 那档也能用）并带回全文与引用；`analyze.ts` 加别名、首次出现位置、`url_norm`；§5.5 的 SQLite 表与迁移（把 `seo-state.json` 里的问题清单与开关搬进来）；导出 / 删除 | 中 | 与 C1 并行（契约先合） |
| **O2** 监测与指标 | 开源 | 每周 GEO 写历史；排名追踪；每月搜索量；§5.3 全部指标（覆盖 < 90% 不出变化）；情感（模型判 + 原话）；域名分类（内置表 + 模型一次 + 缓存）；竞品推荐（首次出「改东西」卡）；Prompt 推荐 5–10 条（不塞品牌名）；「变化大才出卡」规则并进现有改页面 / 交公关两条路；成本预估与一轮合并确认 | 大 | O1、C1 |
| **O3** 界面与报表 | 开源 | 看板：数字 ×4、趋势、Prompt × AI 方格表、关注词排名表、被引用最多的站 Top 10、我们 vs 竞品对比；右栏依据里「一条回答」组件（全文折叠 + 品牌高亮 + 编号引用 + 和上周比）与时间线；设置里「关注设置」（收掉手写面板 `geo-questions.tsx`）；简报一行；问答出组件；教程 `docs/help/search-data.md` 改（删 Perplexity、加 Claude 一句）+ 新教程「AI 回答监测」 | 中到大 | O2；组件注册表等 docs/96 阶段 3（趋势 / 对比没好就先用现有折线 / 表格） |
| C2 云端跑与云端留存（第二期） | 私有云 + 开源 | 电脑关着也每周跑：监测搬到云端定时，历史表云上一份、本机同步 | 中 | 决策 467 |

顺序：C1 与 O1 并行 → O2 → O3；C2 等第二期。验收：用 Rollout 品牌在真机跑一轮（DataForSEO 要先充值，决策 435 目前只有试用额度 $1；默认一轮约 $0.9，试用额度只够一轮）。

## 8. 要 Luoye 定的事（决策 460–473）

| # | 事 | 建议 |
|---|---|---|
| 460 | GEO 默认关注哪几个 AI | **ChatGPT、Gemini、Claude + Google AI 概览**（概览已有、便宜，就在 Google 搜索页上）；每个 AI 可单独关 |
| 461 | Claude 怎么拿 | 走 DataForSEO LLM Responses：`claude-sonnet-5`、强制联网、输出上限 1024；直连 Anthropic 留作备用渠道。claude.ai 网页端没人能抓、条款也禁止，界面问号照实说「通过 Claude 联网回答取得」 |
| 462 | Claude 单价 | 新能力 `ai_answer.claude` **3.6 积分 / 次**（按 $0.10 成本、毛利 80%）；真账单满 20 次后按实价重算（可能降到 2.5 左右） |
| 463 | 默认规模与频率 | 每周；8 个 Prompt、20 个关注词、1 个市场 → **约 155 积分 / 月 / 品牌**（Claude 占 125）。备选：Claude 每两周一次 → 约 93。建议先每周（Luoye 点名要盯 Claude，趋势也可比），面板上写清 Claude 的那份 |
| 464 | Google AI Mode | 先不进默认，第二期做成可选勾（DataForSEO 有，$0.0012–0.004 / 次） |
| 465 | 关注词排名的新能力 | `seo.rank_check`：Google 前 20 + AI 概览，排队档，**0.1 积分 / 词·次** |
| 466 | 排名默认设备 | **手机**（美国电商流量多在手机）；可改电脑或两者都查（两者 = 两份钱） |
| 467 | 回答与引用的历史存哪 | 第一期**本机品牌目录**（三档通用、和现在一样在本机跑）；电脑关着也照跑的云端监测与云端留存放第二期（C2），跟「长程任务数据上云」一起做 |
| 468 | 品牌词搜索量 | 用已上架的「关键词概况」每月一次（≤ 100 词 0.88 积分），取过去 12 个月逐月数；不另接 Google Ads 搜索量口（要 4 年历史再说） |
| 469 | ChatGPT / Gemini / AI 概览的定时探测改走排队档 | 改；价不动（0.2），我方成本从 $0.004 降到 $0.0012；手动「现在跑一轮」仍即时 |
| 470 | 情感（「怎么说」）用模型判 | 同意用模型：只对提到我们的回答判正面 / 中性 / 负面，**必须附原话**，标「AI 判断」；提及、引用、位次、比率仍是规则算（数不经模型手） |
| 471 | Apify | 现在不接 AI 回答类 actor；官方 ChatGPT / AI Mode / AI 概览三个 actor 记作以后的备用渠道；社区 actor（含号称能测 Claude 的）不用 |
| 472 | 给 DataForSEO 的书面确认 | 与决策 411 同一封邮件，加问一句「客户付费取得的回答与引用，可以长期保存给该客户看历史」 |
| 473 | 回答全文与引用留多久 | 默认 **13 个月**（够做同比）；按周汇总的指标永久留；用户可导出、可删 |

## 附：出处与日期

- 开源仓（本分支 `wp/307-geo`，基于 main `62c3c45f`）：`packages/seo-core/src/geo.ts`、`apps/server/src/seo-service.ts`、`packages/contracts/src/{search-data,seo,data-service}.ts`、`packages/search-providers/src/{analyze.ts,providers/dataforseo.ts}`、`packages/deck/src/{blocks,queries}.ts`、`apps/workstation/src/components/seo/geo-questions.tsx`、`packages/metering/src/pricing.json`、`packages/roles/roles/dtc/content.yml`。
- 私有云（只读，`43d2d19e`）：`packages/data-hub/src/{catalog,seed}.ts`、`adapters/{search,dataforseo_seo,apify,ahrefs}.ts`、`packages/metering/src/cost-table.json`、`docs/data-adapters/dataforseo_seo.md`。
- open-seo：https://github.com/every-app/open-seo ，commit `89e5a00`（2026-10-08），MIT；只读源码，没装依赖、没跑。
- 外部页面（都是 2026-10-13 读）：正文各表格内链接。读不到原文的写「未核实」：LLM Scraper 排队档多久出结果、SERP 任务结果保留多久、Gemini `groundingMetadata` 字段名、OpenAI 条款当前原文、各 Apify actor 的最后更新日期。
