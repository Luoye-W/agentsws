/**
 * WP138（78 §1 #1）：向导建出来的职责有范围。
 *
 * 钉三件事：
 * 1. 向导不连店 → 新职责挂「整个品牌」（`brand` = 当前工作区），不再挂空；
 * 2. 品牌范围下 `creator.*` / `customer.*` 按 `range=assigned` 照常放行：
 *    红人职责读得到候选池、在线客服建得了试聊会话（真路由，带 X-Assignment）；
 * 3. 老数据的补挂是一次性的：只补店主自己给自己建的、要范围却一条没有的；
 *    跑过一次再重启不再动（店主后来自己清空的不会被加回去）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { WIZARD_RANGE_BACKFILL } from '../src/onboarding.js'

const T0 = '2026-09-24T09:00:00.000Z'

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

function caller(server: Server) {
  return (method: string, path: string, options: { body?: unknown; assignment?: string } = {}) => {
    const headers = new Headers({
      Authorization: `Bearer ${server.bootstrap.internalToken}`,
      'X-Assignment': options.assignment ?? server.bootstrap.ownerAssignment.id,
    })
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    return server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    )
  }
}

const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data
}

interface Applied {
  created_assignments: { id: string; role_id: string }[]
  ranges: { kind: string; id: string; label: string }[]
}

describe('WP138 向导不连店 → 职责挂整个品牌', () => {
  it('新职责的范围是整个品牌；界面上那一格是品牌名，不是工作区 id', async () => {
    const server = await boot()
    const call = caller(server)
    const ws = server.bootstrap.workspace.id
    const applied = await data<Applied>(
      await call('POST', '/v1/onboarding/apply', {
        body: { position_ids: ['kol-marketing', 'customer-care'] },
      }),
    )
    expect(applied.ranges).toHaveLength(1)
    expect(applied.ranges[0]).toMatchObject({ kind: 'brand', id: ws })
    expect(applied.ranges[0]?.label).toMatch(/^整个品牌/)
    expect(applied.ranges[0]?.label).not.toContain(ws)
    // 组织页「选范围」里也有这一项（手动分配时挑得到）
    const options = await data<{ kind: string; id: string; label: string }[]>(
      await call('GET', '/v1/org/ranges'),
    )
    expect(options).toContainEqual(expect.objectContaining({ kind: 'brand', id: ws }))
    expect(applied.created_assignments.length).toBeGreaterThan(0)
    for (const c of applied.created_assignments)
      expect(server.roles.assignments.require(c.id).ranges).toEqual([{ kind: 'brand', id: ws }])
    // 岗位清单（左栏 / 面板读的那一份）也不再是空范围
    const mine = await data<{ positions: { role_id: string; ranges: unknown[] }[] }>(
      await call('GET', '/v1/positions'),
    )
    const kol = mine.positions.find((p) => p.role_id === 'kol.instagram')
    expect(kol?.ranges).toEqual([{ kind: 'brand', id: ws }])
  })

  it('品牌范围的红人职责读得到候选池；在线客服建得了试聊会话（真路由，不 403）', async () => {
    const server = await boot()
    const call = caller(server)
    const applied = await data<Applied>(
      await call('POST', '/v1/onboarding/apply', {
        body: { position_ids: ['kol-marketing', 'customer-care'] },
      }),
    )
    const idOf = (role: string): string => {
      const found = applied.created_assignments.find((a) => a.role_id === role)
      if (found === undefined) throw new Error(`向导没建 ${role}`)
      return found.id
    }
    const pool = await call('GET', '/v1/kol/creators', { assignment: idOf('kol.instagram') })
    expect(pool.status).toBe(200)
    const chat = await call('POST', '/v1/chat/sessions', { assignment: idOf('dtc.live-chat') })
    expect(chat.status).toBe(201)
    const sessions = await call('GET', '/v1/chat/sessions', { assignment: idOf('dtc.live-chat') })
    expect(sessions.status).toBe(200)
  })

  it('对照：同一条职责范围真的是空的时候，这两条照旧 403（31 §3.1 的门没松）', async () => {
    const server = await boot()
    const call = caller(server)
    const empty = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'dtc.live-chat',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    expect((await call('POST', '/v1/chat/sessions', { assignment: empty.id })).status).toBe(403)
  })
})

describe('WP138 老数据一次性补挂', () => {
  /** 模拟「这一版之前」的库：把迁移记号删掉。 */
  const forgetMigration = (dir: string): void => {
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3') as new (
      p: string,
    ) => { prepare(sql: string): { run(...a: string[]): void }; close(): void }
    const db = new Database(join(dir, 'onboarding.sqlite'))
    db.prepare('DELETE FROM onboarding_migrations WHERE key = ?').run(WIZARD_RANGE_BACKFILL)
    db.close()
  }

  it('只补店主自己建的空范围职责；跑过一次就不再跑；手动清空的不加回去', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp138-'))
    dirs.push(dir)
    const first = await boot(dir)
    const ws = first.bootstrap.workspace.id
    const owner = first.bootstrap.person.id
    // 老向导建的：店主给自己、范围空
    const oldKol = first.roles.assignments.create({
      person_id: owner,
      workspace_id: ws,
      role_id: 'kol.instagram',
      granted_by: owner,
      ranges: [],
    })
    // 别人给的（不是向导建的）：不动
    const byOther = first.roles.assignments.create({
      person_id: owner,
      workspace_id: ws,
      role_id: 'dtc.live-chat',
      granted_by: 'p_someone_else',
      ranges: [],
    })
    // 本来就有范围的：不动
    const ranged = first.roles.assignments.create({
      person_id: owner,
      workspace_id: ws,
      role_id: 'kol.youtube',
      granted_by: owner,
      ranges: [{ kind: 'store', id: 'store_main' }],
    })
    await first.close()
    live.splice(live.indexOf(first), 1)
    forgetMigration(dir)

    const second = await boot(dir)
    expect(second.roles.assignments.require(oldKol.id).ranges).toEqual([{ kind: 'brand', id: ws }])
    expect(second.roles.assignments.require(byOther.id).ranges).toEqual([])
    expect(second.roles.assignments.require(ranged.id).ranges).toEqual([
      { kind: 'store', id: 'store_main' },
    ])
    // 不要范围的职责（店主那条）也不动
    expect(second.roles.assignments.require(second.bootstrap.ownerAssignment.id).ranges).toEqual([])
    // 幂等：同一进程里再调一次什么都不做
    expect(second.onboarding.backfillWizardRanges()).toEqual({ patched: [] })
    // 店主后来自己把范围清空了……
    second.roles.assignments.update(oldKol.id, { ranges: [] })
    await second.close()
    live.splice(live.indexOf(second), 1)

    // ……再重启也不会被加回去
    const third = await boot(dir)
    expect(third.roles.assignments.require(oldKol.id).ranges).toEqual([])
  })
})
