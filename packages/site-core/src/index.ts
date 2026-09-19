/**
 * `@agentsws/site-core`（59 §2）：建站四条职责共用的**能力**，不是职责。
 *
 * 同 `kol-core` / `social-core` / `support-core` 的纪律：纯逻辑 + 注入 IO。
 * 这个包里没有 `Date.now()`、没有子进程、没有 `fetch`，碰不到一个凭据。
 *
 * | 模块 | 干什么 |
 * |---|---|
 * | `checklist` | 上线检查单：域名 / 支付 / 税 / 运费 / 政策页 / 导航 / 必装 App / 主题发布 |
 * | `theme` | **薄封装** WP44 那个 CLI 口子（`apps/server/src/shopify-theme.ts`），不重写 |
 * | `email-templates` | 通知邮件的 Liquid 变量抽取与校验、渲染预览 |
 * | `apps` | App 目录、装 / 配的 `after`、与连接目录"待增加"卡的对应 |
 *
 * **不在这里的东西**（各有去处，免得有人在这里找）：
 *
 * - 必需变量表 → `@agentsws/core` 的 `EMAIL_TEMPLATE_REQUIRED_VARS`（全仓唯一一份，
 *   guardrail 与这里读同一个对象）；
 * - "装主题 / 装 App 永远人审" → `@agentsws/core` 的 `HARD_L1`（yml 放宽不了）；
 * - "结账 / 支付 / 税不给写动作" → 两处各一道：Shopify 写动作对照表里没有入口，
 *   guardrail 的 `STORE_SETUP_FORBIDDEN_FIELD_PREFIXES` 拦夹带；
 * - 真的跑 Shopify CLI → `apps/server/src/shopify-theme.ts`（WP44，一行都没搬）。
 */
export * from './apps.js'
// 71（WP122）：建站怎么用那份 DESIGN.md —— 注提示词 + 翻成主题变量（WP89 沙箱吃这一份）
export * from './brand-design.js'
export * from './checklist.js'
export * from './email-templates.js'
export * from './theme.js'
