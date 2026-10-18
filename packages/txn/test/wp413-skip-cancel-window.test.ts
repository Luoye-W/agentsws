/**
 * WP413：插件侧边栏里点「填进页面」= 批这张卡并马上交出去（交出去之后还要人在 Reddit 页面上亲手点发送），
 * 所以那一次施行不等批准后的取消窗口（`skip_cancel_window`）。不带这一格照旧要等；决定记 `via: 'extension'`。
 */
import { describe, expect, it } from 'vitest'
import { harness, outboundInput, tokenOf } from './helpers.js'

describe('WP413 applyApproval 的 skip_cancel_window', () => {
  it('不带：取消窗口内照旧拒；带上：当场施行；决定与事件都记 via=extension', async () => {
    const h = harness({})
    const item = await h.txn.approvals.create(
      outboundInput({ expires_at: '2026-10-01T00:00:00.000Z' }),
    )
    const approved = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item),
      action: 'approve',
      via: 'extension',
    })
    expect(approved.decision?.via).toBe('extension')
    expect(
      h.events.find((e) => e.type === 'approval.decided')?.payload as Record<string, unknown>,
    ).toMatchObject({ via: 'extension' })

    await expect(h.txn.executor.applyApproval(item.id)).rejects.toMatchObject({
      code: 'conflict',
    })
    const out = await h.txn.executor.applyApproval(item.id, { skip_cancel_window: true })
    expect(out.state).toBe('applied')
    // 已经施行过：过了窗口的补扫再来一次也不会再发
    h.clock.advance(121_000)
    await expect(h.txn.executor.applyApproval(item.id)).rejects.toMatchObject({
      code: 'not_approved',
    })
  })
})
