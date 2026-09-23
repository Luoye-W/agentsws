/**
 * 托管实例对外的几个形状（`HostedInstanceDO` 的状态、运营后台那一块的摘要）。
 */
import type { SubscriptionStatus } from '@agentsws/contracts'
import type { HostedDesired, HostedState, HostedStopReason } from './lifecycle.js'
import type { HostedInstanceType } from './pricing.js'

/** 一个工作区的托管实例现在怎么样（没有任何密钥、没有任何业务数据）。 */
export interface HostedInstanceStatus {
  workspace_id: string
  org_id?: string
  desired: HostedDesired
  state: HostedState
  instance_type: HostedInstanceType
  started_at?: string
  last_heartbeat_at?: string
  heartbeat_failures: number
  restarts_this_month: number
  stopped_at?: string
  stop_reason?: HostedStopReason
  /** 最近一份快照（只有时间与大小）。 */
  snapshot?: { at: string; bytes: number; source: 'hosted' | 'local' }
  /** 停了之后快照留到哪天。 */
  snapshot_kept_until?: string
  /** 这个月（`YYYY-MM`）容器活了多少秒。 */
  month: string
  running_seconds_this_month: number
  /** 按官方单价估的本月已花（美元，含 CPU 忙比例的假设）。 */
  cost_estimate_usd_this_month: number
  /** 常驻整月的估算（美元）——30 积分盖不盖得住看这个。 */
  cost_estimate_usd_full_month: number
  /** 起不来时的一句人话（缺种子 / 缺绑定 / 镜像拉不下来）。 */
  last_error?: string
}

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
