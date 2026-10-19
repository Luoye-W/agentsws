/**
 * WP414：同类卡跟随之后的「撤回」与事后补理由。
 *
 * - `reopen`：只认「不要 / 稍后」了的卡（rejected / deferred）→ 回待处理、重新投令牌；批了的不动；
 * - `annotate`：决定之后补一句理由，只有做决定的本人能补；
 * - `decide` 带 `followed`：落到 `Decision.followed`，事件里记 `followed_from`。
 */
import { describe, expect, it } from 'vitest'
import { harness, outboundInput, tokenOf } from './helpers.js'

describe('WP414 reopen / annotate / followed', () => {
  it('跟着处理的「不要」能撤回：回 pending、旧决定进 reopened 事件、新令牌能再决定', async () => {
    const h = harness({})
    const item = await h.txn.approvals.create(outboundInput())
    const rejected = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'reject',
      reason: '跟着「A」：不要',
      via: 'batch',
      followed: { leader_id: 'apr_leader', why: '同一个版块，AI 判断理由相近' },
    })
    expect(rejected.state).toBe('rejected')
    expect(rejected.decision?.followed).toEqual({
      leader_id: 'apr_leader',
      why: '同一个版块，AI 判断理由相近',
    })
    expect(
      h.events.find((e) => e.type === 'approval.decided')?.payload as Record<string, unknown>,
    ).toMatchObject({ followed_from: 'apr_leader' })

    const back = await h.txn.approvals.reopen(item.id, 'p_wang', { reason: '撤回跟随' })
    expect(back?.state).toBe('pending')
    expect(back?.decision).toBeUndefined()
    const reopened = h.events.find((e) => e.type === 'approval.reopened')
    expect(reopened?.payload).toMatchObject({
      previous_state: 'rejected',
      previous_action: 'reject',
      followed_from: 'apr_leader',
    })
    // 旧令牌重放只是幂等回原卡（§7），不会把它再定一次；新令牌能再批
    if (back === undefined) throw new Error('reopen 没回卡')
    const replay = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(rejected),
      action: 'approve',
      via: 'workstation',
    })
    expect(replay.state).toBe('pending')
    const fresh = back.deliveries.filter((d) => d.to === 'p_wang' && d.status === 'sent').at(-1)
    expect(fresh?.decision_token).not.toBe(tokenOf(rejected))
    const approved = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: fresh?.decision_token ?? '',
      action: 'approve',
      via: 'workstation',
    })
    expect(approved.state).toBe('approved')
    // 批了的卡撤不回来（对外的事不撤）
    expect(await h.txn.approvals.reopen(item.id, 'p_wang', { reason: 'x' })).toBeUndefined()
  })

  it('稍后的也能撤回；没决定过的卡不动', async () => {
    const h = harness({})
    const item = await h.txn.approvals.create(outboundInput())
    expect(await h.txn.approvals.reopen(item.id, 'p_wang', { reason: 'x' })).toBeUndefined()
    await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'defer',
      defer_until: '2026-09-07T13:00:00.000Z',
      via: 'batch',
    })
    const back = await h.txn.approvals.reopen(item.id, 'p_wang', { reason: '撤回' })
    expect(back?.state).toBe('pending')
  })

  it('事后补理由：本人能补、记 reason_added；别人补 403；没决定的回 undefined', async () => {
    const h = harness({})
    const item = await h.txn.approvals.create(outboundInput())
    expect(await h.txn.approvals.annotate(item.id, 'p_wang', { reason: '不相关' })).toBeUndefined()
    await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'reject',
      reason: '不要',
      via: 'workstation',
    })
    const out = await h.txn.approvals.annotate(item.id, 'p_wang', { reason: '不相关' })
    expect(out?.decision?.reason).toBe('不相关')
    expect(h.events.find((e) => e.type === 'approval.reason_added')?.payload).toMatchObject({
      reason: '不相关',
      action: 'reject',
    })
    await expect(
      h.txn.approvals.annotate(item.id, 'p_other', { reason: '别人' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})
