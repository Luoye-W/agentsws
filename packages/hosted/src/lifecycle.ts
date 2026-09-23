/**
 * 托管实例的生命周期判定（纯函数；DO 与测试共用这一份）。
 *
 * 一张表说完：
 *
 * | 订阅状态 | 容器 | 为什么 |
 * |---|---|---|
 * | `active` / `cancelling` | **常驻** | 付了钱的这一期，冷启动对聊天窗不可接受 |
 * | `grace`（欠费宽限 30 天） | **照跑** | 派工单：宽限**到期**才停；充上钱不用再冷启动一次 |
 * | `suspended`（宽限到期） | 停，快照留 30 天 | |
 * | `none`（取消且当期用完 / 从没订过） | 停，快照留 30 天 | |
 *
 * 「常驻」怎么做：Cloudflare 官方**没有「永不休眠」的开关**（2026-09-23 核过文档：
 * `sleepAfter` 只是「多久没请求就停」，没有上限值也没有 `Infinity` 的说法）。
 * 所以 `HostedInstanceDO` 自己的 alarm 每 {@link HOSTED_KEEPALIVE_MS} 醒一次：
 * 打一次容器里 `apps/server` 的 `/v1/health`（这一下既是心跳，也让平台看到有活动），
 * 容器没在跑就拉起来。见 docs/64 §11 的偏离说明。
 */
import type { SubscriptionStatus } from '@agentsws/contracts'

export type HostedDesired = 'run' | 'stop'

/** 运营后台那一格看到的四个状态。 */
export type HostedState = 'running' | 'starting' | 'sleeping' | 'stopped'

export type HostedStopReason = 'cancelled' | 'suspended' | 'manual'

/**
 * 心跳 / 保活间隔：3 分钟。
 *
 * 取这个数的理由：`@cloudflare/containers` 自己的 `Container` 类 alarm 最长也是
 * 3 分钟一拍（源码里的 `minTime = 3 * 60 * 1000`）——那是平台方认为「DO 与容器
 * 都不会被当成闲置收走」的节奏，我们不比它更松。
 */
export const HOSTED_KEEPALIVE_MS = 3 * 60 * 1000

/** 一次心跳最多等多久。 */
export const HOSTED_HEARTBEAT_TIMEOUT_MS = 5_000

/** 连续几次心跳失败就判容器坏了、重起。 */
export const HOSTED_MAX_HEARTBEAT_FAILURES = 3

/** 容器里 `apps/server` 监听的端口（根 Dockerfile 的 `AGENTSWS_PORT`）。 */
export const HOSTED_PORT = 4317

/** 停容器之后快照留多久。 */
export const SNAPSHOT_RETENTION_DAYS = 30

/** 每个工作区最多留几份快照（多的顶掉最旧的）。 */
export const SNAPSHOT_KEEP_COUNT = 3

/** 一份快照最大多少字节（一个客服工作区的库远小于它；超了拒收，不截断）。 */
export const SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024

/** 容器里多久推一次快照回来。 */
export const SNAPSHOT_PUSH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 重起的退避：第 n 次重起前等多久（封顶最后一档）。 */
export const RESTART_BACKOFF_MS: readonly number[] = [0, 30_000, 120_000, 600_000]

export function restartBackoffMs(attempt: number): number {
  const index = Math.min(Math.max(0, attempt), RESTART_BACKOFF_MS.length - 1)
  return RESTART_BACKOFF_MS[index] ?? 0
}

/** 订阅状态 → 容器该不该跑。 */
export function desiredFor(status: SubscriptionStatus): HostedDesired {
  return status === 'active' || status === 'cancelling' || status === 'grace' ? 'run' : 'stop'
}

/** 停的时候记一个理由（后台那一格显示用）。 */
export function stopReasonFor(status: SubscriptionStatus): HostedStopReason {
  return status === 'suspended' ? 'suspended' : 'cancelled'
}

/**
 * 眼下是什么状态。
 *
 * - 该停 → `stopped`；
 * - 该跑、容器在跑、最近一次心跳在两拍之内 → `running`；
 * - 该跑、容器在跑、还没收到过心跳（刚起） → `starting`；
 * - 该跑、容器没在跑（平台滚动更新 / 崩了 / 等退避） → `sleeping`。
 */
export function stateOf(input: {
  desired: HostedDesired
  running: boolean
  now: string
  started_at?: string | undefined
  last_heartbeat_at?: string | undefined
}): HostedState {
  if (input.desired === 'stop') return 'stopped'
  if (!input.running) return 'sleeping'
  const beat = input.last_heartbeat_at
  const started = input.started_at
  if (beat !== undefined && (started === undefined || beat >= started)) {
    const age = Date.parse(input.now) - Date.parse(beat)
    if (age <= HOSTED_KEEPALIVE_MS * 2) return 'running'
  }
  return 'starting'
}

/** 停容器那一刻起，快照留到哪天。 */
export function snapshotKeptUntil(stopped_at: string): string {
  return new Date(Date.parse(stopped_at) + SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString()
}
