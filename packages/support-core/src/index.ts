/**
 * `@agentsws/support-core` — 客服共享包（33 §1）。
 *
 * 纯函数、无 IO、无模型调用。SaaS（KefuAgent）与开源中台装的是同一份代码：
 * 修一条话术规则、加一条业务边界，两边同时受益。
 */
export * from './approvals.js'
export * from './boundaries.js'
export * from './classify.js'
export * from './detect.js'
export * from './draft.js'
export * from './entities.js'
export * from './escalation.js'
export * from './knowledge.js'
export * from './lexicon.js'
export * from './prompts/index.js'
export * from './sla.js'
export * from './text.js'
export * from './types.js'
