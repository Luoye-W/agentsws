/**
 * `@agentsws/b2b-core`：B2B 岗位的判断逻辑（docs/84 §7）。
 *
 * 移植自 Luoye 自己的 BtoBAgents 业务纯函数（每个文件头注明出处）。MkSaaS 模板的
 * 东西（登录、支付、积分、后台、通用 UI、邮件模板、多语言、构建配置）一个文件都没搬。
 */
export * from './company-brain.js'
export * from './csv.js'
export * from './evidence.js'
export * from './onboarding.js'
// WP173：开发信（筛人、配额分批、三封模板与系统页脚、发信邮箱体检、回信分类）
export * from './outbound.js'
export * from './outreach-drafts.js'
export * from './ownership.js'
export * from './policy.js'
export * from './replies.js'
export * from './sender.js'
