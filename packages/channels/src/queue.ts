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
  /**
   * WP210：自动重投的进度（`deadLetterRecords` 读出来时附上；存储层不存这一格，
   * 它在单独的 `setDeadLetterRetry` 里）。
   */
  retry?: DeadLetterRetryState
}

/**
 * WP210（Luoye 09-30）：一条死信**自动重投**到了哪一步。
 *
 * 单独存（不写在死信那一行上）：重投时死信行会被删掉，再死一次是新写的一行——
 * 轮数要跨过这一删一写接着数。
 */
export interface DeadLetterRetryState {
  /** 自动重投过几轮。 */
  rounds: number
  /** 上一轮自动重投的时刻（epoch ms）。 */
  last_at_ms: number
  /** 上一轮自动重投时的程序版本。换了版本 = 可能修好了，轮数从头数、立刻再投一次。 */
  release?: string
  /** 判定彻底投不进：不再自动重投（换了版本除外），只进后台日志。 */
  gave_up?: boolean
  /** 已经为它出过一张提醒卡（客户来信才出；换版本重来也不再出第二张）。 */
  notified?: boolean
}

/**
 * 自动重投的退避：第 n 轮等 `base * factor^(n-1)`，封顶 `max_ms`；投满 `max_rounds` 轮还死，
 * 就算彻底投不进。缺省 30 分钟 → 2 小时 → 8 小时 → 24 小时，四轮之后放弃（换版本再来一遍）。
 */
export interface AutoRequeuePolicy {
  max_rounds: number
  base_ms: number
  factor: number
  max_ms: number
}

export const DEFAULT_AUTO_REQUEUE: AutoRequeuePolicy = {
  max_rounds: 4,
  base_ms: 30 * 60_000,
  factor: 4,
  max_ms: 24 * 60 * 60_000,
}

/** 已经自动重投过 `rounds` 轮之后，下一轮要在死信落地后等多久。 */
export function autoRequeueDelayMs(rounds: number, policy: AutoRequeuePolicy): number {
  return Math.min(policy.max_ms, Math.round(policy.base_ms * policy.factor ** Math.max(0, rounds)))
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
  /**
   * WP55 / 18 §2.2：按 id 取一条死信（重投要读它的事件）。
   * 可选：不实现 = 这一档没有重投入口（老实现一个字不用改）。
   */
  deadLetter?(id: string): MaybePromise<DeadLetterRecord | undefined>
  /** WP55：删掉一条死信（重投成功之后）。 */
  removeDead?(id: string): MaybePromise<void>
  /**
   * WP210：自动重投的进度（按死信 id）。可选：不实现 = 这一档不自动重投（老行为）。
   */
  deadLetterRetry?(id: string): MaybePromise<DeadLetterRetryState | undefined>
  /** WP210：写 / 清（`undefined`）一条死信的自动重投进度。 */
  setDeadLetterRetry?(id: string, state: DeadLetterRetryState | undefined): MaybePromise<void>
}

/** 默认租约：一条入站消息的处理不该超过这么久。 */
export const DEFAULT_LEASE_MS = 60_000

export class MemoryQueueStore implements QueueStore {
  private readonly items = new Map<string, QueueItem>()
  private readonly dead: DeadLetterRecord[] = []
  private readonly retries = new Map<string, DeadLetterRetryState>()

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

  deadLetter(id: string): DeadLetterRecord | undefined {
    const found = this.dead.find((d) => d.id === id)
    return found === undefined ? undefined : { ...found }
  }

  removeDead(id: string): void {
    const idx = this.dead.findIndex((d) => d.id === id)
    if (idx >= 0) this.dead.splice(idx, 1)
  }

  deadLetterRetry(id: string): DeadLetterRetryState | undefined {
    const found = this.retries.get(id)
    return found === undefined ? undefined : { ...found }
  }

  setDeadLetterRetry(id: string, state: DeadLetterRetryState | undefined): void {
    if (state === undefined) this.retries.delete(id)
    else this.retries.set(id, { ...state })
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
