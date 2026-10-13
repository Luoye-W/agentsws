# WP307 SEO / GEO 监测：现状盘点、数据源核实与方案（只调研 + 写方案，不实现）

worktree `../agentsws-wt/wp307-geo` · 分支 `wp/307-geo`（从 main 新起）。产出是一份方案文档 `docs/99-SEO与GEO监测-v1.md` + 报告，**不改业务代码**。

## Luoye 10-13 的需求（原话整理）
1. **SEO**：要有报表——SERP（关键词排名 / 搜索结果）、**品牌词的搜索量**等数据。
2. **GEO**：
   a. **搜索结果监测**：看品牌在几个主要搜索平台上的搜索结果是什么样。
   b. **设定关注指标**：一个品牌做 GEO，要先设定要关注的内容——列出几条常见、和这个品牌最相关的 **Prompt**，持续监测 AI 的回答（有没有提到品牌、排第几、怎么说、引用了哪些来源、竞品出现没有）。**重点监控 Gemini、ChatGPT、Claude**（美国用户最常用的三个）。
3. **数据接口**：这类监控 open-seo 里好像有；不确定我们现在用的 DataForSEO、或者接的 Apify 有没有类似功能——要确认，再看怎么完善。

## 要做（调研，写清事实与出处）
1. **我们现在有什么**：
   - 开源仓「内容与搜索」职责（岗位模板、工具、`seo-judgment` 技能、`docs/81-搜索数据接口-SERP与AI问答探测-v1.md`、相关看板 / 报表组件）；
   - 私有云接口中台已有能力：`serp.google`、`serp.bing`、`ai_answer.chatgpt`、`ai_answer.gemini`、`ai_answer.google_ai_overview`、`seo.backlinks`、`seo.domain_rating`，以及 WP300 新接的 DataForSEO SEO 四项（关键词概况 / 相关词 / 域名概况 / 外链概况）——私有仓 `~/Documents/agentsws-cloud` 只读看 `packages/data-hub`；每项走的是哪家、什么接口、价格。
2. **数据源能不能满足**（读官方公开文档，不调付费接口）：
   - **DataForSEO**：SERP API（Google / Bing 等）、Keywords Data（品牌词搜索量与趋势）、**AI Optimization API**（LLM Responses / LLM Mentions 等——核实支持 ChatGPT、Gemini、**Claude**、Perplexity 哪些、能否指定模型与联网、回包里有没有被引用来源、价格）、Google AI Overview / AI Mode。
   - **Apify**：有没有可用的 AI 回答 / AI 搜索监测 actor（ChatGPT、Gemini、Claude、Perplexity、Google AI Mode），成功率、价格、条款风险。
   - **open-seo**（github.com/every-app/open-seo，MIT）：它的「AI visibility tracking」「rank tracking」怎么做的（用了哪些 DataForSEO 接口、指标怎么算、调度频率、存什么），哪些做法值得借鉴。
   - 其它（如 Treg 目录里 AI 可见度相关的上游）只作对比。
3. **方案**（写进 docs/99）：
   - **对象**：每个品牌的「关注设置」——品牌词 / 竞品词、关注的关键词清单（SEO）、关注的 Prompt 清单（GEO，默认由 AI 按品牌档案推荐 5–10 条、人可改）、目标市场 / 语言、关注的 AI（默认 Gemini / ChatGPT / Claude）。
   - **监测**：多久跑一次（建议每周，人可改）、每次跑什么、怎么控成本（每品牌每月预估花费，按 docs/67 积分口径）。
   - **指标**：SEO——关键词排名与变化、品牌词搜索量趋势、SERP 特征（AI 概览出没出现品牌）；GEO——每条 Prompt × 每个 AI：提到没有、第几位、情感倾向、被引用来源、竞品出现情况、提及率（share of voice）趋势。
   - **报表**：按 docs/96 组件化（数字 / 趋势 / 表格 / 对比），每周简报里出一行，变化大才出卡；数据来源对用户不提批发商名（只有 Semrush / Ahrefs / Similarweb 才说）。
   - **差距与拆单**：哪些现在就能做、哪些要新接接口、拆成几单（开源仓 / 私有云各几单）、每单大小。
   - **要 Luoye 定的事**单列、每条附建议（决策号从 450 起）。

## 补充（Luoye 10-13）：GEO 回答与引用都要监测
每条追踪 Prompt 在 Gemini / ChatGPT / Claude 上问出去后，两样都存、都监测，按时间留历史、能前后对比：
1. **AI 的回答**：品牌提没提、排第几、怎么描述、情感、带出哪些竞品。
2. **AI 引用的资料**：每条引用的 URL / 域名 / 标题 / 顺序，属于自家站、竞品站还是第三方媒体 / 论坛；能反查最常被引用的域名和页面。

这两样是后续 GEO 优化的基础。方案要写清：各平台怎么拿到引用（官方 API 的搜索 / grounding 字段、DataForSEO AI 接口、Apify actor 各自能否拿到、形状、单价）、表结构、界面怎么展示（按 docs/96）。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不改业务代码；私有云仓只读。只提交 docs/99 与报告 `docs/briefs/reports/WP307.md`。不合 main、不打 tag、不发版。
