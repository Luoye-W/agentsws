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
// WP317（docs/101 §5.1④）：素材流水线——两个子 Agent、导出表、上传表（最小版）、批量出图单、实验记忆
export * from './creative/index.js'
// WP224（docs/91 §2.2 #3）：盈亏线 ROAS = 1 / 毛利率，只并排显示、不改止损；毛利瀑布
export * from './economics.js'
// WP452（docs/109 §5.2 #13–16）：实验设计与读结果、落地页一致性、素材疲劳
export * from './experiment-design.js'
// WP447（docs/109 §6.2）：六个新平台的导出报表解析与体检骨架（只读）
export * from './exports/index.js'
export * from './fatigue.js'
export * from './landing.js'
// WP314（docs/101 §5.1②）：两家官方上传表的生成、本地校验、改前改后对比、导出解析、读回核对
export * from './sheets/index.js'
export * from './spec.js'
export * from './variants.js'
