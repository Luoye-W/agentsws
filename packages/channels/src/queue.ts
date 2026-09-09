import type { InboundEvent, MaybePromise, RoleId, WorkspaceId } from '@agentsws/contracts'

/**
 * 入站持久队列（18 §2.2 排队一跳）：按 workspace × role 分车道，指数退避重试，超次进死信。
 *
 * 端口是"存 / 取 / 删 + 到期查询 + 租约领取 + 死信"，两档实现：
 * 内存档（测试与 fast 档模拟）在本文件，SQLite 档在 `sqlite-queue.ts`，
 * 同一份契约一致性套件对两档各跑一遍。
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
  /**
   * 租约到期时刻（epoch ms）：`claim` 领走时写上，处理完删除 / 失败时重写都会清掉。
   * 进程崩在半路 → 租约到期后这条自动回到可领取状态（18 §2.2 持久队列）。
   */
  lease_until_ms?: number
}

/** 进了死信的一条（18 §2.2：死信进 owner 车道，要能事后翻）。 */
export interface DeadLetterRecord {
  id: string
  lane: string
  workspace_id: WorkspaceId
  role_id?: RoleId
  event: InboundEvent
  reason: string
  attempts: number
  last_error?: string
  at_ms: number
}

export interface QueueStore {
  put(item: QueueItem): MaybePromise<void>
  remove(id: string): MaybePromise<void>
  /** 到期项（不含租约未过期的在处理项），按 next_at_ms 升序 */
  due(now_ms: number): MaybePromise<QueueItem[]>
  all(): MaybePromise<QueueItem[]>
  /**
   * 领取到期项并打上租约：同一条不会被两个领取方同时拿到；
   * 领取方崩了不删不改，租约到期后这条自动回到可领取状态。
   */
  claim(now_ms: number, lease_ms: number, limit?: number): MaybePromise<QueueItem[]>
  /** 进死信 */
  putDead(record: DeadLetterRecord): MaybePromise<void>
  /** 某工作区的死信，按进入顺序 */
  deadLetters(workspace_id: WorkspaceId): MaybePromise<DeadLetterRecord[]>
}

/** 默认租约：一条入站消息的处理不该超过这么久。 */
export const DEFAULT_LEASE_MS = 60_000

export class MemoryQueueStore implements QueueStore {
  private readonly items = new Map<string, QueueItem>()
  private readonly dead: DeadLetterRecord[] = []

  put(item: QueueItem): void {
    this.items.set(item.id, { ...item })
  }

  remove(id: string): void {
    this.items.delete(id)
  }

  due(now_ms: number): QueueItem[] {
    return [...this.items.values()]
      .filter((i) => i.next_at_ms <= now_ms && (i.lease_until_ms ?? 0) <= now_ms)
      .sort((a, b) => a.next_at_ms - b.next_at_ms)
      .map((i) => ({ ...i }))
  }

  all(): QueueItem[] {
    return [...this.items.values()].map((i) => ({ ...i }))
  }

  claim(now_ms: number, lease_ms: number, limit?: number): QueueItem[] {
    const picked = this.due(now_ms).slice(0, limit ?? Number.POSITIVE_INFINITY)
    for (const item of picked) {
      const stored = this.items.get(item.id)
      if (stored) stored.lease_until_ms = now_ms + lease_ms
      item.lease_until_ms = now_ms + lease_ms
    }
    return picked
  }

  putDead(record: DeadLetterRecord): void {
    this.dead.push({ ...record })
  }

  deadLetters(workspace_id: WorkspaceId): DeadLetterRecord[] {
    return this.dead.filter((d) => d.workspace_id === workspace_id).map((d) => ({ ...d }))
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
