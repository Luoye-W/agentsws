/**
 * `TxnStore` 的**契约一致性套件**（WP18）：接受任意实现，对内存档与 SQLite 档各跑一遍。
 * 两档之间的任何漂移都应该在这里露出来——换存储不该改行为。
 */
import type {
  ApprovalItem,
  Mandate,
  ObjectRef,
  ProvenanceState,
  StagedChange,
} from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApprovalContext, TokenRecord, TxnStore } from '../src/types.js'

export interface StoreHarness {
  name: string
  /** 每个用例一份全新实例。 */
  make(): TxnStore
  /** 用例结束后释放（SQLite 档关库）。 */
  dispose?(store: TxnStore): void
}

const T0 = '2026-09-07T09:00:00.000Z'

export function approval(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'itm_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'staged_change',
    revision: 1,
    role_id: 'dtc.aftersales',
    subject: { object: { type: 'order', id: 'ord_1' } },
    dedupe_key: 'dk_1',
    title: '退款 20 美元',
    summary: '窗口内、原路退回',
    payload: { change_id: 'chg_1' },
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'agent', id: 'agent_1' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: 'per_1', via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: true,
    },
    priority: 'queue',
    state: 'pending',
    deliveries: [],
    links: { children: [] },
    created_at: T0,
    updated_at: T0,
    ...over,
  }
}

export function change(over: Partial<StagedChange> = {}): StagedChange {
  return {
    id: 'chg_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    role_id: 'dtc.aftersales',
    assignment_id: 'asg_3',
    run_id: 'run_5',
    change_set_id: 'cs_1',
    kind: 'refund',
    risk_class: 'money',
    target: { type: 'order', id: 'ord_1' },
    before: { refunded: 0 },
    after: { refunded: 20 },
    guardrail: { verdict: 'allow', hits: [], effective_mandate_hash: 'h_1' },
    notes: [],
    created_by: { kind: 'agent', id: 'agent_1' },
    status: 'staged',
    expires_at: '2026-09-14T09:00:00.000Z',
    created_at: T0,
    updated_at: T0,
    ...over,
  }
}

const token = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  token: 'dt_a',
  item_id: 'itm_1',
  revision: 1,
  snapshot_hash: 'snap_1',
  person: 'per_1',
  issued_at: T0,
  revoked: false,
  ...over,
})

const mandate: Mandate = { caps: { max_auto_refund_amount: 50 }, window: { max_count: 20 } }
const ORDER: ObjectRef = { type: 'order', id: 'ord_1' }
const OTHER: ObjectRef = { type: 'order', id: 'ord_2' }

const provenance = (over: Partial<ProvenanceState> = {}): ProvenanceState => ({
  run_id: 'run_5',
  seen: { 'order:ord_1': ['status'] },
  read_full: ['order:ord_1'],
  recorded_at: T0,
  ...over,
})

export function runTxnStoreConformance(h: StoreHarness): void {
  const live: TxnStore[] = []
  const make = (): TxnStore => {
    const s = h.make()
    live.push(s)
    return s
  }

  afterEach(() => {
    for (const s of live.splice(0)) h.dispose?.(s)
  })

  describe(`TxnStore 契约一致性 · ${h.name}`, () => {
    // ── 审批项
    it('putApproval / getApproval：往返一致，且返回的是副本（改不动内部状态）', () => {
      const s = make()
      const item = approval()
      s.putApproval(item)
      const got = s.getApproval('itm_1')
      expect(got).toEqual(item)
      if (got) got.title = '被篡改'
      expect(s.getApproval('itm_1')?.title).toBe('退款 20 美元')
    })

    it('getApproval：不存在返回 undefined', () => {
      expect(make().getApproval('itm_missing')).toBeUndefined()
    })

    it('putApproval：同 id 再写是更新，不是新增；顺序保持首次写入的顺序', () => {
      const s = make()
      s.putApproval(approval({ id: 'itm_1' }))
      s.putApproval(approval({ id: 'itm_2' }))
      s.putApproval(approval({ id: 'itm_1', state: 'approved' }))
      const all = s.listApprovals()
      expect(all.map((i) => i.id)).toEqual(['itm_1', 'itm_2'])
      expect(all[0]?.state).toBe('approved')
    })

    it('listApprovals：按 workspace / kind / role / dedupe_key / state 过滤', () => {
      const s = make()
      s.putApproval(approval({ id: 'itm_1' }))
      s.putApproval(approval({ id: 'itm_2', workspace_id: 'ws_2' }))
      s.putApproval(approval({ id: 'itm_3', kind: 'outbound_draft', dedupe_key: 'dk_3' }))
      s.putApproval(approval({ id: 'itm_4', role_id: 'common.owner', state: 'approved' }))
      expect(s.listApprovals({ workspace_id: 'ws_1' }).map((i) => i.id)).toEqual([
        'itm_1',
        'itm_3',
        'itm_4',
      ])
      expect(s.listApprovals({ kind: 'outbound_draft' }).map((i) => i.id)).toEqual(['itm_3'])
      expect(s.listApprovals({ role_id: 'common.owner' }).map((i) => i.id)).toEqual(['itm_4'])
      expect(s.listApprovals({ dedupe_key: 'dk_3' }).map((i) => i.id)).toEqual(['itm_3'])
      expect(s.listApprovals({ state: ['approved'] }).map((i) => i.id)).toEqual(['itm_4'])
      expect(s.listApprovals({ state: [] })).toEqual([])
      expect(
        s.listApprovals({ workspace_id: 'ws_1', kind: 'staged_change' }).map((i) => i.id),
      ).toEqual(['itm_1', 'itm_4'])
    })

    it('pushRevision / revisions：按写入顺序返回，全是副本', () => {
      const s = make()
      s.pushRevision(approval({ revision: 1 }))
      s.pushRevision(approval({ revision: 2 }))
      const list = s.revisions('itm_1')
      expect(list.map((i) => i.revision)).toEqual([1, 2])
      const first = list[0]
      if (first) first.revision = 99
      expect(s.revisions('itm_1')[0]?.revision).toBe(1)
      expect(s.revisions('itm_none')).toEqual([])
    })

    it('pushEventId / eventIds：按写入顺序追加', () => {
      const s = make()
      s.pushEventId('itm_1', 'evt_a')
      s.pushEventId('itm_1', 'evt_b')
      s.pushEventId('itm_2', 'evt_c')
      expect(s.eventIds('itm_1')).toEqual(['evt_a', 'evt_b'])
      expect(s.eventIds('itm_2')).toEqual(['evt_c'])
      expect(s.eventIds('itm_none')).toEqual([])
    })

    // ── decision_token 台账（14 §7）
    it('putToken / getToken / tokensFor：往返一致；used 可省', () => {
      const s = make()
      s.putToken(token())
      s.putToken(token({ token: 'dt_b', used: { at: T0, by: 'per_1', action: 'approve' } }))
      s.putToken(token({ token: 'dt_c', item_id: 'itm_2' }))
      expect(s.getToken('dt_a')).toEqual(token())
      expect(s.getToken('dt_b')?.used).toEqual({ at: T0, by: 'per_1', action: 'approve' })
      expect(s.getToken('dt_missing')).toBeUndefined()
      expect(s.tokensFor('itm_1').map((t) => t.token)).toEqual(['dt_a', 'dt_b'])
    })

    it('putToken：同 token 再写是更新（幂等回调只留一条）', () => {
      const s = make()
      s.putToken(token())
      s.putToken(token({ used: { at: T0, by: 'per_2', action: 'reject' } }))
      expect(s.tokensFor('itm_1')).toHaveLength(1)
      expect(s.getToken('dt_a')?.used?.by).toBe('per_2')
    })

    it('revokeTokensFor：只撤销该项的 token，别的项不受影响', () => {
      const s = make()
      s.putToken(token())
      s.putToken(token({ token: 'dt_b' }))
      s.putToken(token({ token: 'dt_c', item_id: 'itm_2' }))
      s.revokeTokensFor('itm_1')
      expect(s.tokensFor('itm_1').every((t) => t.revoked)).toBe(true)
      expect(s.getToken('dt_c')?.revoked).toBe(false)
    })

    // ── 变更账本
    it('putChange / getChange：往返一致且是副本', () => {
      const s = make()
      s.putChange(change())
      expect(s.getChange('chg_1')).toEqual(change())
      const got = s.getChange('chg_1')
      if (got) got.status = 'applied'
      expect(s.getChange('chg_1')?.status).toBe('staged')
      expect(s.getChange('chg_none')).toBeUndefined()
    })

    it('listChanges：按 workspace / kind / status / run / assignment / change_set / target / since 过滤', () => {
      const s = make()
      s.putChange(change({ id: 'chg_1' }))
      s.putChange(change({ id: 'chg_2', workspace_id: 'ws_2' }))
      s.putChange(change({ id: 'chg_3', kind: 'reship', status: 'applied', target: OTHER }))
      s.putChange(
        change({
          id: 'chg_4',
          run_id: 'run_9',
          assignment_id: 'asg_9',
          change_set_id: 'cs_9',
          created_at: '2026-09-08T09:00:00.000Z',
        }),
      )
      expect(s.listChanges().map((c) => c.id)).toEqual(['chg_1', 'chg_2', 'chg_3', 'chg_4'])
      expect(s.listChanges({ workspace_id: 'ws_2' }).map((c) => c.id)).toEqual(['chg_2'])
      expect(s.listChanges({ kind: 'reship' }).map((c) => c.id)).toEqual(['chg_3'])
      expect(s.listChanges({ status: ['applied'] }).map((c) => c.id)).toEqual(['chg_3'])
      expect(s.listChanges({ status: [] })).toEqual([])
      expect(s.listChanges({ run_id: 'run_9' }).map((c) => c.id)).toEqual(['chg_4'])
      expect(s.listChanges({ assignment_id: 'asg_9' }).map((c) => c.id)).toEqual(['chg_4'])
      expect(s.listChanges({ change_set_id: 'cs_9' }).map((c) => c.id)).toEqual(['chg_4'])
      expect(s.listChanges({ target: OTHER }).map((c) => c.id)).toEqual(['chg_3'])
      expect(s.listChanges({ since: '2026-09-08T00:00:00.000Z' }).map((c) => c.id)).toEqual([
        'chg_4',
      ])
    })

    it('putMandate / getMandate：往返一致且是副本', () => {
      const s = make()
      s.putMandate('chg_1', mandate)
      expect(s.getMandate('chg_1')).toEqual(mandate)
      const got = s.getMandate('chg_1')
      if (got) got.caps.max_auto_refund_amount = 999
      expect(s.getMandate('chg_1')?.caps.max_auto_refund_amount).toBe(50)
      expect(s.getMandate('chg_none')).toBeUndefined()
    })

    it('putContext / getContext：往返一致且是副本', () => {
      const s = make()
      const ctx: ApprovalContext = { change_id: 'chg_1', mandate_hash: 'h_1', attachments: ['a'] }
      s.putContext('itm_1', ctx)
      expect(s.getContext('itm_1')).toEqual(ctx)
      const got = s.getContext('itm_1')
      if (got) got.attachments = ['x']
      expect(s.getContext('itm_1')?.attachments).toEqual(['a'])
      expect(s.getContext('itm_none')).toBeUndefined()
    })

    // ── 批准标记（15 §5.2）
    it('markApproved / isApproved：只认写过的那条；重复写幂等', () => {
      const s = make()
      expect(s.isApproved('chg_1')).toBe(false)
      s.markApproved('chg_1')
      s.markApproved('chg_1')
      expect(s.isApproved('chg_1')).toBe(true)
      expect(s.isApproved('chg_2')).toBe(false)
    })

    // ── 预占额度（31 §3.2）
    it('reserve / reservationOf / countReserved：held 计数，committed 仍计，released 不计', () => {
      const s = make()
      expect(s.countReserved('ctr_a')).toBe(0)
      s.reserve('ctr_a', 'chg_1', 1)
      s.reserve('ctr_a', 'chg_2', 2)
      s.reserve('ctr_b', 'chg_3', 5)
      expect(s.reservationOf('chg_1')).toEqual({
        counter: 'ctr_a',
        change_id: 'chg_1',
        amount: 1,
        state: 'held',
      })
      expect(s.countReserved('ctr_a')).toBe(3)
      s.commitReservation('chg_1')
      expect(s.reservationOf('chg_1')?.state).toBe('committed')
      expect(s.countReserved('ctr_a')).toBe(3)
      s.releaseReservation('chg_2')
      expect(s.reservationOf('chg_2')?.state).toBe('released')
      expect(s.countReserved('ctr_a')).toBe(1)
      expect(s.countReserved('ctr_b')).toBe(5)
      expect(s.reservationOf('chg_none')).toBeUndefined()
    })

    it('commit / release 不存在的预占：静默无操作，不抛', () => {
      const s = make()
      expect(() => {
        s.commitReservation('chg_none')
        s.releaseReservation('chg_none')
      }).not.toThrow()
      expect(s.reservationOf('chg_none')).toBeUndefined()
    })

    // ── provenance（15 §6）
    it('putProvenance / getProvenance：按 run_id 往返，是副本，同 run 覆盖', () => {
      const s = make()
      s.putProvenance(provenance())
      expect(s.getProvenance('run_5')).toEqual(provenance())
      const got = s.getProvenance('run_5')
      if (got) got.read_full = []
      expect(s.getProvenance('run_5')?.read_full).toEqual(['order:ord_1'])
      s.putProvenance(provenance({ read_full: [] }))
      expect(s.getProvenance('run_5')?.read_full).toEqual([])
      expect(s.getProvenance('run_none')).toBeUndefined()
    })

    // ── 对账（15 §5.8）
    it('pendingReconcile：只出 unknown，可按 workspace 过滤；applied 不进队列', () => {
      const s = make()
      s.putChange(change({ id: 'chg_1', status: 'unknown' }))
      s.putChange(change({ id: 'chg_2', status: 'applied' }))
      s.putChange(change({ id: 'chg_3', status: 'unknown', workspace_id: 'ws_2' }))
      expect(s.pendingReconcile().map((c) => c.id)).toEqual(['chg_1', 'chg_3'])
      expect(s.pendingReconcile('ws_1').map((c) => c.id)).toEqual(['chg_1'])
    })

    it('getCursor / setCursor：没写过是 undefined；写过按名取回并可覆盖', () => {
      const s = make()
      expect(s.getCursor('reconcile')).toBeUndefined()
      s.setCursor('reconcile', 'chg_1')
      expect(s.getCursor('reconcile')).toBe('chg_1')
      s.setCursor('reconcile', 'chg_2')
      s.setCursor('sampling', 'chg_9')
      expect(s.getCursor('reconcile')).toBe('chg_2')
      expect(s.getCursor('sampling')).toBe('chg_9')
    })

    // ── 事务
    it('transaction：返回值透传，组内的写都能读到', () => {
      const s = make()
      const out = s.transaction(() => {
        s.putChange(change())
        s.markApproved('chg_1')
        return 'done'
      })
      expect(out).toBe('done')
      expect(s.getChange('chg_1')?.id).toBe('chg_1')
      expect(s.isApproved('chg_1')).toBe(true)
    })

    it('transaction：可嵌套（内层直接执行，不重开事务）', () => {
      const s = make()
      s.transaction(() => {
        s.putChange(change())
        s.transaction(() => {
          s.markApproved('chg_1')
        })
      })
      expect(s.isApproved('chg_1')).toBe(true)
    })

    // ── 一条完整的 stage → decide → apply 状态链
    it('stage → decide → apply 的状态链在存储里逐段可见', () => {
      const s = make()
      s.transaction(() => {
        s.putChange(change())
        s.putMandate('chg_1', mandate)
        s.reserve('ctr_a', 'chg_1', 1)
      })
      s.putApproval(approval())
      s.putContext('itm_1', { change_id: 'chg_1' })
      s.putToken(token())
      expect(s.listChanges({ status: ['staged'] })).toHaveLength(1)

      s.transaction(() => {
        s.putToken(token({ used: { at: T0, by: 'per_1', action: 'approve' } }))
        s.revokeTokensFor('itm_1')
        s.putApproval(approval({ state: 'approved' }))
      })
      s.transaction(() => {
        s.putChange(change({ status: 'approved' }))
        s.markApproved('chg_1')
      })
      expect(s.isApproved('chg_1')).toBe(true)
      expect(s.getToken('dt_a')?.used?.action).toBe('approve')

      s.transaction(() => {
        s.commitReservation('chg_1')
        s.putChange(change({ status: 'applied' }))
      })
      expect(s.getChange('chg_1')?.status).toBe('applied')
      expect(s.countReserved('ctr_a')).toBe(1)
      expect(s.getProvenance('run_5')).toBeUndefined()
      expect(s.pendingReconcile()).toEqual([])
    })

    it('目标引用参与过滤时按 type:id 整体比较，不会串到同 id 不同 type', () => {
      const s = make()
      s.putChange(change({ id: 'chg_1', target: ORDER }))
      s.putChange(change({ id: 'chg_2', target: { type: 'customer', id: 'ord_1' } }))
      expect(s.listChanges({ target: ORDER }).map((c) => c.id)).toEqual(['chg_1'])
    })
  })

  // ── 施行锁 + 围栏号（15 §apply / 31 §3.2）
  describe(`施行锁与围栏号 · ${h.name}`, () => {
    const KEY = 'order:ord_1|refund'
    const lease = (over: Partial<Parameters<TxnStore['acquireApplyLock']>[0]> = {}) => ({
      key: KEY,
      holder: 'exec_a',
      now: T0,
      leaseMs: 60_000,
      ...over,
    })

    it('第一次拿到锁，围栏号从 1 开始；释放后再拿号 +1', () => {
      const s = make()
      const first = s.acquireApplyLock(lease())
      expect(first?.token).toBe(1)
      expect(first?.holder).toBe('exec_a')
      s.releaseApplyLock(KEY, 1)
      expect(s.acquireApplyLock(lease())?.token).toBe(2)
    })

    it('别人正持着且租约没过期 → undefined（调用方回 conflict）', () => {
      const s = make()
      expect(s.acquireApplyLock(lease())?.token).toBe(1)
      expect(s.acquireApplyLock(lease({ holder: 'exec_b' }))).toBeUndefined()
      expect(s.applyLockOf(KEY)?.holder).toBe('exec_a')
    })

    it('租约过期 → 接管，且**接管也拿新号**（老施行者的迟到写才拦得住）', () => {
      const s = make()
      const first = s.acquireApplyLock(lease({ leaseMs: 1000 }))
      const later = new Date(Date.parse(T0) + 5000).toISOString()
      const taken = s.acquireApplyLock(lease({ holder: 'exec_b', now: later }))
      expect(taken?.holder).toBe('exec_b')
      expect(taken?.token).toBe((first?.token ?? 0) + 1)
    })

    it('号只增不减：锁放了、再拿、再放，号也不回头', () => {
      const s = make()
      const seen: number[] = []
      for (let i = 0; i < 4; i++) {
        const lock = s.acquireApplyLock(lease())
        seen.push(lock?.token ?? -1)
        s.releaseApplyLock(KEY, lock?.token ?? -1)
      }
      expect(seen).toEqual([1, 2, 3, 4])
    })

    it('拿错号的释放不生效——别把别人的锁放了', () => {
      const s = make()
      s.acquireApplyLock(lease())
      s.releaseApplyLock(KEY, 999)
      expect(s.applyLockOf(KEY)?.token).toBe(1)
      expect(s.acquireApplyLock(lease({ holder: 'exec_b' }))).toBeUndefined()
    })

    it('不同 key 互不干扰，各有各的号', () => {
      const s = make()
      expect(s.acquireApplyLock(lease())?.token).toBe(1)
      expect(s.acquireApplyLock(lease({ key: 'order:ord_2|refund' }))?.token).toBe(1)
      expect(s.applyLockOf('order:ord_9|refund')).toBeUndefined()
    })
  })
}
