/**
 * 投放共享包（57 §2）。
 *
 * 五个模块：`budget`（总闸 / delta / 止损，纯函数、可解释）、`variants`（A/B 变体，
 * 一次只变一样、文案先自查）、`attribution`（**两个口径两列，永不合并**）、
 * `spec`（四平台素材规格表——**设计岗 `design.ads` import 的就是它**）、
 * `channels`（四条平台适配器，Meta / Google 真实现，X / TikTok 接口 + 人话）。
 *
 * 全包没有一处 IO、没有一处 `Date.now()`、没有一处 `console`、零真 key。
 */
export * from './attribution.js'
// 71（WP122）：投放怎么用那份 DESIGN.md —— 注提示词 + 卡片上那一行提示（只提示，不拦人）
export * from './brand-design.js'
export * from './budget.js'
export * from './channels/index.js'
export * from './spec.js'
export * from './variants.js'
