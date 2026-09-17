/**
 * `@agentsws/pr-core`（60 §2）：公共关系四条职责共用的**能力**，不是职责。
 *
 * 同 `kol-core` / `social-core` / `support-core` 的纪律：纯逻辑 + 注入 IO。
 * 这个包里没有 `Date.now()`、没有 `fetch` 的实现（只有注入口）、没有模型调用、
 * 碰不到一个凭据。四条职责（`packages/roles` 的 `roles/pr/*.yml`）与服务进程
 * 那一侧调它。
 *
 * | 模块 | 干什么 |
 * |---|---|
 * | `release` | 结构化新闻稿六段；数字 ↔ 事实卡对照；引语必须是人给的 |
 * | `media` | 媒体名单、pitch 两封序列、日配额与抑制名单（复用建联那一套） |
 * | `subreddits` | 版规解析（禁推广 / 要 flair / 冷却）→ 可发 / 不可发 + 原因 |
 * | `monitor` | 提及归一 + 去重 + 情绪三档 + 客户问题 vs 舆情（复用 social-core 的 triage） |
 * | `channels` | Reddit（社媒那份适配器 + 三口）、论坛（浏览器）、Alerts（RSS） |
 *
 * **不在这里的东西**（各有去处，免得有人在这里找）：
 *
 * - 数字抽取与"有没有出处" → `@agentsws/core` 的 `extractFigures` /
 *   `uncitedFigures`（与 guardrail **同一份**，这里 `import` 它）；
 * - 抑制名单的规则 → `@agentsws/core` 的 `suppression.ts`（全仓唯一一份）；
 * - 承诺扫描的词表 → `@agentsws/support-core`（经 `social-core` 的
 *   `checkOutbound` 调，全仓唯一一份）；
 * - "在别人的社区里发东西永远人审" → `@agentsws/core` 的 `HARD_L1`
 *   （职责 yml 放宽不了）；
 * - 四条职责的清单 → `@agentsws/contracts` 的 `PR_ROLES`。
 */
export * from './channels/index.js'
export * from './media.js'
export * from './monitor.js'
export * from './release.js'
export * from './subreddits.js'
