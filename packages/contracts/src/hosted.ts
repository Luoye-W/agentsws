/**
 * 托管实例（WP128 / docs/74）对外的几个形状。
 *
 * WP164：从 `packages/hosted` 搬到契约里——商家本机看状态（`GET /v1/support/hosted`）、
 * 转发器状态里的 `hosted` 那一格都用它，云端搬进私有仓之后开源侧只认这一份。
 * `packages/hosted` 原样重导出这几个名字，调用方一个字不用改。
 */
import type { Iso8601 } from './common.js'

/** 想让它跑还是停（订阅状态推出来的）。 */
export type HostedDesired = 'run' | 'stop'

/** 运营后台那一格看到的四个状态。 */
export type HostedState = 'running' | 'starting' | 'sleeping' | 'stopped'

export type HostedStopReason = 'cancelled' | 'suspended' | 'manual'

/** Cloudflare Containers 的实例规格。 */
export type HostedInstanceType =
  | 'lite'
  | 'basic'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4'

/** 快照是谁推的：容器自己（`hosted`）还是商家本机（`local`）。 */
export type HostedSnapshotSource = 'hosted' | 'local'

/** 一个工作区的托管实例现在怎么样（没有任何密钥、没有任何业务数据）。 */
export interface HostedInstanceStatus {
  /** 从没开通过就是空串。 */
  workspace_id: string
  org_id?: string
  desired: HostedDesired
  state: HostedState
  instance_type: HostedInstanceType
  started_at?: Iso8601
  last_heartbeat_at?: Iso8601
  heartbeat_failures: number
  restarts_this_month: number
  stopped_at?: Iso8601
  stop_reason?: HostedStopReason
  /** 最近一份快照（只有时间与大小）。 */
  snapshot?: { at: Iso8601; bytes: number; source: HostedSnapshotSource }
  /** 停了之后快照留到哪天。 */
  snapshot_kept_until?: Iso8601
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

/** 推上去一份快照之后的回执（`PUT …/snapshot`）。 */
export interface HostedSnapshotStored {
  at: Iso8601
  bytes: number
  source: HostedSnapshotSource
  /** 云上现在留着几份（只留最近几份）。 */
  kept: number
}
