/**
 * WP199：审批卡升级给上级之后，批了要能施行。
 *
 * 现象（WP191 报告「偏离」第 1 条）：卡落在一个批不了的人手上，升级链把老板加进收件人，
 * 老板批了，执行器施行前重算快照——收件人那一格多了老板，与出卡时那一份对不上 →
 * `snapshot_mismatch`，施行失败。
 *
 * 升级 = 追加（14 §7），不是改名单：快照里那一格只绑出卡（或改派）时的名单，
 * 升级追加的人按升级链核对。越权批准仍然要拒。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { boundRecipients, escalationDigest, verifiedEscalatedRecipients } from '../src/index.js'
import { SqliteTxnStore } from '../src/sqlite-store.js'
import { harness, outboundInput, refundStage, tokenOf } from './helpers.js'

/** 周一 09:00 出卡；4 / 8 工作小时两级升级（与模拟场景同一个压缩法）。 */
const escalationHarness = (canApprove?: (person: string) => boolean) =>
  harness({
    policy: { business_tz_offset_minutes: 0, escalation_hours: { scope_manager: 4, owner: 8 } },
    records: { 'order:ord_1042': { record_version: 'v1' } },
    directory: {
      scopeManager: () => 'p_manager',
      owner: () => 'p_owner',
      ...(canApprove === undefined ? {} : { canApprove: (p) => canApprove(p) }),
    },
  })

describe('WP199 升级之后批了能施行', () => {
  it('复现：staged_change 升级给老板 → 老板批 → 施行成功（不是 snapshot_mismatch）', async () => {
    // 运营主管没有这条职责，批不了；老板能批
    const h = escalationHarness((p) => p !== 'p_manager')
    const staged = await h.txn.ledger.stage(
      refundStage({ approval: { recipients: [{ person: 'p_manager', via: 'scope_manager' }] } }),
    )
    if (!staged.ok) throw new Error(staged.message)
    // 运营主管点不动
    await expect(
      h.txn.approvals.decide(staged.approval.id, 'p_manager', {
        decision_token: tokenOf(staged.approval, 'p_manager'),
        action: 'approve',
        via: 'workstation',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })

    h.clock.set('2026-09-07T17:30:00.000Z') // 8 工作小时：两级都到点
    const [escalated] = await h.txn.approvals.escalate()
    expect(escalated?.routing.recipients.map((r) => r.person)).toEqual(['p_manager', 'p_owner'])
    if (escalated === undefined) throw new Error('not escalated')

    const approved = await h.txn.approvals.decide(staged.approval.id, 'p_owner', {
      decision_token: tokenOf(escalated, 'p_owner'),
      action: 'approve',
      via: 'workstation',
    })
    expect(approved.state).toBe('approved')
    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.error?.code).toBeUndefined()
    expect(out.status).toBe('applied')
    expect((await h.txn.approvals.get(staged.approval.id))?.state).toBe('applied')
  })

  it('复现：outbound_draft 升级之后原收件人批 → 发得出去', async () => {
    const h = escalationHarness()
    const item = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
    )
    h.clock.set('2026-09-07T13:30:00.000Z') // 4 工作小时：升到范围管理者
    await h.txn.approvals.escalate()
    const approved = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'approve',
      via: 'workstation',
    })
    expect(approved.state).toBe('approved')
    h.clock.advance(121_000)
    const out = await h.txn.executor.applyApproval(item.id)
    expect(out.state).toBe('applied')
  })

  it('留痕：升级每一步都在卡上（第几级 / 送给谁 / 新加没新加 / revision / 指纹），事件也带 added', async () => {
    const h = escalationHarness()
    const item = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
    )
    h.clock.set('2026-09-07T17:30:00.000Z')
    const [escalated] = await h.txn.approvals.escalate()
    const trail = escalated?.routing.escalation.trail ?? []
    expect(trail.map((s) => [s.tier, s.to, s.added, s.revision])).toEqual([
      ['scope_manager', 'p_manager', true, 1],
      ['owner', 'p_owner', true, 1],
    ])
    expect(trail[0]?.digest).toBe(escalationDigest(item.id, trail[0] as never, ''))
    expect(trail[1]?.digest).toBe(
      escalationDigest(item.id, trail[1] as never, trail[0]?.digest ?? ''),
    )
    // 快照没动：绑定的还是出卡时那一个人
    expect(escalated?.execution_snapshot?.hash).toBe(item.execution_snapshot?.hash)
    if (escalated === undefined) throw new Error('not escalated')
    expect(boundRecipients(escalated)).toEqual(['p_wang'])
    expect(
      h.events.filter((e) => e.type === 'approval.escalated').map((e) => e.payload.added),
    ).toEqual([true, true])
  })

  it('升级到本来就在名单里的人：只多一张投递，added=false，照样能批能施行', async () => {
    const h = harness({
      policy: { business_tz_offset_minutes: 0, escalation_hours: { scope_manager: 4, owner: 8 } },
      directory: { scopeManager: () => 'p_wang', owner: () => 'p_wang' },
    })
    const item = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
    )
    h.clock.set('2026-09-07T17:30:00.000Z')
    const [escalated] = await h.txn.approvals.escalate()
    expect(escalated?.routing.escalation.trail?.map((s) => s.added)).toEqual([false, false])
    if (escalated === undefined) throw new Error('not escalated')
    await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(escalated),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.applyApproval(item.id)).state).toBe('applied')
  })

  it('升级之后改着批（approve_edited）：重算的快照也不含升级追加者，施行对得上', async () => {
    const h = escalationHarness()
    const item = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
    )
    h.clock.set('2026-09-07T17:30:00.000Z')
    const [escalated] = await h.txn.approvals.escalate()
    if (escalated === undefined) throw new Error('not escalated')
    const edited = await h.txn.approvals.decide(item.id, 'p_owner', {
      decision_token: tokenOf(escalated, 'p_owner'),
      action: 'approve_edited',
      edited_payload: {
        ...(item.payload as object),
        body: { text: 'Hi Anna — refund is on its way.' },
      },
      via: 'workstation',
    })
    expect(edited.state).toBe('approved_edited')
    h.clock.advance(121_000)
    expect((await h.txn.executor.applyApproval(item.id)).state).toBe('applied')
  })
})

/** 批一张升过级的对外草稿，然后动一下存储里的卡，看施行拦不拦。 */
async function approvedAfterEscalation() {
  const h = escalationHarness()
  const item = await h.txn.approvals.create(
    outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
  )
  h.clock.set('2026-09-07T17:30:00.000Z')
  const [escalated] = await h.txn.approvals.escalate()
  if (escalated === undefined) throw new Error('not escalated')
  await h.txn.approvals.decide(item.id, 'p_owner', {
    decision_token: tokenOf(escalated, 'p_owner'),
    action: 'approve',
    via: 'workstation',
  })
  h.clock.advance(121_000)
  const store = h.txn.runtime.store
  const tamper = (fn: (i: ApprovalItem) => void) => {
    const cur = store.getApproval(item.id)
    if (cur === undefined) throw new Error('gone')
    fn(cur)
    store.putApproval(cur)
  }
  return { h, item, tamper }
}

describe('WP199 越权批准仍然要拒', () => {
  it('不在名单里的人（也不是升级链送到的人）点不动', async () => {
    const h = escalationHarness()
    const item = await h.txn.approvals.create(outboundInput())
    await expect(
      h.txn.approvals.decide(item.id, 'p_stranger', {
        decision_token: tokenOf(item),
        action: 'approve',
        via: 'workstation',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('升级链送到了、但他没有这条职责的批准权 → forbidden（canApprove 照旧管）', async () => {
    const h = escalationHarness((p) => p !== 'p_owner')
    const item = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
    )
    h.clock.set('2026-09-07T17:30:00.000Z')
    const [escalated] = await h.txn.approvals.escalate()
    if (escalated === undefined) throw new Error('not escalated')
    await expect(
      h.txn.approvals.decide(item.id, 'p_owner', {
        decision_token: tokenOf(escalated, 'p_owner'),
        action: 'approve',
        via: 'workstation',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('名单被塞进一个「升级来的」人（链上没有这一步）→ 快照对不上，不施行', async () => {
    const { h, item, tamper } = await approvedAfterEscalation()
    tamper((i) => i.routing.recipients.push({ person: 'p_x', via: 'escalation' }))
    await expect(h.txn.executor.applyApproval(item.id)).rejects.toMatchObject({
      code: 'snapshot_mismatch',
    })
  })

  it('升级链被改过（送给谁换了人、指纹没重算）→ 那一步不认，快照对不上', async () => {
    const { h, item, tamper } = await approvedAfterEscalation()
    tamper((i) => {
      const step = i.routing.escalation.trail?.[1]
      if (step === undefined) throw new Error('no step')
      step.to = 'p_x'
      const r = i.routing.recipients.find((x) => x.person === 'p_owner')
      if (r !== undefined) r.person = 'p_x'
      if (i.decision) i.decision.by = 'p_x'
    })
    await expect(h.txn.executor.applyApproval(item.id)).rejects.toMatchObject({
      code: 'snapshot_mismatch',
    })
  })

  it('链上补一步不在这张卡升级链里的级别 / 同一级升两次 → 不认', async () => {
    const h = escalationHarness()
    const item = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
    )
    h.clock.set('2026-09-07T17:30:00.000Z')
    const [escalated] = await h.txn.approvals.escalate()
    if (escalated === undefined) throw new Error('not escalated')
    const trail = escalated.routing.escalation.trail ?? []
    const last = trail[trail.length - 1]?.digest ?? ''
    const extra = {
      tier: 'owner' as const,
      to: 'p_x',
      at: escalated.updated_at,
      added: true,
      revision: 1,
    }
    const forged: ApprovalItem = {
      ...escalated,
      routing: {
        ...escalated.routing,
        recipients: [...escalated.routing.recipients, { person: 'p_x', via: 'escalation' }],
        escalation: {
          ...escalated.routing.escalation,
          trail: [...trail, { ...extra, digest: escalationDigest(item.id, extra, last) }],
        },
      },
    }
    expect([...verifiedEscalatedRecipients(forged)].sort()).toEqual(['p_manager', 'p_owner'])
    expect(boundRecipients(forged)).toEqual(['p_wang', 'p_x'])
    const onlyOwner: ApprovalItem = {
      ...escalated,
      routing: {
        ...escalated.routing,
        escalation: { ...escalated.routing.escalation, chain: ['owner'] },
      },
    }
    // 第一步是 scope_manager，不在这张卡的链里：它和它后面的都不认
    expect(verifiedEscalatedRecipients(onlyOwner).size).toBe(0)
  })

  it('批准人被改成名单外的人 → 施行前拦下（authorization_check_failed）', async () => {
    const { h, item, tamper } = await approvedAfterEscalation()
    tamper((i) => {
      if (i.decision) i.decision.by = 'p_stranger'
    })
    await expect(h.txn.executor.applyApproval(item.id)).rejects.toMatchObject({
      code: 'authorization_check_failed',
    })
  })
})

/** 这个人手上最新一张还能用的投递（改派 / 重提之后旧投递都 expired）。 */
const liveToken = (item: ApprovalItem, person: string): string => {
  const d = [...item.deliveries].reverse().find((x) => x.to === person && x.status === 'sent')
  if (d === undefined) throw new Error(`no live delivery for ${person}`)
  return d.decision_token
}

/** 出卡 → 两级升级（经理、老板都进名单）。 */
async function escalatedDraft(h: ReturnType<typeof escalationHarness>) {
  await h.txn.approvals.create(
    outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
  )
  h.clock.set('2026-09-07T17:30:00.000Z')
  const [escalated] = await h.txn.approvals.escalate()
  if (escalated === undefined) throw new Error('not escalated')
  return escalated
}

describe('WP199 顺查：别的改名单的路径', () => {
  it('转交（redirect）：升过级再转给别人 → 新人批 → 施行成功', async () => {
    const h = escalationHarness()
    const item = await escalatedDraft(h)
    const moved = await h.txn.approvals.decide(item.id, 'p_owner', {
      decision_token: tokenOf(item, 'p_owner'),
      action: 'redirect',
      reason: '这条给运营',
      redirect_to: { person_id: 'p_ops' },
      via: 'workstation',
    })
    expect(moved.revision).toBe(2)
    await h.txn.approvals.decide(item.id, 'p_ops', {
      decision_token: tokenOf(moved, 'p_ops'),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.applyApproval(item.id)).state).toBe('applied')
    // 升级留痕还在（挂在 revision 1），只是不再算数
    const after = await h.txn.approvals.get(item.id)
    expect(after?.routing.escalation.trail?.map((s) => s.revision)).toEqual([1, 1])
  })

  it('审批人离职交接（reroute）：升级进来的经理离职、改派老板 → 老板批 → 施行成功', async () => {
    const h = escalationHarness()
    const item = await escalatedDraft(h)
    const moved = await h.txn.approvals.reroute(item.id, {
      from: 'p_manager',
      to: 'p_owner',
      via: 'owner',
      reason: '上级离职了，改由老板批',
    })
    if (moved === undefined) throw new Error('not moved')
    expect(moved.routing.recipients.map((r) => r.person)).toEqual(['p_owner', 'p_wang'])
    await h.txn.approvals.decide(item.id, 'p_owner', {
      decision_token: liveToken(moved, 'p_owner'),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.applyApproval(item.id)).state).toBe('applied')
  })

  it('先改派、后升级：新 revision 上的升级步照样核对得上', async () => {
    const h = escalationHarness()
    const item = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
    )
    const moved = await h.txn.approvals.reroute(item.id, {
      from: 'p_wang',
      to: 'p_lead',
      via: 'scope_manager',
      reason: '换人',
    })
    expect(moved?.revision).toBe(2)
    h.clock.set('2026-09-07T17:30:00.000Z')
    const [escalated] = await h.txn.approvals.escalate()
    if (escalated === undefined) throw new Error('not escalated')
    expect(escalated.routing.escalation.trail?.map((s) => s.revision)).toEqual([2, 2])
    await h.txn.approvals.decide(item.id, 'p_owner', {
      decision_token: tokenOf(escalated, 'p_owner'),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.applyApproval(item.id)).state).toBe('applied')
  })

  it('升级后同键重提（内容更新）：revision+1、名单整份重新绑定 → 老板批新版 → 施行成功', async () => {
    const h = escalationHarness()
    const item = await escalatedDraft(h)
    const next = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z', title: '回复 Anna（改过一版）' }),
    )
    expect(next.id).toBe(item.id)
    expect(next.revision).toBe(2)
    await h.txn.approvals.decide(item.id, 'p_owner', {
      decision_token: liveToken(next, 'p_owner'),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.applyApproval(item.id)).state).toBe('applied')
  })
})

describe('WP199 顺查：撤回重开 / 批量 / 失败重试 / 重启', () => {
  const managerStage = () =>
    refundStage({ approval: { recipients: [{ person: 'p_manager', via: 'scope_manager' }] } })

  it('撤回后重开：旧卡撤回，同一笔重新提 → 新卡升级 → 老板批 → 施行成功', async () => {
    const h = escalationHarness((p) => p !== 'p_manager')
    const first = await h.txn.ledger.stage(managerStage())
    if (!first.ok) throw new Error(first.message)
    await h.txn.approvals.withdraw(first.approval.id, 'agent_aftersales')
    const again = await h.txn.ledger.stage(managerStage())
    if (!again.ok) throw new Error(again.message)
    expect(again.approval.id).not.toBe(first.approval.id)
    expect(again.approval.links.supersedes).toBe(first.approval.id)
    h.clock.set('2026-09-07T17:30:00.000Z')
    const escalated = (await h.txn.approvals.escalate()).find((i) => i.id === again.approval.id)
    if (escalated === undefined) throw new Error('not escalated')
    await h.txn.approvals.decide(again.approval.id, 'p_owner', {
      decision_token: liveToken(escalated, 'p_owner'),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.apply(again.change.id)).status).toBe('applied')
  })

  it('批量通过（decideBatch）：老板在升级来的两张卡上一次批 → 都施行成功', async () => {
    const h = escalationHarness((p) => p !== 'p_manager')
    const a = await h.txn.ledger.stage(managerStage())
    const b = await h.txn.ledger.stage(
      refundStage({
        target: { type: 'order', id: 'ord_1043' },
        run_id: 'run_6',
        provenance: {
          run_id: 'run_6',
          seen: { order: ['ord_1043'], customer: ['cus_7'] },
          read_full: [],
          recorded_at: '2026-09-07T09:00:00.000Z',
        },
        approval: { recipients: [{ person: 'p_manager', via: 'scope_manager' }] },
      }),
    )
    if (!a.ok || !b.ok) throw new Error('stage failed')
    h.setRecord({ type: 'order', id: 'ord_1043' }, { record_version: 'v1' })
    h.clock.set('2026-09-07T17:30:00.000Z')
    const escalated = await h.txn.approvals.escalate()
    const entries = escalated.map((i) => ({ id: i.id, decision_token: liveToken(i, 'p_owner') }))
    expect(entries).toHaveLength(2)
    const out = await h.txn.approvals.decideBatch(entries, 'p_owner', { action: 'approve' })
    expect(out.every((o) => o.item?.state === 'approved')).toBe(true)
    h.clock.advance(121_000)
    const applied = await h.txn.executor.applyAll([a.change.id, b.change.id])
    expect(applied.map((o) => o.status)).toEqual(['applied', 'applied'])
  })

  it('施行失败后重试（retryApply）：升级来的批准人照样认', async () => {
    const h = escalationHarness((p) => p !== 'p_manager')
    let down = true
    h.setBackend(() =>
      down
        ? { status: 'failed', error: { message: 'down', retryable: false } }
        : { status: 'ok', execution_id: 'exec_2' },
    )
    const staged = await h.txn.ledger.stage(managerStage())
    if (!staged.ok) throw new Error(staged.message)
    h.clock.set('2026-09-07T17:30:00.000Z')
    const [escalated] = await h.txn.approvals.escalate()
    if (escalated === undefined) throw new Error('not escalated')
    await h.txn.approvals.decide(staged.approval.id, 'p_owner', {
      decision_token: liveToken(escalated, 'p_owner'),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.apply(staged.change.id)).status).toBe('failed')
    expect((await h.txn.approvals.get(staged.approval.id))?.state).toBe('apply_failed')
    down = false
    const retried = await h.txn.approvals.retryApply(staged.approval.id, 'p_owner')
    expect(retried.state).toBe('applied')
  })

  it('变更账本那条路：批准人被改成名单外的人 → apply_failed（authorization_check_failed）', async () => {
    const h = escalationHarness((p) => p !== 'p_manager')
    const staged = await h.txn.ledger.stage(managerStage())
    if (!staged.ok) throw new Error(staged.message)
    h.clock.set('2026-09-07T17:30:00.000Z')
    const [escalated] = await h.txn.approvals.escalate()
    if (escalated === undefined) throw new Error('not escalated')
    await h.txn.approvals.decide(staged.approval.id, 'p_owner', {
      decision_token: liveToken(escalated, 'p_owner'),
      action: 'approve',
      via: 'workstation',
    })
    const cur = h.txn.runtime.store.getApproval(staged.approval.id)
    if (cur?.decision === undefined) throw new Error('no decision')
    cur.decision.by = 'p_stranger'
    h.txn.runtime.store.putApproval(cur)
    h.clock.advance(121_000)
    const out = await h.txn.executor.apply(staged.change.id)
    expect(out.status).toBe('failed')
    expect(out.error?.code).toBe('authorization_check_failed')
  })
})

describe('WP199 重启之后', () => {
  it('SQLite 档：升级后关库重开（换进程、换密钥）→ 老板批 → 施行成功', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp199-'))
    const dbPath = join(dir, 'txn.sqlite')
    const policy = {
      business_tz_offset_minutes: 0,
      escalation_hours: { scope_manager: 4, owner: 8 },
    }
    const directory = { scopeManager: () => 'p_manager', owner: () => 'p_owner' }
    const s1 = new SqliteTxnStore({ dbPath })
    const s2 = new SqliteTxnStore({ dbPath })
    try {
      const h1 = harness({ store: s1, policy, directory })
      const item = await h1.txn.approvals.create(
        outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
      )
      h1.clock.set('2026-09-07T17:30:00.000Z')
      await h1.txn.approvals.escalate()
      s1.close()

      const h2 = harness({ store: s2, policy, directory, start: '2026-09-07T17:31:00.000Z' })
      const reopened = await h2.txn.approvals.get(item.id)
      if (reopened === undefined) throw new Error('gone')
      expect(reopened.routing.escalation.trail).toHaveLength(2)
      await h2.txn.approvals.decide(item.id, 'p_owner', {
        decision_token: liveToken(reopened, 'p_owner'),
        action: 'approve',
        via: 'workstation',
      })
      h2.clock.advance(121_000)
      expect((await h2.txn.executor.applyApproval(item.id)).state).toBe('applied')
    } finally {
      s2.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
