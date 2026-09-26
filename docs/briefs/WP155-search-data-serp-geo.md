# WP155 第三方搜索数据接口：SERP 查询 + 主流 AI 平台问答探测（SEO / GEO 共用）

worktree `../agentsws-wt/wp155-search-data` · 分支 `wp/155-search-data`（从 main 新起）。先读 `_common.md`、`docs/75-数据接口路由与自带数据接口-v1.md`（WP126：官方接口走积分 / 自带数据接口 / 失败退款）、
`docs/77-积分价目重算-v1.md`（**数据接口与体检类毛利不低于 80%**）、`packages/metering/src/pricing.json`、`packages/cloud-entry`（官方数据接口的云端入口）、WP126 与 WP129 的实现（红人数据的路由与计费写法照抄）。

## Luoye 09-26 定
网页搜索用**第三方 SERP**；GEO 也用**第三方**去看各主流平台（ChatGPT、Perplexity、Gemini、Google AI 概览、Copilot 等）的问答情况。不用 dsh 的 Exa / Perplexity 搜索插件。

## 要做
1. **选服务商**（先调研再实现，结论写进新文档 `docs/80` 之后的下一个号 `docs/81-搜索数据接口-SERP与AI问答探测-v1.md`）：对比至少三家（候选：DataForSEO——同时有 SERP API 与 LLM / AI 回答类接口；SerpApi；Serper；以及专门做 AI 可见度的服务），比：
   覆盖哪些搜索引擎与 AI 平台、按国家 / 语言、单价（每千次）、有没有 AI 概览字段、条款是否允许我们转售 / 作为官方数据接口、数据保留、国内能不能直连。**每条都要有官方文档出处链接**，查不到的写「未核实」。推荐一家做首选（最好 SERP 与 AI 问答同一家，一把 key），另一家做备选。
2. **契约**（`packages/contracts/src/search-data.ts`，只加）——WP154 会按这个形状消费，**字段名照这个，不许改**，要加字段只加可选的：
   ```ts
   export type SearchEngine = 'google' | 'bing'
   export type AiPlatform = 'chatgpt' | 'perplexity' | 'gemini' | 'google_ai_overview' | 'copilot'
   export interface SerpQuery { query: string; engine: SearchEngine; country: string; language: string; device?: 'desktop' | 'mobile' }
   export interface SerpItem { position: number; url: string; domain: string; title: string; snippet?: string; type: 'organic' | 'shopping' | 'video' | 'forum' | 'other' }
   export interface SerpResult { query: SerpQuery; items: SerpItem[]; ai_overview?: { text: string; cited_urls: string[] }; people_also_ask?: string[]; fetched_at: string; source: string }
   export interface AiAnswerProbe { question: string; platforms: AiPlatform[]; country: string; language: string; brand: { name: string; domains: string[] } }
   export interface AiAnswerResult { platform: AiPlatform; answer_excerpt: string; brand_mentioned: boolean; our_domain_cited: boolean; cited_urls: string[]; competitors_mentioned: string[]; fetched_at: string; source: string }
   export interface SearchDataStatus { configured: boolean; route: 'official' | 'byo' | 'none'; reason?: string }
   export interface SearchDataPort {
     status(): Promise<SearchDataStatus>
     serp(q: SerpQuery): Promise<SerpResult>
     aiAnswers(p: AiAnswerProbe): Promise<AiAnswerResult[]>
   }
   ```
3. **路由照 WP126**：官方接口（走积分，云端用我们的服务商 key，key 由 Luoye 用 `wrangler secret put` 自己敲，**不经 AI**）→ 自带 key（用户在原生表单填，存本机加密库）→ 都没有就 `route: 'none'` + 人话。**命中缓存也收同样的钱、失败退还预扣**（Luoye 09-21 定的规矩）。
4. **计费**：`pricing.json` 加 `data.search.serp`、`data.search.ai_answer`（按次；AI 问答按「每个平台一次」计），`block: data`，`basis` 写清成本与毛利 ≥ 80% 的算法，`reviewed_at` **留空**——价格要 Luoye 定，报告里给建议价。
5. **连接页 / 设置页**：「搜索数据」一行：官方（用积分）/ 自带 key（选服务商 + 填 key）/ 不接，照数据接口现有的写法。
6. **测试**（不联网）：服务商适配器用录好的替身响应解析成契约形状；路由三档；预扣与失败退款；缓存命中照收；key 不进日志与响应。

## 纪律
不调用真服务商、不用任何真 key；不跑批量清理命令；不读 .env*；不部署。研究时可以用 WebFetch / gh 读服务商公开文档。截图 demo 端口 4443。

## 验证（审核方全量用）
`vitest run packages/contracts packages/cloud-entry packages/metering apps/server apps/workstation apps/cloud apps/cloud-worker` + `wrangler deploy --dry-run --containers-rollout=none` + `gen-sdk` / `gen-cloud-openapi` / `gen-ontology --check`。
