/**
 * WP271（docs/95 §7 A，决策 222 / 232 / 234）：组织的「模式」——① 个人 / ② 同事互联 / ③ 公司集体。
 *
 * 走真装配线（路由 → `OrganizationsPort` → 身份层组织面），覆盖：
 * - 新装 = ① 个人，「让同事找到我」默认关；一个人两个品牌仍是 ①（不再看品牌数）
 * - 第二个人进来（组织成员）自动到 ②；③ 只能有人主动开（这一单不做开的界面）
 * - 老数据推断（决策 232）：没有「模式」那一格的组织，启动时按人数推一次写上——
 *   有别人 → ③（行为不变），只有本人（一人两品牌也算）→ ①、并关掉局域网发现；幂等
 * - ① 里建分配不挑范围 = 整个品牌；③ 照旧（不给就是没给）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { organizationModeOf } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-08T09:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => {
      t += 1
      return new Date(t).toISOString()
    },
  }
}

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const servers: Server[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(dbDir?: string): Promise<Server> {
  const server = await createServer({
    ...(dbDir === undefined ? {} : { dbDir }),
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com', AGENTSWS_WORKSPACE_NAME: '小店' },
    mdns: () => ({ reason: '测试里不开局域网' }),
  })
  servers.push(server)
  return server
}

async function shut(server: Server): Promise<void> {
  servers.splice(servers.indexOf(server), 1)
  await server.close()
}

async function call<T>(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T }
  return { status: res.status, ...(parsed.data === undefined ? {} : { data: parsed.data }) }
}

interface OrgRow {
  id: string
  solo: boolean
  mode: 'solo' | 'peers' | 'company'
  discoverable: boolean
  brands: number
}

async function orgOf(server: Server): Promise<OrgRow> {
  const res = await call<OrgRow[]>(server, 'GET', '/v1/orgs')
  const org = res.data?.[0]
  if (org === undefined) throw new Error('启动之后应该有一个组织')
  return org
}

const require = createRequire(import.meta.url)
type Db = {
  prepare(sql: string): {
    get(...args: unknown[]): unknown
    run(...args: unknown[]): unknown
  }
  close(): void
}
const openDb = (path: string): Db => {
  const Database = require('better-sqlite3') as new (p: string) => Db
  return new Database(path)
}

/** 把组织改回「这一格出现之前」的样子：没有模式，发现开着（老版本默认开）。 */
function makeLegacy(dir: string, org_id: string): void {
  const id = openDb(join(dir, 'identity.sqlite'))
  const row = id.prepare('SELECT json FROM organizations WHERE id = ?').get(org_id) as {
    json: string
  }
  const {
    mode: _m,
    mode_changed_at: _a,
    mode_changed_by: _b,
    ...org
  } = JSON.parse(row.json) as Record<string, unknown>
  id.prepare('UPDATE organizations SET json = ? WHERE id = ?').run(
    JSON.stringify({ ...org, discoverable: true }),
    org_id,
  )
  id.close()
}

function rawOrg(dir: string, org_id: string): Record<string, unknown> {
  const id = openDb(join(dir, 'identity.sqlite'))
  const row = id.prepare('SELECT json FROM organizations WHERE id = ?').get(org_id) as {
    json: string
  }
  id.close()
  return JSON.parse(row.json) as Record<string, unknown>
}

describe('WP271 模式的读法（organizationModeOf）', () => {
  it('存了 company 永远是 ③；solo / peers 跟人数走；没存按决策 232 推', () => {
    expect(organizationModeOf({ mode: 'company' }, 0)).toBe('company')
    expect(organizationModeOf({ mode: 'solo' }, 0)).toBe('solo')
    expect(organizationModeOf({ mode: 'solo' }, 1)).toBe('peers')
    expect(organizationModeOf({ mode: 'peers' }, 0)).toBe('solo')
    expect(organizationModeOf({}, 0)).toBe('solo')
    expect(organizationModeOf({}, 2)).toBe('company')
  })
})

describe('WP271 新装与人数', () => {
  it('新装 = ① 个人：solo、发现默认关；一个人加第二个品牌仍是 ①', async () => {
    const server = await boot()
    const org = await orgOf(server)
    expect(org.mode).toBe('solo')
    expect(org.solo).toBe(true)
    expect(org.discoverable).toBe(false)
    const added = await call(server, 'POST', `/v1/orgs/${org.id}/brands`, { name: '小店二号' })
    expect(added.status).toBe(201)
    const after = await orgOf(server)
    expect(after.brands).toBe(2)
    expect(after.mode).toBe('solo')
    expect(after.solo).toBe(true)
  })

  it('第二个人进了组织 = ② 同事互联（不会自己变成 ③）', async () => {
    const server = await boot()
    const org = await orgOf(server)
    const invited = await call(server, 'POST', `/v1/orgs/${org.id}/members`, {
      email: 'colleague@example.com',
      name: '同事',
      brands: [server.bootstrap.workspace.id],
    })
    expect(invited.status).toBe(201)
    const after = await orgOf(server)
    expect(after.mode).toBe('peers')
    expect(after.solo).toBe(false)
  })
})

describe('WP271 ① 里建分配不挑范围 = 整个品牌', () => {
  it('① 个人：不给范围的分配落成整个品牌，不再是「还没给范围」', async () => {
    const server = await boot()
    const made = await call<{ ranges: { kind: string; id: string }[] }[]>(
      server,
      'POST',
      '/v1/assignments',
      { person_id: server.bootstrap.person.id, role_id: 'dtc.support', ranges: [] },
    )
    expect(made.status).toBe(201)
    expect(made.data?.[0]?.ranges).toEqual([{ kind: 'brand', id: server.bootstrap.workspace.id }])
  })
})

describe('WP271 ② 同事互联里建分配不挑范围也 = 整个品牌', () => {
  it('第二个人进来（②）之后，不给范围的分配照样落成整个品牌', async () => {
    const server = await boot()
    const org = await orgOf(server)
    await call(server, 'POST', `/v1/orgs/${org.id}/members`, {
      email: 'colleague@example.com',
      brands: [server.bootstrap.workspace.id],
    })
    expect((await orgOf(server)).mode).toBe('peers')
    const made = await call<{ ranges: { kind: string; id: string }[] }[]>(
      server,
      'POST',
      '/v1/assignments',
      { person_id: server.bootstrap.person.id, role_id: 'dtc.support', ranges: [] },
    )
    expect(made.data?.[0]?.ranges).toEqual([{ kind: 'brand', id: server.bootstrap.workspace.id }])
  })
})

describe('WP271 老安装归档（决策 232）', () => {
  it('只有本人、两个品牌、发现开着 → ①，发现关掉；再启动不再变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp271-solo-'))
    try {
      const first = await boot(dir)
      const org = await orgOf(first)
      await call(first, 'POST', `/v1/orgs/${org.id}/brands`, { name: '小店二号' })
      await shut(first)
      makeLegacy(dir, org.id)

      const second = await boot(dir)
      const settled = await orgOf(second)
      expect(settled.mode).toBe('solo')
      expect(settled.solo).toBe(true)
      expect(settled.discoverable).toBe(false)
      const stamped = rawOrg(dir, org.id)
      expect(stamped.mode).toBe('solo')
      expect(stamped.mode_changed_by).toBeUndefined()
      await shut(second)

      // 幂等：再启动一次，模式与改的时刻都不变
      const third = await boot(dir)
      expect((await orgOf(third)).mode).toBe('solo')
      expect(rawOrg(dir, org.id).mode_changed_at).toBe(stamped.mode_changed_at)
      await shut(third)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('除本人外还有在职的人 → ③ 公司集体（行为不变、发现不动）；③ 里不给范围照旧是没给', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp271-company-'))
    try {
      const first = await boot(dir)
      const org = await orgOf(first)
      await call(first, 'POST', `/v1/orgs/${org.id}/members`, {
        email: 'colleague@example.com',
        brands: [first.bootstrap.workspace.id],
      })
      await shut(first)
      makeLegacy(dir, org.id)

      const second = await boot(dir)
      const settled = await orgOf(second)
      expect(settled.mode).toBe('company')
      expect(settled.solo).toBe(false)
      expect(settled.discoverable).toBe(true)
      const made = await call<{ ranges: unknown[] }[]>(second, 'POST', '/v1/assignments', {
        person_id: second.bootstrap.person.id,
        role_id: 'dtc.support',
        ranges: [],
      })
      expect(made.status).toBe(201)
      expect(made.data?.[0]?.ranges).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
