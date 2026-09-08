import { describe, expect, it } from 'vitest'
import {
  businessHoursBetween,
  counterKey,
  createTxn,
  DEFAULT_POLICY,
  dedupeKey,
  expiryFor,
  isKnownKind,
  localDay,
  MemoryTxnStore,
  runPrecheck,
  scanSecrets,
} from '../src/index.js'
import {
  CUSTOMER,
  harness,
  ORDER,
  outboundInput,
  refundStage,
  seeded,
  T0,
  tokenOf,
} from './helpers.js'

describe('工具（14 §5 §6 §7、15 §4）', () => {
  it('工作时间只算周一至周五 9–18', () => {
    // 周一 09:00Z → 周一 18:00Z = 9 小时
    expect(businessHoursBetween(T0, '2026-09-07T18:00:00.000Z', 0)).toBe(9)
    // 跨周末：周五 09:00 → 下周一 12:00 = 9 + 3
    expect(businessHoursBetween('2026-09-11T09:00:00.000Z', '2026-09-14T12:00:00.000Z', 0)).toBe(12)
    expect(businessHoursBetween(T0, T0, 0)).toBe(0)
    expect(businessHoursBetween('bad', T0, 0)).toBe(0)
    // tz 偏移改变归属日
    expect(localDay('2026-09-07T20:00:00.000Z', 480)).toBe('2026-09-08')
    expect(counterKey('asg_3', 'refund', '2026-09-08')).toBe('asg_3|refund|2026-09-08')
  })

  it('dedupe_key 稳定且区分 discriminator；过期默认值按 kind', () => {
    const a = dedupeKey('ws_1', 'outbound_draft', ORDER, 'thr_88')
    expect(dedupeKey('ws_1', 'outbound_draft', ORDER, 'thr_88')).toBe(a)
    expect(dedupeKey('ws_1', 'outbound_draft', ORDER, 'thr_89')).not.toBe(a)
    expect(expiryFor('outbound_draft', T0, DEFAULT_POLICY)).toBe('2026-09-09T09:00:00.000Z')
    expect(expiryFor('claim', T0, DEFAULT_POLICY)).toBe('2026-09-21T09:00:00.000Z')
    expect(expiryFor('policy_change', T0, DEFAULT_POLICY)).toBe('2026-09-14T09:00:00.000Z')
  })

  it('密钥扫描认得 key / 卡号形态', () => {
    expect(scanSecrets({ text: 'sk-0123456789abcdefghij' })).toContain('api_key')
    expect(scanSecrets({ text: 'AKIAIOSFODNN7EXAMPLE' })).toContain('aws_key')
    expect(scanSecrets({ text: '4111 1111 1111 1111' })).toContain('card_number')
    expect(scanSecrets({ text: '一切正常' })).toEqual([])
    expect(isKnownKind('staged_action')).toBe(false)
    expect(isKnownKind('outbound_draft')).toBe(true)
  })

  it('语义 diff 为空的 knowledge_update 不建项', () => {
    const out = runPrecheck({
      ...outboundInput(),
      kind: 'knowledge_update',
      payload: { layer: 'fact', op: 'update', content: 'x' },
      evidence: {
        source_events: [],
        provenance: { seen: [] },
        precheck: {},
        diff: { before: 'x', after: 'x' },
      },
    })
    expect(out.blocked).toContain('empty_diff')
    expect(out.precheck.semantic_diff).toBe('empty')
  })

  it('内存存储：修订历史、token、预占、变更过滤', () => {
    const store = new MemoryTxnStore()
    expect(store.getApproval('nope')).toBeUndefined()
    expect(store.getChange('nope')).toBeUndefined()
    expect(store.getMandate('nope')).toBeUndefined()
    expect(store.getContext('nope')).toBeUndefined()
    expect(store.getProvenance('nope')).toBeUndefined()
    expect(store.getToken('nope')).toBeUndefined()
    expect(store.reservationOf('nope')).toBeUndefined()
    store.reserve('c1', 'chg_1', 1)
    store.reserve('c1', 'chg_2', 2)
    expect(store.countReserved('c1')).toBe(3)
    store.commitReservation('chg_1')
    store.releaseReservation('chg_2')
    expect(store.countReserved('c1')).toBe(1)
    expect(store.reservationOf('chg_1')?.state).toBe('committed')
    store.putToken({
      token: 't1',
      item_id: 'apr_1',
      revision: 1,
      snapshot_hash: 'h',
      person: 'p',
      issued_at: T0,
      revoked: false,
    })
    expect(store.tokensFor('apr_1')).toHaveLength(1)
    store.revokeTokensFor('apr_1')
    expect(store.getToken('t1')?.revoked).toBe(true)
  })

  it('注入自定义 store 与 clock/random，同 seed 结果稳定', async () => {
    const store = new MemoryTxnStore()
    const mk = () =>
      createTxn({
        clock: { now: () => T0 },
        random: seeded(1),
        eventSink: () => undefined,
        store: new MemoryTxnStore(),
      })
    const a = await mk().approvals.create(outboundInput())
    const b = await mk().approvals.create(outboundInput())
    expect(a.id).toBe(b.id)
    expect(a.execution_snapshot?.hash).toBe(b.execution_snapshot?.hash)
    const txn = createTxn({
      clock: { now: () => T0 },
      random: seeded(1),
      eventSink: () => undefined,
      store,
    })
    const item = await txn.approvals.create(outboundInput())
    expect(store.getApproval(item.id)?.id).toBe(item.id)
  })

  it('账本 list / get；施行失败后 retryApply 重开并重新预占', async () => {
    let calls = 0
    const h = harness({
      records: { 'order:ord_1042': { record_version: 'v1' } },
      backend: () => {
        calls++
        return calls === 1
          ? { status: 'failed', error: { message: 'provider down', retryable: false } }
          : { status: 'ok', execution_id: 'exec_2' }
      },
    })
    const staged = await h.txn.ledger.stage(refundStage())
    if (!staged.ok) throw new Error(staged.message)
    expect(await h.txn.ledger.get(staged.change.id)).toBeDefined()
    expect(await h.txn.ledger.list({ target: ORDER, kind: 'refund' })).toHaveLength(1)
    await h.txn.approvals.decide(staged.approval.id, 'p_wang', {
      decision_token: tokenOf(staged.approval),
      action: 'approve',
      via: 'workstation',
    })
    h.clock.advance(121_000)
    expect((await h.txn.executor.apply(staged.change.id)).status).toBe('failed')
    const counter = staged.change.reservation?.counter ?? ''
    expect(h.txn.runtime.store.countReserved(counter)).toBe(0)
    const retried = await h.txn.approvals.retryApply(staged.approval.id, 'p_wang')
    expect(retried.state).toBe('applied')
    expect(h.txn.runtime.store.countReserved(counter)).toBe(1)
    await expect(h.txn.approvals.retryApply(staged.approval.id, 'p_wang')).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it('claim 后 release 只允许认领人；不存在的 id 报 not_found', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(outboundInput())
    await h.txn.approvals.claim(item.id, 'p_wang')
    await expect(h.txn.approvals.release(item.id, 'p_other')).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(h.txn.approvals.get('apr_none')).resolves.toBeUndefined()
    await expect(h.txn.approvals.withdraw('apr_none', 'p_wang')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(h.txn.executor.apply('chg_none')).rejects.toMatchObject({ code: 'not_found' })
    // 已 in_review 不可再 claim
    await expect(h.txn.approvals.claim(item.id, 'p_wang')).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it('defer 后到时可再决定；决定人拿别人的 token 被拒', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(
      outboundInput({
        routing: {
          recipients: [
            { person: 'p_wang', via: 'role_holder' },
            { person: 'p_li', via: 'explicit' },
          ],
          rule: 'role_holder',
          escalation: {
            after_hours: 24,
            business_hours: true,
            chain: ['scope_manager', 'owner'],
            escalated_at: [],
          },
          separation_of_duties: true,
        },
      }),
    )
    await expect(
      h.txn.approvals.decide(item.id, 'p_li', {
        decision_token: tokenOf(item, 'p_wang'),
        action: 'approve',
        via: 'workstation',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    const deferred = await h.txn.approvals.decide(item.id, 'p_wang', {
      decision_token: tokenOf(item, 'p_wang'),
      action: 'defer',
      defer_until: '2026-09-08T09:00:00.000Z',
      via: 'workstation',
    })
    expect(deferred.state).toBe('deferred')
    expect(deferred.decision?.defer_until).toBe('2026-09-08T09:00:00.000Z')
  })

  it('withdraw 经 decide 转发；未接入执行器的 kind 报错', async () => {
    const h = harness()
    const item = await h.txn.approvals.create(outboundInput())
    const out = await h.txn.approvals.decide(item.id, 'agent_aftersales', {
      decision_token: tokenOf(item),
      action: 'withdraw',
      via: 'api',
    })
    expect(out.state).toBe('withdrawn')
    const other = await h.txn.approvals.create(
      outboundInput({
        kind: 'claim',
        dedupe_key: 'dk_claim',
        payload: { claim_kind: 'action_item', text: '跟进 Anna', quote: '请帮我退款' },
        subject: { object: CUSTOMER },
        evidence: {
          run_id: 'run_9',
          source_events: [],
          provenance: { seen: [CUSTOMER] },
          precheck: {},
        },
      }),
    )
    await h.txn.approvals.decide(other.id, 'p_wang', {
      decision_token: tokenOf(other),
      action: 'approve',
      via: 'workstation',
    })
    await expect(h.txn.executor.applyApproval(other.id)).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })
})
