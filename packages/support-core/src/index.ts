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
// WP440（docs/108 M9）：邮件客服也按把握直接回（同一套判定 + 邮件特有的剥引用 / 签名、称呼落款）
export * from './email/auto-reply.js'
export * from './entities.js'
export * from './escalation.js'
export * from './gates/index.js'
// WP488（决策 1680 / 1681）：从过往邮件拼问答对、从官网 / 售后网站学
export * from './history-mail.js'
export * from './knowledge.js'
// WP125（72 §2.2 第 1 条）：教 AI 的指导原文泄漏守卫（投递前那一道）
export * from './leak-guard.js'
export * from './lexicon.js'
// WP125（72 §P0-2）：进 prompt 的外部文本走这一个入口（打码先于围栏）
export * from './prompt-text.js'
export * from './prompts/index.js'
export * from './site-learning.js'
export * from './sla.js'
// WP488（决策 1700 / 1704）：售前 / 售后由 AI 判（提示词与认回话）
export * from './stage-ai.js'
export * from './text.js'
export * from './types.js'
// WP54（48 v2 L2）：实物 / 虚拟两套垂直包与 `getVerticalPack` 解析入口
export * from './verticals/index.js'
