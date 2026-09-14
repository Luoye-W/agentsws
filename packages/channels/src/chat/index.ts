/**
 * 在线聊天渠道（18 §2；48 §4 L3 #11 的本地部分，WP57）。
 *
 * 入站与邮件走同一条 `ChannelInboundPipeline`；出站是会话内推送（本地 SSE）。
 * widget 脚本、公网端点与 Origin 白名单属于托管档（B 期），不在本包。
 */
export * from './adapter.js'
export * from './rate-limit.js'
export * from './sqlite-store.js'
export * from './store.js'
export * from './stream.js'
export * from './types.js'
