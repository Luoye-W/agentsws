/**
 * 托管实例对外的几个形状（`HostedInstanceDO` 的状态、运营后台那一块的摘要）。
 */
import type { HostedInstanceStatus, SubscriptionStatus } from '@agentsws/contracts'

/** 一个工作区的托管实例现在怎么样。WP164：形状挪进契约（开源侧只认那一份），这里原样重导出。 */
export type { HostedInstanceStatus } from '@agentsws/contracts'

/** 运营后台组织抽屉里「客服增值服务」那一块。 */
export interface SupportServiceSummary {
  org_id: string
  workspaces: {
    workspace_id: string
    subscription_status: SubscriptionStatus
    current_cycle_end?: string
    grace_until?: string
    hosted?: HostedInstanceStatus
  }[]
}

/** 后台那一口（Workers 形态按工作区打两个 DO；没开通就不接，路由回 503）。 */
export interface SupportServiceAdminPort {
  summary(org_id: string): Promise<SupportServiceSummary>
}
