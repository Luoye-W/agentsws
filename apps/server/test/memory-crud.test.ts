/**
 * WP71（36 §10）**每一层的记忆可手改**，端到端：真装配线（路由 → `SkillsPort` →
 * `apps/server/src/learning.ts` → 技能库），不打桩。
 *
 * 钉住的六条：
 *
 * - 手动加一条 → 它出现在**本层**的记忆里，带着"手动加 · 谁 · 什么时候"；
 * - 改本层那一条 → 正文换掉，条数不变；删掉 → 真没了；
 * - **越层改被拒**：不在本人名下的那条职责，改它那一层是 403；公司层非 owner 也是 403；
 * - `GET /v1/memory` 回的 `can_edit` 与上面那条门是**同一份判据**（界面照它出按钮）；
 * - **提升仍然走提议**：手动加不是提升，"提到上一层"出的是一张待审卡、不落任何层；
 * - 手动加的那一段**真的进了下一次解析**（不是只在列表里好看）——它要能被模型吃到。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { canEditMemory } from '../src/learning.js'

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

function seeded(seed = 71): () => number {
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
/** owner 名下挂的那条职责（岗位 `web-ops` 的一条）。 */
const HELD_ROLE = 'dtc.store'
/** 没挂在 owner 名下的那条——用来证"越层改被拒"。 */
const NOT_HELD_ROLE = 'dtc.support'

interface MemoryView {
  tier: string
  scope_id?: string
  summary: string
  can_edit?: boolean
  entries: {
    id?: string
    skill: string
    section_id: string
    heading?: string
    body: string
    origin: string
    source?: string
    added_by?: string
    added_at?: string
  }[]
}

const call = async (
  method: string,
  path: string,
  /** WP71b：`token` 不给就是 owner 自己——普通成员那一组用例要带他自己那张。 */
  options: { body?: unknown; assignment?: string; token?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${options.token ?? server.bootstrap.internalToken}`)
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

const memoryAt = async (tier: string, scope_id?: string): Promise<MemoryView> =>
  dataOf<MemoryView>(
    await call(
      'GET',
      `/v1/memory?tier=${tier}${scope_id === undefined ? '' : `&scope_id=${scope_id}`}`,
    ),
  )

beforeEach(async () => {
  server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: HELD_ROLE,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP71 手动加 / 改 / 删本层的记忆', () => {
  it('加一条 → 出现在本层，带着「手动加 · 谁 · 什么时候」', async () => {
    const res = await call('POST', '/v1/memory', {
      body: { tier: 'role', scope_id: HELD_ROLE, text: '改价先看竞品同款价，差 10% 以内可以。' },
    })
    expect(res.status).toBe(201)

    const view = await memoryAt('role', HELD_ROLE)
    const hit = view.entries.find((e) => e.body.startsWith('改价先看'))
    expect(hit).toBeDefined()
    expect(hit?.source).toBe('manual')
    expect(hit?.added_by).toBe(server.bootstrap.person.id)
    expect(hit?.added_at).toBe(T0)
    // 地址是服务端给的，前端不拼
    expect(hit?.id?.startsWith(`m:role:${HELD_ROLE}:`)).toBe(true)
  })

  it('改一条：正文换掉，条数不变；删一条：真没了', async () => {
    await call('POST', '/v1/memory', {
      body: { tier: 'role', scope_id: HELD_ROLE, text: '第一版' },
    })
    const before = await memoryAt('role', HELD_ROLE)
    const id = before.entries.find((e) => e.body === '第一版')?.id ?? ''
    expect(id).not.toBe('')

    const patched = await dataOf<{ body: string }>(
      await call('PATCH', `/v1/memory/${encodeURIComponent(id)}`, { body: { text: '第二版' } }),
    )
    expect(patched.body).toBe('第二版')
    const after = await memoryAt('role', HELD_ROLE)
    expect(after.entries).toHaveLength(before.entries.length)
    expect(after.entries.some((e) => e.body === '第一版')).toBe(false)
    expect(after.entries.some((e) => e.body === '第二版')).toBe(true)

    const dropped = await call('DELETE', `/v1/memory/${encodeURIComponent(id)}`)
    expect(dropped.status).toBe(200)
    const gone = await memoryAt('role', HELD_ROLE)
    expect(gone.entries).toHaveLength(before.entries.length - 1)
    expect(gone.entries.some((e) => e.body === '第二版')).toBe(false)
  })

  it('手动加的那一段真的进了下一次解析（不是只在列表里好看）', async () => {
    await call('POST', '/v1/memory', {
      body: { tier: 'role', scope_id: HELD_ROLE, text: '库存低于 5 件的 SKU 不做促销。' },
    })
    const resolved = await server.skills.registry.resolve('customer-care', {
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: HELD_ROLE,
    })
    // 这一层的段并进了解析结果——不然模型永远吃不到用户手写的那句话
    expect(resolved?.markdown).toContain('库存低于 5 件的 SKU 不做促销。')
    expect(resolved?.layers_applied).toContain('role')
  })
})

describe('WP71 越层改被拒（改得动哪一层，看你在哪一层干活）', () => {
  it('不在本人名下的那条职责：加是 403，连读都读不到（WP71b 起）', async () => {
    const res = await call('POST', '/v1/memory', {
      body: { tier: 'role', scope_id: NOT_HELD_ROLE, text: '不该写进去的一句话' },
    })
    expect(res.status).toBe(403)
    /*
     * WP71b 把读也收进同一条线：**你在哪一层干活，就看得见哪一层**。
     * 所以这里不再是"读得到但 can_edit 是假"，而是这一层整个读不到。
     * 「真的一个字都没写进去」改成直接问库——它不经过那道门，问的是事实本身。
     */
    expect((await call('GET', `/v1/memory?tier=role&scope_id=${NOT_HELD_ROLE}`)).status).toBe(403)
    const layer = server.skills.registry.peek('customer-care', 'role', {
      workspace_id: server.bootstrap.workspace.id,
      scope_id: NOT_HELD_ROLE,
    })
    expect(layer?.sections ?? []).toHaveLength(0)
  })

  it('本人名下那一条：can_edit 为真，写得进去', async () => {
    const view = await memoryAt('role', HELD_ROLE)
    expect(view.can_edit).toBe(true)
  })

  it('岗位层：本人在这个岗位下持有一条职责就改得动', async () => {
    const res = await call('POST', '/v1/memory', {
      body: { tier: 'position', scope_id: 'web-ops', text: '网站运营这边一律先留草稿。' },
    })
    expect(res.status).toBe(201)
    const view = await memoryAt('position', 'web-ops')
    expect(view.can_edit).toBe(true)
    expect(view.entries.some((e) => e.body.startsWith('网站运营这边'))).toBe(true)
  })

  it('认不出的条目 id → 400，不是 500', async () => {
    const res = await call('PATCH', '/v1/memory/not-a-real-id', { body: { text: 'x' } })
    expect(res.status).toBe(400)
  })

  it('包层与个人层这条路根本不开（tier 就不收）', async () => {
    for (const tier of ['package', 'personal']) {
      const res = await call('POST', '/v1/memory', {
        body: { tier, scope_id: HELD_ROLE, text: 'x' },
      })
      expect(res.status).toBe(400)
    }
  })
})

describe('WP71 提升仍然走提议（手动加不是提升）', () => {
  it('「提到上一层」出的是一张待审卡，不落任何一层', async () => {
    // 先在个人层上改一段（晋升提的是个人层上改过的那几段，24 §2）
    const sections = server.skills.registry.listSections('customer-care')
    const section_id = sections[0]?.id ?? ''
    expect(section_id).not.toBe('')
    await server.skills.registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: server.bootstrap.person.id,
      ops: [{ op: 'replace', section_id, body: '想让整个岗位都照这么做的一句话' }],
      base_version: '1.0.0',
      version: 0,
    })

    const before = await memoryAt('position', 'web-ops')
    const out = await dataOf<{ accepted: boolean; approval_item_id?: string }>(
      await call('POST', '/v1/skills/customer-care/promote', {
        body: { section_ids: [section_id], to_tier: 'position', scope_id: 'web-ops' },
      }),
    )
    expect(out.accepted).toBe(true)
    expect(out.approval_item_id).toBeDefined()
    // 不批不生效：卡出来了，岗位层一个字都还没多
    const after = await memoryAt('position', 'web-ops')
    expect(after.entries).toHaveLength(before.entries.length)
  })
})

/**
 * 判据本身的单测（纯函数，不起服务进程）。
 * 端到端那几条证的是"这道门真的在路由上"，这几条证的是"门的规则本身对"。
 */
describe('WP71 canEditMemory 判据', () => {
  const positions = [
    { id: 'web-ops', roles: [{ role: 'dtc.store' }, { role: 'dtc.content' }] },
    { id: 'customer-care', roles: [{ role: 'dtc.support' }] },
  ]
  const base = { held_roles: ['dtc.store'] as string[], positions, is_owner: false }

  it('职责层：名下有才改得动', () => {
    expect(canEditMemory({ ...base, tier: 'role', scope_id: 'dtc.store' }).ok).toBe(true)
    expect(canEditMemory({ ...base, tier: 'role', scope_id: 'dtc.support' }).ok).toBe(false)
  })

  it('岗位层：在这个岗位里干活就改得动，不在就不行', () => {
    expect(canEditMemory({ ...base, tier: 'position', scope_id: 'web-ops' }).ok).toBe(true)
    expect(canEditMemory({ ...base, tier: 'position', scope_id: 'customer-care' }).ok).toBe(false)
    expect(canEditMemory({ ...base, tier: 'position', scope_id: 'no-such' }).ok).toBe(false)
  })

  it('公司层 / 部门层：只有 owner', () => {
    expect(canEditMemory({ ...base, tier: 'company' }).ok).toBe(false)
    expect(canEditMemory({ ...base, tier: 'company', is_owner: true }).ok).toBe(true)
    expect(canEditMemory({ ...base, tier: 'department', scope_id: 'd1' }).ok).toBe(false)
  })

  it('包层与个人层：owner 也不行（一个是上游的，一个是别人的私事）', () => {
    expect(canEditMemory({ ...base, tier: 'package', is_owner: true }).ok).toBe(false)
    expect(canEditMemory({ ...base, tier: 'personal', is_owner: true }).ok).toBe(false)
  })

  it('岗位 / 职责层没给 scope_id：不猜，直接拒', () => {
    expect(canEditMemory({ ...base, tier: 'role' }).ok).toBe(false)
    expect(canEditMemory({ ...base, tier: 'position' }).ok).toBe(false)
  })
})

/**
 * WP71b 第二步：**写那一侧也跟上**。
 *
 * 读换判据之后有半天时间是"看得见、改不动"——`POST` / `PATCH` / `DELETE /v1/memory`
 * 仍要 `skill.stage@workspace`，而职责模板里没有那个域。这一组用的是**真的普通成员**
 * （邀请 → 接受 → 他自己的会话 token，不是 owner 的），钉住三条：
 *
 * - 切到自己持有的 `dtc.store`：加 / 改 / 删**三样都成**；
 * - 切到不持有的那条职责：仍然 403（换判据不是拆门）；
 * - 公司层：仍然 403（制度层的东西只有 owner 改得动，14 §13.3）。
 */
describe('WP71b 普通成员改自己那一层（写也换成 canEditMemory）', () => {
  let member: { token: string; assignment: string }

  const asMember = (method: string, path: string, body?: unknown): Promise<Response> =>
    call(method, path, {
      ...(body === undefined ? {} : { body }),
      assignment: member.assignment,
      token: member.token,
    })

  beforeEach(async () => {
    const ws = server.bootstrap.workspace.id
    const invitation = await dataOf<{ url: string }>(
      await call('POST', `/v1/workspaces/${ws}/invitations`, {
        body: { email: 'li@example.com', name: '李默' },
      }),
    )
    const invite = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
    const accepted = await dataOf<{ person_id: string }>(
      await call('POST', `/v1/invitations/${encodeURIComponent(invite)}/accept`, { body: {} }),
    )
    const link = await dataOf<{ token: string }>(
      await call('POST', '/v1/auth/magic-link', { body: { email: 'li@example.com' } }),
    )
    const session = await dataOf<{ session_token: string }>(
      await call('POST', '/v1/auth/verify', { body: { token: link.token } }),
    )
    const assignment = server.roles.assignments.create({
      person_id: accepted.person_id,
      workspace_id: ws,
      role_id: HELD_ROLE,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    member = { token: session.session_token, assignment: assignment.id }
  })

  it('自己持有的那条职责：加 / 改 / 删三样都成', async () => {
    const created = await asMember('POST', '/v1/memory', {
      tier: 'role',
      scope_id: HELD_ROLE,
      text: '上架新品先留草稿，等图片齐了再人审发布。',
    })
    expect(created.status).toBe(201)
    const entry = await dataOf<{ id?: string; added_by?: string }>(created)
    const id = entry.id ?? ''
    expect(id).not.toBe('')

    const patched = await asMember('PATCH', `/v1/memory/${encodeURIComponent(id)}`, {
      text: '上架新品一律先留草稿。',
    })
    expect(patched.status).toBe(200)
    expect((await dataOf<{ body: string }>(patched)).body).toBe('上架新品一律先留草稿。')

    expect((await asMember('DELETE', `/v1/memory/${encodeURIComponent(id)}`)).status).toBe(200)
  })

  it('不持有的那条职责：仍然 403（换判据不是拆门）', async () => {
    const res = await asMember('POST', '/v1/memory', {
      tier: 'role',
      scope_id: NOT_HELD_ROLE,
      text: '不该写进去的一句话',
    })
    expect(res.status).toBe(403)
  })

  it('公司层：普通成员看得见，但仍然改不动（14 §13.3）', async () => {
    expect((await asMember('GET', '/v1/memory?tier=company')).status).toBe(200)
    const res = await asMember('POST', '/v1/memory', { tier: 'company', text: '公司层的一句话' })
    expect(res.status).toBe(403)
  })
})
