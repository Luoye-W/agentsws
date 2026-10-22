/**
 * `@agentsws/social-core`（56 §3）：九条渠道职责共用的**能力**，不是职责。
 *
 * 同 `kol-core` / `support-core` 的纪律：纯逻辑 + 注入 IO。这个包里没有
 * `Date.now()`、没有 `fetch` 的实现（只有一个注入口）、没有模型调用、
 * 碰不到一个凭据。九条渠道职责（`packages/roles` 的 `roles/social/*.yml`）
 * 与服务进程那一侧调它。
 *
 * 六个模块按"能力"归类而不是按渠道：
 *
 * | 模块 | 干什么 |
 * |---|---|
 * | `calendar` | 内容日历（本周 / 下周）、排期撞车、下一个空档 |
 * | `triage` | 封闭六类分类 + **转客服卡**（56 的那条边界就在这里） |
 * | `voice` | 品牌话术：只取公司层技能，不编；出站过承诺扫描 |
 * | `broadcast` | 群发受众、抑制名单、频率；WhatsApp 的两道硬闸 |
 * | `moderation` | 群规匹配与分级（封禁要人点） |
 * | `channels` | 各渠道适配器（WP191 起加了 FB 主页 / IG / Threads / LinkedIn 四条，老的 `meta` 留着） |
 * | `platform` | WP191：各平台的硬限制一张表（字数、标签、@、链接、轮播张数、每日上限） |
 * | `watch-query` | WP331：报告积木的纯计算——时间窗、巡查条目筛选 / 计数 / 按话题归组、发出记录计数（不认平台） |
| `research` | WP220：研究技能的取数白名单、Reddit 两路取数、趋势排序、爆款帖、报告与卡 |
 *
 * **不在这里的东西**（各有去处，免得有人在这里找）：
 *
 * - 抑制名单的规则 → `@agentsws/core` 的 `suppression.ts`（全仓唯一一份）；
 * - 承诺扫描的词表 → `@agentsws/support-core` 的门三（全仓唯一一份）；
 * - "发内容永远人审" → `@agentsws/core` 的 `HARD_L1`（yml 放宽不了）；
 * - 九条渠道的清单 → `@agentsws/contracts` 的 `SOCIAL_CHANNELS`。
 */
export * from './broadcast.js'
export * from './calendar.js'
export * from './channels/index.js'
// WP392：竞品监控的快照对比引擎、变化表查询与一句人话
export * from './competitor/diff.js'
export * from './competitor/query.js'
// WP393：店铺管理「竞品动向」——哪条算重要、简报那一段、对标款
export * from './competitor/store-plan.js'
export * from './moderation.js'
export * from './own-sub-queue.js'
export * from './platform.js'
// WP468：Reddit 草稿去 Markdown 记号（新版评论框是富文本，出卡前兜一道）
export * from './reddit-plain.js'
// WP411：Reddit 巡查与起草的质量闸（整词匹配、去重、外部帖闸、草稿依据 / 矛盾 / 人设）
export * from './reddit-quality.js'
export * from './research/index.js'
export * from './thread-tags.js'
export * from './triage.js'
export * from './voice.js'
// WP331：报告积木的纯计算（时间窗、巡查条目查询 / 归组、发出记录计数）
export * from './watch-query.js'
