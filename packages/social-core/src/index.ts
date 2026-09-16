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
 * | `channels` | 九条渠道适配器（四条有真实现，四条说清为什么还没有，一条走浏览器） |
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
export * from './moderation.js'
export * from './triage.js'
export * from './voice.js'
