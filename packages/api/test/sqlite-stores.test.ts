/**
 * SQLite 档独有的性质：重启后状态保持、TTL 清理、迁移幂等、token 只落哈希。
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_IDEMPOTENCY_TTL_MS } from '../src/idempotency.js'
import { createSqliteIdempotencyStore, SqliteIdempotencyStore } from '../src/sqlite-idempotency.js'
import { createSqliteIdentity, SqliteIdentityService } from '../src/sqlite-identity.js'
import { seeded, testClock } from './identity-conformance.js'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

const record = {
  fingerprint: 'fp_a',
  status: 201,
  body: '{"id":"chg_1"}',
  content_type: 'application/json',
  stored_at: T0,
}

describe('SQLite 档 · 落盘特性', () => {
  let dir = ''
  const open: { close(): void }[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-api-'))
  })
  afterEach(() => {
    for (const s of open.splice(0)) s.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const track = <T extends { close(): void }>(s: T): T => {
    open.push(s)
    return s
  }

  it('幂等表：重启后同键仍能重放原响应', () => {
    const dbPath = join(dir, 'idempotency.sqlite')
    const first = new SqliteIdempotencyStore({ dbPath })
    first.put('POST /v1/changes', 'k1', record)
    first.close()

    const second = track(new SqliteIdempotencyStore({ dbPath }))
    expect(second.get('POST /v1/changes', 'k1', T0 + 1000)).toEqual(record)
    expect(second.size).toBe(1)
  })

  it('幂等表：重启后过期的仍然算过期（TTL 按 stored_at 算，不按进程寿命）', () => {
    const dbPath = join(dir, 'idempotency.sqlite')
    const first = new SqliteIdempotencyStore({ dbPath })
    first.put('POST /v1/changes', 'k1', record)
    first.close()

    const second = track(new SqliteIdempotencyStore({ dbPath }))
    expect(second.get('POST /v1/changes', 'k1', T0 + DAY)).toBeUndefined()
    expect(second.size).toBe(0)
  })

  it('幂等表：缺省 TTL 是 24h；迁移幂等（同一个库开两次）', () => {
    const dbPath = join(dir, 'idempotency.sqlite')
    const first = createSqliteIdempotencyStore({ dbPath, clock: { now: () => 'T' } })
    first.put('POST /v1/changes', 'k1', record)
    expect(first.get('POST /v1/changes', 'k1', T0 + DEFAULT_IDEMPOTENCY_TTL_MS - 1)).toBeDefined()
    const v = first.schemaVersion
    first.close()
    const second = track(new SqliteIdempotencyStore({ dbPath }))
    expect(second.schemaVersion).toBe(v)
    expect(
      second.database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM _migrations').get()?.n,
    ).toBe(v)
  })

  it('身份表：重启后人 / 工作区 / 成员 / token 都在，撤销也在', async () => {
    const dbPath = join(dir, 'identity.sqlite')
    const clock = testClock()
    const first = new SqliteIdentityService({ dbPath, clock, random: seeded(7) })
    const person = await first.createPerson({ email: 'owner@example.com', name: 'Owner' })
    const workspace = await first.createWorkspace({
      name: 'default',
      owner_id: person.id,
      kind: 'personal',
    })
    const live = first.issue('internal', person.id, workspace.id)
    const dead = first.issue('api_key', person.id, workspace.id)
    first.revoke(dead.token)
    first.close()

    const second = track(createSqliteIdentity({ dbPath, clock, random: seeded(99) }))
    expect(second.schemaVersion).toBeGreaterThan(0)
    expect((await second.getPerson(person.id))?.email).toBe('owner@example.com')
    expect((await second.getWorkspace(workspace.id))?.name).toBe('default')
    expect(await second.members(workspace.id)).toHaveLength(1)
    expect(second.workspacesOf(person.id).map((w) => w.id)).toEqual([workspace.id])
    expect(await second.authenticate(live.token)).toMatchObject({ person_id: person.id })
    expect(await second.authenticate(dead.token)).toBeUndefined()
  })

  it('身份表：重启后 id 序号不撞号（序号也落盘）', async () => {
    const dbPath = join(dir, 'identity.sqlite')
    const clock = testClock()
    const first = new SqliteIdentityService({ dbPath, clock, random: seeded(7) })
    const a = await first.createPerson({ email: 'a@example.com', name: 'A' })
    first.close()
    // 同一个 seed 重开：如果序号不落盘，第二个人会拿到和 a 一样的 id
    const second = track(new SqliteIdentityService({ dbPath, clock, random: seeded(7) }))
    const b = await second.createPerson({ email: 'b@example.com', name: 'B' })
    expect(b.id).not.toBe(a.id)
  })

  it('21 §5：token 与 magic link 只落 sha256 哈希，库里没有明文', async () => {
    const svc = track(new SqliteIdentityService({ clock: testClock(), random: seeded(7) }))
    const person = await svc.createPerson({ email: 'owner@example.com', name: 'Owner' })
    const workspace = await svc.createWorkspace({
      name: 'default',
      owner_id: person.id,
      kind: 'personal',
    })
    const issued = svc.issue('api_key', person.id, workspace.id)
    const login = await svc.issueLogin('owner@example.com')

    const dump = JSON.stringify([
      svc.database.prepare('SELECT * FROM tokens').all(),
      svc.database.prepare('SELECT * FROM logins').all(),
    ])
    expect(dump).not.toContain(issued.token)
    expect(dump).not.toContain(login.token)
    expect(dump).toContain(createHash('sha256').update(issued.token).digest('hex'))
    expect(dump).toContain(createHash('sha256').update(login.token).digest('hex'))
  })

  it('身份表：magic link 用过之后重启仍然是用过的', async () => {
    const dbPath = join(dir, 'identity.sqlite')
    const clock = testClock()
    const first = new SqliteIdentityService({ dbPath, clock, random: seeded(7) })
    const person = await first.createPerson({ email: 'owner@example.com', name: 'Owner' })
    await first.createWorkspace({ name: 'default', owner_id: person.id, kind: 'personal' })
    const login = await first.issueLogin('owner@example.com')
    expect(await first.verifyLogin(login.token)).toBeDefined()
    first.close()

    const second = track(new SqliteIdentityService({ dbPath, clock, random: seeded(7) }))
    expect(await second.verifyLogin(login.token)).toBeUndefined()
  })

  it('close 幂等：两个 store 关两次都不抛', () => {
    const a = new SqliteIdempotencyStore()
    const b = new SqliteIdentityService({ clock: testClock(), random: seeded(7) })
    a.close()
    b.close()
    expect(() => {
      a.close()
      b.close()
    }).not.toThrow()
  })
})
