/**
 * WP414：同类卡跟着前一个决定（网关这一层；10-19 更正：以理由为准）。
 *
 * - 「不要 / 稍后」**没给理由**：只处理这一张，一张都不带；
 * - 给了理由：理由 + 候选卡交给 `judgeByReason`（AI 逐张判），判为是的照办，每张记 `followed`，
 *   账本一条 `approval.followed`（带理由）；事后补理由（`/reason`）那一刻才去找；
 * - 「通过 / 发送」：**绝不自动做**，只把同类列回去；
 * - 不在那几种卡里 / 没装相似度：不跟；
 * - 撤回只认「跟着这张、本人那一下带动」的；事后补理由连跟着的一起补。
 */
import type { ApprovalItem, DecideInput } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  followDecision,
  followReason,
  type ReasonJudgeInput,
  type SimilarCard,
} from '../src/card-follow.js'
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

/** 按理由判的替身：记下拿到的理由与候选，候选全判「是」。 */
function judgeAll(why: string): {
  judgeByReason: NonNullable<GatewayDeps['judgeByReason']>
  calls: ReasonJudgeInput[]
} {
  const calls: ReasonJudgeInput[] = []
  return {
    calls,
    judgeByReason: async (input) => {
      calls.push(input)
      return input.pool.map((c): SimilarCard => ({ id: c.id, why, basis: ['same_reason'] }))
    },
  }
}

const rejected = (reason: string): ApprovalItem => {
  const leader = reddit('ap_a', '回复 u/alice', 'rejected')
  leader.decision = { action: 'reject', by: 'per_me', at: 'x', via: 'workstation', reason }
  return leader
}

describe('followDecision', () => {
  it('「不要」没给理由：只处理这一张，不找同类、不带动任何一张', async () => {
    const { bus, decided } = miniBus([
      rejected('不要'),
      reddit('ap_b', '回复 u/bob'),
      reddit('ap_c', '回复 u/cat'),
    ])
    const judge = judgeAll('x')
    const out = await followDecision(
      { approvals: bus, eventLog: new FakeEventLog(), judgeByReason: judge.judgeByReason },
      {
        item: rejected('不要'),
        person_id: 'per_me',
        assignment_id: 'asg',
        action: 'reject',
        trace_id: 'tr',
      },
    )
    expect(out).toBeUndefined()
    expect(judge.calls).toEqual([])
    expect(decided).toEqual([])
  })

  it('「不要」给了理由：理由交给 AI 逐张判，判为是的一并不发，决定带 followed，账本记理由', async () => {
    const leader = rejected('不相关')
    const { bus, decided } = miniBus([
      leader,
      reddit('ap_b', '回复 u/bob'),
      reddit('ap_c', '回复 u/cat'),
    ])
    const eventLog = new FakeEventLog()
    const judge = judgeAll('也是换手机的帖子，和眼镜无关')
    const out = await followDecision(
      { approvals: bus, eventLog, judgeByReason: judge.judgeByReason },
      {
        item: leader,
        person_id: 'per_me',
        assignment_id: 'asg',
        action: 'reject',
        reason: '不相关',
        trace_id: 'tr',
      },
    )
    expect(judge.calls[0]?.reason).toBe('不相关')
    expect(judge.calls[0]?.pool.map((c) => c.id)).toEqual(['ap_b', 'ap_c'])
    expect(out?.reason).toBe('不相关')
    expect(out?.applied.map((a) => a.id)).toEqual(['ap_b', 'ap_c'])
    expect(out?.applied[0]?.title).toBe('回复 u/bob')
    expect(decided[0]?.input).toMatchObject({
      action: 'reject',
      via: 'batch',
      reason: followReason('回复 u/alice', '不相关'),
      followed: { leader_id: 'ap_a', why: '也是换手机的帖子，和眼镜无关' },
    })
    expect(eventLog.events.find((e) => e.type === 'approval.followed')?.payload).toMatchObject({
      leader_id: 'ap_a',
      action: 'reject',
      reason: '不相关',
    })
  })

  it('AI 判为「不是」的不动', async () => {
    const leader = rejected('不相关')
    const { bus, decided } = miniBus([leader, reddit('ap_b', 'B'), reddit('ap_c', 'C')])
    const out = await followDecision(
      {
        approvals: bus,
        eventLog: new FakeEventLog(),
        judgeByReason: async () => [{ id: 'ap_c', why: '一样', basis: ['same_reason'] }],
      },
      {
        item: leader,
        person_id: 'per_me',
        assignment_id: 'asg',
        action: 'reject',
        reason: '不相关',
        trace_id: 'tr',
      },
    )
    expect(out?.applied.map((a) => a.id)).toEqual(['ap_c'])
    expect(decided.map((d) => d.id)).toEqual(['ap_c'])
  })

  it('「稍后」：没理由不跟；有理由按同一个时间推迟', async () => {
    const leader = reddit('ap_a', 'A', 'deferred')
    leader.decision = {
      action: 'defer',
      by: 'per_me',
      at: 'x',
      via: 'workstation',
      defer_until: '2026-10-19T04:00:00.000Z',
    }
    const { bus, decided } = miniBus([leader, reddit('ap_b', 'B')])
    const deps = {
      approvals: bus,
      eventLog: new FakeEventLog(),
      judgeByReason: judgeAll('同样在等资料').judgeByReason,
    }
    const base = { item: leader, person_id: 'per_me', assignment_id: 'asg', trace_id: 'tr' }
    expect(await followDecision(deps, { ...base, action: 'snooze' })).toBeUndefined()
    expect(decided).toEqual([])
    await followDecision(deps, { ...base, action: 'snooze', reason: '等产品资料' })
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
      {
        item: leader,
        person_id: 'per_me',
        assignment_id: 'asg',
        action: 'approve',
        trace_id: 'tr',
      },
    )
    expect(out?.applied).toEqual([])
    expect(out?.suggested.map((s) => s.id)).toEqual(['ap_b', 'ap_c'])
    expect(decided).toEqual([])
  })

  it('没装判断 / 不在那几种卡里 / 选择题卡：不跟', async () => {
    const leader = rejected('不相关')
    const { bus } = miniBus([leader, reddit('ap_b', 'B')])
    const deps = { approvals: bus, eventLog: new FakeEventLog() }
    const base = {
      person_id: 'per_me',
      assignment_id: 'asg',
      action: 'reject' as const,
      reason: '不相关',
      trace_id: 't',
    }
    expect(await followDecision(deps, { ...base, item: leader })).toBeUndefined()
    const judged = { ...deps, judgeByReason: judgeAll('x').judgeByReason }
    const plugin = { ...leader, kind: 'official_plugin' as const }
    expect(await followDecision(judged, { ...base, item: plugin })).toBeUndefined()
    const choice = { ...leader, payload: { options: [{ id: 'a', label: 'A' }] } }
    expect(await followDecision(judged, { ...base, item: choice })).toBeUndefined()
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

  it('第一次补理由（还没跟着处理过）：按这条理由去找同类，回包带 follow', async () => {
    const { h } = await env()
    const calls: ReasonJudgeInput[] = []
    h.deps.judgeByReason = async (input) => {
      calls.push(input)
      return []
    }
    const res = await h.post('/v1/approvals/ap_lead/reason', { reason: '不相关' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { follow?: { reason?: string; applied: unknown[] } }
    }
    expect(calls[0]?.reason).toBe('不相关')
    expect(body.data.follow).toMatchObject({ reason: '不相关', applied: [] })
  })
})
