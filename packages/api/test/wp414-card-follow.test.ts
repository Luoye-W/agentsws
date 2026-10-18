/**
 * WP414：同类卡跟着前一个决定（网关这一层）。
 *
 * - 「不要 / 稍后」：同类卡一并照办，每张记 `followed`（谁带动的、为什么），账本一条 `approval.followed`；
 * - 「通过 / 发送」：**绝不自动做**，只把同类列回去；
 * - 不在那几种卡里 / 没装相似度：不跟；
 * - 撤回只认「跟着这张、本人那一下带动」的；事后补理由连跟着的一起补。
 */
import type { ApprovalItem, DecideInput } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { followDecision, followReason, type SimilarCard } from '../src/card-follow.js'
import type { GatewayDeps } from '../src/types.js'
import { approvalItem, FakeEventLog, harness } from './helpers.js'

type Bus = GatewayDeps['approvals']

/** 一本只够这里用的审批账：队列、按动作改状态、记下每次决定的入参。 */
function miniBus(items: ApprovalItem[]): {
  bus: Bus
  decided: { id: string; input: DecideInput }[]
} {
  const byId = new Map(items.map((i) => [i.id, i]))
  const decided: { id: string; input: DecideInput }[] = []
  const bus = {
    get: async (id: string) => byId.get(id),
    queue: async (f: { state?: string[]; kind?: string; role_id?: string }) =>
      [...byId.values()].filter(
        (i) =>
          (f.state === undefined || f.state.includes(i.state)) &&
          (f.kind === undefined || i.kind === f.kind) &&
          (f.role_id === undefined || i.role_id === f.role_id),
      ),
    decide: async (id: string, by: string, input: DecideInput) => {
      const item = byId.get(id)
      if (item === undefined) throw new Error('not found')
      decided.push({ id, input })
      item.state = input.action === 'reject' ? 'rejected' : 'deferred'
      item.decision = {
        action: input.action,
        by,
        at: '2026-10-19T00:00:00.000Z',
        via: input.via,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.followed === undefined ? {} : { followed: input.followed }),
      }
      return item
    },
  } as unknown as Bus
  return { bus, decided }
}

const reddit = (
  id: string,
  title: string,
  state: ApprovalItem['state'] = 'pending',
): ApprovalItem =>
  approvalItem({
    id,
    title,
    state,
    dedupe_key: `dk_${id}`,
    payload: { form: 'reddit_write', channel_label: 'Reddit · r/Smartphones' },
    deliveries: [
      {
        channel: 'workstation',
        to: 'per_me',
        sent_at: '2026-10-19T00:00:00.000Z',
        view: 'full',
        decision_token: `tok_${id}`,
        status: 'sent',
      },
    ],
  })

const similarAll =
  (why: string): GatewayDeps['similarCards'] =>
  (_leader, pool) =>
    pool.map(
      (c): SimilarCard => ({
        id: c.id,
        why,
        basis: ['same_source', 'same_judgement'],
        source: 'r/Smartphones',
      }),
    )

describe('followDecision', () => {
  it('「不要」：同类卡一并不发，决定带 followed 与跟着谁的理由，账本记一条', async () => {
    const leader = reddit('ap_a', '回复 u/alice', 'rejected')
    leader.decision = {
      action: 'reject',
      by: 'per_me',
      at: 'x',
      via: 'workstation',
      reason: '不要',
    }
    const { bus, decided } = miniBus([
      leader,
      reddit('ap_b', '回复 u/bob'),
      reddit('ap_c', '回复 u/cat'),
    ])
    const eventLog = new FakeEventLog()
    const out = await followDecision(
      { approvals: bus, eventLog, similarCards: similarAll('同在 r/Smartphones，AI 判断理由相近') },
      { item: leader, person_id: 'per_me', action: 'reject', trace_id: 'tr' },
    )
    expect(out?.applied.map((a) => a.id)).toEqual(['ap_b', 'ap_c'])
    expect(out?.applied[0]?.title).toBe('回复 u/bob')
    expect(decided).toHaveLength(2)
    expect(decided[0]?.input).toMatchObject({
      action: 'reject',
      via: 'batch',
      reason: followReason('回复 u/alice', '不要'),
      followed: { leader_id: 'ap_a', why: '同在 r/Smartphones，AI 判断理由相近' },
    })
    const ev = eventLog.events.find((e) => e.type === 'approval.followed')
    expect(ev?.payload).toMatchObject({ leader_id: 'ap_a', action: 'reject' })
  })

  it('「稍后」：同类卡按同一个时间推迟', async () => {
    const leader = reddit('ap_a', 'A', 'deferred')
    leader.decision = {
      action: 'defer',
      by: 'per_me',
      at: 'x',
      via: 'workstation',
      defer_until: '2026-10-19T04:00:00.000Z',
    }
    const { bus, decided } = miniBus([leader, reddit('ap_b', 'B')])
    await followDecision(
      { approvals: bus, eventLog: new FakeEventLog(), similarCards: similarAll('同类') },
      { item: leader, person_id: 'per_me', action: 'snooze', trace_id: 'tr' },
    )
    expect(decided[0]?.input).toMatchObject({
      action: 'defer',
      defer_until: '2026-10-19T04:00:00.000Z',
    })
  })

  it('「发送 / 通过」：只列回同类，一张都不自动发', async () => {
    const leader = reddit('ap_a', 'A', 'approved')
    const { bus, decided } = miniBus([leader, reddit('ap_b', 'B'), reddit('ap_c', 'C')])
    const out = await followDecision(
      { approvals: bus, eventLog: new FakeEventLog(), similarCards: similarAll('同类') },
      { item: leader, person_id: 'per_me', action: 'approve', trace_id: 'tr' },
    )
    expect(out?.applied).toEqual([])
    expect(out?.suggested.map((s) => s.id)).toEqual(['ap_b', 'ap_c'])
    expect(decided).toEqual([])
  })

  it('没装相似度 / 不在那几种卡里 / 选择题卡：不跟', async () => {
    const leader = reddit('ap_a', 'A', 'rejected')
    const { bus } = miniBus([leader, reddit('ap_b', 'B')])
    const deps = { approvals: bus, eventLog: new FakeEventLog() }
    expect(
      await followDecision(deps, {
        item: leader,
        person_id: 'per_me',
        action: 'reject',
        trace_id: 't',
      }),
    ).toBeUndefined()
    const plugin = { ...leader, kind: 'official_plugin' as const }
    expect(
      await followDecision(
        { ...deps, similarCards: similarAll('x') },
        { item: plugin, person_id: 'per_me', action: 'reject', trace_id: 't' },
      ),
    ).toBeUndefined()
    const choice = { ...leader, payload: { options: [{ id: 'a', label: 'A' }] } }
    expect(
      await followDecision(
        { ...deps, similarCards: similarAll('x') },
        { item: choice, person_id: 'per_me', action: 'reject', trace_id: 't' },
      ),
    ).toBeUndefined()
  })
})

describe('撤回与补理由的路由', () => {
  const env = async () => {
    const h = await harness()
    const ws = h.workspace_id
    const me = h.person_id
    const leader = approvalItem({
      id: 'ap_lead',
      workspace_id: ws,
      state: 'rejected',
      decision: { action: 'reject', by: me, at: 'x', via: 'workstation', reason: '不要' },
    })
    const follower = approvalItem({
      id: 'ap_f1',
      workspace_id: ws,
      dedupe_key: 'dk_f1',
      state: 'rejected',
      decision: {
        action: 'reject',
        by: me,
        at: 'x',
        via: 'batch',
        reason: '跟着「回复 Anna」',
        followed: { leader_id: 'ap_lead', why: '同类' },
      },
    })
    const mine = approvalItem({
      id: 'ap_self',
      workspace_id: ws,
      dedupe_key: 'dk_self',
      state: 'rejected',
      decision: { action: 'reject', by: me, at: 'x', via: 'workstation', reason: '自己点的' },
    })
    for (const i of [leader, follower, mine]) h.approvals.seed(i)
    const reopened: string[] = []
    const annotated: { id: string; reason: string }[] = []
    Object.assign(h.approvals, {
      reopen: async (id: string) => {
        const it = h.approvals.items.get(id)
        if (it === undefined) return undefined
        reopened.push(id)
        it.state = 'pending'
        delete it.decision
        return it
      },
      annotate: async (id: string, _by: string, input: { reason: string }) => {
        const it = h.approvals.items.get(id)
        if (it?.decision === undefined) return undefined
        annotated.push({ id, reason: input.reason })
        it.decision = { ...it.decision, reason: input.reason }
        return it
      },
    })
    return { h, reopened, annotated }
  }

  it('撤回只放回「跟着这张」的那几张；自己点的不动', async () => {
    const { h, reopened } = await env()
    const res = await h.post('/v1/approvals/ap_lead/follow/undo', { ids: ['ap_f1', 'ap_self'] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { restored: { id: string }[]; skipped: string[] } }
    expect(body.data.restored.map((r) => r.id)).toEqual(['ap_f1'])
    expect(body.data.skipped).toEqual(['ap_self'])
    expect(reopened).toEqual(['ap_f1'])
  })

  it('事后补理由：带头那张记原话，跟着的记「跟着〈X〉：理由」', async () => {
    const { h, annotated } = await env()
    const res = await h.post('/v1/approvals/ap_lead/reason', {
      reason: '不相关',
      follower_ids: ['ap_f1', 'ap_self'],
    })
    expect(res.status).toBe(200)
    expect(annotated).toEqual([
      { id: 'ap_lead', reason: '不相关' },
      { id: 'ap_f1', reason: '跟着「回复 Anna」：不相关' },
    ])
    expect((await h.post('/v1/approvals/ap_lead/reason', { reason: '' })).status).toBe(400)
  })
})
