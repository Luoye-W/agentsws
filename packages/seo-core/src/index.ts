/**
 * `@agentsws/seo-core`（WP154「内容与搜索」）：`dtc.content` 那条职责里 SEO 与 GEO 的**判断**。
 *
 * 纯逻辑 + 注入 IO：没有 `Date.now()`、没有 `fetch`、没有模型调用、碰不到一个凭据。
 * 出卡、开事项、定时这些副作用在服务端（`apps/server/src/seo-service.ts`）。
 *
 * | 模块 | 干什么 |
 * |---|---|
 * | `signals` | 读 Search Console：只算六个信号（文章第 1 步），其余不看 |
 * | `picks` | 判断：每个查询一件、定车道（改页 / 新页 / 交建站 / 交公关）、先修再写地排 |
 * | `serp` | 写新页之前看一眼 SERP：排前面的是不是对的人群（文章第 5 步） |
 * | `daily` | 早上那一轮：读 → 判断 → 5 件（没接搜索数据接口就跳过 SERP，照跑） |
 * | `attribution` | 点击之后看转化：按页面并排点击 / 订单 / 收入（Shopify `landing_site`） |
 * | `geo` | 买家会问的问题、各 AI 平台的探测小结、缺位建议 |
 * | `geo-strategy` / `geo-metrics` / `geo-cost` / `geo-judge` | WP321：关注策略（AI 建议、兜底 5 条）、指标与「变化大才出卡」、一轮花多少、交给模型的情感与站点分类 |
 * | `geo-grid` | WP335：看板的 Prompt × AI 方格、一格的时间线、简报那一行 |
 * | `quality` | 发布前质检：事实对得上知识库、数字有出处、没有违规宣称 |
 * | `ports` | Search Console 口与搜索数据口的替身（不联网） |
 * | `google` | WP158：GSC / GA4 真读数的纯逻辑（请求体、返回怎么认、日期窗口、错误的人话） |
 *
 * GEO 的思路参考过 GEOFlow（AGPL-3.0）的公开 README；**代码一行没搬**，全部自己写。
 */

// WP396（docs/106 §13）：自家 Amazon Listing 体检的规则表与判法
export * from './amazon-listing-check.js'
export * from './attribution.js'
export * from './claim-rules.js'
export * from './daily.js'
export * from './demo.js'
export * from './drafts.js'
export * from './geo.js'
export * from './geo-cost.js'
export * from './geo-grid.js'
export * from './geo-judge.js'
export * from './geo-metrics.js'
export * from './geo-prompts.js'
export * from './geo-strategy.js'
export * from './google.js'
export * from './picks.js'
export * from './ports.js'
export * from './quality.js'
export * from './serp.js'
export * from './signals.js'
