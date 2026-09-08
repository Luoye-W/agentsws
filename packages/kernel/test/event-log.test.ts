import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope } from '@agentsws/contracts'
import Database from 'better-sqlite3'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  collect,
  EVENT_SCHEMA_VERSION,
  type EventInput,
  FixedClock,
  SqliteEventLog,
  seededRandom,
} from '../src/index.js'

const WS = 'ws_demo'

function newLog(schemaVersion?: number): SqliteEventLog {
  return new SqliteEventLog({
    clock: new FixedClock('2026-09-08T09:00:00.000Z'),
    random: seededRandom(42),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  })
}

function event(over: Partial<EventInput> = {}): EventInput {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    workspace_id: WS,
    type: 'approval.created',
    actor: { kind: 'system', id: 'kernel' },
    correlation: { trace_id: 'trace_1' },
    payload: { hello: 'world' },
    ...over,
  }
}

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SqliteEventLog', () => {
  let log: SqliteEventLog

  beforeEach(() => {
    log = newLog()
  })

  describe('21 §6 用例 1：事件表 append-only', () => {
    it('UPDATE 被 SQLite 触发器拒绝', async () => {
      const e = await log.append(event())
      expect(() =>
        log.database.prepare('UPDATE events SET payload = ? WHERE id = ?').run('{}', e.id),
      ).toThrow(/append-only: UPDATE rejected/)
      const rows = await collect(log.read({ workspace_id: WS }))
      expect(rows[0]?.payload).toEqual({ hello: 'world' })
    })

    it('DELETE 被 SQLite 触发器拒绝', async () => {
      const e = await log.append(event())
      expect(() => log.database.prepare('DELETE FROM events WHERE id = ?').run(e.id)).toThrow(
        /append-only: DELETE rejected/,
      )
      expect(await collect(log.read({ workspace_id: WS }))).toHaveLength(1)
    })

    it('无差别 DELETE（整表）同样被拒', async () => {
      await log.append(event())
      expect(() => log.database.exec('DELETE FROM events')).toThrow(/append-only: DELETE rejected/)
    })
  })

  describe('21 §6 用例 2：版本与迁移器链', () => {
    it('写入旧版 schema 被拒', async () => {
      await expect(log.append(event({ schema_version: 0 }))).rejects.toThrow(
        /always written at the current schema_version 1/,
      )
      await expect(log.append(event({ schema_version: 99 }))).rejects.toThrow(
        /always written at the current schema_version 1/,
      )
    })

    it('读旧版记录经迁移器链返回最新形状', async () => {
      const v3 = newLog(3)
      v3.registerUpcaster('order.noted', 1, (payload) => {
        const p = payload as { name: string }
        return { first_name: p.name, last_name: '' }
      })
      v3.registerUpcaster('order.noted', 2, (payload) => {
        const p = payload as { first_name: string; last_name: string }
        return { full_name: `${p.first_name} ${p.last_name}`.trim() }
      })
      v3.appendHistorical(
        event({ type: 'order.noted', schema_version: 1, payload: { name: '阿罗' } }),
      )

      const [read] = await collect(v3.read({ workspace_id: WS }))
      expect(read?.schema_version).toBe(3)
      expect(read?.payload).toEqual({ full_name: '阿罗' })
      v3.close()
    })

    it('链断了就报错，不悄悄返回旧形状', async () => {
      const v2 = newLog(2)
      v2.appendHistorical(event({ schema_version: 1 }))
      await expect(collect(v2.read({ workspace_id: WS }))).rejects.toThrow(
        /no upcaster registered for approval.created@1/,
      )
      v2.close()
    })

    it('迁移器链不可覆盖，也不能注册到当前版本或更高', () => {
      const v2 = newLog(2)
      v2.registerUpcaster('t', 1, (p) => p)
      expect(() => v2.registerUpcaster('t', 1, (p) => p)).toThrow(/already registered/)
      expect(() => v2.registerUpcaster('t', 2, (p) => p)).toThrow(/must be below the current/)
      expect(() => v2.registerUpcaster('t', 0, (p) => p)).toThrow(/positive integer/)
      v2.close()
    })

    it('不接受比当前版本还新的历史导入', () => {
      expect(() => log.appendHistorical(event({ schema_version: 5 }))).toThrow(/newer than/)
      expect(() => log.appendHistorical(event({ schema_version: 0 }))).toThrow(/positive/)
    })
  })

  describe('21 §6 用例 3：信封必填项', () => {
    it('无 workspace_id 的事件被拒', async () => {
      await expect(log.append(event({ workspace_id: '' }))).rejects.toThrow(
        /requires a non-empty workspace_id/,
      )
      await expect(
        log.append(event({ workspace_id: undefined as unknown as string })),
      ).rejects.toThrow(/requires a non-empty workspace_id/)
      expect(await collect(log.read({ workspace_id: WS }))).toHaveLength(0)
    })

    it('绕过服务直连 SQL 写空 workspace_id 也被列约束拒绝', () => {
      const insert = log.database.prepare(
        'INSERT INTO events (id, schema_version, workspace_id, type, at, actor_kind, actor_id, trace_id, payload, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      expect(() => insert.run('01J0', 1, null, 'x', 'now', 'system', 'k', 't', '{}', 'h')).toThrow(
        /NOT NULL/,
      )
      expect(() => insert.run('01J0', 1, '', 'x', 'now', 'system', 'k', 't', '{}', 'h')).toThrow(
        /CHECK/,
      )
    })

    it('缺 type / actor / trace_id 一样被拒', async () => {
      await expect(log.append(event({ type: '' }))).rejects.toThrow(/non-empty type/)
      await expect(
        log.append(event({ actor: undefined as unknown as EventEnvelope['actor'] })),
      ).rejects.toThrow(/requires an actor/)
      await expect(log.append(event({ actor: { kind: 'system', id: '' } }))).rejects.toThrow(
        /non-empty actor.id/,
      )
      await expect(
        log.append(event({ correlation: undefined as unknown as EventEnvelope['correlation'] })),
      ).rejects.toThrow(/requires a correlation/)
      await expect(log.append(event({ correlation: { trace_id: '' } }))).rejects.toThrow(
        /non-empty correlation.trace_id/,
      )
    })
  })

  describe('replayRun', () => {
    it('按 ulid 序返回该运行的全部事件，且不串运行', async () => {
      const types = ['run.started', 'prompt.assembled', 'tool.call', 'run.completed']
      for (const type of types) {
        await log.append(event({ type, correlation: { trace_id: 'tr', run_id: 'run_a' } }))
        await log.append(event({ type, correlation: { trace_id: 'tr', run_id: 'run_b' } }))
      }
      const a = await collect(log.replayRun('run_a'))
      expect(a.map((e) => e.type)).toEqual(types)
      expect(a.every((e) => e.correlation.run_id === 'run_a')).toBe(true)
      expect(a.map((e) => e.id)).toEqual([...a.map((e) => e.id)].sort())
      expect(await collect(log.replayRun('run_missing'))).toHaveLength(0)
      expect(() => log.replayRunSync('')).toThrow(/non-empty run_id/)
    })
  })

  describe('read', () => {
    it('since 续传：读一半再续，无丢无重', async () => {
      const written: string[] = []
      for (let i = 0; i < 10; i++) {
        written.push((await log.append(event({ payload: { i } }))).id)
      }
      const first = await collect(log.read({ workspace_id: WS, limit: 4 }))
      expect(first.map((e) => e.id)).toEqual(written.slice(0, 4))

      const cursor = first.at(-1)?.id
      const rest = await collect(
        log.read({ workspace_id: WS, ...(cursor ? { since: cursor } : {}) }),
      )
      expect(rest.map((e) => e.id)).toEqual(written.slice(4))
      expect([...first, ...rest].map((e) => e.id)).toEqual(written)

      const tail = await collect(log.read({ workspace_id: WS, since: written.at(-1) as string }))
      expect(tail).toHaveLength(0)
    })

    it('types / run_id / workspace 过滤', async () => {
      await log.append(event({ type: 'run.started', correlation: { trace_id: 't', run_id: 'r1' } }))
      await log.append(event({ type: 'tool.call', correlation: { trace_id: 't', run_id: 'r1' } }))
      await log.append(event({ type: 'tool.call', correlation: { trace_id: 't', run_id: 'r2' } }))
      await log.append(event({ workspace_id: 'ws_other', type: 'tool.call' }))

      expect(
        (await collect(log.read({ workspace_id: WS, types: ['tool.call'] }))).map((e) => e.type),
      ).toEqual(['tool.call', 'tool.call'])
      expect(await collect(log.read({ workspace_id: WS, types: [] }))).toHaveLength(0)
      expect(await collect(log.read({ workspace_id: WS, run_id: 'r1' }))).toHaveLength(2)
      expect(await collect(log.read({ workspace_id: 'ws_other' }))).toHaveLength(1)
      expect(
        await collect(log.read({ workspace_id: WS, types: ['tool.call'], run_id: 'r2', limit: 1 })),
      ).toHaveLength(1)
    })

    it('拒绝非法过滤参数', () => {
      expect(() => log.readSync({ workspace_id: '' })).toThrow(/non-empty workspace_id/)
      expect(() => log.readSync({ workspace_id: WS, limit: -1 })).toThrow(/non-negative integer/)
      expect(() => log.readSync({ workspace_id: WS, since: '' })).toThrow(/non-empty since/)
      expect(() => log.readSync({ workspace_id: WS, types: [''] })).toThrow(/non-empty types/)
    })

    it('信封往返：subject / payload_encrypted / actor.run_id / correlation 全部保真', async () => {
      const written = await log.append(
        event({
          subject: { type: 'order', id: 'ord_1' },
          actor: { kind: 'agent', id: 'agent_1', run_id: 'run_1' },
          correlation: {
            trace_id: 'tr',
            run_id: 'run_1',
            work_item_id: 'wi_1',
            change_id: 'ch_1',
            execution_id: 'ex_1',
          },
          payload_encrypted: { key_id: 'sub_1', blob: 'AAAA' },
        }),
      )
      const [read] = await collect(log.read({ workspace_id: WS }))
      expect(read).toEqual(written)
      expect(read?.subject).toEqual({ type: 'order', id: 'ord_1' })
      expect(read?.payload_encrypted).toEqual({ key_id: 'sub_1', blob: 'AAAA' })
    })
  })

  describe('21 §1 链式校验', () => {
    it('prev_hash 串成链，verifyChain 通过', async () => {
      const a = await log.append(event())
      const b = await log.append(event())
      expect(a.prev_hash).toBeUndefined()
      expect(b.prev_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(log.verifyChain(WS)).toEqual({ ok: true })
      expect(log.verifyChain('ws_empty')).toEqual({ ok: true })
    })

    it('有人绕过应用层直接改 sqlite 文件 → verifyChain 查得出来', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentsws-eventlog-'))
      tempDirs.push(dir)
      const dbPath = join(dir, 'events.db')
      const persisted = new SqliteEventLog({
        dbPath,
        clock: new FixedClock('2026-09-08T09:00:00.000Z'),
        random: seededRandom(9),
      })
      const written = await persisted.append(event())
      persisted.close()

      // 只有把触发器 DROP 掉才改得动——正是「离线篡改」的样子；链式 hash 就是为这一步准备的。
      const raw = new Database(dbPath)
      raw.exec('DROP TRIGGER events_append_only_update')
      raw
        .prepare('UPDATE events SET payload = ? WHERE id = ?')
        .run('{"hello":"tampered"}', written.id)
      raw.close()

      const reopened = new SqliteEventLog({
        dbPath,
        clock: new FixedClock('2026-09-08T09:00:00.000Z'),
        random: seededRandom(9),
      })
      expect(reopened.verifyChain(WS)).toEqual({
        ok: false,
        broken_at: written.id,
        reason: 'stored hash does not match the payload',
      })
      reopened.close()
    })

    it('链断（导入时伪造 prev_hash）能被查出来', async () => {
      await log.append(event())
      const forged = log.appendHistorical(event({ prev_hash: 'f'.repeat(64) }))
      const result = log.verifyChain(WS)
      expect(result.ok).toBe(false)
      expect(result.broken_at).toBe(forged.id)
    })
  })

  it('拒绝非法 schemaVersion，close 幂等', () => {
    expect(() => newLog(0)).toThrow(/positive integer/)
    log.close()
    log.close()
  })
})
