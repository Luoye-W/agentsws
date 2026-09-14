/**
 * 在线聊天流水线的纯函数层（48 §4 L3 #11 的本地部分，WP57）。
 *
 * 聊天与邮件共用知识、订单只读、围栏与升级判据，但**轮次、分类、计划各有一套**：
 * 邮件慢而长，聊天秒回而碎。这里只有判定，没有 IO——渠道在 `@agentsws/channels/chat`，
 * 接线在 `apps/server/src/chat.ts`。
 */
export * from './aggregate.js'
export * from './assist-timeout.js'
export * from './classify.js'
export * from './pack.js'
export * from './plan.js'
export * from './teach.js'
export * from './types.js'
