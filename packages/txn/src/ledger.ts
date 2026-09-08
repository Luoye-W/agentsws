import type {
  ChangeKind,
  GuardrailResult,
  Iso8601,
  PersonId,
  StagedChange,
} from '@agentsws/contracts'
import {
  authorizationCheck,
  evaluateGuardrail,
  KIND_RISK,
  mandateHash,
  Provenance,
} from '@agentsws/core'
import type { ApprovalBusImpl } from './approvals.js'
import type { TxnRuntime } from './runtime.js'
import type { ApprovalContext, ChangeFilter, StageInput, StageOutcome } from './types.js'
import { TxnError } from './types.js'
import { counterKey, DAY_MS, deepEqual, localDay, plusMs, refKey } from './util.js'

const KNOWN_KINDS: ReadonlySet<string> = new Set<ChangeKind>(Object.keys(KIND_RISK) as ChangeKind[])
const AUTHORIZATION_GUARDED: ChangeKind[] = ['refund', 'reship', 'address_change']
/** 15 §3.2/§4.3：算累计与预占时算在内的状态（applied + 在途 + 预占）。 */
const IN_FLIGHT: StagedChange['status'][] = [
  'staged',
  'approved',
  'auto_approved',
  'applying',
  'applied',
  'unknown',
]
const REVERSIBLE: ChangeKind[] = [
  'price_change',
  'address_change',
  'publish_product',
  'unpublish_product',
  'pause_ad',
  'discount_code',
  'listing_edit',
  'bid_change',
  'budget_change',
]

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const pctDelta = (before: unknown, after: unknown): number => {
  const b = num(rec(before).price)
  const a = num(rec(after).price)
  if (b === undefined || a === undefined || b === 0) return 0
  return (Math.abs(a - b) / Math.abs(b)) * 100
}

export class ChangeLedgerImpl {
  constructor(
    private readonly rt: TxnRuntime,
    private readonly bus: ApprovalBusImpl,
  ) {}

  /**
   * 15 §3.3 stage：关系授权门禁 → guardrail(stage) → 预占 → 建审批项。
   * block 不建变更、不建审批项，返回原因（运行内告诉模型）。
   */
  async stage(input: StageInput): Promise<StageOutcome> {
    const now = this.rt.now()
    if (!KNOWN_KINDS.has(input.kind))
      throw new TxnError(
        'invalid_input',
        `未建模的变更 kind：${String(input.kind)}（staged_action v1 关闭，31 §3.2）`,
      )
    if (input.provenance) this.rt.store.putProvenance(input.provenance)

    // 15 §6.1 / 31 §3.3 关系授权门禁（provenance 只证明"读过"）
    if (AUTHORIZATION_GUARDED.includes(input.kind)) {
      const auth = authorizationCheck({
        kind: input.kind,
        requester: input.requester ?? { channel: 'unknown', external_id: '' },
        target: input.target,
        ...(input.target_owner ? { target_owner: input.target_owner } : {}),
      })
      if (!auth.ok) {
        await this.rt.emit('change.blocked', {
          workspace_id: input.workspace_id,
          actor: { kind: 'agent', id: input.created_by.id, run_id: input.run_id },
          subject: input.target,
          correlation: { run_id: input.run_id },
          payload: { kind: input.kind, rule: 'authorization_check', reason: auth.reason },
        })
        await this.rt.emit('guardrail.hit', {
          workspace_id: input.workspace_id,
          actor: { kind: 'agent', id: input.created_by.id, run_id: input.run_id },
          subject: input.target,
          correlation: { run_id: input.run_id },
          payload: { rule: 'authorization_check', severity: 'block', reason: auth.reason },
        })
        return {
          ok: false,
          reason: 'authorization_check_failed',
          message: auth.reason ?? '关系授权门禁未通过，转人工核验',
        }
      }
    }

    // 15 §8.2：before 必须来自 stage 时读到的记录，篡改 before 的 stage 请求被拒
    let record_version = input.record_version
    if (this.rt.opts.readRecord) {
      const read = await this.rt.opts.readRecord(input.target)
      if (record_version === undefined) record_version = read.record_version
      if (read.record !== undefined) {
        const r = rec(read.record)
        const b = rec(input.before)
        const tampered = Object.keys(b).filter((k) => k in r && !deepEqual(r[k], b[k]))
        if (tampered.length > 0) {
          await this.rt.emit('change.blocked', {
            workspace_id: input.workspace_id,
            actor: { kind: 'agent', id: input.created_by.id, run_id: input.run_id },
            subject: input.target,
            correlation: { run_id: input.run_id },
            payload: { kind: input.kind, rule: 'before_ungrounded', fields: tampered },
          })
          return {
            ok: false,
            reason: 'guardrail',
            message: `before_ungrounded: ${tampered.join(', ')}`,
          }
        }
      }
    }

    const provenance = input.provenance ? Provenance.from(input.provenance) : undefined
    if (provenance) provenance.pin(input.target)
    const counter = counterKey(
      input.assignment_id,
      input.kind,
      localDay(now, this.rt.policy.business_tz_offset_minutes),
    )
    const guardrail = evaluateGuardrail(
      {
        kind: input.kind,
        target: input.target,
        ...(input.field !== undefined ? { field: input.field } : {}),
        before: input.before,
        after: input.after,
        ...(input.money ? { amount_base: input.money.amount_base } : {}),
        ...(input.margin_after_pct !== undefined
          ? { margin_after_pct: input.margin_after_pct }
          : {}),
      },
      input.mandate,
      {
        now,
        changeSet: this.rt.store
          .listChanges({ change_set_id: input.change_set_id, status: IN_FLIGHT })
          .map((c) => ({ target: c.target, kind: c.kind, ...(c.field ? { field: c.field } : {}) })),
        // 15 §4.3 + 31 §3.2：applied + 在途 + 预占
        windowCount: this.rt.store.countReserved(counter),
        cumulativePct: this.cumulativePct(input, now),
        ...(input.daily_spend_total !== undefined
          ? { dailySpendTotal: input.daily_spend_total }
          : {}),
        ...(provenance ? { provenance } : {}),
      },
      'stage',
    )

    for (const hit of guardrail.hits)
      await this.rt.emit('guardrail.hit', {
        workspace_id: input.workspace_id,
        actor: { kind: 'agent', id: input.created_by.id, run_id: input.run_id },
        subject: input.target,
        correlation: { run_id: input.run_id },
        payload: { ...hit, kind: input.kind, phase: 'stage' },
      })

    if (guardrail.verdict === 'block') {
      await this.rt.emit('change.blocked', {
        workspace_id: input.workspace_id,
        actor: { kind: 'agent', id: input.created_by.id, run_id: input.run_id },
        subject: input.target,
        correlation: { run_id: input.run_id },
        payload: { kind: input.kind, hits: guardrail.hits },
      })
      return {
        ok: false,
        reason: 'guardrail',
        guardrail,
        message: guardrail.hits
          .filter((h) => h.severity === 'block')
          .map((h) => h.rule)
          .join(', '),
      }
    }

    const id = this.rt.newId('chg')
    const expires_at = plusMs(
      now,
      (this.rt.policy.expiry_days[input.approval.parent ? 'outbound_draft' : 'staged_change'] ??
        this.rt.policy.expiry_days.default) * DAY_MS,
    )
    const change: StagedChange = {
      id,
      schema_version: 1,
      workspace_id: input.workspace_id,
      role_id: input.role_id,
      assignment_id: input.assignment_id,
      run_id: input.run_id,
      change_set_id: input.change_set_id,
      kind: input.kind,
      risk_class: KIND_RISK[input.kind],
      target: input.target,
      ...(input.field !== undefined ? { field: input.field } : {}),
      before: input.before,
      after: input.after,
      ...(record_version !== undefined ? { record_version } : {}),
      ...(input.money ? { money: input.money } : {}),
      guardrail,
      notes: input.notes ?? [],
      created_by: input.created_by,
      status: 'staged',
      reservation: { counter, amount: 1 },
      expires_at,
      created_at: now,
      updated_at: now,
    }
    this.rt.store.putChange(change)
    this.rt.store.putMandate(id, input.mandate)
    // 31 §3.2 预占：stage 即占 (assignment, kind, day) 的名额
    this.rt.store.reserve(counter, id, 1)
    await this.rt.emit('change.staged', {
      workspace_id: change.workspace_id,
      actor: { kind: change.created_by.kind, id: change.created_by.id, run_id: change.run_id },
      subject: { type: 'staged_change', id },
      correlation: { run_id: change.run_id, change_id: id },
      payload: { kind: change.kind, target: refKey(change.target), verdict: guardrail.verdict },
    })

    const ctx: ApprovalContext = {
      change_id: id,
      ...(record_version !== undefined ? { record_version } : {}),
      ...(input.connection_id !== undefined ? { connection_id: input.connection_id } : {}),
      mandate_hash: guardrail.effective_mandate_hash,
    }
    const item = await this.bus.create({
      workspace_id: input.workspace_id,
      schema_version: 1,
      kind: 'staged_change',
      role_id: input.role_id,
      subject: { object: input.target },
      dedupe_key: this.dedupeFor(input),
      title: input.approval.title,
      summary: input.approval.summary,
      payload: {
        change_id: id,
        kind: input.kind,
        target: input.target,
        before: input.before,
        after: input.after,
        guardrail_notes: guardrail.hits.map((h) => h.rule),
        mandate_result: { within: guardrail.verdict === 'allow' },
        ...(input.money ? { money: input.money } : {}),
      },
      evidence: {
        run_id: input.run_id,
        source_events: input.approval.source_events ?? [],
        provenance: { seen: seenRefs(input) },
        precheck: {},
      },
      proposer: input.approval.proposer,
      automation: {
        level_at_creation: input.level,
        auto_approved: false,
        mandate_check: {
          within: guardrail.verdict === 'allow',
          caps_hit: guardrail.hits.map((h) => h.rule),
        },
        sampling: { selected: false },
      },
      routing: {
        recipients: input.approval.recipients,
        rule: input.approval.rule ?? 'role_holder',
        escalation: {
          after_hours: this.rt.policy.escalation_hours.scope_manager,
          business_hours: true,
          chain: ['scope_manager', 'owner'],
          escalated_at: [],
          ...input.approval.escalation,
        },
        separation_of_duties: input.approval.separation_of_duties ?? true,
      },
      priority: input.approval.priority ?? 'queue',
      expires_at,
      ...(input.approval.parent ? { links: { parent: input.approval.parent } } : {}),
      context: ctx,
    })

    if (item.state === 'blocked') {
      this.rt.store.releaseReservation(id)
      this.rt.store.putChange({
        ...change,
        status: 'withdrawn',
        reservation: { counter, amount: 1, released: true },
        updated_at: now,
      })
      return {
        ok: false,
        reason: 'guardrail',
        guardrail,
        message: (item.evidence.precheck.notes ?? ['预检失败']).join('; '),
      }
    }

    const stored = this.rt.store.getChange(id)
    if (!stored) throw new TxnError('not_found', id)
    return { ok: true, change: stored, approval: item }
  }

  /** 15 §5 §4.3：同目标同 kind 最近 N 天 applied + 在途 + 预占的累计百分比。 */
  private cumulativePct(
    input: Pick<StageInput, 'kind' | 'target' | 'workspace_id'>,
    now: Iso8601,
  ): number {
    const since = plusMs(now, -this.rt.policy.cumulative_window_days * DAY_MS)
    return this.rt.store
      .listChanges({
        workspace_id: input.workspace_id,
        target: input.target,
        kind: input.kind,
        status: IN_FLIGHT,
        since,
      })
      .reduce((sum, c) => sum + pctDelta(c.before, c.after), 0)
  }

  /** 14 §5：staged_change 的 discriminator 是 (target, field)。 */
  private dedupeFor(input: StageInput): string {
    return `dk_${input.workspace_id}|staged_change|${refKey(input.target)}|${input.kind}|${input.field ?? ''}`
  }

  async get(id: string): Promise<StagedChange | undefined> {
    return this.rt.store.getChange(id)
  }

  async list(filter: ChangeFilter): Promise<StagedChange[]> {
    return this.rt.store.listChanges(filter)
  }

  async withdraw(id: string, by: PersonId): Promise<StagedChange> {
    const change = this.rt.store.getChange(id)
    if (!change) throw new TxnError('not_found', id)
    if (!['staged', 'approved', 'auto_approved'].includes(change.status))
      throw new TxnError('conflict', `状态 ${change.status} 不可撤回`)
    const now = this.rt.now()
    this.rt.store.releaseReservation(id)
    const next: StagedChange = {
      ...change,
      status: 'withdrawn',
      updated_at: now,
      ...(change.reservation ? { reservation: { ...change.reservation, released: true } } : {}),
    }
    this.rt.store.putChange(next)
    await this.rt.emit('change.withdrawn', {
      workspace_id: change.workspace_id,
      actor: { kind: 'person', id: by },
      subject: { type: 'staged_change', id },
      correlation: { change_id: id },
      payload: { by },
    })
    return next
  }

  /** 15 §5 反向变更：可逆 kind 的 applied 变更生成 reversal_of 的新条目（走同一流程）。 */
  async reverse(id: string, by: PersonId): Promise<StagedChange> {
    const change = this.rt.store.getChange(id)
    if (!change) throw new TxnError('not_found', id)
    if (!REVERSIBLE.includes(change.kind))
      throw new TxnError('conflict', `${change.kind} 不可逆，反向操作需另提`)
    if (change.status !== 'applied')
      throw new TxnError('conflict', `只有 applied 的变更可反向（当前 ${change.status}）`)
    const now = this.rt.now()
    const reversal: StagedChange = {
      ...change,
      id: this.rt.newId('chg'),
      before: change.after,
      after: change.before,
      status: 'staged',
      reversal_of: change.id,
      guardrail: {
        verdict: 'require_review',
        hits: [{ rule: 'reversal', severity: 'review' }],
        effective_mandate_hash: mandateHash(this.rt.store.getMandate(change.id) ?? { caps: {} }),
        evaluated_at: now,
      } satisfies GuardrailResult,
      created_by: { kind: 'person', id: by },
      created_at: now,
      updated_at: now,
    }
    delete reversal.apply
    delete reversal.approval
    delete reversal.execution_snapshot
    this.rt.store.putChange(reversal)
    this.rt.store.putChange({ ...change, status: 'reversed', updated_at: now })
    await this.rt.emit('change.reversed', {
      workspace_id: change.workspace_id,
      actor: { kind: 'person', id: by },
      subject: { type: 'staged_change', id: change.id },
      correlation: { change_id: change.id },
      payload: { reversal_id: reversal.id },
    })
    return reversal
  }
}

function seenRefs(input: StageInput): { type: string; id: string }[] {
  if (!input.provenance) return [input.target]
  const out: { type: string; id: string }[] = []
  for (const [type, ids] of Object.entries(input.provenance.seen))
    for (const id of ids) out.push({ type, id })
  return out
}
