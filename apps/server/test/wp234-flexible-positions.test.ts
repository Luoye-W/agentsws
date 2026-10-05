/**
 * WP234（docs/54 §6）岗位弹性化，真装配线（路由 → onboarding / org / positions / learning），不打桩。
 *
 * 钉住的：
 * - 第 ③ 步交岗位清单：一个岗位装来自不同模板的职责（INMO：「Reddit 运营」= 公关 + 社媒的 Reddit）；
 *   新分配安放在它那一行上，左栏只出它，不出模板「社媒运营」「公共关系」；
 * - 「负责人」不进「我的岗位」，`common.owner` 那条分配原样在；
 * - 合并：职责、安放、事项、岗位层记忆都跟过去，两版打架的记忆两版都留；自建的那个删掉；记审计；
 * - 移动 / 拆出：只动走那条职责的事项；岗位层记忆留在原岗位；
 * - 推荐：没接上真模型就照实说（`unavailable`），不拿假话当推荐；
 * - 负责人转交：对方拿到 `common.owner`，自己那条不收回。
 */
import type { Matter, PositionInstance } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-05T01:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 234): () => number {
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

const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
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

const mine = async (): Promise<PositionInstance[]> =>
  (await dataOf<{ instances?: PositionInstance[] }>(await call('GET', '/v1/positions')))
    .instances ?? []

const events = async (type: string): Promise<Record<string, unknown>[]> => {
  const out: Record<string, unknown>[] = []
  for await (const e of server.kernel.eventLog.read({
    workspace_id: server.bootstrap.workspace.id,
  }))
    if (e.type === type) out.push(e.payload as Record<string, unknown>)
  return out
}

interface ApplyView {
  created_assignments: { id: string; role_id: string }[]
  positions?: { id: string; name: string; role_ids: string[] }[]
}

const apply = (positions: { name: string; role_ids: string[]; template_id?: string }[]) =>
  call('POST', '/v1/onboarding/apply', { position_ids: [], role_ids: [], positions }).then((r) =>
    dataOf<ApplyView>(r),
  )

const matterAt = (position_template_id: string, role_id: string, title: string): Matter =>
  server.work.createMatter({
    kind: 'adhoc',
    title,
    entry: 'position',
    position_template_id,
    role_id,
    participants: [server.bootstrap.person.id],
  })

beforeEach(async () => {
  server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
})

afterEach(async () => {
  await server.close()
})

describe('docs/54 §6.2 第 ③ 步交岗位清单', () => {
  it('INMO：「Reddit 运营」装公关与社媒两条 Reddit；左栏只出它，不出那两个模板', async () => {
    const out = await apply([{ name: 'Reddit 运营', role_ids: ['pr.reddit', 'social.reddit'] }])
    expect(out.created_assignments.map((a) => a.role_id).sort()).toEqual([
      'pr.reddit',
      'social.reddit',
    ])
    const id = out.positions?.[0]?.id ?? ''
    expect(id).toMatch(/^pos-/)
    const list = await mine()
    expect(list.map((p) => p.name.zh)).toEqual(['Reddit 运营'])
    const view = list[0]
    expect(
      view?.roles.filter((r) => r.my_assignment_id !== undefined).map((r) => r.role_id),
    ).toEqual(['pr.reddit', 'social.reddit'])
    // 起 Run 的岗位层：两条职责都在两个岗位行里，但安放说得清是哪一个
    const asg = out.created_assignments[0]?.id ?? ''
    const resolved = await dataOf<PositionInstance>(await call('GET', `/v1/positions/${asg}`))
    expect(resolved.position_id).toBe(id)
    expect((await events('onboarding.applied'))[0]?.positions).toEqual([
      { id, role_ids: ['pr.reddit', 'social.reddit'] },
    ])
  })

  it('职责全在一个模板里且带了 template_id → 复用那个岗位行，名字改成用户的', async () => {
    const out = await apply([
      { name: '客服小组', role_ids: ['dtc.support', 'amz.support'], template_id: 'customer-care' },
    ])
    expect(out.positions?.[0]?.id).toBe('customer-care')
    const list = await mine()
    expect(list.map((p) => [p.position_id, p.name.zh])).toEqual([['customer-care', '客服小组']])
  })

  it('「负责人」不进我的岗位，`common.owner` 那条分配原样在', async () => {
    await apply([{ name: '网站运营', role_ids: ['dtc.store'], template_id: 'web-ops' }])
    const list = await mine()
    expect(list.map((p) => p.position_id)).not.toContain('owner')
    const live = server.roles.assignments
      .listByPerson(server.bootstrap.person.id, { workspace_id: server.bootstrap.workspace.id })
      .filter((a) => a.revoked_at === undefined)
    expect(live.some((a) => a.role_id === 'common.owner')).toBe(true)
  })

  it('类别目录不含「负责人」与底座职责', async () => {
    const cats = await dataOf<{ id: string; roles: { id: string }[] }[]>(
      await call('GET', '/v1/onboarding/positions'),
    )
    expect(cats.map((c) => c.id)).not.toContain('owner')
    expect(
      cats.flatMap((c) => c.roles.map((r) => r.id)).filter((r) => r.startsWith('common.')),
    ).toEqual([])
  })
})

describe('docs/70 §5 推荐：没接上真模型就照实说', () => {
  it('只有 stub、又不是演示世界：unavailable + 一句人话，一条推荐都不编', async () => {
    const out = await dataOf<{ source: string; note?: string; roles: unknown[] }>(
      await call('POST', '/v1/onboarding/suggest', { text: '我们只做 Reddit，盯口碑也自己发帖' }),
    )
    expect(out.source).toBe('unavailable')
    expect(out.roles).toEqual([])
    expect(out.note).toContain('手选')
    // 原话不进日志
    const logged = await events('onboarding.suggested')
    expect(JSON.stringify(logged)).not.toContain('Reddit')
  })
})

describe('docs/54 §6.4 合并 / 移动 / 拆出', () => {
  it('合并：职责、安放、事项、岗位层记忆都跟过去；两版打架的都留；自建的删掉；记审计', async () => {
    const out = await apply([
      { name: 'Reddit 运营', role_ids: ['pr.reddit', 'social.reddit'] },
      { name: '社媒', role_ids: ['social.tiktok'], template_id: 'social-media' },
    ])
    const reddit = out.positions?.find((p) => p.name === 'Reddit 运营')?.id ?? ''
    const matter = matterAt(reddit, 'pr.reddit', '这周 Reddit 上的差评')
    const by = server.bootstrap.person.id
    await server.learning.addMemory({
      tier: 'position',
      scope_id: reddit,
      text: '发帖先看版规',
      by,
    })
    // 两边在同一段上各有一版（提升批下来的那种）
    const skill = server.skills.registry.listSkillNames()[0] ?? 'customer-care'
    for (const [owner, body] of [
      [reddit, 'Reddit 那边的说法'],
      ['social-media', '社媒这边的说法'],
    ] as const)
      await server.skills.registry.setOverlay({
        skill,
        tier: 'position',
        owner,
        ops: [{ op: 'append', section_id: 'sec_shared', body }],
        base_version: '1.0.0',
        version: 0,
      })

    const res = await dataOf<{
      moved_assignments: number
      moved_matters: number
      memory?: { moved: number; kept_both: number }
      deleted?: string
    }>(await call('POST', `/v1/org/positions/${reddit}/merge`, { into: 'social-media' }))
    expect(res).toMatchObject({ moved_assignments: 2, moved_matters: 1, deleted: reddit })
    expect(res.memory).toEqual({ moved: 1, kept_both: 1 })

    const list = await mine()
    expect(list.map((p) => p.position_id)).toEqual(['social-media'])
    expect(
      list[0]?.roles
        .filter((r) => r.my_assignment_id !== undefined)
        .map((r) => r.role_id)
        .sort(),
    ).toEqual(['pr.reddit', 'social.reddit', 'social.tiktok'])
    expect(server.work.getMatter(matter.id)?.position_template_id).toBe('social-media')

    const memory = server.learning.memoryAt({ tier: 'position', scope_id: 'social-media' })
    const bodies = memory.map((m) => m.body)
    expect(bodies).toContain('发帖先看版规')
    expect(bodies).toContain('社媒这边的说法')
    expect(bodies).toContain('Reddit 那边的说法')
    expect(memory.find((m) => m.body === 'Reddit 那边的说法')?.heading).toContain(
      '（原「Reddit 运营」）',
    )
    expect(server.learning.memoryAt({ tier: 'position', scope_id: reddit })).toEqual([])
    expect(server.org.positions().some((p) => p.id === reddit)).toBe(false)

    const audit = await events('position.merged')
    expect(audit[0]).toMatchObject({ from: reddit, into: 'social-media', moved_matters: 1 })
    expect(JSON.stringify(audit)).not.toContain('发帖先看版规')
  })

  it('拆出 + 移动：只动走那条职责的事项；岗位层记忆留在原岗位', async () => {
    await apply([
      {
        name: '社媒运营',
        role_ids: ['social.tiktok', 'social.youtube', 'social.reddit'],
        template_id: 'social-media',
      },
    ])
    const tiktokMatter = matterAt('social-media', 'social.tiktok', '下周的 TikTok 排期')
    const youtubeMatter = matterAt('social-media', 'social.youtube', 'YouTube 评论')
    await server.learning.addMemory({
      tier: 'position',
      scope_id: 'social-media',
      text: '发布前都要过一遍品牌口吻',
      by: server.bootstrap.person.id,
    })

    const split = await dataOf<{
      positions: { id: string; name: string }[]
      moved_matters: number
    }>(
      await call('POST', '/v1/org/positions/social-media/split', {
        name: '短视频',
        role_ids: ['social.tiktok'],
      }),
    )
    const shorts = split.positions.find((p) => p.name === '短视频')?.id ?? ''
    expect(split.moved_matters).toBe(1)
    expect(server.work.getMatter(tiktokMatter.id)?.position_template_id).toBe(shorts)
    expect(server.work.getMatter(youtubeMatter.id)?.position_template_id).toBe('social-media')
    expect(server.learning.memoryAt({ tier: 'position', scope_id: shorts })).toEqual([])
    expect(
      server.learning.memoryAt({ tier: 'position', scope_id: 'social-media' }).map((m) => m.body),
    ).toEqual(['发布前都要过一遍品牌口吻'])

    // 再把 YouTube 移过去
    const moved = await dataOf<{ moved_assignments: number; moved_matters: number }>(
      await call('POST', '/v1/org/positions/social-media/move-duty', {
        role_id: 'social.youtube',
        to: shorts,
      }),
    )
    expect(moved).toMatchObject({ moved_assignments: 1, moved_matters: 1 })
    const list = await mine()
    const byId = new Map(list.map((p) => [p.position_id, p]))
    const mineIn = (id: string) =>
      byId
        .get(id)
        ?.roles.filter((r) => r.my_assignment_id !== undefined)
        .map((r) => r.role_id)
    expect(mineIn(shorts)).toEqual(['social.tiktok', 'social.youtube'])
    expect(mineIn('social-media')).toEqual(['social.reddit'])
    expect((await events('position.split'))[0]).toMatchObject({
      from: 'social-media',
      to: shorts,
      role_ids: ['social.tiktok'],
    })
    expect((await events('position.duty_moved'))[0]).toMatchObject({ role_id: 'social.youtube' })
  })

  it('「负责人」不能合并、不能拆；合到自己拒', async () => {
    await apply([{ name: '网站运营', role_ids: ['dtc.store'], template_id: 'web-ops' }])
    expect((await call('POST', '/v1/org/positions/owner/merge', { into: 'web-ops' })).status).toBe(
      400,
    )
    expect(
      (await call('POST', '/v1/org/positions/web-ops/merge', { into: 'web-ops' })).status,
    ).toBe(400)
  })
})

describe('docs/54 §6.5 负责人转交', () => {
  it('对方拿到 common.owner，自己那条不收回；再转一次说「已经是」', async () => {
    const li = await server.identity.createPerson({ email: 'li@example.test', name: '李默' })
    await server.identity.addMember({
      workspace_id: server.bootstrap.workspace.id,
      person_id: li.id,
      role: 'member',
      ranges: [],
    })
    const first = await dataOf<{ already: boolean; person_name: string }>(
      await call('POST', '/v1/org/owner/transfer', { person_id: li.id }),
    )
    expect(first).toMatchObject({ already: false, person_name: '李默' })
    const holds = (person: string) =>
      server.roles.assignments
        .listByPerson(person, {
          workspace_id: server.bootstrap.workspace.id,
          role_id: 'common.owner',
        })
        .some((a) => a.revoked_at === undefined)
    expect(holds(li.id)).toBe(true)
    expect(holds(server.bootstrap.person.id)).toBe(true)
    const again = await dataOf<{ already: boolean }>(
      await call('POST', '/v1/org/owner/transfer', { person_id: li.id }),
    )
    expect(again.already).toBe(true)
    expect(await events('owner.transferred')).toHaveLength(1)
    // 卸下：有另一位负责人在才卸得下；最后一位卸不下
    const liOwner = server.roles.assignments
      .listByPerson(li.id, { workspace_id: server.bootstrap.workspace.id, role_id: 'common.owner' })
      .find((a) => a.revoked_at === undefined)
    expect((await call('DELETE', `/v1/assignments/${liOwner?.id ?? ''}`)).status).toBe(200)
    const last = await call('DELETE', `/v1/assignments/${server.bootstrap.ownerAssignment.id}`)
    expect(last.status).toBe(409)
  })
})
