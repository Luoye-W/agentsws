/**
 * Extracted from KefuAgent src/lib/support/delivery-outbox.ts
 * （七态状态机、合法迁移表、失败分类器、重试与对账退避表、payload 哈希），
 * rewritten for agentsws contracts。
 *
 * ## 为什么要有 outbox（18 §3 + 15 §5 第 8 条 + 31 §3.2）
 *
 * SMTP 的 `send()` 抛了异常**不等于**这封信没发出去。最常见的一种：正文已经流
 * 完、只在等 `DATA` 的 250 回执时连接被 reset。这时候重发一次，客户收到两封；
 * 不重发，可能一封都没发。两种都错——所以要有一条持久的行记着「这一次到底走到
 * 了哪一步」，并且**歧义一律不重试**，交给对账去找证据。
 *
 * 状态机：
 *
 * ```
 * prepared ──► sending ──┬─► accepted_by_provider ──► confirmed
 *                        ├─► failed_retryable ──► sending（退避 ≤ 5 次）
 *                        ├─► sent_unknown ──► confirmed | failed_terminal
 *                        └─► failed_terminal
 * ```
 *
 * `sent_unknown` **绝不自动重试**（18 §3 / 15 §5 第 8 条）。它只有两条出路：
 * 对账找到证据 → `confirmed`；退避次数耗尽 → 人工卡。第三条「人看过之后决定
 * 重发」也存在，但那是**人**按的按钮，不是机器自己走的边。
 */

import type { Iso8601, MaybePromise, WorkspaceId } from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'

/** 七态（逐字抄 KefuAgent `DeliveryOperationStatus`）。 */
export type OutboxStatus =
  | 'prepared'
  | 'sending'
  | 'accepted_by_provider'
  | 'confirmed'
  | 'sent_unknown'
  | 'failed_retryable'
  | 'failed_terminal'

/** 合法迁移。表外的一律拒绝——状态机写在数据里，不写在四散的 if 里。 */
export const OUTBOX_TRANSITIONS: Readonly<Record<OutboxStatus, readonly OutboxStatus[]>> = {
  prepared: ['sending', 'failed_terminal'],
  sending: ['accepted_by_provider', 'failed_retryable', 'sent_unknown', 'failed_terminal'],
  accepted_by_provider: ['confirmed', 'sent_unknown'],
  failed_retryable: ['sending', 'failed_terminal'],
  // `prepared` 这条边只有**人**能走（死信 / 对账卡上的「确认没发出去，重发一次」）。
  sent_unknown: ['confirmed', 'failed_terminal', 'prepared'],
  confirmed: [],
  failed_terminal: [],
}

export function canTransition(from: OutboxStatus, to: OutboxStatus): boolean {
  return OUTBOX_TRANSITIONS[from].includes(to)
}

/** 1 次即时 + 4 次重试。 */
export const OUTBOX_MAX_ATTEMPTS = 5
/** 每次重试的退避（毫秒）；索引 = 已用尽的尝试数 − 1。 */
export const OUTBOX_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 120 * 60_000] as const
/** 进入 `sent_unknown` 之后的对账节奏（毫秒）。 */
export const RECONCILE_SCHEDULE_MS = [
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  180 * 60_000,
  360 * 60_000,
  720 * 60_000,
] as const
export const MAX_RECONCILE_ATTEMPTS = RECONCILE_SCHEDULE_MS.length
/** `accepted_by_provider` 迟迟没确认的宽限：10 分钟之后进对账扫描。 */
export const ACCEPTED_RECONCILE_GRACE_MS = 10 * 60_000

/** 确认是从哪儿来的（人工确认与机器找到证据必须分得开）。 */
export type ConfirmationSource = 'send_result' | 'sent_folder' | 'archive_folder' | 'manual'

export interface OutboxRecord {
  id: string
  workspace_id: WorkspaceId
  /**
   * 幂等键（= 审批项的 `idempotency_key`）。**同一审批项只发一次**：发送前先查
   * 这张表，已经 `accepted_by_provider` / `confirmed` / `sent_unknown` 的直接
   * 返回，不再走 SMTP。
   */
  idempotency_key: string
  approval_item_id?: string
  thread_ref: string
  /**
   * 内容哈希。一条 outbox 行只能投递这一份内容——同一个幂等键换了正文再来，
   * 是调用方的 bug，不该被当成"重试"悄悄发出另一封信。
   */
  payload_hash: string
  /** 我们生成的 Message-ID：对账就是拿它去已发 / 归档文件夹里搜。 */
  message_id: string
  status: OutboxStatus
  attempts: number
  /** 下次可尝试的时刻（`failed_retryable` 才有）。 */
  next_at_ms?: number
  reconcile_attempts: number
  reconcile_next_at_ms?: number
  reconcile_exhausted_at_ms?: number
  confirmation_source?: ConfirmationSource
  external_id?: string
  last_error?: string
  created_at_ms: number
  updated_at_ms: number
}

export interface OutboxStore {
  get(id: string): MaybePromise<OutboxRecord | undefined>
  byIdempotencyKey(workspace_id: WorkspaceId, key: string): MaybePromise<OutboxRecord | undefined>
  put(record: OutboxRecord): MaybePromise<void>
  /** 到期该对账的：`sent_unknown` 到点未耗尽 + 迟迟没确认的 `accepted_by_provider`。 */
  dueForReconcile(now_ms: number, limit?: number): MaybePromise<OutboxRecord[]>
  list(workspace_id: WorkspaceId): MaybePromise<OutboxRecord[]>
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<string, OutboxRecord>()

  get(id: string): OutboxRecord | undefined {
    const row = this.rows.get(id)
    return row === undefined ? undefined : { ...row }
  }

  byIdempotencyKey(workspace_id: WorkspaceId, key: string): OutboxRecord | undefined {
    for (const row of this.rows.values())
      if (row.workspace_id === workspace_id && row.idempotency_key === key) return { ...row }
    return undefined
  }

  put(record: OutboxRecord): void {
    this.rows.set(record.id, { ...record })
  }

  dueForReconcile(now_ms: number, limit?: number): OutboxRecord[] {
    return [...this.rows.values()]
      .filter((r) => isDueForReconcile(r, now_ms))
      .sort((a, b) => (a.reconcile_next_at_ms ?? 0) - (b.reconcile_next_at_ms ?? 0))
      .slice(0, limit ?? Number.POSITIVE_INFINITY)
      .map((r) => ({ ...r }))
  }

  list(workspace_id: WorkspaceId): OutboxRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.workspace_id === workspace_id)
      .map((r) => ({ ...r }))
  }

  get size(): number {
    return this.rows.size
  }
}

/** 到期该对账没有。 */
export function isDueForReconcile(record: OutboxRecord, now_ms: number): boolean {
  if (record.reconcile_exhausted_at_ms !== undefined) return false
  if (record.status === 'sent_unknown')
    return (
      (record.reconcile_next_at_ms ?? 0) <= now_ms &&
      record.reconcile_attempts < MAX_RECONCILE_ATTEMPTS
    )
  if (record.status === 'accepted_by_provider')
    return record.updated_at_ms + ACCEPTED_RECONCILE_GRACE_MS <= now_ms
  return false
}

/**
 * payload 哈希：收件人 + 主题 + 正文 + 线程头。
 * 规范化用 `canonicalJson`（`JSON.stringify` 对 `undefined` 的取舍在那里统一过）。
 */
export function outboxPayloadHash(input: {
  to: readonly string[]
  subject?: string
  text: string
  in_reply_to?: string
}): string {
  return sha256(
    canonicalJson({
      to: [...input.to].map((t) => t.trim().toLowerCase()).sort(),
      subject: input.subject ?? '',
      text: input.text,
      in_reply_to: input.in_reply_to ?? null,
    }),
  )
}

/* ------------------------------------------------------------------ */
/* 失败分类器                                                           */
/* ------------------------------------------------------------------ */

/**
 * 发送走到哪一步了。`post_data` = 正文已经流出去了——这之后**任何**错误都是歧义，
 * 一律 `sent_unknown`，绝不当成"发送前失败"去重试。
 */
export type SendPhase = 'pre_connect' | 'connected' | 'post_data' | 'unknown'

export interface SendFailure {
  status: 'failed_retryable' | 'failed_terminal' | 'sent_unknown'
  /** 机器可读的分类标记（进事件与人工卡）。 */
  token: string
}

/**
 * 错误 → 三态。默认分支是 `sent_unknown`：**只有能证明"在被接受之前就失败了"的
 * 错误才映射 `failed_*`**，其余一律当成歧义。这条默认方向反了的话，代价是客户
 * 收到两封信——而两封信是收不回来的。
 */
export function classifySendFailure(error: unknown, phase: SendPhase = 'unknown'): SendFailure {
  // 正文已在途：任何错误都不可能可证明 pre-acceptance。
  if (phase === 'post_data') return { token: 'ambiguous_post_data', status: 'sent_unknown' }

  const o = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const code = typeof o.code === 'string' ? o.code.toUpperCase() : ''
  const responseCode = typeof o.responseCode === 'number' ? o.responseCode : undefined
  const message = error instanceof Error ? error.message : String(error ?? '')

  // 鉴权失败：重试多少次都一样，要人去重新授权。
  if (code === 'EAUTH' || responseCode === 535 || o.authenticationFailed === true)
    return { token: 'smtp_auth_failed', status: 'failed_terminal' }

  // 连不上：还没开始说话，可证明没发出去。
  if (
    phase === 'pre_connect' &&
    (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EDNS')
  )
    return { token: 'connect_failed', status: 'failed_retryable' }

  // 连接中途断：**不可**证明 pre-acceptance ⇒ 保守当歧义，绝不重发。
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNRESET' || code === 'EPIPE')
    return { token: 'ambiguous_connection_lost', status: 'sent_unknown' }

  if (responseCode !== undefined) {
    if (responseCode >= 500 && responseCode < 600)
      return { token: `smtp_${responseCode}`, status: 'failed_terminal' }
    if (responseCode >= 400 && responseCode < 500)
      return { token: `smtp_${responseCode}`, status: 'failed_retryable' }
  }

  // 超时随处可发生（可能在 DATA 之后）⇒ 歧义。
  if (code === 'ETIMEDOUT' || /timed?\s*out/i.test(message))
    return { token: 'ambiguous_timeout', status: 'sent_unknown' }

  // 收件人门禁这类"我们自己拒发的"：确定没发出去，也没有重试的意义。
  if (code === 'authorization_check_failed' || code === 'invalid_input')
    return { token: code, status: 'failed_terminal' }

  return { token: 'ambiguous_unclassified', status: 'sent_unknown' }
}

/** 第 n 次尝试失败后等多久（封顶在表尾）。 */
export function outboxBackoffMs(attempts: number): number {
  const idx = Math.min(Math.max(0, attempts - 1), OUTBOX_RETRY_BACKOFF_MS.length - 1)
  return OUTBOX_RETRY_BACKOFF_MS[idx] ?? 0
}

/** 第 n 次对账之后隔多久再找一遍。 */
export function reconcileDelayMs(reconcile_attempts: number): number {
  const idx = Math.min(reconcile_attempts, RECONCILE_SCHEDULE_MS.length - 1)
  return RECONCILE_SCHEDULE_MS[idx] ?? 0
}

/* ------------------------------------------------------------------ */
/* 操作内核                                                             */
/* ------------------------------------------------------------------ */

export interface OutboxTransitionEvent {
  record: OutboxRecord
  from: OutboxStatus
  to: OutboxStatus
  reason?: string
}

export interface OutboxOptions {
  store: OutboxStore
  workspace_id: WorkspaceId
  /** 每次状态迁移落一条事件（payload 只有状态与分类标记，没有正文）。 */
  onTransition?: (e: OutboxTransitionEvent) => MaybePromise<void>
}

export interface PrepareInput {
  idempotency_key: string
  thread_ref: string
  message_id: string
  payload_hash: string
  approval_item_id?: string
  now: Iso8601
}

/** `prepare` 的结论：新建，还是"这封信之前已经走到某一步了"。 */
export type PrepareOutcome =
  | { kind: 'new'; record: OutboxRecord }
  /** 已经发出去（或可能已经发出去）：**不要再发**。 */
  | { kind: 'already'; record: OutboxRecord }
  /** 上一次失败了、可以重来。 */
  | { kind: 'retry'; record: OutboxRecord }
  /** 同一幂等键换了正文——调用方的 bug，拒绝。 */
  | { kind: 'payload_drift'; record: OutboxRecord }

/** 这些状态下「这封信可能已经在客户手里」，重发就是发第二封。 */
const TERMINAL_OR_IN_FLIGHT: ReadonlySet<OutboxStatus> = new Set<OutboxStatus>([
  'sending',
  'accepted_by_provider',
  'confirmed',
  'sent_unknown',
  'failed_terminal',
])

export class Outbox {
  readonly #store: OutboxStore
  readonly #workspace: WorkspaceId
  readonly #onTransition: ((e: OutboxTransitionEvent) => MaybePromise<void>) | undefined

  constructor(options: OutboxOptions) {
    this.#store = options.store
    this.#workspace = options.workspace_id
    this.#onTransition = options.onTransition
  }

  get store(): OutboxStore {
    return this.#store
  }

  /**
   * 发送前的第一跳：**同一审批项只发一次**。
   *
   * 这是 outbox 存在的最直接理由。没有它，一次 `failed_retryable` 的重试、一次
   * 人手动再按一遍「通过」、一次进程重启后的补偿，都会各发一封信。
   */
  async prepare(input: PrepareInput): Promise<PrepareOutcome> {
    const now_ms = Date.parse(input.now)
    const prior = await this.#store.byIdempotencyKey(this.#workspace, input.idempotency_key)
    if (prior !== undefined) {
      if (prior.payload_hash !== input.payload_hash) return { kind: 'payload_drift', record: prior }
      if (TERMINAL_OR_IN_FLIGHT.has(prior.status)) return { kind: 'already', record: prior }
      return { kind: 'retry', record: prior }
    }
    const record: OutboxRecord = {
      id: `obx_${sha256(`${this.#workspace}|${input.idempotency_key}`).slice(0, 16)}`,
      workspace_id: this.#workspace,
      idempotency_key: input.idempotency_key,
      thread_ref: input.thread_ref,
      message_id: input.message_id,
      payload_hash: input.payload_hash,
      status: 'prepared',
      attempts: 0,
      reconcile_attempts: 0,
      created_at_ms: now_ms,
      updated_at_ms: now_ms,
      ...(input.approval_item_id === undefined ? {} : { approval_item_id: input.approval_item_id }),
    }
    await this.#store.put(record)
    return { kind: 'new', record }
  }

  /** 领走这一次尝试（`prepared` / `failed_retryable` → `sending`，attempts + 1）。 */
  async beginSend(record: OutboxRecord, now: Iso8601): Promise<OutboxRecord> {
    return this.#move(record, 'sending', Date.parse(now), (r) => {
      r.attempts += 1
      delete r.next_at_ms
    })
  }

  /** 上游收下了（SMTP 250 / Connect 回了 id）。还不算 confirmed——那要对账拿到证据。 */
  async markAccepted(
    record: OutboxRecord,
    now: Iso8601,
    external_id?: string,
  ): Promise<OutboxRecord> {
    return this.#move(record, 'accepted_by_provider', Date.parse(now), (r) => {
      if (external_id !== undefined) r.external_id = external_id
      delete r.last_error
    })
  }

  /** 拿到证据了。 */
  async markConfirmed(
    record: OutboxRecord,
    now: Iso8601,
    source: ConfirmationSource,
  ): Promise<OutboxRecord> {
    return this.#move(record, 'confirmed', Date.parse(now), (r) => {
      r.confirmation_source = source
      delete r.reconcile_next_at_ms
    })
  }

  /**
   * 一次失败的落账。三态由 `classifySendFailure` 定：
   *
   * - `failed_retryable`：排退避；尝试次数到顶转 `failed_terminal`。
   * - `sent_unknown`：**排对账，不排重试**。
   * - `failed_terminal`：到此为止。
   */
  async recordFailure(
    record: OutboxRecord,
    failure: SendFailure,
    now: Iso8601,
  ): Promise<OutboxRecord> {
    const now_ms = Date.parse(now)
    if (failure.status === 'failed_retryable' && record.attempts >= OUTBOX_MAX_ATTEMPTS) {
      return this.#move(record, 'failed_terminal', now_ms, (r) => {
        r.last_error = `${failure.token}（重试 ${record.attempts} 次仍然失败）`
      })
    }
    return this.#move(record, failure.status, now_ms, (r) => {
      r.last_error = failure.token
      if (failure.status === 'failed_retryable') r.next_at_ms = now_ms + outboxBackoffMs(r.attempts)
      if (failure.status === 'sent_unknown') {
        // 绝不自动重试：这条行从此只等对账的证据。
        delete r.next_at_ms
        r.reconcile_next_at_ms = now_ms + reconcileDelayMs(r.reconcile_attempts)
      }
    })
  }

  /** 到期该对账的那几条。 */
  async dueForReconcile(now: Iso8601, limit?: number): Promise<OutboxRecord[]> {
    return this.#store.dueForReconcile(Date.parse(now), limit)
  }

  /**
   * 一次对账的结论。
   *
   * 找到证据 → `confirmed`。没找到 → 排下一次；次数耗尽 → 标记耗尽（调用方据此
   * 出人工卡）。**任何一条路上都不重发**。
   */
  async recordReconcile(
    record: OutboxRecord,
    found: { source: ConfirmationSource } | undefined,
    now: Iso8601,
  ): Promise<{ record: OutboxRecord; outcome: 'confirmed' | 'still_unknown' | 'exhausted' }> {
    const now_ms = Date.parse(now)
    if (found !== undefined) {
      return { record: await this.markConfirmed(record, now, found.source), outcome: 'confirmed' }
    }
    // 迟迟没确认的 `accepted_by_provider` 只重排，不消耗 `sent_unknown` 的对账预算。
    if (record.status === 'accepted_by_provider') {
      const next = { ...record, updated_at_ms: now_ms }
      await this.#store.put(next)
      return { record: next, outcome: 'still_unknown' }
    }
    const attempts = record.reconcile_attempts + 1
    if (attempts >= MAX_RECONCILE_ATTEMPTS) {
      const next: OutboxRecord = {
        ...record,
        reconcile_attempts: attempts,
        reconcile_exhausted_at_ms: now_ms,
        updated_at_ms: now_ms,
      }
      delete next.reconcile_next_at_ms
      await this.#store.put(next)
      return { record: next, outcome: 'exhausted' }
    }
    const next: OutboxRecord = {
      ...record,
      reconcile_attempts: attempts,
      reconcile_next_at_ms: now_ms + reconcileDelayMs(attempts),
      updated_at_ms: now_ms,
    }
    await this.#store.put(next)
    return { record: next, outcome: 'still_unknown' }
  }

  /**
   * 人看过对账卡之后决定「确实没发出去，重发一次」。
   *
   * 这条边**只有人能走**。它存在是因为对账找不到证据不等于没发出去，也不等于
   * 发出去了——那时候需要一个人去看客户那边到底收没收到。
   */
  async requeueByHuman(record: OutboxRecord, now: Iso8601): Promise<OutboxRecord> {
    return this.#move(record, 'prepared', Date.parse(now), (r) => {
      r.reconcile_attempts = 0
      delete r.reconcile_next_at_ms
      delete r.reconcile_exhausted_at_ms
    })
  }

  async #move(
    record: OutboxRecord,
    to: OutboxStatus,
    now_ms: number,
    mutate: (r: OutboxRecord) => void,
  ): Promise<OutboxRecord> {
    const from = record.status
    if (!canTransition(from, to)) {
      throw new Error(`outbox：不合法的状态迁移 ${from} → ${to}（${record.id}）`)
    }
    const next: OutboxRecord = { ...record, status: to, updated_at_ms: now_ms }
    mutate(next)
    await this.#store.put(next)
    await this.#onTransition?.({
      record: next,
      from,
      to,
      ...(next.last_error === undefined ? {} : { reason: next.last_error }),
    })
    return next
  }
}
