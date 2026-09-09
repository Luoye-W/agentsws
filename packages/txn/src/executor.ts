import type {
  ApplyError,
  ApprovalItem,
  ExecutionSnapshot,
  Iso8601,
  ObjectRef,
  StagedChange,
} from '@agentsws/contracts'
import { evaluateGuardrail, Provenance, snapshotMatches } from '@agentsws/core'
import { ApprovalBusImpl, finalPayload } from './approvals.js'
import type { TxnRuntime } from './runtime.js'
import type {
  ApplyOutcome,
  ApprovalContext,
  BackendResult,
  RecordRead,
  SnapshotComponents,
} from './types.js'
import { TxnError } from './types.js'
import { counterKey, DAY_MS, localDay, ms, plusMs, refKey } from './util.js'

const IN_FLIGHT: StagedChange['status'][] = [
  'staged',
  'approved',
  'auto_approved',
  'applying',
  'applied',
  'unknown',
]

export interface ReconcileOutcome {
  status: 'applied' | 'failed'
  execution_id?: string
  outcome_ref?: ObjectRef
  message?: string
}

/**
 * 15 §5 执行器：八步（含步骤 0 幂等）。同目标同 kind 串行；三态结果含 unknown。
 *
 * **串行是两层**（31 §3.2「单一施行者队列」）：
 * 1. 进程内一条 Promise 链 —— 同一个执行器实例里排队，不去抢自己的锁；
 * 2. 存储层的施行锁 + 围栏号 —— 跨进程那一层。WP4 只有第 1 层，
 *    于是同一台机器上跑两个服务进程（或桌面壳重启 sidecar 时老进程还没死透）
 *    就会两边同时 apply 同一条变更。第 2 层由 `TxnStore.acquireApplyLock` 兑现：
 *    内存档是进程内 Map，SQLite 档是真表，一致性套件对两档跑同一份用例。
 *
 * 围栏号（fencing token）随每次拿锁**严格递增**，原样传给 `backendApply` /
 * `deliverOutbound`。锁能防同时写，防不了「租约过期后才醒过来、以为自己还持着锁」
 * 的迟到写——那一次能拦住的只有号：后端记下见过的最大号，比它小的一律拒。
 */
export class Executor {
  /** 同 (target, kind) 的进程内施行串行队列 */
  private locks = new Map<string, Promise<unknown>>()
  /** 这个执行器实例的身份（错误信息里告诉用户是谁占着）。 */
  private readonly holder: string

  constructor(
    private readonly rt: TxnRuntime,
    private readonly bus: ApprovalBusImpl,
  ) {
    this.holder = `${rt.policy.executor_id}#${rt.newId('ex')}`
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /**
   * 进程内排队 → 抢存储层的锁 → 把围栏号交给 `fn` → 无论成败都释放。
   * 抢不到就是 `conflict`：另一个施行者正在动同一个目标，这一次不该硬挤进去。
   */
  private withApplyLock<T>(key: string, fn: (fencing_token: number) => Promise<T>): Promise<T> {
    return this.serial(key, async () => {
      const lock = this.rt.store.acquireApplyLock({
        key,
        holder: this.holder,
        now: this.rt.now(),
        leaseMs: this.rt.policy.apply_lease_ms,
      })
      if (lock === undefined) {
        const held = this.rt.store.applyLockOf(key)
        throw new TxnError('conflict', `同一目标正在施行中，请稍后再试：${key}`, {
          key,
          holder: held?.holder,
          expires_at: held?.expires_at,
        })
      }
      try {
        return await fn(lock.token)
      } finally {
        this.rt.store.releaseApplyLock(key, lock.token)
      }
    })
  }

  async apply(change_id: string, opts: { force?: boolean } = {}): Promise<ApplyOutcome> {
    const head = this.rt.store.getChange(change_id)
    if (!head) throw new TxnError('not_found', `变更不存在：${change_id}`)
    return this.withApplyLock(`${refKey(head.target)}|${head.kind}`, (fencing_token) =>
      this.applyLocked(change_id, { ...opts, fencing_token }),
    )
  }

  /** 批量通过后逐条 apply：一条失败不影响其他（14 §8）。 */
  async applyAll(change_ids: string[]): Promise<ApplyOutcome[]> {
    const out: ApplyOutcome[] = []
    for (const id of change_ids) {
      try {
        out.push(await this.apply(id))
      } catch (err) {
        const change = this.rt.store.getChange(id)
        if (!change) throw err
        out.push({
          change,
          status: change.status,
          error: { code: 'provider_error', message: String(err), retryable: false },
        })
      }
    }
    return out
  }

  private async applyLocked(
    change_id: string,
    opts: { force?: boolean; fencing_token: number },
  ): Promise<ApplyOutcome> {
    const now = this.rt.now()
    const change = this.rt.store.getChange(change_id)
    if (!change) throw new TxnError('not_found', change_id)

    // 步骤 0：已 applied（或已记 unknown）再 apply → 返回原结果，不二次写
    if (change.status === 'applied' || change.status === 'unknown')
      return {
        change,
        status: change.status,
        ...(change.apply?.error ? { error: change.apply.error } : {}),
      }

    // 步骤 1：必须 approved / auto_approved
    if (change.status !== 'approved' && change.status !== 'auto_approved')
      return this.fail(change, {
        code: 'not_approved',
        message: `状态 ${change.status} 不可施行`,
        retryable: false,
      })

    // 31 §3.2 批准后取消窗口
    const approvedAt = change.approval?.at
    if (
      !opts.force &&
      approvedAt &&
      ms(now) - ms(approvedAt) < this.rt.policy.cancel_window_sec * 1000
    )
      throw new TxnError('conflict', '批准后的取消窗口尚未结束')

    // 步骤 2：批准标记必须来自宿主
    if (!this.rt.store.isApproved(change_id))
      return this.fail(change, {
        code: 'not_approved',
        message: '宿主未写入 approved_change_ids',
        retryable: false,
      })

    // 步骤 3：凭 run_id 取 ProvenanceState，apply 时重查 target
    const provState = this.rt.store.getProvenance(change.run_id)
    if (!provState || !Provenance.from(provState).has(change.target))
      return this.fail(change, {
        code: 'guardrail',
        message: `provenance_missing：${refKey(change.target)} 不在本次运行见过的集合里`,
        retryable: false,
      })

    // 步骤 4：重读目标记录，record_version 变了 → 任何 kind 一律 stale_record
    const fallback: RecordRead = {
      ...(change.record_version !== undefined ? { record_version: change.record_version } : {}),
    }
    const read: RecordRead = await (this.rt.opts.readRecord?.(change.target) ?? fallback)
    if ((read.record_version ?? '') !== (change.record_version ?? ''))
      return this.fail(change, {
        code: 'stale_record',
        message: `记录已变（${change.record_version ?? '-'} → ${read.record_version ?? '-'}）`,
        retryable: false,
      })

    // 步骤 5：重跑 Guardrail（当前生效额度 + 新读到的记录）
    const mandate = this.rt.opts.mandateFor?.(change) ??
      this.rt.store.getMandate(change_id) ?? { caps: {} }
    const counter = counterKey(
      change.assignment_id,
      change.kind,
      localDay(now, this.rt.policy.business_tz_offset_minutes),
    )
    const rerun = evaluateGuardrail(
      {
        kind: change.kind,
        target: change.target,
        ...(change.field !== undefined ? { field: change.field } : {}),
        before: read.record ?? change.before,
        after: change.after,
        ...(change.money ? { amount_base: change.money.amount_base } : {}),
        ...(change.money?.margin_after_pct !== undefined
          ? { margin_after_pct: change.money.margin_after_pct }
          : {}),
      },
      mandate,
      {
        now,
        changeSet: [],
        windowCount: Math.max(0, this.rt.store.countReserved(counter) - 1),
        cumulativePct: this.cumulativePctExcluding(change, now),
        provenance: Provenance.from(provState),
        approvedException: change.guardrail.approved_exception === true,
      },
      'apply',
    )
    for (const hit of rerun.hits)
      await this.rt.emit('guardrail.hit', {
        workspace_id: change.workspace_id,
        actor: { kind: 'system', id: this.rt.policy.executor_id },
        subject: { type: 'staged_change', id: change_id },
        correlation: { change_id, run_id: change.run_id },
        payload: { ...hit, kind: change.kind, phase: 'apply' },
      })
    if (rerun.verdict !== 'allow')
      return this.fail(
        { ...change, guardrail_rerun: rerun },
        {
          // 15 §8.6：stage 时通过、apply 时不通过 = 策略收紧
          code: change.guardrail.verdict === 'allow' ? 'policy_tightened' : 'guardrail',
          message: rerun.hits.map((h) => h.rule).join(', '),
          retryable: false,
        },
      )

    // 步骤 5.5（31 §3.2）：重算执行快照，任一分量变化 → snapshot_mismatch
    const item = change.approval ? this.rt.store.getApproval(change.approval.item_id) : undefined
    const fresh = this.snapshotOf(change, item, read.record_version, rerun.effective_mandate_hash)
    if (change.execution_snapshot) {
      const cmp = snapshotMatches(change.execution_snapshot, fresh)
      if (!cmp.ok)
        return this.fail(
          { ...change, guardrail_rerun: rerun },
          {
            code: 'snapshot_mismatch',
            message: `执行快照分量变化：${cmp.changed.join(', ')}`,
            retryable: false,
          },
        )
    }

    // 步骤 6–8
    return this.runBackend({ ...change, guardrail_rerun: rerun }, item, now, opts.fencing_token)
  }

  private async runBackend(
    change: StagedChange,
    item: ApprovalItem | undefined,
    now: Iso8601,
    fencing_token: number,
  ): Promise<ApplyOutcome> {
    this.rt.store.putChange({ ...change, status: 'applying', updated_at: now })
    if (item) await this.bus.recordApply(item.id, 'applying', item.apply ?? { attempts: [] })
    await this.rt.emit('change.applying', {
      workspace_id: change.workspace_id,
      actor: { kind: 'system', id: this.rt.policy.executor_id },
      subject: { type: 'staged_change', id: change.id },
      correlation: { change_id: change.id, run_id: change.run_id },
      payload: { kind: change.kind },
    })
    if (item)
      await this.rt.emit('approval.applying', {
        workspace_id: change.workspace_id,
        actor: { kind: 'system', id: this.rt.policy.executor_id },
        subject: { type: 'approval_item', id: item.id },
        correlation: { change_id: change.id },
        payload: {},
        item_id: item.id,
      })

    const attempts: NonNullable<ApprovalItem['apply']>['attempts'] = []
    let result: BackendResult = { status: 'failed', error: { message: '未接入 backendApply' } }
    const maxAttempts = this.rt.policy.retry_max + 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result = this.rt.opts.backendApply
        ? await this.rt.opts.backendApply(change, {
            idempotencyKey: change.id,
            attempt,
            fencing_token,
          })
        : result
      attempts.push({
        at: this.rt.now(),
        by_executor: this.rt.policy.executor_id,
        idempotency_key: change.id,
        result: result.status === 'ok' ? 'ok' : result.status,
        ...(result.execution_id ? { execution_id: result.execution_id } : {}),
        ...(result.error ? { error: result.error.message } : {}),
      })
      if (result.status !== 'failed' || result.error?.retryable !== true) break
    }
    return this.finish(change, item, result, attempts)
  }

  private async finish(
    change: StagedChange,
    item: ApprovalItem | undefined,
    result: BackendResult,
    attempts: NonNullable<ApprovalItem['apply']>['attempts'],
  ): Promise<ApplyOutcome> {
    const at = this.rt.now()
    const guardrail_rerun = {
      passed: change.guardrail_rerun === undefined || change.guardrail_rerun.verdict === 'allow',
      caps_hit: (change.guardrail_rerun?.hits ?? []).map((h) => h.rule),
    }
    if (result.status === 'ok') {
      const next: StagedChange = {
        ...change,
        status: 'applied',
        updated_at: at,
        apply: {
          by_executor: this.rt.policy.executor_id,
          at,
          idempotency_key: change.id,
          ...(result.execution_id ? { execution_id: result.execution_id } : {}),
          ...(result.outcome_ref ? { outcome_ref: result.outcome_ref } : {}),
        },
      }
      // apply 成功的落地一次做完：预占转 committed + 变更转 applied
      this.rt.tx(() => {
        this.rt.store.commitReservation(change.id)
        this.rt.store.putChange(next)
      })
      if (item)
        await this.bus.recordApply(item.id, 'applied', {
          attempts,
          guardrail_rerun,
          ...(result.outcome_ref ? { outcome_ref: result.outcome_ref } : {}),
        })
      await this.rt.emit('change.applied', {
        workspace_id: change.workspace_id,
        actor: { kind: 'system', id: this.rt.policy.executor_id },
        subject: { type: 'staged_change', id: change.id },
        correlation: {
          change_id: change.id,
          run_id: change.run_id,
          ...(result.execution_id ? { execution_id: result.execution_id } : {}),
        },
        payload: { outcome_ref: result.outcome_ref ?? null },
        ...(item ? { item_id: item.id } : {}),
      })
      if (item)
        await this.rt.emit('approval.applied', {
          workspace_id: change.workspace_id,
          actor: { kind: 'system', id: this.rt.policy.executor_id },
          subject: { type: 'approval_item', id: item.id },
          correlation: { change_id: change.id },
          payload: {},
          item_id: item.id,
        })
      return { change: next, status: 'applied' }
    }

    if (result.status === 'unknown') {
      // 15 §5.8：超时 / 响应丢失 → unknown；预占不释放，等对账
      const next: StagedChange = {
        ...change,
        status: 'unknown',
        updated_at: at,
        apply: {
          by_executor: this.rt.policy.executor_id,
          at,
          idempotency_key: change.id,
          ...(result.execution_id ? { execution_id: result.execution_id } : {}),
          error: {
            code: 'unknown_outcome',
            message: result.error?.message ?? '响应丢失，待对账',
            retryable: false,
          },
        },
      }
      this.rt.store.putChange(next)
      if (item) await this.bus.recordApply(item.id, 'applying', { attempts, guardrail_rerun })
      await this.rt.emit('change.unknown', {
        workspace_id: change.workspace_id,
        actor: { kind: 'system', id: this.rt.policy.executor_id },
        subject: { type: 'staged_change', id: change.id },
        correlation: {
          change_id: change.id,
          ...(result.execution_id ? { execution_id: result.execution_id } : {}),
        },
        payload: { needs_reconciliation: true },
        ...(item ? { item_id: item.id } : {}),
      })
      return {
        change: next,
        status: 'unknown',
        ...(next.apply?.error ? { error: next.apply.error } : {}),
      }
    }

    const error: ApplyError = {
      code: 'provider_error',
      message: result.error?.message ?? '施行失败',
      retryable: result.error?.retryable === true,
    }
    return this.fail(change, error, item, attempts)
  }

  private async fail(
    change: StagedChange,
    error: ApplyError,
    item?: ApprovalItem,
    attempts: NonNullable<ApprovalItem['apply']>['attempts'] = [],
  ): Promise<ApplyOutcome> {
    const at = this.rt.now()
    const next: StagedChange = {
      ...change,
      status: 'failed',
      updated_at: at,
      ...(change.reservation ? { reservation: { ...change.reservation, released: true } } : {}),
      apply: {
        by_executor: this.rt.policy.executor_id,
        at,
        idempotency_key: change.id,
        error,
      },
    }
    // 失败的落地一次做完：释放预占 + 变更转 failed
    this.rt.tx(() => {
      this.rt.store.releaseReservation(change.id)
      this.rt.store.putChange(next)
    })
    const linked =
      item ?? (change.approval ? this.rt.store.getApproval(change.approval.item_id) : undefined)
    if (linked)
      await this.bus.recordApply(linked.id, 'apply_failed', {
        attempts,
        guardrail_rerun: {
          passed: false,
          caps_hit: (change.guardrail_rerun?.hits ?? []).map((h) => h.rule),
        },
      })
    await this.rt.emit('change.failed', {
      workspace_id: change.workspace_id,
      actor: { kind: 'system', id: this.rt.policy.executor_id },
      subject: { type: 'staged_change', id: change.id },
      correlation: { change_id: change.id, run_id: change.run_id },
      payload: { error },
      ...(linked ? { item_id: linked.id } : {}),
    })
    if (linked)
      await this.rt.emit('approval.apply_failed', {
        workspace_id: change.workspace_id,
        actor: { kind: 'system', id: this.rt.policy.executor_id },
        subject: { type: 'approval_item', id: linked.id },
        correlation: { change_id: change.id },
        payload: { error },
        item_id: linked.id,
      })
    return { change: next, status: 'failed', error }
  }

  /** 15 §5.8：unknown 的人工 / 自动对账。 */
  async reconcile(change_id: string, outcome: ReconcileOutcome): Promise<ApplyOutcome> {
    const change = this.rt.store.getChange(change_id)
    if (!change) throw new TxnError('not_found', change_id)
    if (change.status !== 'unknown')
      throw new TxnError('conflict', `只有 unknown 需要对账（当前 ${change.status}）`)
    const item = change.approval ? this.rt.store.getApproval(change.approval.item_id) : undefined
    return this.finish(
      { ...change, status: 'applying' },
      item,
      outcome.status === 'applied'
        ? {
            status: 'ok',
            ...(outcome.execution_id ? { execution_id: outcome.execution_id } : {}),
            ...(outcome.outcome_ref ? { outcome_ref: outcome.outcome_ref } : {}),
          }
        : { status: 'failed', error: { message: outcome.message ?? '对账确认未施行' } },
      change.apply
        ? [
            {
              at: change.apply.at,
              by_executor: change.apply.by_executor,
              idempotency_key: change.apply.idempotency_key,
              result: 'unknown' as const,
              ...(change.apply.execution_id ? { execution_id: change.apply.execution_id } : {}),
            },
          ]
        : [],
    )
  }

  /** 31 §3.2 取消窗口内撤销一条已批准但未施行的变更。 */
  async cancel(change_id: string): Promise<StagedChange> {
    const change = this.rt.store.getChange(change_id)
    if (!change) throw new TxnError('not_found', change_id)
    if (change.status !== 'approved' && change.status !== 'auto_approved')
      throw new TxnError('conflict', `状态 ${change.status} 不可取消`)
    const now = this.rt.now()
    const approvedAt = change.approval?.at ?? change.updated_at
    if (ms(now) - ms(approvedAt) >= this.rt.policy.cancel_window_sec * 1000)
      throw new TxnError('conflict', '取消窗口已关闭')
    const next: StagedChange = {
      ...change,
      status: 'withdrawn',
      updated_at: now,
      ...(change.reservation ? { reservation: { ...change.reservation, released: true } } : {}),
    }
    this.rt.tx(() => {
      this.rt.store.releaseReservation(change_id)
      this.rt.store.putChange(next)
    })
    if (change.approval)
      await this.bus.recordApply(change.approval.item_id, 'apply_failed', undefined)
    await this.rt.emit('change.withdrawn', {
      workspace_id: change.workspace_id,
      actor: { kind: 'system', id: this.rt.policy.executor_id },
      subject: { type: 'staged_change', id: change_id },
      correlation: { change_id },
      payload: { reason: 'cancelled_in_window' },
    })
    return next
  }

  /**
   * 14 §4.1 / 31 §3.2 父子顺序：含子退款的回信，必须在所有子项 applied 之后才发。
   */
  async applyApproval(item_id: string): Promise<ApprovalItem> {
    const item = this.rt.store.getApproval(item_id)
    if (!item) throw new TxnError('not_found', item_id)
    if (!['approved', 'approved_edited', 'auto_approved'].includes(item.state))
      throw new TxnError('not_approved', `状态 ${item.state} 不可施行`)

    if (item.kind === 'staged_change') {
      const change_id = (item.payload as { change_id?: string }).change_id
      if (!change_id) throw new TxnError('invalid_input', 'staged_change 审批项缺 change_id')
      await this.apply(change_id)
      const out = this.rt.store.getApproval(item_id)
      if (!out) throw new TxnError('not_found', item_id)
      return out
    }
    if (item.kind !== 'outbound_draft')
      throw new TxnError('invalid_input', `${item.kind} 无执行器（v1）`)

    // 出站也要单一施行者：同一个线程 / 目标不能被两个进程同时发。
    return this.withApplyLock(`${refKey(item.subject.object)}|outbound_draft`, (fencing_token) =>
      this.deliverLocked(item, fencing_token),
    )
  }

  private async deliverLocked(item: ApprovalItem, fencing_token: number): Promise<ApprovalItem> {
    for (const child_id of item.links.children) {
      const child = this.rt.store.getApproval(child_id)
      if (!child) throw new TxnError('not_found', child_id)
      if (child.state !== 'applied')
        throw new TxnError('conflict', `子项 ${child_id} 尚未 applied（父子顺序）`)
    }

    const now = this.rt.now()
    const decidedAt = item.decision?.at
    if (decidedAt && ms(now) - ms(decidedAt) < this.rt.policy.cancel_window_sec * 1000)
      throw new TxnError('conflict', '批准后的取消窗口尚未结束')

    const ctx: ApprovalContext = this.rt.store.getContext(item.id) ?? {}
    const fresh = this.rt.snapshot({
      workspace: item.workspace_id,
      connection: ctx.connection_id ?? '',
      target: refKey(item.subject.object),
      record_version: ctx.record_version ?? '',
      recipients: item.routing.recipients.map((r) => r.person).sort(),
      final_payload: finalPayload(item),
      attachments: [...(ctx.attachments ?? [])].sort(),
      executor_version: this.rt.policy.executor_version,
      mandate_hash: ctx.mandate_hash ?? '',
    })
    if (item.execution_snapshot && !snapshotMatches(item.execution_snapshot, fresh).ok)
      throw new TxnError('snapshot_mismatch', '执行快照已变化，请重新审阅')

    await this.bus.recordApply(item.id, 'applying', item.apply ?? { attempts: [] })
    await this.rt.emit('approval.applying', {
      workspace_id: item.workspace_id,
      actor: { kind: 'system', id: this.rt.policy.executor_id },
      subject: { type: 'approval_item', id: item.id },
      payload: {},
      item_id: item.id,
    })
    const attempts: NonNullable<ApprovalItem['apply']>['attempts'] = []
    let result: BackendResult = { status: 'failed', error: { message: '未接入 deliverOutbound' } }
    const maxAttempts = this.rt.policy.retry_max + 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result = this.rt.opts.deliverOutbound
        ? await this.rt.opts.deliverOutbound(item, {
            idempotencyKey: item.id,
            attempt,
            fencing_token,
          })
        : result
      attempts.push({
        at: this.rt.now(),
        by_executor: this.rt.policy.executor_id,
        idempotency_key: item.id,
        result: result.status === 'ok' ? 'ok' : result.status,
        ...(result.execution_id ? { execution_id: result.execution_id } : {}),
        ...(result.error ? { error: result.error.message } : {}),
      })
      if (result.status !== 'failed' || result.error?.retryable !== true) break
    }
    const ok = result.status === 'ok'
    await this.bus.recordApply(item.id, ok ? 'applied' : 'apply_failed', {
      attempts,
      guardrail_rerun: { passed: ok, caps_hit: [] },
      ...(result.outcome_ref ? { outcome_ref: result.outcome_ref } : {}),
    })
    await this.rt.emit(ok ? 'approval.applied' : 'approval.apply_failed', {
      workspace_id: item.workspace_id,
      actor: { kind: 'system', id: this.rt.policy.executor_id },
      subject: { type: 'approval_item', id: item.id },
      correlation: { ...(result.execution_id ? { execution_id: result.execution_id } : {}) },
      payload: { outcome_ref: result.outcome_ref ?? null, status: result.status },
      item_id: item.id,
    })
    const out = this.rt.store.getApproval(item.id)
    if (!out) throw new TxnError('not_found', item.id)
    return out
  }

  private snapshotOf(
    change: StagedChange,
    item: ApprovalItem | undefined,
    record_version: string | undefined,
    mandate_hash: string,
  ): ExecutionSnapshot {
    const ctx: ApprovalContext = (item ? this.rt.store.getContext(item.id) : undefined) ?? {}
    const components: SnapshotComponents = {
      workspace: change.workspace_id,
      connection: ctx.connection_id ?? '',
      target: refKey(change.target),
      record_version: record_version ?? '',
      recipients: item ? item.routing.recipients.map((r) => r.person).sort() : [],
      final_payload: item ? finalPayload(item) : change.after,
      attachments: [...(ctx.attachments ?? [])].sort(),
      executor_version: this.rt.policy.executor_version,
      mandate_hash,
    }
    return this.rt.snapshot(components)
  }

  private cumulativePctExcluding(change: StagedChange, now: Iso8601): number {
    const since = plusMs(now, -this.rt.policy.cumulative_window_days * DAY_MS)
    return this.rt.store
      .listChanges({
        workspace_id: change.workspace_id,
        target: change.target,
        kind: change.kind,
        status: IN_FLIGHT,
        since,
      })
      .filter((c) => c.id !== change.id)
      .reduce((sum, c) => {
        const b = (c.before as { price?: number } | null)?.price
        const a = (c.after as { price?: number } | null)?.price
        if (typeof b !== 'number' || typeof a !== 'number' || b === 0) return sum
        return sum + (Math.abs(a - b) / Math.abs(b)) * 100
      }, 0)
  }
}

export { ApprovalBusImpl }
