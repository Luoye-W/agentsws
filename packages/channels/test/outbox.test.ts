/**
 * WP55 / 48 §4 L3 #4：出站 outbox 与对账。
 *
 * 这一套用例的中心只有一句话：**`sent_unknown` 绝不自动重试**。
 * 重发一封可能已经发出去的信，客户会收到两封，而两封信是收不回来的。
 */
import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_RECONCILE_GRACE_MS,
  canTransition,
  classifySendFailure,
  MAX_RECONCILE_ATTEMPTS,
  MemoryOutboxStore,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_TRANSITIONS,
  Outbox,
  type OutboxStatus,
  type OutboxStore,
  type OutboxTransitionEvent,
  outboxPayloadHash,
  SqliteOutboxStore,
} from '../src/index.js'

const WS = 'ws_1'
const T = (min: number): string =>
  new Date(Date.parse('2026-09-10T00:00:00.000Z') + min * 60_000).toISOString()

const PAYLOAD = outboxPayloadHash({ to: ['ann@customer.com'], subject: 'Re: x', text: 'hello' })

function make(store: OutboxStore = new MemoryOutboxStore()): {
  outbox: Outbox
  transitions: OutboxTransitionEvent[]
} {
  const transitions: OutboxTransitionEvent[] = []
  const outbox = new Outbox({
    store,
    workspace_id: WS,
    onTransition: (e) => {
      transitions.push(e)
    },
  })
  return { outbox, transitions }
}

const prepare = (outbox: Outbox, key = 'chg_1', payload_hash = PAYLOAD, at = T(0)) =>
  outbox.prepare({
    idempotency_key: key,
    thread_ref: '<thr-1@mail>',
    message_id: '<msg-1@shop>',
    payload_hash,
    approval_item_id: 'apr_1',
    now: at,
  })

describe('状态机：表写在数据里，表外的迁移一律拒绝', () => {
  it('七态与合法边（`confirmed` / `failed_terminal` 是终态）', () => {
    expect(Object.keys(OUTBOX_TRANSITIONS).sort()).toEqual(
      [
        'accepted_by_provider',
        'confirmed',
        'failed_retryable',
        'failed_terminal',
        'prepared',
        'sending',
        'sent_unknown',
      ].sort(),
    )
    expect(OUTBOX_TRANSITIONS.confirmed).toEqual([])
    expect(OUTBOX_TRANSITIONS.failed_terminal).toEqual([])
    expect(canTransition('prepared', 'sending')).toBe(true)
    expect(canTransition('confirmed', 'sending')).toBe(false)
    // 机器不能从 sent_unknown 走回 sending：那就是自动重发
    expect(canTransition('sent_unknown', 'sending')).toBe(false)
    // 但人可以（对账卡上的「确认没发出去，重发一次」）
    expect(canTransition('sent_unknown', 'prepared')).toBe(true)
  })

  it('非法迁移抛异常，不是悄悄写进去', async () => {
    const { outbox } = make()
    const out = await prepare(outbox)
    const row = out.kind === 'new' ? out.record : undefined
    expect(row).toBeDefined()
    if (row === undefined) return
    await expect(outbox.markConfirmed(row, T(1), 'manual')).rejects.toThrow('不合法的状态迁移')
  })

  it('每次迁移落一条事件（给事件日志用，只有状态没有正文）', async () => {
    const { outbox, transitions } = make()
    const out = await prepare(outbox)
    if (out.kind !== 'new') return
    const sending = await outbox.beginSend(out.record, T(1))
    await outbox.markAccepted(sending, T(2), '<msg-1@shop>')
    expect(transitions.map((t) => `${t.from}→${t.to}`)).toEqual([
      'prepared→sending',
      'sending→accepted_by_provider',
    ])
    expect(JSON.stringify(transitions)).not.toContain('hello')
  })
})

describe('幂等：同一审批项只发一次', () => {
  it('第二次 prepare 拿到 `already`——调用方据此不再走 SMTP', async () => {
    const { outbox } = make()
    const first = await prepare(outbox)
    if (first.kind !== 'new') return
    const sending = await outbox.beginSend(first.record, T(1))
    await outbox.markAccepted(sending, T(2))

    const second = await prepare(outbox)
    expect(second.kind).toBe('already')
    expect(second.record.attempts).toBe(1)
  })

  it('上一次是 failed_retryable → `retry`，可以再来一次', async () => {
    const { outbox } = make()
    const first = await prepare(outbox)
    if (first.kind !== 'new') return
    const sending = await outbox.beginSend(first.record, T(1))
    await outbox.recordFailure(
      sending,
      { status: 'failed_retryable', token: 'connect_failed' },
      T(2),
    )
    expect((await prepare(outbox)).kind).toBe('retry')
  })

  it('`sent_unknown` 之后再 prepare 也是 `already`——歧义不重发', async () => {
    const { outbox } = make()
    const first = await prepare(outbox)
    if (first.kind !== 'new') return
    const sending = await outbox.beginSend(first.record, T(1))
    await outbox.recordFailure(
      sending,
      { status: 'sent_unknown', token: 'ambiguous_timeout' },
      T(2),
    )
    const again = await prepare(outbox)
    expect(again.kind).toBe('already')
    expect(again.record.status).toBe('sent_unknown')
  })

  it('同一幂等键换了正文 → `payload_drift`，拒绝（这不是重试）', async () => {
    const { outbox } = make()
    await prepare(outbox)
    const drift = await prepare(
      outbox,
      'chg_1',
      outboxPayloadHash({ to: ['ann@customer.com'], text: '换了一份' }),
    )
    expect(drift.kind).toBe('payload_drift')
  })
})

describe('失败分类：默认分支是歧义，不是"重试"', () => {
  const cases: [unknown, Parameters<typeof classifySendFailure>[1], OutboxStatus][] = [
    [Object.assign(new Error('auth'), { code: 'EAUTH' }), 'unknown', 'failed_terminal'],
    [
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      'pre_connect',
      'failed_retryable',
    ],
    [Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 'connected', 'sent_unknown'],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'unknown', 'sent_unknown'],
    [Object.assign(new Error('5xx'), { responseCode: 550 }), 'connected', 'failed_terminal'],
    [Object.assign(new Error('4xx'), { responseCode: 451 }), 'connected', 'failed_retryable'],
    [new Error('谁知道呢'), 'unknown', 'sent_unknown'],
  ]
  for (const [error, phase, expected] of cases) {
    it(`${(error as Error).message} / ${phase} → ${expected}`, () => {
      expect(classifySendFailure(error, phase).status).toBe(expected)
    })
  }

  it('正文已在途（post_data）：任何错误都是歧义，连鉴权失败也不例外', () => {
    const auth = Object.assign(new Error('auth'), { code: 'EAUTH' })
    expect(classifySendFailure(auth, 'post_data').status).toBe('sent_unknown')
  })
})

describe('重试与对账的退避', () => {
  it('failed_retryable 排退避；次数到顶转 failed_terminal', async () => {
    const { outbox } = make()
    const first = await prepare(outbox)
    if (first.kind !== 'new') return
    let row = first.record
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      row = await outbox.beginSend(row, T(i * 10))
      row = await outbox.recordFailure(
        row,
        { status: 'failed_retryable', token: 'connect_failed' },
        T(i * 10 + 1),
      )
      if (row.status === 'failed_terminal') break
    }
    expect(row.status).toBe('failed_terminal')
    expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS)
  })

  it('sent_unknown 排的是**对账**，不是重试（`next_at_ms` 是空的）', async () => {
    const { outbox } = make()
    const first = await prepare(outbox)
    if (first.kind !== 'new') return
    const sending = await outbox.beginSend(first.record, T(1))
    const unknown = await outbox.recordFailure(
      sending,
      { status: 'sent_unknown', token: 'x' },
      T(2),
    )
    expect(unknown.next_at_ms).toBeUndefined()
    expect(unknown.reconcile_next_at_ms).toBe(Date.parse(T(2)) + 10 * 60_000)
  })
})

describe('对账：找证据，不重发', () => {
  const toUnknown = async (outbox: Outbox) => {
    const first = await prepare(outbox)
    if (first.kind !== 'new') throw new Error('unreachable')
    const sending = await outbox.beginSend(first.record, T(1))
    return outbox.recordFailure(
      sending,
      { status: 'sent_unknown', token: 'ambiguous_timeout' },
      T(2),
    )
  }

  it('到期才进扫描；找到证据 → confirmed，并记下证据来源', async () => {
    const { outbox } = make()
    const unknown = await toUnknown(outbox)
    expect(await outbox.dueForReconcile(T(5))).toHaveLength(0)
    const due = await outbox.dueForReconcile(T(20))
    expect(due).toHaveLength(1)
    const { record, outcome } = await outbox.recordReconcile(
      due[0] as NonNullable<(typeof due)[0]>,
      { source: 'sent_folder' },
      T(20),
    )
    expect(outcome).toBe('confirmed')
    expect(record.status).toBe('confirmed')
    expect(record.confirmation_source).toBe('sent_folder')
    void unknown
  })

  it('找不到 → 排下一次，次数耗尽 → exhausted（人工卡），全程一次都没重发', async () => {
    const { outbox, transitions } = make()
    let row = await toUnknown(outbox)
    let outcome: string = 'still_unknown'
    for (let i = 0; i < MAX_RECONCILE_ATTEMPTS + 1; i += 1) {
      const r = await outbox.recordReconcile(row, undefined, T(60 * (i + 1)))
      row = r.record
      outcome = r.outcome
      if (outcome === 'exhausted') break
    }
    expect(outcome).toBe('exhausted')
    expect(row.reconcile_exhausted_at_ms).toBeDefined()
    // 耗尽之后不再进扫描（否则会永远扫下去）
    expect(await outbox.dueForReconcile(T(10_000))).toHaveLength(0)
    // 这条行从头到尾没有回过 `sending`
    expect(transitions.filter((t) => t.to === 'sending')).toHaveLength(1)
  })

  it('迟迟没确认的 accepted_by_provider 过了宽限也进扫描，但只重排、不消耗对账预算', async () => {
    const { outbox } = make()
    const first = await prepare(outbox)
    if (first.kind !== 'new') return
    const sending = await outbox.beginSend(first.record, T(1))
    const accepted = await outbox.markAccepted(sending, T(2))
    expect(await outbox.dueForReconcile(T(3))).toHaveLength(0)
    const at = new Date(accepted.updated_at_ms + ACCEPTED_RECONCILE_GRACE_MS).toISOString()
    expect(await outbox.dueForReconcile(at)).toHaveLength(1)
    const { record, outcome } = await outbox.recordReconcile(accepted, undefined, at)
    expect(outcome).toBe('still_unknown')
    expect(record.reconcile_attempts).toBe(0)
  })

  it('人看过之后可以重来一次（这条边只有人能走）', async () => {
    const { outbox } = make()
    const unknown = await toUnknown(outbox)
    const requeued = await outbox.requeueByHuman(unknown, T(100))
    expect(requeued.status).toBe('prepared')
    expect(requeued.reconcile_attempts).toBe(0)
    expect((await prepare(outbox)).kind).toBe('retry')
  })
})

describe('SQLite 档：同一份契约跑第二遍', () => {
  it('落盘之后幂等、状态、对账到期都还认得出', async () => {
    const store = new SqliteOutboxStore()
    const { outbox } = make(store)
    const first = await prepare(outbox)
    if (first.kind !== 'new') return
    const sending = await outbox.beginSend(first.record, T(1))
    await outbox.recordFailure(
      sending,
      { status: 'sent_unknown', token: 'ambiguous_timeout' },
      T(2),
    )

    // 换一个实例读同一张库：行还在，状态没变
    const again = new Outbox({ store, workspace_id: WS })
    const found = await again.dueForReconcile(T(30))
    expect(found).toHaveLength(1)
    expect(found[0]?.status).toBe('sent_unknown')
    expect((await prepare(again)).kind).toBe('already')
    expect(store.list(WS)).toHaveLength(1)
    store.close()
  })
})
