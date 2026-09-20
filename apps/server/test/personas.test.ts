/**
 * WP120（69 §4）：**角色定位**——看、公司层改写、还原，以及"改完下一次运行就生效"。
 *
 * 走的是真装配线（路由 → `PersonaPort` → `apps/server/src/personas.ts` → 职责库 /
 * 岗位模板 / 事件日志），不打桩。三件事必须一起成立，少一件这一单就等于没做：
 *
 * 1. **包里的原文一个字不动**——覆盖是另存的一层，所以「还原」永远做得到（24 §1）；
 * 2. **只有 owner 改得动**——persona 是公司对外的口径，不是个人偏好；
 * 3. **每改一次记一条审计**——它进系统提示，改了它等于改了 Agent 对外说什么。
 *
 * 最后一条断言（`sections()` 改写后立刻变）是晚绑定那一半：运行时装提示时现查覆盖表，
 * 公司在右栏改完不用重启。
 */
import type { EventEnvelope, PersonaView } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { PersonaError } from '../src/personas.js'

const T0 = '2026-09-16T01:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

let server: Server
const clock = makeClock()

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

const errorOf = async (res: Response): Promise<{ code: string; message: string }> => {
  const parsed = (await res.json()) as { code?: string; message?: string }
  return { code: parsed.code ?? '', message: parsed.message ?? '' }
}

async function allEvents(): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const e of server.kernel.eventLog.read({
    workspace_id: server.bootstrap.workspace.id,
    limit: 5000,
  }))
    out.push(e)
  return out
}

/** 红人营销那条渠道职责与它的岗位（69 §0 那条亲测记录里的两个主角）。 */
const ROLE = { kind: 'role', id: 'kol.youtube' } as const
const POSITION = { kind: 'position', id: 'kol-marketing' } as const

const get = (subject: typeof ROLE | typeof POSITION) =>
  call('GET', `/v1/personas?kind=${subject.kind}&id=${subject.id}`)

beforeEach(async () => {
  server = await createServer({
    clock,
    random: () => 0.5,
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
})

afterEach(async () => {
  await server.close()
})

describe('69 §4 看：现在生效的那一份 + 包里的原文', () => {
  it('职责的定位读得到，还没被改过', async () => {
    const view = await dataOf<PersonaView>(await get(ROLE))
    expect(view.subject).toEqual(ROLE)
    expect(view.overridden).toBe(false)
    expect(view.effective).toEqual(view.packaged)
    // 包里那份的第三段——防串岗的那一句（crosswalk 那组逐条钉着原文）
    expect(JSON.stringify(view.packaged)).toContain('你不负责')
  })

  it('岗位模板的定位也读得到（两层 persona 的上半层）', async () => {
    const view = await dataOf<PersonaView>(await get(POSITION))
    expect(view.name.zh).toBe('红人营销')
    expect(JSON.stringify(view.packaged)).toContain('你不负责')
  })

  it('没有这个岗位 / 职责 → 404，不是一段空白', async () => {
    const res = await call('GET', '/v1/personas?kind=position&id=nope')
    expect(res.status).toBe(404)
    expect((await errorOf(res)).message).toContain('nope')
  })

  it('kind 写错 → 400 + 一句人话', async () => {
    const res = await call('GET', '/v1/personas?kind=department&id=kol.youtube')
    expect(res.status).toBe(400)
  })
})

describe('69 §4 改：公司层覆盖，包里的原文留着', () => {
  it('改完 `overridden` 为真、原文还在、`effective` 是新写的那一份', async () => {
    const before = await dataOf<PersonaView>(await get(ROLE))
    const res = await call('PUT', '/v1/personas', {
      body: { ...ROLE, zh: '你是谁：我们公司自己的红人打法。\n你不负责：客户的退款→客服。' },
    })
    expect(res.status).toBe(200)
    const after = await dataOf<PersonaView>(res)
    expect(after.overridden).toBe(true)
    expect(after.effective).not.toEqual(before.packaged)
    // 原文一个字没动：「还原」因此永远做得到
    expect(after.packaged).toEqual(before.packaged)
    expect(after.updated_by).toBe(server.bootstrap.person.id)
  })

  it('只改中文那一边时，英文那一份从原文补齐（不是留空）', async () => {
    const before = await dataOf<PersonaView>(await get(ROLE))
    await call('PUT', '/v1/personas', { body: { ...ROLE, zh: '你是谁：改写过的中文版。' } })
    const after = await dataOf<PersonaView>(await get(ROLE))
    /*
     * 两边都 trim 再比：`packaged` 是包里的原文（yml 的块标量带一个尾换行），
     * `effective` 是叠完覆盖、trim 过的那一份。差的就是那个换行，不是文字。
     */
    const en = (
      typeof after.effective === 'string' ? after.effective : (after.effective.en ?? '')
    ).trim()
    const packagedEn = (
      typeof before.packaged === 'string' ? before.packaged : (before.packaged.en ?? '')
    ).trim()
    expect(en).toBe(packagedEn)
    expect(en).not.toBe('')
  })

  it('两份都空 → 400（要恢复原文请用「还原」，不是清空）', async () => {
    const res = await call('PUT', '/v1/personas', { body: { ...ROLE, zh: '', en: '' } })
    expect(res.status).toBe(400)
  })

  it('还原：回到包里的原文，`overridden` 变回假', async () => {
    const before = await dataOf<PersonaView>(await get(ROLE))
    await call('PUT', '/v1/personas', { body: { ...ROLE, zh: '你是谁：改写过的版本。' } })
    const res = await call('POST', '/v1/personas/revert', { body: ROLE })
    expect(res.status).toBe(200)
    const after = await dataOf<PersonaView>(res)
    expect(after.overridden).toBe(false)
    expect(after.effective).toEqual(before.packaged)
  })

  it(
    'owner 绑着职责的分配也改得动（右栏面板挂在职责页上，绑的是那条职责的分配；e2e 钓出来的）',
    async () => {
      const duty = server.roles.assignments.create({
        person_id: server.bootstrap.person.id,
        workspace_id: server.bootstrap.workspace.id,
        role_id: 'kol.youtube',
        granted_by: server.bootstrap.person.id,
        ranges: [],
      })
      const res = await call('PUT', '/v1/personas', {
        assignment: duty.id,
        body: { ...ROLE, zh: '你是谁：职责页上改的版本。' },
      })
      expect(res.status).toBe(200)
      const reverted = await call('POST', '/v1/personas/revert', {
        assignment: duty.id,
        body: ROLE,
      })
      expect(reverted.status).toBe(200)
    },
  )

  it('不是 owner 改不动：403 + 一句人话（要个性化写在个人技能层里）', async () => {
    const other = server.roles.assignments.create({
      person_id: 'p_other',
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'dtc.support',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const res = await call('PUT', '/v1/personas', {
      assignment: other.id,
      body: { ...ROLE, zh: '你是谁：我自己的一套说法。' },
    })
    expect(res.status).toBe(403)
  })

  it('第二道门单独钉住：过了授权、但不是 owner，端口里照样拒', () => {
    expect(() =>
      server.personas.set({ subject: ROLE, text: { zh: '改一句' }, by: 'p_other' }),
    ).toThrow(PersonaError)
  })
})

describe('69 §4 审计：改一次记一条', () => {
  it('改写记 `persona.overridden`、还原记 `persona.reverted`，都带着改了谁', async () => {
    await call('PUT', '/v1/personas', { body: { ...ROLE, zh: '你是谁：改写过的版本。' } })
    await call('POST', '/v1/personas/revert', { body: ROLE })
    const ours = (await allEvents()).filter(
      (e) => e.type === 'persona.overridden' || e.type === 'persona.reverted',
    )
    expect(ours.map((e) => e.type)).toEqual(['persona.overridden', 'persona.reverted'])
    const payload = ours[0]?.payload as { subject_kind: string; subject_id: string }
    expect(payload).toEqual({ subject_kind: 'role', subject_id: 'kol.youtube' })
  })
})

describe('69 §3 接线：运行时拿到的那几段', () => {
  it('岗位在前、职责在后，两段都带着「你不负责」', () => {
    const sections = server.personas.sections({
      role_id: 'kol.youtube',
      position_id: 'kol-marketing',
    })
    expect(sections.map((s) => s.id)).toContain('position')
    expect(sections.map((s) => s.id)).toContain('role')
    const position = sections.find((s) => s.id === 'position')
    const role = sections.find((s) => s.id === 'role')
    expect(position?.name).toBe('红人营销')
    expect(position?.order ?? 0).toBeLessThan(role?.order ?? 0)
    expect(position?.text).toContain('你不负责')
    expect(role?.text).toContain('你不负责')
  })

  it('不给岗位（反查不出唯一那一个）就整段不出（54 §3「不猜一个」）', () => {
    const sections = server.personas.sections({ role_id: 'common.member' })
    expect(sections.map((s) => s.id)).not.toContain('position')
  })

  it('**改写完下一次运行就是新的那一份**——晚绑定，不用重启', async () => {
    const before = server.personas
      .sections({ role_id: 'kol.youtube', position_id: 'kol-marketing' })
      .find((s) => s.id === 'role')?.text
    await call('PUT', '/v1/personas', { body: { ...ROLE, zh: '你是谁：公司改写后的红人打法。' } })
    const after = server.personas
      .sections({ role_id: 'kol.youtube', position_id: 'kol-marketing' })
      .find((s) => s.id === 'role')?.text
    expect(after).toBe('你是谁：公司改写后的红人打法。')
    expect(after).not.toBe(before)
    // 岗位那一段没被这次改写碰到
    expect(
      server.personas
        .sections({ role_id: 'kol.youtube', position_id: 'kol-marketing' })
        .find((s) => s.id === 'position')?.text,
    ).toContain('你不负责')
  })
})
