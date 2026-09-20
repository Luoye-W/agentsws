/**
 * 运营后台看订阅的那一口（67 §3 / 65）。
 *
 * 与 WP116 的 `KolAdminPort` 一模一样的形状与一模一样的理由：后台那一层握的是
 * 一个口子，Compose 形态下它直接查库，官方托管形态下它是"打那个租户对象"。
 * **后台这一层不知道自己在哪个形态里。**
 *
 * 只有两件事，刻意没有第三件：
 *
 * - `summary`：一个组织的订阅现状（后台抽屉那一块）；
 * - `grant`：赠送 N 个月。
 *
 * **没有"替用户取消"，也没有"替用户删数据"。** 取消是用户自己的决定，删数据是
 * 用户自己的按钮——后台能做这两件事，就迟早有一天有人替用户做了。
 */
import type { ServiceSubscription, SubscriptionCharge } from '@agentsws/contracts'

/** 后台抽屉那一块要的东西。 */
export interface KolCloudSummary {
  org_id: string
  subscription: ServiceSubscription
  /** 云端有多少条（不含墓碑）。 */
  object_count: number
  /** 还没被人处理的冲突条数。不为 0 就在后台挂一个标。 */
  pending_conflicts: number
  last_sync_at?: string
  /** 最近几笔扣费（含扣不上的那些——用户来问的时候要答得出）。 */
  charges: SubscriptionCharge[]
}

export interface KolCloudAdminPort {
  summary(org_id: string): Promise<KolCloudSummary> | KolCloudSummary
  grant(org_id: string, months: number): Promise<ServiceSubscription> | ServiceSubscription
}
