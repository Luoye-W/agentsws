/**
 * `@agentsws/support-core` — 客服共享包（33 §1）。
 *
 * 纯函数、无 IO、无模型调用。SaaS（KefuAgent）与开源中台装的是同一份代码：
 * 修一条话术规则、加一条业务边界，两边同时受益。
 */
export * from './amazon/index.js'
export * from './approvals.js'
export * from './boundaries.js'
export * from './chat/index.js'
export * from './classify.js'
export * from './detect.js'
export * from './draft.js'
export * from './entities.js'
export * from './escalation.js'
export * from './gates/index.js'
export * from './knowledge.js'
// WP125（72 §2.2 第 1 条）：教 AI 的指导原文泄漏守卫（投递前那一道）
export * from './leak-guard.js'
export * from './lexicon.js'
// WP125（72 §P0-2）：进 prompt 的外部文本走这一个入口（打码先于围栏）
export * from './prompt-text.js'
export * from './prompts/index.js'
export * from './sla.js'
export * from './text.js'
export * from './types.js'
// WP54（48 v2 L2）：实物 / 虚拟两套垂直包与 `getVerticalPack` 解析入口
export * from './verticals/index.js'
