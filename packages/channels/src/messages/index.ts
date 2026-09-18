/**
 * WP113（63）：**消息**——把整只邮箱接进来那一层。
 *
 * 与 `../email/*` 的分工：那边是"传输"（IMAP 拉、SMTP 发、入站管线），
 * 这边是"用户看到的那只邮箱"（消息库、分拣、标签、草稿、回写）。
 * 两边共用同一批解析零件与同一套游标 / 租约 / 毒消息纪律，不另起炉灶。
 */
export * from './labels.js'
export * from './parse.js'
export * from './query.js'
export * from './sanitize.js'
export * from './sqlite-store.js'
export * from './store.js'
export * from './suggest.js'
export * from './sync.js'
export * from './triage.js'
export * from './writeback.js'
