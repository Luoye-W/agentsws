/**
 * 54（WP69）岗位是任务主入口，端到端：真装配线（路由 → PositionEntryPort →
 * `apps/server/src/positions.ts` → 职责库 / 工作模型 / 审批总线 / 运行时），不打桩。
 *
 * 钉住的六条：
 * - 岗位实体：谁在做、展开了哪几条职责（各自的分配）、下面有多少事项
 * - 一句话交给网站运营 → 路由到店铺管理 → 起 Run，**用的是那条职责的分配**
 * - **权限不并集**：同一个人也持有客服职责，但这次 Run 那条分配上没有退款动作
 * - 拿不准 → 出选择卡，不起 Run，事项上没有职责
 * - 换职责 → 新的分配；旧 Run 一条都没动
 * - 不是自己名下的职责换不过去（换职责不是扩权的口子）
 */
import type { Assignment, Matter, MatterEvent, PositionInstance } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-15T01:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 69): () => number {
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
/** 网站运营那四条 + 客服那一条，全挂在同一个人（owner）名下。 */
const held = new Map<string, Assignment>()

const WEB_OPS_ROLES = ['dtc.store', 'dtc.content', 'dtc.email-marketing', 'dtc.fulfillment']
const CARE_ROLES = ['dtc.support']

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment ?? server.bootstrap.ownerAssignment.id)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

interface OpenView {
  matter: { id: string; title: string; entry?: string; role_id?: string }
  picked?: { role_id: string; role_name: string; assignment_id: string }
  candidates: { role_id: string; role_name: string; score: number; why: string[] }[]
  ambiguous: boolean
  reason: string
  approval_item_id?: string
  run_id?: string
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
  for (const role_id of [...WEB_OPS_ROLES, ...CARE_ROLES]) {
    held.set(
      role_id,
      server.roles.assignments.create({
        person_id: server.bootstrap.person.id,
        workspace_id: server.bootstrap.workspace.id,
        role_id,
        granted_by: server.bootstrap.person.id,
        ranges: [{ kind: 'store', id: 'store_1' }],
      }),
    )
  }
})

afterEach(async () => {
  await server.close()
})

const idOf = (role_id: string): string => {
  const a = held.get(role_id)
  if (a === undefined) throw new Error(`没挂上这条职责：${role_id}`)
  return a.id
}

describe('54 §1 岗位实体', () => {
  it('谁在做、展开了哪几条职责、各自的分配', async () => {
    const view = await dataOf<PositionInstance>(await call('GET', '/v1/positions/web-ops'))
    expect(view.position_id).toBe('web-ops')
    expect(view.name.zh).toBe('网站运营')
    expect(view.holders).toContain(server.bootstrap.person.id)
    const store = view.roles.find((r) => r.role_id === 'dtc.store')
    expect(store?.role_name).toBe('店铺管理')
    expect(store?.assignment_ids).toContain(idOf('dtc.store'))
    // 岗位上没有任何权限字段：权限一律在职责那一条分配上（05 §4）
    expect(Object.keys(view)).not.toContain('scopes')
    expect(Object.keys(view)).not.toContain('actions')
  })

  it('给的是本人持有的一条分配 id 也认（换算成它所属的岗位）', async () => {
    const view = await dataOf<PositionInstance>(
      await call('GET', `/v1/positions/${idOf('dtc.store')}`),
    )
    expect(view.position_id).toBe('web-ops')
  })
})

describe('54 §2 从岗位开一件事', () => {
  it('「把 A 商品降价 10%」→ 店铺管理 → 起 Run（用的是那条职责的分配）', async () => {
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/web-ops/matters', {
        body: { title: '把 A 商品降价 10%' },
      }),
    )
    expect(out.ambiguous).toBe(false)
    expect(out.picked?.role_id).toBe('dtc.store')
    expect(out.picked?.assignment_id).toBe(idOf('dtc.store'))
    expect(out.run_id).toBeDefined()
    expect(out.matter.entry).toBe('position')
    expect(out.matter.role_id).toBe('dtc.store')

    const matter = server.work.getMatter(out.matter.id) as Matter
    // 事项钉在**被路由到的那条分配**上，不是请求里带的 X-Assignment（owner 那条）
    expect(matter.position_id).toBe(idOf('dtc.store'))
    expect(matter.position_id).not.toBe(server.bootstrap.ownerAssignment.id)
    expect(matter.position_template_id).toBe('web-ops')
  })

  it('权限不并集：这次 Run 那条分配上没有退款动作，哪怕本人也持有客服职责', async () => {
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/web-ops/matters', {
        body: { title: '把 A 商品降价 10%' },
      }),
    )
    const used = out.picked?.assignment_id as string
    const actions = server.roles.effectiveConfig(used).actions.map((a) => a.id)
    // 它能改价——这正是被路由过来的理由
    expect(actions).toContain('stage_price_change')
    // 它**不能**退款：退款是客服那条职责的动作，同一个人持有，但不在这一条上
    expect(actions).not.toContain('stage_refund')
    const careActions = server.roles.effectiveConfig(idOf('dtc.support')).actions.map((a) => a.id)
    expect(careActions).toContain('stage_refund')
  })

  it('路由结果进事项时间线，也进事件日志（判据词与原话不进日志）', async () => {
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/web-ops/matters', {
        body: { title: '把 A 商品降价 10%' },
      }),
    )
    const timeline = server.work.store.listMatterEvents(out.matter.id, { limit: 50 })
    const routed = timeline.find((e: MatterEvent) => e.text.includes('路由到'))
    expect(routed?.ref).toEqual({ type: 'position', id: 'web-ops' })
    expect(routed?.text).toContain('店铺管理')
  })

  it('同一句话交给客服 → 网站客服（岗位不同，落到的职责就不同）', async () => {
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/customer-care/matters', {
        body: { title: '客户问退货' },
      }),
    )
    expect(out.picked?.role_id).toBe('dtc.support')
    expect(out.picked?.assignment_id).toBe(idOf('dtc.support'))
  })

  it('拿不准不猜：出一张选择卡，不起 Run，事项上还没有职责', async () => {
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/web-ops/matters', {
        body: { title: '客户问退货' },
      }),
    )
    expect(out.ambiguous).toBe(true)
    expect(out.picked).toBeUndefined()
    expect(out.run_id).toBeUndefined()
    expect(out.approval_item_id).toBeDefined()
    expect(out.candidates.length).toBeGreaterThanOrEqual(2)
    const matter = server.work.getMatter(out.matter.id) as Matter
    // 没有职责就没有权限，这一点不含糊
    expect(matter.role_id).toBeUndefined()
    expect(matter.position_id).toBeUndefined()
    const card = await server.txn.approvals.get(out.approval_item_id as string)
    expect(card?.kind).toBe('claim')
    expect((card?.options ?? []).map((o) => o.id).length).toBeGreaterThanOrEqual(2)
  })

  it('名下没有这个岗位下任何一条职责 → 开不了这里的事', async () => {
    for (const role_id of WEB_OPS_ROLES) server.roles.assignments.revoke(idOf(role_id), {})
    const res = await call('POST', '/v1/positions/web-ops/matters', {
      body: { title: '把 A 商品降价 10%' },
    })
    expect(res.status).toBe(403)
  })
})

describe('54 §2 换职责', () => {
  it('换后新的分配；旧 Run 一条都没动', async () => {
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/web-ops/matters', {
        body: { title: '把 A 商品降价 10%' },
      }),
    )
    const runsBefore = server.work.store
      .listMatterEvents(out.matter.id, { limit: 100 })
      .filter((e: MatterEvent) => e.kind === 'run')
    expect(runsBefore.length).toBeGreaterThan(0)

    const after = await dataOf<{ matter: { role_id?: string }; assignment_id: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/reroute`, {
        body: { role_id: 'dtc.content' },
      }),
    )
    expect(after.matter.role_id).toBe('dtc.content')
    expect(after.assignment_id).toBe(idOf('dtc.content'))
    const matter = server.work.getMatter(out.matter.id) as Matter
    expect(matter.position_id).toBe(idOf('dtc.content'))

    // 旧 Run 原样在那儿：它们是在店铺管理那条职责下跑的，换职责不改历史
    const runsAfter = server.work.store
      .listMatterEvents(out.matter.id, { limit: 100 })
      .filter((e: MatterEvent) => e.kind === 'run')
    expect(runsAfter.map((e) => e.run_id)).toEqual(
      expect.arrayContaining(runsBefore.map((e) => e.run_id)),
    )
    expect(runsAfter[0]?.actor.id).toBe(idOf('dtc.store'))
  })

  it('不是自己名下的职责换不过去（换职责不是扩权的口子）', async () => {
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/web-ops/matters', {
        body: { title: '把 A 商品降价 10%' },
      }),
    )
    server.roles.assignments.revoke(idOf('dtc.content'), {})
    const res = await call('POST', `/v1/matters/${out.matter.id}/reroute`, {
      body: { role_id: 'dtc.content' },
    })
    expect(res.status).toBe(403)
  })

  it('换到这个岗位里没有的职责 → 400', async () => {
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/web-ops/matters', {
        body: { title: '把 A 商品降价 10%' },
      }),
    )
    const res = await call('POST', `/v1/matters/${out.matter.id}/reroute`, {
      body: { role_id: 'dtc.support' },
    })
    expect(res.status).toBe(400)
  })
})

describe('54 §3 记忆：提到岗位 / 职责层走提议，不自动写', () => {
  it('提到岗位层 → 一张 skill_promotion 卡；批准之前那一层一个字没有', async () => {
    const skill = server.skills.registry.listSkillNames()[0] as string
    const sections = server.skills.registry.listSections(skill)
    const section_id = sections[0]?.id as string
    // 先在个人层攒一段（晋升提的是个人层已有的那几段）
    await server.skills.registry.setOverlay({
      skill,
      tier: 'personal',
      owner: server.bootstrap.person.id,
      ops: [{ op: 'replace', section_id, body: '网站运营改价先看竞品', origin: 'authored' }],
      base_version: '0.0.0',
      version: 0,
    })
    const out = await server.learning.promote({
      skill,
      section_ids: [section_id],
      to_tier: 'position',
      scope_id: 'web-ops',
      by: server.bootstrap.person.id,
    })
    expect(out.accepted).toBe(true)
    // 只是一张卡：岗位层现在还是空的
    expect(server.skills.registry.getOverlay(skill, 'position', 'web-ops')).toBeUndefined()
    expect(server.learning.memoryAt({ tier: 'position', scope_id: 'web-ops' })).toEqual([])
  })

  it('提到岗位 / 职责层不说清是哪一个 → 不收', async () => {
    const skill = server.skills.registry.listSkillNames()[0] as string
    const out = await server.learning.promote({
      skill,
      section_ids: ['sec_1'],
      to_tier: 'role',
      by: server.bootstrap.person.id,
    })
    expect(out.accepted).toBe(false)
    expect(out.reason).toContain('scope_id')
  })
})
