import type {
  ApprovalBus,
  ApprovalExecutionContext,
  ApprovalItem,
  ApprovalKind,
  ApprovalState,
  DecideInput,
  Decision,
  Delivery,
  ExecutionSnapshot,
  Iso8601,
  PersonId,
  Recipient,
  RerouteInput,
  RoleId,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { appendEscalationStep, boundRecipients, escalationTierHeldBy } from './escalation.js'
import { isKnownKind, runPrecheck } from './precheck.js'
import type { TxnRuntime } from './runtime.js'
import type {
  ApplyOutcome,
  ApprovalContext,
  CreateApprovalInput,
  NormalizedCreateInput,
  SnapshotComponents,
} from './types.js'
import { normalizeCreateInput, TxnError } from './types.js'
import { businessHoursBetween, expiryFor, ms, nonceFrom, refKey, signToken } from './util.js'

/** §4 状态机里"还能被决定"的状态。 */
const ACTIVE: ApprovalState[] = ['pending', 'in_review', 'deferred']
const DECIDABLE: ApprovalState[] = ['pending', 'in_review', 'deferred']

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

export interface BatchEntry {
  id: string
  decision_token: string
}

/**
 * 落在 `ApprovalItem.execution_context` 上的那一份：**只有快照分量的来源**。
 *
 * 门禁输入（`thread_participants` / `verified_contacts` / `precheck_overrides`）
 * 留在旁边那张上下文表里，不进审批项本体——审批项会经 `/v1/approvals` 发给所有
 * 有权看队列的人，客户联系方式没必要跟着走一圈（31 §3.3「输出通道清单统一过一遍脱敏」）。
 * apply 前重算快照读的仍是上下文表，两处是同一份 `ApprovalExecutionContext`。
 */
function snapshotProvenanceOf(ctx: ApprovalContext): ApprovalExecutionContext {
  return {
    ...(ctx.connection_id === undefined ? {} : { connection_id: ctx.connection_id }),
    ...(ctx.record_version === undefined ? {} : { record_version: ctx.record_version }),
    ...(ctx.attachments === undefined ? {} : { attachments: [...ctx.attachments] }),
    ...(ctx.mandate_hash === undefined ? {} : { mandate_hash: ctx.mandate_hash }),
    ...(ctx.change_id === undefined ? {} : { change_id: ctx.change_id }),
  }
}

export class ApprovalBusImpl implements ApprovalBus {
  /** 由 createTxn 注入，供 retryApply 用（同一事务边界内的执行器）。 */
  applier?: (item: ApprovalItem) => Promise<ApplyOutcome | ApprovalItem>

  constructor(private readonly rt: TxnRuntime) {}

  // ───────────────────────────── create（§0 → §6 → 额度 → 路由）

  async create<P>(raw: CreateApprovalInput<P>): Promise<ApprovalItem<P>> {
    if (!isKnownKind(raw.kind))
      throw new TxnError(
        'invalid_input',
        `未知审批 kind：${String(raw.kind)}（staged_action v1 关闭，31 §3.2）`,
      )
    // 14：调用方只给等级，其余三项宿主补齐（缺 mandate_check 的卡后面每一步都要用它）
    const input = normalizeCreateInput(raw)
    // WP275：① ② 没有审批流——超了上限的改动卡要本人再确认一次（落库前就写进收件人）
    if ((await this.approvalFlowOf(input.workspace_id)) === false) markReconfirm(input)
    const ctx: ApprovalContext = input.context ?? {}
    const now = this.rt.now()
    const pre = runPrecheck(input, ctx)

    // WP55 / 48 §4 L3 #3：三道门的结论落一条事件。
    //
    // **只记录，不改状态**：这条事件不决定卡去哪，它只回答事后必然会被问到的那句
    // 「当时用的是哪一版规则集、三道门各怎么说」。payload 里只有门名、结论、原因
    // 与规则 id——被扫的客户原文与草稿正文一个字都不进日志。
    if (pre.gate_decisions !== undefined && pre.gate_decisions.length > 0) {
      await this.rt.emit('guardrail.gate_decided', {
        workspace_id: input.workspace_id,
        actor: {
          kind: input.proposer.kind === 'person' ? 'person' : 'agent',
          id: input.proposer.id,
        },
        correlation: { ...(input.evidence.run_id ? { run_id: input.evidence.run_id } : {}) },
        payload: {
          kind: input.kind,
          autonomous: pre.autonomous === true,
          ruleset_hash: pre.gate_decisions[0]?.ruleset_hash,
          gates: pre.gate_decisions.map((g) => ({
            gate: g.gate,
            status: g.status,
            ...(g.reason === undefined ? {} : { reason: g.reason }),
            ...(g.evidence === undefined ? {} : { evidence: g.evidence }),
          })),
        },
      })
    }

    // §5 去重：同键在 pending / in_review / deferred → 更新原项
    const active = this.rt.store
      .listApprovals({
        workspace_id: input.workspace_id,
        dedupe_key: input.dedupe_key,
        state: ACTIVE,
      })
      .filter((i) => i.kind === input.kind)
    const existing = active[active.length - 1]

    if (pre.blocked.length > 0) {
      const item = this.materialize(input, ctx, pre, now, 'blocked')
      item.evidence.precheck = pre.precheck
      this.rt.store.putApproval(item)
      await this.rt.emit('approval.blocked', {
        workspace_id: item.workspace_id,
        actor: {
          kind: input.proposer.kind === 'person' ? 'person' : 'agent',
          id: input.proposer.id,
        },
        subject: { type: 'approval_item', id: item.id },
        correlation: { ...(item.evidence.run_id ? { run_id: item.evidence.run_id } : {}) },
        payload: { kind: item.kind, reasons: pre.blocked, precheck: pre.precheck },
        item_id: item.id,
      })
      return item as ApprovalItem<P>
    }

    if (existing)
      return (await this.updateRevision(existing, input, ctx, pre, now)) as ApprovalItem<P>

    const item = this.materialize(input, ctx, pre, now, 'pending')

    // §5：同键的旧终态项 → 新项 supersedes 旧项
    const prior = this.rt.store
      .listApprovals({ workspace_id: input.workspace_id, dedupe_key: input.dedupe_key })
      .filter((i) => i.kind === input.kind && i.id !== item.id && i.state !== 'blocked')
    const last = prior[prior.length - 1]
    if (last) {
      item.links.supersedes = last.id
      last.links.superseded_by = item.id
      last.updated_at = now
      this.rt.store.putApproval(last)
      await this.rt.emit('approval.superseded', {
        workspace_id: item.workspace_id,
        actor: { kind: 'system', id: 'txn' },
        subject: { type: 'approval_item', id: last.id },
        payload: { superseded_by: item.id },
        item_id: last.id,
      })
    }

    const auto = this.autoApprovable(input, ctx)
    if (auto) {
      item.state = 'auto_approved'
      item.automation.auto_approved = true
      item.automation.sampling = { selected: this.rt.sample() < this.rt.policy.sampling_rate }
      const token = this.issueToken(item, 'mandate')
      item.decision = {
        action: 'approve',
        by: 'mandate',
        at: now,
        via: 'api',
        decision_token: token,
      }
      this.rt.store.putToken({
        ...(this.rt.store.getToken(token) ?? {
          token,
          item_id: item.id,
          revision: item.revision,
          snapshot_hash: item.execution_snapshot?.hash ?? '',
          person: 'mandate',
          issued_at: now,
          revoked: false,
        }),
        used: { at: now, by: 'mandate', action: 'approve' },
      })
      this.rt.store.putApproval(item)
      await this.emitCreated(item)
      await this.rt.emit('approval.auto_approved', {
        workspace_id: item.workspace_id,
        actor: { kind: 'system', id: 'mandate' },
        subject: { type: 'approval_item', id: item.id },
        payload: { level: item.automation.level_at_creation, kind: item.kind },
        item_id: item.id,
      })
      if (item.automation.sampling.selected)
        await this.rt.emit('approval.sampled', {
          workspace_id: item.workspace_id,
          actor: { kind: 'system', id: 'mandate' },
          subject: { type: 'approval_item', id: item.id },
          payload: { rate: this.rt.policy.sampling_rate },
          item_id: item.id,
        })
      await this.writeApprovedMarker(item, 'mandate', now)
      return this.rt.store.getApproval(item.id) as ApprovalItem<P>
    }

    item.state = 'pending'
    this.rt.store.putApproval(item)
    await this.emitCreated(item)
    await this.route(item)
    return this.rt.store.getApproval(item.id) as ApprovalItem<P>
  }

  private materialize<P>(
    input: NormalizedCreateInput<P>,
    ctx: ApprovalContext,
    pre: ReturnType<typeof runPrecheck>,
    now: Iso8601,
    state: ApprovalState,
  ): ApprovalItem {
    const id = this.rt.newId('apr')
    const payload =
      pre.redaction_preview !== undefined && input.kind === 'outbound_draft'
        ? { ...rec(input.payload), redaction_preview: pre.redaction_preview }
        : input.payload
    const { context: _context, ...rest } = input
    const item: ApprovalItem = {
      ...(rest as unknown as ApprovalItem),
      id,
      schema_version: 1,
      revision: 1,
      payload,
      evidence: { ...input.evidence, precheck: pre.precheck },
      automation: {
        ...input.automation,
        auto_approved: false,
        sampling: { ...input.automation.sampling, selected: false },
      },
      state,
      deliveries: [],
      links: { children: [], ...(input.links ?? {}) },
      created_at: now,
      updated_at: now,
      expires_at: input.expires_at ?? expiryFor(input.kind, now, this.rt.policy),
    }
    item.execution_snapshot = this.snapshotOf(item, ctx)
    item.execution_context = snapshotProvenanceOf(ctx)
    this.rt.store.putContext(item.id, ctx)
    return item
  }

  /** 14 §4 / 31 §3.2：创建时冻结执行快照。 */
  private snapshotOf(item: ApprovalItem, ctx: ApprovalContext): ExecutionSnapshot {
    const p = rec(item.payload)
    const target =
      typeof p.target === 'object' && p.target !== null
        ? (p.target as { type: string; id: string })
        : item.subject.object
    const components: SnapshotComponents = {
      workspace: item.workspace_id,
      connection: ctx.connection_id ?? '',
      target: refKey({ type: String(target.type), id: String(target.id) }),
      record_version: ctx.record_version ?? '',
      // WP199：只绑出卡 / 改派时的名单；升级追加的人按升级链核对（./escalation.ts）
      recipients: boundRecipients(item),
      final_payload: finalPayload(item),
      attachments: [...(ctx.attachments ?? [])].sort(),
      executor_version: this.rt.policy.executor_version,
      mandate_hash: ctx.mandate_hash ?? '',
    }
    return this.rt.snapshot(components)
  }

  /** 31 §3.4：只有 risk_class=low 的已建模变更可自动；medium / high 永远人审。 */
  private autoApprovable<P>(input: NormalizedCreateInput<P>, ctx: ApprovalContext): boolean {
    if (input.kind !== 'staged_change') return false
    if (input.automation.level_at_creation === 'L1') return false
    if (!input.automation.mandate_check.within) return false
    const change = ctx.change_id ? this.rt.store.getChange(ctx.change_id) : undefined
    return change?.risk_class === 'low'
  }

  private async emitCreated(item: ApprovalItem): Promise<void> {
    await this.rt.emit('approval.created', {
      workspace_id: item.workspace_id,
      actor: {
        kind: item.proposer.kind === 'person' ? 'person' : 'agent',
        id: item.proposer.id,
        ...(item.evidence.run_id ? { run_id: item.evidence.run_id } : {}),
      },
      subject: { type: 'approval_item', id: item.id },
      correlation: {
        ...(item.evidence.run_id ? { run_id: item.evidence.run_id } : {}),
        ...(typeof rec(item.payload).change_id === 'string'
          ? { change_id: String(rec(item.payload).change_id) }
          : {}),
      },
      payload: {
        kind: item.kind,
        revision: item.revision,
        dedupe_key: item.dedupe_key,
        title: item.title,
        state: item.state,
      },
      item_id: item.id,
    })
  }

  /** §7 投递：工作台永远投递；每个 recipient 一张卡片、一枚一次性 token。 */
  private async route(item: ApprovalItem): Promise<void> {
    const now = this.rt.now()
    const deliveries: Delivery[] = item.routing.recipients.map((r) => ({
      channel: 'workstation',
      to: r.person,
      sent_at: now,
      view: 'full',
      decision_token: this.issueToken(item, r.person),
      status: 'sent',
    }))
    item.deliveries = [
      ...item.deliveries.map((d) =>
        d.status === 'sent' ? { ...d, status: 'expired' as const } : d,
      ),
      ...deliveries,
    ]
    item.updated_at = now
    this.rt.store.putApproval(item)
    await this.rt.emit('approval.routed', {
      workspace_id: item.workspace_id,
      actor: { kind: 'system', id: 'txn' },
      subject: { type: 'approval_item', id: item.id },
      payload: {
        rule: item.routing.rule,
        recipients: item.routing.recipients.map((r) => r.person),
      },
      item_id: item.id,
    })
    for (const d of deliveries)
      await this.rt.emit('approval.delivered', {
        workspace_id: item.workspace_id,
        actor: { kind: 'system', id: 'txn' },
        subject: { type: 'approval_item', id: item.id },
        payload: { to: d.to, channel: d.channel, revision: item.revision },
        item_id: item.id,
      })
  }

  private issueToken(item: ApprovalItem, person: PersonId | 'mandate'): string {
    const token = signToken(this.rt.secret, {
      item_id: item.id,
      revision: item.revision,
      snapshot_hash: item.execution_snapshot?.hash ?? '',
      nonce: nonceFrom(() => this.rt.random()),
    })
    this.rt.store.putToken({
      token,
      item_id: item.id,
      revision: item.revision,
      snapshot_hash: item.execution_snapshot?.hash ?? '',
      person,
      issued_at: this.rt.now(),
      revoked: false,
    })
    return token
  }

  /**
   * §5 重复提交：更新原项、revision+1、旧 payload 进历史、
   * 旧 decision_token 全部失效、已投递卡片刷新为"内容已更新，请重新审阅"。
   */
  private async updateRevision<P>(
    existing: ApprovalItem,
    input: NormalizedCreateInput<P>,
    ctx: ApprovalContext,
    pre: ReturnType<typeof runPrecheck>,
    now: Iso8601,
  ): Promise<ApprovalItem> {
    this.rt.store.pushRevision(existing)
    const next: ApprovalItem = {
      ...existing,
      revision: existing.revision + 1,
      title: input.title,
      summary: input.summary,
      payload:
        pre.redaction_preview !== undefined && input.kind === 'outbound_draft'
          ? { ...rec(input.payload), redaction_preview: pre.redaction_preview }
          : (input.payload as unknown),
      evidence: { ...input.evidence, precheck: pre.precheck },
      automation: {
        ...existing.automation,
        ...input.automation,
        auto_approved: false,
        sampling: { selected: false },
      },
      state: 'pending',
      updated_at: now,
    }
    delete next.decision
    next.execution_snapshot = this.snapshotOf(next, ctx)
    this.rt.store.revokeTokensFor(existing.id)
    next.deliveries = existing.deliveries.map((d) => ({ ...d, status: 'expired' as const }))
    next.execution_snapshot = this.snapshotOf(next, ctx)
    this.rt.store.putContext(next.id, ctx)
    this.rt.store.putApproval(next)
    await this.emitCreated(next)
    await this.route(next)
    const refreshed = this.rt.store.getApproval(next.id)
    if (!refreshed) throw new TxnError('not_found', next.id)
    return refreshed
  }

  // ───────────────────────────── 读

  async get(id: string): Promise<ApprovalItem | undefined> {
    return this.rt.store.getApproval(id)
  }

  async queue(filter: {
    workspace_id: WorkspaceId
    person_id: PersonId
    lane: 'mine' | 'scope' | 'unclaimed'
    kind?: ApprovalKind
    role_id?: RoleId
    state?: ApprovalState[]
  }): Promise<ApprovalItem[]> {
    const states = filter.state ?? (['pending', 'in_review'] as ApprovalState[])
    const rank = { immediate: 0, queue: 1, digest: 2 } as const
    return this.rt.store
      .listApprovals({
        workspace_id: filter.workspace_id,
        state: states,
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.role_id ? { role_id: filter.role_id } : {}),
      })
      .filter((i) => {
        const isRecipient = i.routing.recipients.some((r) => r.person === filter.person_id)
        if (filter.lane === 'mine') return isRecipient || i.routing.assignee === filter.person_id
        if (filter.lane === 'unclaimed') return isRecipient && i.routing.assignee === undefined
        return isRecipient
      })
      .sort(
        (a, b) =>
          rank[a.priority] - rank[b.priority] ||
          ms(a.due_at ?? a.expires_at ?? a.created_at) -
            ms(b.due_at ?? b.expires_at ?? b.created_at) ||
          ms(a.created_at) - ms(b.created_at),
      )
  }

  async history(id: string): Promise<{ revisions: ApprovalItem[]; events: string[] }> {
    const current = this.rt.store.getApproval(id)
    return {
      revisions: [...this.rt.store.revisions(id), ...(current ? [current] : [])],
      events: this.rt.store.eventIds(id),
    }
  }

  // ───────────────────────────── decide（§4 状态机 + §7 token）

  async decide(id: string, by: PersonId, input: DecideInput): Promise<ApprovalItem> {
    const item = this.rt.store.getApproval(id)
    if (!item) throw new TxnError('not_found', `审批项不存在：${id}`)
    if (input.action === 'withdraw') return this.withdraw(id, by)

    const tok = this.rt.store.getToken(input.decision_token)
    if (!tok || tok.item_id !== id) throw new TxnError('forbidden', 'decision_token 无效')
    // §7：IM 平台重放同一回调 → 幂等返回原结果
    if (tok.used) return item
    if (tok.revoked)
      throw new TxnError('conflict', '内容已更新，请重新审阅（decision_token 已失效）')
    if (tok.revision !== item.revision)
      throw new TxnError(
        'conflict',
        `decision_token 绑定 revision ${tok.revision}，当前 ${item.revision}`,
      )
    if (item.execution_snapshot && tok.snapshot_hash !== item.execution_snapshot.hash)
      throw new TxnError('snapshot_mismatch', '执行快照已变化，请重新审阅')
    if (tok.person !== 'mandate' && tok.person !== by)
      throw new TxnError('forbidden', 'decision_token 不属于该决定人')
    if (!DECIDABLE.includes(item.state))
      throw new TxnError('conflict', `状态 ${item.state} 不可决定`)

    // §4.2 谁能决定
    const isRecipient = item.routing.recipients.some((r) => r.person === by)
    const dir = this.rt.opts.directory
    if (!isRecipient) throw new TxnError('forbidden', '不在 recipients 内')
    if (dir?.canApprove && !dir.canApprove(by, item))
      throw new TxnError('forbidden', '该 Assignment 对此职责没有 approve 操作')

    // §4.2 SoD；个人工作区（成员 1）自动关闭并在事件标 self_approved
    // WP275：给了 `approvalFlow` 就只看它——① ② 没有审批流，提的人自己点就是安全闸本身
    let self_approved = false
    if (item.routing.separation_of_duties && item.proposer.id === by) {
      const flow = await this.approvalFlowOf(item.workspace_id)
      const enforced = flow ?? (dir?.memberCount?.(item.workspace_id) ?? 2) > 1
      if (enforced) throw new TxnError('sod_violation', '提议者不得自批（职责分离）')
      self_approved = true
    }

    const now = this.rt.now()
    if ((input.action === 'reject' || input.action === 'redirect') && !input.reason)
      throw new TxnError('invalid_input', 'reject / redirect 必须给 reason')
    if (input.action === 'approve_edited' && input.edited_payload === undefined)
      throw new TxnError('invalid_input', 'approve_edited 必须给 edited_payload')

    const decision: Decision = {
      action: input.action,
      by,
      at: now,
      via: input.via,
      decision_token: input.decision_token,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.edited_payload !== undefined ? { edited_payload: input.edited_payload } : {}),
      ...(input.edited_payload !== undefined
        ? { edit_diff: { before: item.payload, after: input.edited_payload, summary: '人工编辑' } }
        : {}),
      ...(input.redirect_to !== undefined ? { redirect_to: input.redirect_to } : {}),
      ...(input.defer_until !== undefined ? { defer_until: input.defer_until } : {}),
    }

    item.decision = decision
    item.updated_at = now
    item.deliveries = item.deliveries.map((d) =>
      d.decision_token === input.decision_token
        ? { ...d, status: 'acted' as const }
        : { ...d, status: 'expired' as const },
    )

    let learning: 'accepted' | 'edited' | 'rejected' | 'redirected' | 'deferred' = 'accepted'
    switch (input.action) {
      case 'approve':
        item.state = 'approved'
        break
      case 'approve_edited': {
        item.state = 'approved_edited'
        learning = 'edited'
        const ctx: ApprovalContext = this.contextOf(item)
        item.payload = input.edited_payload
        item.execution_snapshot = this.snapshotOf(item, ctx)
        break
      }
      case 'reject':
        item.state = 'rejected'
        learning = 'rejected'
        break
      case 'redirect': {
        learning = 'redirected'
        const to = input.redirect_to?.person_id
        item.revision += 1
        item.routing = {
          ...item.routing,
          recipients: to
            ? [{ person: to, via: 'explicit' as Recipient['via'] }]
            : item.routing.recipients,
          rule: 'explicit',
        }
        delete item.routing.assignee
        item.state = 'pending'
        item.execution_snapshot = this.snapshotOf(item, this.contextOf(item))
        break
      }
      case 'defer':
        item.state = 'deferred'
        learning = 'deferred'
        break
    }
    // decide 的状态跃迁一次落地：token 置为已用 + 撤销同项其余 token + 审批项落库
    this.rt.tx(() => {
      this.rt.store.putToken({ ...tok, used: { at: now, by, action: input.action } })
      this.rt.store.revokeTokensFor(item.id)
      this.rt.store.putApproval(item)
    })

    await this.rt.emit('approval.decided', {
      workspace_id: item.workspace_id,
      actor: { kind: 'person', id: by },
      subject: { type: 'approval_item', id: item.id },
      payload: {
        action: input.action,
        state: item.state,
        learning,
        accepted: learning === 'accepted',
        edited: learning === 'edited',
        rejected: learning === 'rejected',
        ...(decision.edit_diff ? { edit_diff: decision.edit_diff } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        self_approved,
        via: input.via,
      },
      item_id: item.id,
    })

    if (item.state === 'pending' && input.action === 'redirect') await this.route(item)
    if (item.state === 'approved' || item.state === 'approved_edited')
      await this.writeApprovedMarker(item, by, now)

    const out = this.rt.store.getApproval(item.id)
    if (!out) throw new TxnError('not_found', item.id)
    return out
  }

  /** §8 批量：同 kind 同 role 才能一起决定；每条单独记 Decision（via: batch）。 */
  async decideBatch(
    entries: BatchEntry[],
    by: PersonId,
    input: Omit<DecideInput, 'decision_token' | 'via'>,
  ): Promise<{ id: string; item?: ApprovalItem; error?: TxnError }[]> {
    const items = entries.map((e) => {
      const it = this.rt.store.getApproval(e.id)
      if (!it) throw new TxnError('not_found', e.id)
      return it
    })
    const kinds = new Set(items.map((i) => i.kind))
    const roles = new Set(items.map((i) => i.role_id))
    if (kinds.size > 1 || roles.size > 1)
      throw new TxnError('invalid_input', '批量决定不跨 kind / role（14 §13.4）')
    const out: { id: string; item?: ApprovalItem; error?: TxnError }[] = []
    for (const e of entries) {
      try {
        const item = await this.decide(e.id, by, {
          ...input,
          decision_token: e.decision_token,
          via: 'batch',
        })
        out.push({ id: e.id, item })
      } catch (err) {
        out.push({
          id: e.id,
          error: err instanceof TxnError ? err : new TxnError('conflict', String(err)),
        })
      }
    }
    return out
  }

  /** 15 §5.2：批准标记只由宿主写；执行器只信这一处。 */
  private async writeApprovedMarker(
    item: ApprovalItem,
    by: PersonId | 'mandate',
    at: Iso8601,
  ): Promise<void> {
    const change_id = rec(item.payload).change_id
    if (item.kind !== 'staged_change' || typeof change_id !== 'string') return
    const change = this.rt.store.getChange(change_id)
    if (!change) return
    const next: StagedChange = {
      ...change,
      status: item.state === 'auto_approved' ? 'auto_approved' : 'approved',
      approval: { item_id: item.id, by, at },
      updated_at: at,
      ...(item.execution_snapshot ? { execution_snapshot: item.execution_snapshot } : {}),
      // 15 §3.2：人批准过的软额度 → apply 时记 approved_exception，不再因它失败
      guardrail:
        by === 'mandate'
          ? change.guardrail
          : {
              ...change.guardrail,
              approved_exception: change.guardrail.verdict === 'require_review',
            },
    }
    // 15 §5.2：批准标记与变更状态必须同生同死，不能只落一半
    this.rt.tx(() => {
      this.rt.store.putChange(next)
      this.rt.store.markApproved(change_id)
    })
    await this.rt.emit('change.approved', {
      workspace_id: change.workspace_id,
      actor: by === 'mandate' ? { kind: 'system', id: 'mandate' } : { kind: 'person', id: by },
      subject: { type: 'staged_change', id: change_id },
      correlation: { change_id, run_id: change.run_id },
      payload: { item_id: item.id, status: next.status },
      item_id: item.id,
    })
  }

  private contextOf(item: ApprovalItem): ApprovalContext {
    return this.rt.store.getContext(item.id) ?? {}
  }

  // ───────────────────────────── 认领 / 撤回 / 过期 / 升级

  async claim(id: string, by: PersonId): Promise<ApprovalItem> {
    const item = this.mustGet(id)
    if (item.state !== 'pending') throw new TxnError('conflict', `状态 ${item.state} 不可认领`)
    item.routing.assignee = by
    item.state = 'in_review'
    item.updated_at = this.rt.now()
    this.rt.store.putApproval(item)
    await this.rt.emit('approval.claimed', {
      workspace_id: item.workspace_id,
      actor: { kind: 'person', id: by },
      subject: { type: 'approval_item', id: item.id },
      payload: { by },
      item_id: item.id,
    })
    return item
  }

  async release(id: string, by: PersonId): Promise<ApprovalItem> {
    const item = this.mustGet(id)
    if (item.routing.assignee !== by) throw new TxnError('forbidden', '不是认领人')
    delete item.routing.assignee
    item.state = 'pending'
    item.updated_at = this.rt.now()
    this.rt.store.putApproval(item)
    return item
  }

  /**
   * WP174：改派一张还没定的卡（上级离职 → 老板）。
   *
   * 只换 `from` 那一格收件人，别的收件人一个不动；认领人是他就放掉。
   * 与 redirect 同一条路：revision + 1、重算快照、旧 token 全废、按新的收件人重新投递——
   * 于是离职那个人手里那张旧 token 当场失效，新收件人拿到一张新的。
   * 已经定了（或在"稍后"里）的卡一个字不动，回 `undefined`。
   *
   * WP199：`from` 是被升级送到卡上的人（`via: 'escalation'`、升级链上核对得上他是那一级的
   * 当前持有者）时，这一次改派是**那一级的交接**：在升级链上追加一步「从他交给 `to`」，
   * 与上一步首尾相接，链不断；`to` 也按升级来的人记（`via: 'escalation'`）。
   */
  async reroute(id: string, input: RerouteInput): Promise<ApprovalItem | undefined> {
    const item = this.rt.store.getApproval(id)
    if (!item || (item.state !== 'pending' && item.state !== 'in_review')) return undefined
    const leaving = item.routing.recipients.find((r) => r.person === input.from)
    if (leaving === undefined) return undefined
    const now = this.rt.now()
    const tier = leaving.via === 'escalation' ? escalationTierHeldBy(item, input.from) : undefined
    const next: Recipient = {
      person: input.to,
      via: tier === undefined ? input.via : 'escalation',
      reason: input.reason,
    }
    const already = item.routing.recipients.some((r) => r.person === input.to)
    const kept = item.routing.recipients.filter(
      (r) => r.person !== input.from && r.person !== input.to,
    )
    item.revision += 1
    item.routing = { ...item.routing, recipients: [next, ...kept] }
    if (item.routing.assignee === input.from) {
      delete item.routing.assignee
      item.state = 'pending'
    }
    if (tier !== undefined)
      appendEscalationStep(item, {
        tier,
        to: input.to,
        at: now,
        added: !already,
        handover_from: input.from,
      })
    item.execution_snapshot = this.snapshotOf(item, this.contextOf(item))
    item.updated_at = now
    this.rt.tx(() => {
      this.rt.store.revokeTokensFor(item.id)
      this.rt.store.putApproval(item)
    })
    await this.rt.emit('approval.rerouted', {
      workspace_id: item.workspace_id,
      actor: { kind: 'system', id: 'txn' },
      subject: { type: 'approval_item', id: item.id },
      payload: {
        from: input.from,
        to: input.to,
        via: next.via,
        reason: input.reason,
        ...(tier === undefined ? {} : { escalation_tier: tier }),
      },
      item_id: item.id,
    })
    await this.route(item)
    return this.rt.store.getApproval(item.id)
  }

  /** §4.5：pending 可撤回；已 approved 不可撤 → 409 conflict。 */
  async withdraw(id: string, by: PersonId): Promise<ApprovalItem> {
    const item = this.mustGet(id)
    if (!ACTIVE.includes(item.state))
      throw new TxnError('conflict', `状态 ${item.state} 不可撤回（已批准的只能反向变更）`)
    const now = this.rt.now()
    item.state = 'withdrawn'
    item.updated_at = now
    this.rt.store.revokeTokensFor(item.id)
    this.rt.store.putApproval(item)
    await this.releaseLinkedChange(item, 'withdrawn', now)
    await this.rt.emit('approval.withdrawn', {
      workspace_id: item.workspace_id,
      actor: { kind: 'person', id: by },
      subject: { type: 'approval_item', id: item.id },
      payload: { by },
      item_id: item.id,
    })
    return item
  }

  /** §4.4：过期不施行、记 expired、释放预占。 */
  async expire(at?: Iso8601): Promise<ApprovalItem[]> {
    const now = at ?? this.rt.now()
    const out: ApprovalItem[] = []
    for (const item of this.rt.store.listApprovals({ state: ACTIVE })) {
      if (!item.expires_at || ms(item.expires_at) > ms(now)) continue
      item.state = 'expired'
      item.updated_at = now
      this.rt.store.revokeTokensFor(item.id)
      this.rt.store.putApproval(item)
      await this.releaseLinkedChange(item, 'expired', now)
      await this.rt.emit('approval.expired', {
        workspace_id: item.workspace_id,
        actor: { kind: 'system', id: 'txn' },
        subject: { type: 'approval_item', id: item.id },
        payload: { expires_at: item.expires_at },
        item_id: item.id,
      })
      out.push(item)
    }
    return out
  }

  /** §7：升级 = 新增 Delivery 给下一层，不撤销原 recipients；工作时间按工作区 tz。 */
  async escalate(at?: Iso8601): Promise<ApprovalItem[]> {
    const now = at ?? this.rt.now()
    const dir = this.rt.opts.directory
    const out: ApprovalItem[] = []
    for (const item of this.rt.store.listApprovals({ state: ['pending', 'in_review'] })) {
      const elapsed = item.routing.escalation.business_hours
        ? businessHoursBetween(item.created_at, now, this.rt.policy.business_tz_offset_minutes)
        : (ms(now) - ms(item.created_at)) / 3_600_000
      // WP275：① ② 没有审批流——到点不升级给上级 / 老板，只提醒本人
      if ((await this.approvalFlowOf(item.workspace_id)) === false) {
        const reminded = await this.remindOnly(item, elapsed, now)
        if (reminded !== undefined) out.push(reminded)
        continue
      }
      let changed = false
      for (const tier of item.routing.escalation.chain) {
        const hours =
          tier === 'scope_manager'
            ? this.rt.policy.escalation_hours.scope_manager
            : this.rt.policy.escalation_hours.owner
        if (elapsed < hours) continue
        const already = item.routing.escalation.escalated_at.length
        const idx = item.routing.escalation.chain.indexOf(tier)
        if (idx < already) continue
        const person = tier === 'scope_manager' ? dir?.scopeManager?.(item) : dir?.owner?.(item)
        if (!person) continue
        const added = !item.routing.recipients.some((r) => r.person === person)
        if (added) item.routing.recipients.push({ person, via: 'escalation' })
        item.routing.escalation.escalated_at.push(now)
        // WP199：升级 = 在原审批链上追加一步并留痕；快照不动，施行前按这条链核对
        appendEscalationStep(item, { tier, to: person, at: now, added })
        item.deliveries.push({
          channel: 'workstation',
          to: person,
          sent_at: now,
          view: 'full',
          decision_token: this.issueToken(item, person),
          status: 'sent',
        })
        item.updated_at = now
        changed = true
        this.rt.store.putApproval(item)
        await this.rt.emit('approval.escalated', {
          workspace_id: item.workspace_id,
          actor: { kind: 'system', id: 'txn' },
          subject: { type: 'approval_item', id: item.id },
          payload: { tier, to: person, business_hours: elapsed, added },
          item_id: item.id,
        })
      }
      if (changed) {
        const refreshed = this.rt.store.getApproval(item.id)
        if (refreshed) out.push(refreshed)
      }
    }
    return out
  }

  /** WP275：这个工作区有没有审批流（宿主没给口子 = `undefined`，按以前的规矩办）。 */
  private async approvalFlowOf(workspace_id: WorkspaceId): Promise<boolean | undefined> {
    const hook = this.rt.opts.directory?.approvalFlow
    return hook === undefined ? undefined : await hook(workspace_id)
  }

  /**
   * WP275（docs/95 §5「卡片没人管：① 只提醒你 / ② 只提醒本人」）：到了升级那一级的时点，
   * 不往名单里加任何人，只给**原收件人**再投一次（卡在他那边重新冒出来）。
   *
   * 每一级只提醒一次（记进 `escalated_at`，与升级共用同一个计数，模式改回 ③ 时不会补升已经提醒过的那一级）；
   * 不写升级链（`trail`）——没有人被加进来，快照与「谁能拍板」都不变。
   */
  private async remindOnly(
    item: ApprovalItem,
    elapsed: number,
    now: Iso8601,
  ): Promise<ApprovalItem | undefined> {
    let changed = false
    item.routing.escalation.chain.forEach((tier, idx) => {
      const hours =
        tier === 'scope_manager'
          ? this.rt.policy.escalation_hours.scope_manager
          : this.rt.policy.escalation_hours.owner
      if (elapsed < hours || idx < item.routing.escalation.escalated_at.length) return
      item.routing.escalation.escalated_at.push(now)
      changed = true
    })
    if (!changed) return undefined
    const to = [...new Set(boundRecipients(item))]
    for (const person of to)
      item.deliveries.push({
        channel: 'workstation',
        to: person,
        sent_at: now,
        view: 'full',
        decision_token: this.issueToken(item, person),
        status: 'sent',
      })
    item.updated_at = now
    this.rt.store.putApproval(item)
    await this.rt.emit('approval.reminded', {
      workspace_id: item.workspace_id,
      actor: { kind: 'system', id: 'txn' },
      subject: { type: 'approval_item', id: item.id },
      payload: {
        to,
        business_hours: elapsed,
        reminders: item.routing.escalation.escalated_at.length,
      },
      item_id: item.id,
    })
    return this.rt.store.getApproval(item.id)
  }

  /** 14 §10 /approvals/{id}/retry-apply：施行失败后重开，恢复批准态并重新预占。 */
  async retryApply(id: string, _by: PersonId): Promise<ApprovalItem> {
    const item = this.mustGet(id)
    if (item.state !== 'apply_failed')
      throw new TxnError('conflict', `状态 ${item.state} 不可重试施行`)
    if (!this.applier) throw new TxnError('invalid_input', '未接入执行器')
    item.state = item.automation.auto_approved
      ? 'auto_approved'
      : item.decision?.action === 'approve_edited'
        ? 'approved_edited'
        : 'approved'
    item.updated_at = this.rt.now()
    this.rt.store.putApproval(item)
    const change_id = rec(item.payload).change_id
    if (typeof change_id === 'string') {
      const change = this.rt.store.getChange(change_id)
      if (change && change.status === 'failed') {
        const status = item.automation.auto_approved ? 'auto_approved' : 'approved'
        this.rt.store.putChange({
          ...change,
          status,
          updated_at: item.updated_at,
          ...(change.reservation
            ? {
                reservation: {
                  counter: change.reservation.counter,
                  amount: change.reservation.amount,
                },
              }
            : {}),
        })
        if (change.reservation)
          this.rt.store.reserve(change.reservation.counter, change_id, change.reservation.amount)
        this.rt.store.markApproved(change_id)
      }
    }
    await this.applier(item)
    return this.mustGet(id)
  }

  /** 供执行器写回施行状态（同一事务边界）。 */
  async recordApply(
    id: string,
    state: 'applying' | 'applied' | 'apply_failed',
    apply: ApprovalItem['apply'],
  ): Promise<void> {
    const item = this.rt.store.getApproval(id)
    if (!item) return
    item.state = state
    if (apply) item.apply = apply
    item.updated_at = this.rt.now()
    this.rt.store.putApproval(item)
  }

  private async releaseLinkedChange(
    item: ApprovalItem,
    status: 'withdrawn' | 'expired',
    at: Iso8601,
  ): Promise<void> {
    const change_id = rec(item.payload).change_id
    if (typeof change_id !== 'string') return
    const change = this.rt.store.getChange(change_id)
    if (!change || ['applied', 'failed', 'unknown'].includes(change.status)) return
    this.rt.store.releaseReservation(change_id)
    const next: StagedChange = {
      ...change,
      status,
      updated_at: at,
      ...(change.reservation ? { reservation: { ...change.reservation, released: true } } : {}),
    }
    this.rt.store.putChange(next)
    await this.rt.emit(status === 'withdrawn' ? 'change.withdrawn' : 'change.expired', {
      workspace_id: change.workspace_id,
      actor: { kind: 'system', id: 'txn' },
      subject: { type: 'staged_change', id: change_id },
      correlation: { change_id },
      payload: { reason: status },
      item_id: item.id,
    })
  }

  private mustGet(id: string): ApprovalItem {
    const item = this.rt.store.getApproval(id)
    if (!item) throw new TxnError('not_found', `审批项不存在：${id}`)
    return item
  }
}

/** 14 §3：发出的是 decision.edited_payload ?? payload。 */
/** WP275：卡上那一句（① ② 超了上限、落回本人时）。 */
export const RECONFIRM_REASON = '超了你设的上限，要你再确认一次'

/**
 * WP275：① ② 里额度核对没过的改动卡（护栏判「要人看」）——收件人都要再确认一次。
 * 只看 `staged_change`：别的卡没有额度核对这回事（没报过额度的默认值也是 `within: false`）。
 * 调用方已经写了那一句（比如 B2B 报价写清超了哪几项）就不覆盖。
 */
function markReconfirm<P>(input: NormalizedCreateInput<P>): void {
  if (input.kind !== 'staged_change' || input.automation.mandate_check.within) return
  input.routing.recipients = input.routing.recipients.map((r) => ({
    ...r,
    reconfirm: true,
    reason: r.reason ?? RECONFIRM_REASON,
  }))
}

export function finalPayload(item: ApprovalItem): unknown {
  return item.decision?.edited_payload ?? item.payload
}
