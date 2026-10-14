/**
 * `@agentsws/browser-action`：浏览器动作的公共执行模块（WP313，docs/101 §5.4）。
 *
 * Reddit 官方号通道（WP249）的规矩抽到这里：写死的步骤表、白名单、读回确认、限速（只限速不伪装）、
 * 被拦就停；加上广告要的：上传 / 下载 / 截屏、审批编号 + 上传表指纹、「默认不碰」区域、排队 24 小时作废。
 */

export * from './ads/index.js'
export * from './dom.js'
export * from './evidence.js'
export * from './fingerprint.js'
export * from './guard.js'
export * from './pace.js'
export * from './protocol.js'
export * from './queue.js'
// WP328：Reddit 只读（插件读收件箱与自家版块）
export * from './reddit/index.js'
export * from './runner.js'
export * from './types.js'
export * from './walls.js'
export * from './zones.js'
