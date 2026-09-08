import type { InboundEvent, MaybePromise, RoleId, WorkspaceId } from '@agentsws/contracts'

/**
 * 入站持久队列（18 §2.2 排队一跳）：按 workspace × role 分车道，指数退避重试，超次进死信。
 *
 * 这里只定义端口 + 内存实现；SQLite 档留给后续（见报告 §5 未完成项）——
 * 端口刻意做成"存 / 取 / 删 + 到期查询"，SQLite 实现只需一张表和一个 `next_at_ms` 索引。
 */
export interface QueueItem {
  id: string
  lane: string
  workspace_id: WorkspaceId
  role_id?: RoleId
  event: InboundEvent
  /** 已经尝试过几次（含首次） */
  attempts: number
  /** 下次可尝试的时刻（epoch ms） */
  next_at_ms: number
  last_error?: string
}

export interface QueueStore {
  put(item: QueueItem): MaybePromise<void>
  remove(id: string): MaybePromise<void>
  /** 到期项，按 next_at_ms 升序 */
  due(now_ms: number): MaybePromise<QueueItem[]>
  all(): MaybePromise<QueueItem[]>
}

export class MemoryQueueStore implements QueueStore {
  private readonly items = new Map<string, QueueItem>()

  put(item: QueueItem): void {
    this.items.set(item.id, { ...item })
  }

  remove(id: string): void {
    this.items.delete(id)
  }

  due(now_ms: number): QueueItem[] {
    return [...this.items.values()]
      .filter((i) => i.next_at_ms <= now_ms)
      .sort((a, b) => a.next_at_ms - b.next_at_ms)
      .map((i) => ({ ...i }))
  }

  all(): QueueItem[] {
    return [...this.items.values()].map((i) => ({ ...i }))
  }

  get size(): number {
    return this.items.size
  }
}

export interface RetryPolicy {
  /** 总尝试次数（含首次）；超过即死信。18 §2.2「重试指数退避 ≤ 5 次」 */
  max_attempts: number
  base_ms: number
  factor: number
  max_ms: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  max_attempts: 5,
  base_ms: 1_000,
  factor: 2,
  max_ms: 15 * 60_000,
}

/** 第 n 次尝试失败后的等待：`base * factor^(n-1)`，封顶 max_ms。 */
export function backoffMs(attempts: number, policy: RetryPolicy): number {
  const n = Math.max(1, attempts)
  return Math.min(policy.max_ms, Math.round(policy.base_ms * policy.factor ** (n - 1)))
}

/** 车道键：workspace × role；没有 role 的进 owner 车道（死信也走这条）。 */
export function laneOf(workspace_id: WorkspaceId, role_id: RoleId | undefined): string {
  return `${workspace_id}:${role_id ?? 'owner'}`
}
