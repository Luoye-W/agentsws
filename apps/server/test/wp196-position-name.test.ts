/**
 * WP196（Luoye 09-29）：最高那个岗位默认叫「负责人」（Lead），用户可以在公司页自己改名。
 *
 * 钉四件事：
 * 1. 新工作区种出来的就是「负责人 / Lead」，岗位 id 仍是 `owner`；
 * 2. 老工作区里还停在旧出厂名（「店主 / 负责人」「店主」「Owner」）的，启动时换成新默认名——
 *    中英各判各的，用户改过的一律不动，别的岗位叫「店主」也不动，重启几次都一样；
 * 3. 只改名字（职责一条没动）：版本号与来源不变，记一条 `position.renamed` 审计；
 * 4. 改名不影响路由：岗位内路由看的是职责，改完名问「有哪些岗位和连接」照样交给同一条职责。
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { migrateOwnerPositionName, OWNER_POSITION_NAME } from '../src/org.js'

const T0 = '2026-09-29T09:00:00.000Z'

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const live: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of live.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(dbDir?: string): Promise<Server> {
  const s = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: seeded(),
    startRun: false,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  live.push(s)
  return s
}

async function shut(server: Server): Promise<void> {
  await server.close()
  live.splice(live.indexOf(server), 1)
}

function caller(server: Server) {
  return (method: string, path: string, body?: unknown) => {
    const headers = new Headers({
      Authorization: `Bearer ${server.bootstrap.internalToken}`,
      'X-Assignment': server.bootstrap.ownerAssignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
}

const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data
}

interface PositionView {
  id: string
  name: string
  name_en: string
  version: string
  source: string
  roles: { role_id: string; default: boolean }[]
}

const positionsOf = async (server: Server): Promise<PositionView[]> =>
  data<PositionView[]>(await caller(server)('GET', '/v1/org/positions'))

const ownerOf = async (server: Server): Promise<PositionView> => {
  const found = (await positionsOf(server)).find((p) => p.id === 'owner')
  if (found === undefined) throw new Error('没有 owner 岗位')
  return found
}

/** 数据目录里那份 org.sqlite（在哪一层子目录都认）。 */
function orgDbIn(dir: string): string {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'org.sqlite') return path
    if (statSync(path).isDirectory()) {
      try {
        return orgDbIn(path)
      } catch {
        // 这一层没有，接着找
      }
    }
  }
  throw new Error(`${dir} 下没有 org.sqlite`)
}

/** 直接改库里的岗位（模拟老版本留下来的数据）。 */
function writePosition(dir: string, id: string, patch: (json: Record<string, unknown>) => void) {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(orgDbIn(dir))
  const row = db.prepare('SELECT json FROM org_positions WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  const json: Record<string, unknown> =
    row === undefined
      ? {
          id,
          version: '1.0.0',
          roles: [{ role: 'common.member', default: true }],
          source: 'custom',
        }
      : (JSON.parse(row.json) as Record<string, unknown>)
  patch(json)
  db.prepare(
    'INSERT INTO org_positions (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
  ).run(id, JSON.stringify(json))
  db.close()
}

describe('WP196：默认名与老数据迁移', () => {
  it('新工作区：owner 岗位叫「负责人 / Lead」', async () => {
    const server = await boot()
    const owner = await ownerOf(server)
    expect(owner.name).toBe('负责人')
    expect(owner.name_en).toBe('Lead')
    expect(OWNER_POSITION_NAME).toEqual({ zh: '负责人', en: 'Lead' })
  })

  it('纯函数：只换逐字等于旧出厂名的那一半；别的岗位、改过的名字不动；可重复跑', () => {
    const old = { id: 'owner', name: { zh: '店主 / 负责人', en: 'Owner' } }
    const once = migrateOwnerPositionName(old)
    expect(once?.name).toEqual({ zh: '负责人', en: 'Lead' })
    expect(once === undefined ? 'x' : migrateOwnerPositionName(once)).toBeUndefined()
    expect(
      migrateOwnerPositionName({ id: 'owner', name: { zh: '店主', en: 'CEO' } })?.name,
    ).toEqual({ zh: '负责人', en: 'CEO' })
    expect(
      migrateOwnerPositionName({ id: 'owner', name: { zh: '海外业务总监', en: 'Owner' } })?.name,
    ).toEqual({ zh: '海外业务总监', en: 'Lead' })
    expect(
      migrateOwnerPositionName({ id: 'owner', name: { zh: 'CEO', en: 'CEO' } }),
    ).toBeUndefined()
    expect(
      migrateOwnerPositionName({ id: 'pos-x', name: { zh: '店主', en: 'Owner' } }),
    ).toBeUndefined()
  })

  it('老工作区：旧出厂名启动时换掉；用户改过的、别的岗位不动；重启几次都一样', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp196-'))
    dirs.push(dir)
    await shut(await boot(dir))
    writePosition(dir, 'owner', (p) => {
      p.name = { zh: '店主 / 负责人', en: 'Owner' }
    })
    writePosition(dir, 'pos-shop', (p) => {
      p.name = { zh: '店主', en: 'Owner' }
    })

    const second = await boot(dir)
    const owner = await ownerOf(second)
    expect([owner.name, owner.name_en]).toEqual(['负责人', 'Lead'])
    const other = (await positionsOf(second)).find((p) => p.id === 'pos-shop')
    expect([other?.name, other?.name_en]).toEqual(['店主', 'Owner'])
    await shut(second)

    // 用户把中文名改成了 CEO、英文还是旧的 → 只换英文
    writePosition(dir, 'owner', (p) => {
      p.name = { zh: 'CEO', en: 'Owner' }
    })
    const third = await boot(dir)
    const renamed = await ownerOf(third)
    expect([renamed.name, renamed.name_en]).toEqual(['CEO', 'Lead'])
    await shut(third)

    // 再重启：什么都不变
    const fourth = await boot(dir)
    const again = await ownerOf(fourth)
    expect([again.name, again.name_en]).toEqual(['CEO', 'Lead'])
  })
})

describe('WP196：岗位改名', () => {
  it('只改名：版本与来源不变，记一条 position.renamed；空名字拒', async () => {
    const server = await boot()
    const call = caller(server)
    const before = await ownerOf(server)
    const roles = before.roles.map((r) => ({ role_id: r.role_id, default: r.default }))
    const after = await data<PositionView>(
      await call('PUT', '/v1/org/positions/owner', {
        name: '海外业务总监',
        name_en: 'Head of International',
        roles,
      }),
    )
    expect([after.name, after.name_en]).toEqual(['海外业务总监', 'Head of International'])
    expect(after.version).toBe(before.version)
    expect(after.source).toBe(before.source)
    expect(after.id).toBe('owner')

    const events: { type: string; payload: unknown }[] = []
    for await (const e of server.kernel.eventLog.read({
      workspace_id: server.bootstrap.workspace.id,
    }))
      events.push({ type: e.type, payload: e.payload })
    expect(events.find((e) => e.type === 'position.renamed')?.payload).toEqual({
      position_id: 'owner',
      from: { zh: '负责人', en: 'Lead' },
      to: { zh: '海外业务总监', en: 'Head of International' },
    })

    // 不给英文名：英文保持原样
    const zhOnly = await data<PositionView>(
      await call('PUT', '/v1/org/positions/owner', { name: 'CEO', roles }),
    )
    expect([zhOnly.name, zhOnly.name_en]).toEqual(['CEO', 'Head of International'])

    const blank = await call('PUT', '/v1/org/positions/owner', { name: '   ', roles })
    expect(blank.status).toBe(400)
  })

  it('加减职责照旧升版本（改模板）', async () => {
    const server = await boot()
    const before = await ownerOf(server)
    const after = await data<PositionView>(
      await caller(server)('PUT', '/v1/org/positions/owner', {
        name: before.name,
        roles: [
          ...before.roles.map((r) => ({ role_id: r.role_id, default: r.default })),
          { role_id: 'common.member', default: false },
        ],
      }),
    )
    expect(after.version).not.toBe(before.version)
  })

  it('改名不影响路由：改完名在这个岗位上问岗位和连接，照样交给 common.owner', async () => {
    const server = await boot()
    const call = caller(server)
    const before = await ownerOf(server)
    await data(
      await call('PUT', '/v1/org/positions/owner', {
        name: 'CEO',
        name_en: 'CEO',
        roles: before.roles.map((r) => ({ role_id: r.role_id, default: r.default })),
      }),
    )
    const opened = await data<{ picked?: { role_id: string } }>(
      await call('POST', '/v1/positions/owner/matters', {
        title: '现在有哪些岗位和连接',
      }),
    )
    expect(opened.picked?.role_id).toBe('common.owner')
  })
})
