/**
 * WP474（决策 1514）：一张一张里「刚才…撤回」补齐——
 * - 「不要」能撤（`undoable` = reopen，随时）；
 * - 「通过」在批准后 120 秒取消窗口里、真发出去之前能撤（`unapprove` → pending，重新投令牌）；
 *   过了窗口 / 已经发了 / 别人批的 / 不走窗口的卡都撤不了（回 undefined、一个字不动）；
 * - 改动卡（staged_change）撤回后变更回 `staged`、批准标记拿掉，执行器施行不了；
 * - 改过再批的退回改之前那一版。
 */
import { describe, expect, it } from 'vitest'
import { harness, outboundInput, refundStage, tokenOf } from './helpers.js'

const LATER = '2026-10-01T00:00:00.000Z'

describe('WP474 undoable / unapprove', () => {
  it('「不要」随时能撤（reopen）；没决定过的回 undefined', async () => {
    const h = harness({})
    const item = await h.txn.approvals.create(outboundInput({ expires_at: LATER }))
    expect(await h.txn.approvals.undoable(item.id, 'p_wang')).toBeUndefined()
    await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'reject',
      reason: '不要',
      via: 'workstation',
    })
    h.clock.advance(3_600_000)
    expect(await h.txn.approvals.undoable(item.id, 'p_wang')).toEqual({ kind: 'reopen' })
    // 别人问：不是他那一下
    expect(await h.txn.approvals.undoable(item.id, 'p_li')).toBeUndefined()
  })

  it('「通过」窗口里能撤：回 pending、新令牌能再批、reopened 事件记 in_cancel_window；执行器施行不了', async () => {
    const h = harness({})
    const item = await h.txn.approvals.create(outboundInput({ expires_at: LATER }))
    const approved = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'approve',
      via: 'workstation',
    })
    const decidedAt = Date.parse(approved.decision?.at ?? '')
    h.clock.advance(60_000)
    const how = await h.txn.approvals.undoable(item.id, 'p_wang')
    expect(how?.kind).toBe('unapprove')
    expect(Date.parse(how?.until ?? '')).toBe(decidedAt + 120_000)
    expect(how?.seconds_left).toBe(60)
    // 别人撤不了
    expect(await h.txn.approvals.unapprove(item.id, 'p_li', { reason: 'x' })).toBeUndefined()
    const back = await h.txn.approvals.unapprove(item.id, 'p_wang', { reason: '撤回' })
    expect(back?.state).toBe('pending')
    expect(back?.decision).toBeUndefined()
    expect(h.events.find((e) => e.type === 'approval.reopened')?.payload).toMatchObject({
      previous_state: 'approved',
      previous_action: 'approve',
      in_cancel_window: true,
    })
    // 过了窗口补扫也发不出去（不是 approved 了）
    h.clock.advance(121_000)
    await expect(h.txn.executor.applyApproval(item.id)).rejects.toMatchObject({
      code: 'not_approved',
    })
    // 新令牌能再批
    if (back === undefined) throw new Error('没撤回')
    const fresh = back.deliveries.filter((d) => d.to === 'p_wang' && d.status === 'sent').at(-1)
    const again = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: fresh?.decision_token ?? '',
      action: 'approve',
      via: 'workstation',
    })
    expect(again.state).toBe('approved')
  })

  it('「通过」过了 120 秒、或已经发了：撤不了，一个字不动', async () => {
    const h = harness({})
    const item = await h.txn.approvals.create(outboundInput({ expires_at: LATER }))
    await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(120_000)
    expect(await h.txn.approvals.undoable(item.id, 'p_wang')).toBeUndefined()
    expect(await h.txn.approvals.unapprove(item.id, 'p_wang', { reason: 'x' })).toBeUndefined()
    expect((await h.txn.approvals.get(item.id))?.state).toBe('approved')

    // 窗口里但已经交出去了（插件「填进页面」那种不等窗口的）
    const h2 = harness({})
    const sent = await h2.txn.approvals.create(outboundInput({ expires_at: LATER }))
    await h2.txn.approvals.decide(sent.id, 'p_wang', {
      decision_token: tokenOf(sent),
      action: 'approve',
      via: 'extension',
    })
    await h2.txn.executor.applyApproval(sent.id, { skip_cancel_window: true })
    expect(await h2.txn.approvals.undoable(sent.id, 'p_wang')).toBeUndefined()
    expect(await h2.txn.approvals.unapprove(sent.id, 'p_wang', { reason: 'x' })).toBeUndefined()
    expect((await h2.txn.approvals.get(sent.id))?.state).toBe('applied')
  })

  it('改过再批的：撤回退回改之前那一版', async () => {
    const h = harness({})
    const item = await h.txn.approvals.create(outboundInput({ expires_at: LATER }))
    const before = item.payload
    await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'approve_edited',
      edited_payload: { ...(before as Record<string, unknown>), body: '改过的一版' },
      via: 'workstation',
    })
    const back = await h.txn.approvals.unapprove(item.id, 'p_wang', { reason: '撤回' })
    expect(back?.state).toBe('pending')
    expect(back?.payload).toEqual(before)
  })

  it('改动卡（退款）：撤回后变更回 staged、批准标记拿掉；过了窗口执行器也施行不了', async () => {
    const h = harness({})
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    expect(h.txn.runtime.store.isApproved(staged.change.id)).toBe(true)
    const back = await h.txn.approvals.unapprove(staged.approval.id, 'p_wang', { reason: '撤回' })
    expect(back?.state).toBe('pending')
    const change = h.txn.runtime.store.getChange(staged.change.id)
    expect(change?.status).toBe('staged')
    expect(change?.approval).toBeUndefined()
    expect(h.txn.runtime.store.isApproved(staged.change.id)).toBe(false)
    h.clock.advance(121_000)
    await expect(h.txn.executor.applyApproval(staged.approval.id)).rejects.toMatchObject({
      code: 'not_approved',
    })
  })
})
