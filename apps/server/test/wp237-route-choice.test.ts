/**
 * WP237（Fable 10-06 在 Luoye 的 Windows 真机 0.0.0-ci.7 上实测）：合并岗位之后「走哪条职责」。
 * 真装配线（合并 → 岗位入口 → 路由 → 审批总线 → 运行时），不打桩。
 *
 * 现场：公共关系（pr.reddit）并进社媒运营（social.reddit）→ 自建「Reddit 运营」，两条都是 Luoye 的。
 * 交给它一件 Reddit 调研 → 打平 → 出了一张「认领 / 不是客户问题」的卡 → 点「认领」后什么都没发生；
 * 在事项里补一句「按 Reddit 运营这条来，开始吧」→ 跑到了负责人那条通用助手上。
 *
 * 钉住的：
 * - 打平（同一个人的两条职责）不问人：按分高的那条直接开跑，时间线上挂「换成另一条」；
 * - 一键「换成另一条」= 改派并重跑；
 * - 真拿不准（一个判据词都没命中）才出卡：按钮就是候选职责；选了 → 钉到那条、run.started；
 * - 事项页上「走 X」= 同一件事，顺手把那张卡定掉；
 * - 还没定职责时续一句话：点了名就钉那条；没点名按原话 + 这句再路由；都不行就再问——
 *   **绝不落到负责人的通用助手**。
 */
import type { ApprovalItem, Matter, MatterEvent } from '@agentsws/contracts'
import { projectCard } from '@agentsws/deck'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createPositions } from '../src/positions.js'

const T0 = '2026-10-06T12:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 237): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let positionId = ''
const held = new Map<string, string>()

const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  // 请求头上带的是**负责人**那条分配——真机上工作台就是这样发的
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

interface OpenView {
  matter: { id: string; role_id?: string }
  picked?: { role_id: string; assignment_id: string }
  ambiguous: boolean
  reason: string
  approval_item_id?: string
  run_id?: string
}

const open = async (title: string): Promise<OpenView> =>
  dataOf<OpenView>(await call('POST', `/v1/positions/${positionId}/matters`, { title }))

const timeline = (matter_id: string): MatterEvent[] => server.work.store.listMatterEvents(matter_id)

const runs = (matter_id: string): MatterEvent[] =>
  timeline(matter_id).filter((e) => e.kind === 'run')

const startedRuns = async (): Promise<Record<string, unknown>[]> => {
  const out: Record<string, unknown>[] = []
  for await (const e of server.kernel.eventLog.read({
    workspace_id: server.bootstrap.workspace.id,
  }))
    if (e.type === 'run.started') out.push({ ...(e.payload as object), subject: e.subject })
  return out
}

beforeEach(async () => {
  server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  held.clear()
  for (const role_id of ['pr.reddit', 'social.reddit']) {
    const a = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id,
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    held.set(role_id, a.id)
  }
  // 真机那一步：公司页把公共关系并进社媒运营 → 自建岗位「Reddit 运营」
  const merged = await dataOf<{ created?: string }>(
    await call('POST', '/v1/org/positions/pr/merge', { into: 'social-media' }),
  )
  positionId = merged.created ?? ''
  expect(positionId).toMatch(/^pos-/)
})

afterEach(async () => {
  await server.close()
})

describe('WP237 ① 同一个人的两条职责打平：不问人，按分高的那条开跑', () => {
  it('「Reddit 调研」→ 直接走「自家版运营」并起运行；时间线挂「换成 Reddit 营销」', async () => {
    const out = await open('帮我做一份 Reddit 调研，看看大家怎么评价我们')
    expect(out.ambiguous).toBe(false)
    expect(out.approval_item_id).toBeUndefined()
    expect(out.picked?.role_id).toBe('social.reddit')
    expect(out.run_id).toBeDefined()
    const matter = server.work.getMatter(out.matter.id) as Matter
    expect(matter.position_id).toBe(held.get('social.reddit'))

    const routed = timeline(out.matter.id).find((e) => e.actor.id === 'position_router')
    expect(routed?.text).toContain('按「自家版运营」来做的')
    expect(routed?.text).toContain('要换成「Reddit 营销」点这里')
    expect(routed?.route).toEqual({
      picked: 'social.reddit',
      options: [{ role_id: 'pr.reddit', role_name: 'Reddit 营销' }],
    })
    // 运行用的是那条职责的分配，不是请求头上负责人那条
    expect(runs(out.matter.id).map((e) => e.actor.id)).toEqual([held.get('social.reddit')])
    expect((await startedRuns()).length).toBe(1)
  })

  it('一键「换成 Reddit 营销」= 改派并重跑', async () => {
    const out = await open('帮我做一份 Reddit 调研，看看大家怎么评价我们')
    const res = await dataOf<{ matter: { role_id?: string }; run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/reroute`, {
        role_id: 'pr.reddit',
        run: true,
      }),
    )
    expect(res.matter.role_id).toBe('pr.reddit')
    expect(res.run_id).toBeDefined()
    expect(runs(out.matter.id).map((e) => e.actor.id)).toEqual([
      held.get('social.reddit'),
      held.get('pr.reddit'),
    ])
    expect((await startedRuns()).length).toBe(2)
  })
})

describe('WP237（Fable 代定）一个判据词都没命中：按岗位里职责的先后取第一条开跑', () => {
  it('「整理一下」→ 走「自家版运营」并起运行，时间线挂「换成 Reddit 营销」，不出卡', async () => {
    const out = await open('整理一下')
    expect(out.ambiguous).toBe(false)
    expect(out.approval_item_id).toBeUndefined()
    expect(out.picked?.role_id).toBe('social.reddit')
    expect(out.run_id).toBeDefined()
    const routed = timeline(out.matter.id).find((e) => e.actor.id === 'position_router')
    expect(routed?.text).toContain('看不出更像哪条，先按「自家版运营」来做的')
    expect(routed?.route).toEqual({
      picked: 'social.reddit',
      options: [{ role_id: 'pr.reddit', role_name: 'Reddit 营销' }],
    })
    expect((await startedRuns()).length).toBe(1)
  })

  it('「你好」这种不是交活的话：不起运行、不出卡，只回一句问要做什么', async () => {
    const out = await open('你好')
    expect(out.run_id).toBeUndefined()
    expect(out.approval_item_id).toBeUndefined()
    expect(server.work.getMatter(out.matter.id)?.role_id).toBeUndefined()
    const ask = timeline(out.matter.id).find((e) => e.kind === 'agent_message')
    expect(ask?.text).toContain('想让我做什么')
    expect(await startedRuns()).toEqual([])
  })
})

describe('WP237 ②③ 几条都沾一点、谁都不像才出卡；卡上按钮是候选职责；选了就开跑', () => {
  const CARE = ['amz.support', 'dtc.community-support', 'dtc.live-chat', 'dtc.support']
  const care = new Map<string, string>()
  const openCare = async (title: string): Promise<OpenView> =>
    dataOf<OpenView>(await call('POST', '/v1/positions/customer-care/matters', { title }))

  beforeEach(() => {
    care.clear()
    for (const role_id of CARE) {
      const a = server.roles.assignments.create({
        person_id: server.bootstrap.person.id,
        workspace_id: server.bootstrap.workspace.id,
        role_id,
        granted_by: server.bootstrap.person.id,
        ranges: [],
      })
      care.set(role_id, a.id)
    }
  })

  it('客服岗位四条各 0.25 → 出卡（选择题、按钮「走 X」），不起运行；事项页同样给这几个选项', async () => {
    const out = await openCare('把 A 商品降价 10%')
    expect(out.ambiguous).toBe(true)
    expect(out.run_id).toBeUndefined()
    const item = (await server.txn.approvals.get(out.approval_item_id as string)) as ApprovalItem
    const card = projectCard(item, { now: T0, position_id: '' })
    expect(card.layout).toBe('choice')
    expect(card.options?.map((o) => o.label)).toContain('走「网站客服」')
    expect(card.options?.length).toBe(4)
    const routed = timeline(out.matter.id).find((e) => e.actor.id === 'position_router')
    expect(routed?.route?.picked).toBeUndefined()
    expect(routed?.route?.options.length).toBe(4)
    expect(routed?.approval_item_id).toBe(out.approval_item_id)
    expect(await startedRuns()).toEqual([])
  })

  it('在卡上选「走 网站客服」→ 事项钉到那条，立刻 run.started', async () => {
    const out = await openCare('把 A 商品降价 10%')
    const res = await call('POST', `/v1/approvals/${out.approval_item_id}/decide`, {
      action: 'approve',
      selected_option_id: 'dtc.support',
    })
    expect(res.status).toBe(200)
    const matter = server.work.getMatter(out.matter.id) as Matter
    expect(matter.role_id).toBe('dtc.support')
    expect(matter.position_id).toBe(care.get('dtc.support'))
    expect(runs(out.matter.id).map((e) => e.actor.id)).toEqual([care.get('dtc.support')])
    expect((await startedRuns()).length).toBe(1)
  })

  it('卡上不选就按「认领」（老按钮）→ 被拒（要选一条），事项不会卡在「批了没反应」', async () => {
    const out = await openCare('把 A 商品降价 10%')
    const res = await call('POST', `/v1/approvals/${out.approval_item_id}/decide`, {
      action: 'approve',
    })
    expect(res.status).toBe(400)
  })

  it('事项页上点「走 网站客服」→ 钉到那条、开跑，那张卡跟着定掉、不重跑', async () => {
    const out = await openCare('把 A 商品降价 10%')
    const res = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/reroute`, {
        role_id: 'dtc.support',
        run: true,
      }),
    )
    expect(res.run_id).toBeDefined()
    const item = await server.txn.approvals.get(out.approval_item_id as string)
    expect(item?.state).not.toBe('pending')
    expect(runs(out.matter.id).length).toBe(1)
    expect((await startedRuns()).length).toBe(1)
  })

  it('还没定时续一句点了名的话 → 钉到那条开跑，卡跟着定掉', async () => {
    const out = await openCare('把 A 商品降价 10%')
    const said = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/messages`, { text: '按网站客服来，开始吧' }),
    )
    expect(said.run_id).toBeDefined()
    expect(runs(out.matter.id).map((e) => e.actor.id)).toEqual([care.get('dtc.support')])
    const item = await server.txn.approvals.get(out.approval_item_id as string)
    expect(item?.state).not.toBe('pending')
  })
})

describe('WP237 还没定职责时续一句话：绝不落到负责人的通用助手', () => {
  it('「按 自家版运营这条来，开始吧。」→ 钉到 自家版运营，用那条分配起运行', async () => {
    const out = await open('你好')
    const said = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/messages`, {
        text: '按 自家版运营这条来，开始吧。',
      }),
    )
    expect(said.run_id).toBeDefined()
    const matter = server.work.getMatter(out.matter.id) as Matter
    expect(matter.role_id).toBe('social.reddit')
    const actors = runs(out.matter.id).map((e) => e.actor.id)
    expect(actors).toEqual([held.get('social.reddit')])
    expect(actors).not.toContain(server.bootstrap.ownerAssignment.id)
  })

  it('没点名但这句话带出了方向 → 按原话 + 这句再路由，打平按分取', async () => {
    const out = await open('你好')
    const said = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/messages`, {
        text: '去 Reddit 上调研一下',
      }),
    )
    expect(said.run_id).toBeDefined()
    expect(server.work.getMatter(out.matter.id)?.role_id).toBe('social.reddit')
    expect(runs(out.matter.id).map((e) => e.actor.id)).toEqual([held.get('social.reddit')])
  })

  it('一个都没命中 → 按先后取第一条开跑', async () => {
    const out = await open('你好')
    const said = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/messages`, { text: '整理一下' }),
    )
    expect(said.run_id).toBeDefined()
    expect(runs(out.matter.id).map((e) => e.actor.id)).toEqual([held.get('social.reddit')])
  })

  it('又只是应一声（「嗯」）→ 只记下这句、再问一句要做什么，不起运行', async () => {
    const out = await open('你好')
    const said = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/messages`, { text: '嗯' }),
    )
    expect(said.run_id).toBeUndefined()
    expect(server.work.getMatter(out.matter.id)?.role_id).toBeUndefined()
    expect(runs(out.matter.id)).toEqual([])
    expect(await startedRuns()).toEqual([])
    expect(timeline(out.matter.id).at(-1)?.text).toContain('想让我做什么')
  })

  it('已经定了职责的事项：续话用那条分配，不用请求头上负责人那条', async () => {
    const out = await open('帮我做一份 Reddit 调研，看看大家怎么评价我们')
    await call('POST', `/v1/matters/${out.matter.id}/messages`, { text: '再补一下竞品' })
    expect(runs(out.matter.id).map((e) => e.actor.id)).toEqual([
      held.get('social.reddit'),
      held.get('social.reddit'),
    ])
  })
})

describe('WP237（Fable 代定）「换成 X」重跑之前先停掉还在跑的那次', () => {
  it('先停（原因写「已换成「X」重跑」）再起新的；不带 run 的换职责不停', async () => {
    const calls: string[] = []
    const positions = createPositions({
      workspace_id: server.bootstrap.workspace.id,
      clock: makeClock(),
      roles: server.roles,
      work: server.work,
      approvals: server.txn.approvals,
      positions: () => server.org.positions(),
      placementOf: (id) => server.org.placementOf(id),
      appendEvent: () => {},
      stopRuns: async (matter_id, reason) => {
        calls.push(`stop ${matter_id} ${reason} runs=${runs(matter_id).length}`)
        return 1
      },
    })
    const out = await open('帮我做一份 Reddit 调研，看看大家怎么评价我们')
    const person_id = server.bootstrap.person.id
    await positions.reroute({ matter_id: out.matter.id, role_id: 'pr.reddit', person_id })
    expect(calls).toEqual([])
    const res = await positions.reroute({
      matter_id: out.matter.id,
      role_id: 'social.reddit',
      person_id,
      run: true,
    })
    // 停在新运行之前（那一刻只有开事项时那一次）
    expect(calls).toEqual([`stop ${out.matter.id} 已换成「自家版运营」重跑 runs=1`])
    expect(res.run_id).toBeDefined()
    expect(runs(out.matter.id).length).toBe(2)
  })
})
