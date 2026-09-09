/**
 * 39 待办 G：`fencing_token` 已经送到回调里了（WP31），但真后端一直忽略它。
 *
 * 锁挡的是「两个施行者同时写」；围栏号挡的是「租约过期后老施行者才醒过来、
 * 以为自己还持着锁」的**迟到写**。少了这一半，一个卡住的进程醒来照样能把
 * 后来者的合法修改覆盖掉。
 */
import type { ApprovalItem, StagedChange } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { LATE_WRITE_ERROR, MemoryBackend } from '../src/index.js'

const T0 = '2026-09-10T00:00:00.000Z'
const ORDER = { type: 'order', id: 'ord_1042' } as const

function change(over: Partial<StagedChange> = {}): StagedChange {
  return {
    id: 'chg_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    role_id: 'dtc.aftersales',
    assignment_id: 'asg_1',
    run_id: 'run_1',
    change_set_id: 'cs_1',
    kind: 'refund',
    target: ORDER,
    before: {},
    after: {},
    guardrail: { verdict: 'allow', hits: [], effective_mandate_hash: 'm:1', evaluated_at: T0 },
    notes: [],
    created_by: { kind: 'agent', id: 'agent_aftersales' },
    status: 'approved',
    risk_class: 'medium',
    expires_at: T0,
    created_at: T0,
    updated_at: T0,
    ...over,
  } as StagedChange
}

describe('真后端用起围栏号（31 §3.2 f / 39 待办 G）', () => {
  it('号只增不减：3 之后再来 2 就是迟到写，直接拒', () => {
    const backend = new MemoryBackend()
    const c = change()
    expect(backend.apply(c, { idempotencyKey: c.id, attempt: 1, fencing_token: 3 })).toMatchObject({
      status: 'ok',
    })
    expect(backend.fencingTokenOf('order:ord_1042|refund')).toBe(3)

    const late = backend.apply(c, { idempotencyKey: c.id, attempt: 2, fencing_token: 2 })
    expect(late.status).toBe('failed')
    expect(late.error?.message).toBe(LATE_WRITE_ERROR)
    // 迟到写不该被当成 unknown：它确定没发生，不必造一条对账项
    expect(late.error?.retryable).toBe(false)
    // 被拒的那一次不抬号
    expect(backend.fencingTokenOf('order:ord_1042|refund')).toBe(3)
  })

  it('同号可以再来一次（重试同一把锁），更大的号照收', () => {
    const backend = new MemoryBackend()
    const c = change()
    backend.apply(c, { idempotencyKey: c.id, attempt: 1, fencing_token: 5 })
    expect(backend.apply(c, { idempotencyKey: c.id, attempt: 2, fencing_token: 5 }).status).toBe(
      'ok',
    )
    expect(backend.apply(c, { idempotencyKey: c.id, attempt: 3, fencing_token: 9 }).status).toBe(
      'ok',
    )
    expect(backend.fencingTokenOf('order:ord_1042|refund')).toBe(9)
  })

  it('不同目标 / 不同 kind 各算各的号，互不干扰', () => {
    const backend = new MemoryBackend()
    backend.apply(change(), { idempotencyKey: 'k1', attempt: 1, fencing_token: 7 })
    const other = change({ id: 'chg_2', target: { type: 'order', id: 'ord_9' } })
    expect(
      backend.apply(other, { idempotencyKey: 'k2', attempt: 1, fencing_token: 1 }),
    ).toMatchObject({ status: 'ok' })
    const otherKind = change({ id: 'chg_3', kind: 'reship' })
    expect(
      backend.apply(otherKind, { idempotencyKey: 'k3', attempt: 1, fencing_token: 1 }),
    ).toMatchObject({ status: 'ok' })
  })

  it('没传号的老调用方一律放行（接线没到位不该让链路停摆）', () => {
    const backend = new MemoryBackend()
    const c = change()
    backend.apply(c, { idempotencyKey: c.id, attempt: 1, fencing_token: 4 })
    expect(backend.apply(c, { idempotencyKey: c.id, attempt: 2 }).status).toBe('ok')
  })

  it('出站投递同样受围栏号管', () => {
    const backend = new MemoryBackend()
    const item = { id: 'apr_1' } as ApprovalItem
    expect(
      backend.deliver(item, { idempotencyKey: 'apr_1', attempt: 1, fencing_token: 2 }).status,
    ).toBe('ok')
    expect(
      backend.deliver(item, { idempotencyKey: 'apr_1', attempt: 2, fencing_token: 1 }).status,
    ).toBe('failed')
  })
})

describe('对账回查（15 §5.8）', () => {
  it('写成功过的那条查得到 applied；没见过的回 undefined = 转人工', () => {
    const backend = new MemoryBackend()
    const c = change()
    backend.apply(c, { idempotencyKey: c.id, attempt: 1, fencing_token: 1 })
    expect(backend.verify(c)).toMatchObject({ status: 'applied', outcome_ref: ORDER })
    expect(backend.verify(change({ id: 'chg_never' }))).toBeUndefined()
  })

  it('后端说失败的那条不进「写成功过」的名册', () => {
    const backend = new MemoryBackend()
    const c = change({ id: 'chg_bad' })
    backend.setResult('chg_bad', { status: 'failed', error: { message: '上游拒绝' } })
    backend.apply(c, { idempotencyKey: c.id, attempt: 1, fencing_token: 1 })
    expect(backend.verify(c)).toBeUndefined()
  })
})
