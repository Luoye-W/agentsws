/**
 * SQLite 档独有的性质：重启保持、并发领取不重复、租约过期回队、迁移幂等、保留期与随主体删除，
 * 以及整条入站管线跑在 SQLite 档上（去重 / 重试 / 死信跨重启都在）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InboundEvent } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EmailChannelAdapter } from '../src/email/adapter.js'
import { ChannelInboundPipeline } from '../src/pipeline.js'
import {
  createSqliteChannelStores,
  SqliteDedupeStore,
  SqliteQueueStore,
} from '../src/sqlite-queue.js'
import { createSqliteRawStore, SqliteRawStore } from '../src/sqlite-raw-store.js'
import {
  FakeClock,
  MemoryEventSink,
  MemoryMailSource,
  RecordingMailer,
  rawEmail,
} from './helpers.js'
import { inbound, queueItem } from './store-conformance.js'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')
const WS = 'ws_1'

describe('SQLite 档 · 落盘特性（渠道）', () => {
  let dir = ''
  const open: { close(): void }[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-channels-'))
  })
  afterEach(() => {
    for (const s of open.splice(0)) s.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const track = <T extends { close(): void }>(s: T): T => {
    open.push(s)
    return s
  }

  it('队列：重启后待处理项、重试次数、退避时间、死信都还在', async () => {
    const dbPath = join(dir, 'channels.sqlite')
    const first = new SqliteQueueStore({ dbPath })
    first.put(queueItem({ id: 'q_1', attempts: 2, next_at_ms: T0 + 4000, last_error: 'boom' }))
    first.putDead({
      id: 'dl_1',
      lane: 'ws_1:owner',
      workspace_id: WS,
      event: inbound(),
      reason: 'retries_exhausted',
      attempts: 5,
      last_error: 'boom',
      at_ms: T0,
    })
    first.close()

    const second = track(new SqliteQueueStore({ dbPath }))
    const all = second.all()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ attempts: 2, next_at_ms: T0 + 4000, last_error: 'boom' })
    expect(second.deadLetters(WS)).toHaveLength(1)
    expect(second.deadLetters(WS)[0]?.reason).toBe('retries_exhausted')
  })

  it('队列：两个连接并发领取，同一条只会被一边拿到', () => {
    const dbPath = join(dir, 'channels.sqlite')
    const a = track(new SqliteQueueStore({ dbPath }))
    const b = track(new SqliteQueueStore({ dbPath }))
    for (const id of ['q_1', 'q_2', 'q_3']) a.put(queueItem({ id }))

    const first = a.claim(T0, 30_000, 2)
    const second = b.claim(T0, 30_000, 2)
    expect(first.map((i) => i.id)).toEqual(['q_1', 'q_2'])
    expect(second.map((i) => i.id)).toEqual(['q_3'])
    const ids = [...first, ...second].map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(b.claim(T0, 30_000)).toEqual([])
  })

  it('队列：领取方崩在半路（不删不改）→ 重启后租约到期，这条回到可领取', () => {
    const dbPath = join(dir, 'channels.sqlite')
    const first = new SqliteQueueStore({ dbPath })
    first.put(queueItem())
    expect(first.claim(T0, 30_000)).toHaveLength(1)
    first.close() // 进程崩了，既没删也没重排

    const second = track(new SqliteQueueStore({ dbPath }))
    expect(second.claim(T0 + 1, 30_000)).toEqual([]) // 租约还在
    expect(second.claim(T0 + 30_000, 30_000).map((i) => i.id)).toEqual(['q_1'])
  })

  it('去重表：重启后 24h 窗口内的键还在，prune 之后没了', () => {
    const dbPath = join(dir, 'channels.sqlite')
    const first = new SqliteDedupeStore({ dbPath })
    first.set('dk_1', { at_ms: T0, event: inbound() })
    first.close()

    const second = track(new SqliteDedupeStore({ dbPath }))
    expect(second.get('dk_1')?.event.id).toBe('in_1')
    expect(second.size).toBe(1)
    second.prune(T0 + 24 * 60 * 60 * 1000)
    expect(second.get('dk_1')).toBeUndefined()
  })

  it('迁移幂等：同一个库开两次不报错，版本号不重复涨；队列与去重表可共用一个连接', () => {
    const dbPath = join(dir, 'channels.sqlite')
    const stores = createSqliteChannelStores({ dbPath, clock: { now: () => 'T' } })
    open.push(stores)
    stores.queue.put(queueItem())
    stores.dedupe.set('dk_1', { at_ms: T0, event: inbound() })
    const v = stores.queue.schemaVersion
    expect(v).toBeGreaterThan(0)
    expect(stores.dedupe.database).toBe(stores.queue.database)
    // 共用连接的那两个 store 自己不关库，关库由 stores.close 负责
    stores.queue.close()
    expect(stores.queue.size).toBe(1)

    const again = track(new SqliteQueueStore({ dbPath }))
    expect(again.schemaVersion).toBe(v)
    expect(
      again.database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM _migrations').get()?.n,
    ).toBe(v)
  })

  it('原始材料区：重启后按 ref 还能取回；保留期 prune 与随主体 erase', () => {
    const dbPath = join(dir, 'raw.sqlite')
    const clock = new FakeClock()
    const first = new SqliteRawStore({ dbPath, clock })
    const ref = first.put({
      channel: 'email',
      kind: 'message',
      stored_at: clock.now(),
      payload: 'hello',
    })
    const keep = first.put({
      channel: 'email',
      kind: 'message',
      stored_at: new Date(Date.parse(clock.now()) + 10_000).toISOString(),
      payload: 'later',
    })
    first.close()

    const second = track(createSqliteRawStore({ dbPath, clock }))
    expect(second.get(ref)?.payload).toBe('hello')
    expect(second.size).toBe(2)
    expect(
      second.database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM raw').get()?.n,
    ).toBe(2)
    expect(second.schemaVersion).toBeGreaterThan(0)
    // 保留期：时钟推到 T+8s，只留最近 5 秒的 —— 第一条（T）出局，第二条（T+10s）留下
    clock.advance(8000)
    expect(second.prune(5000)).toBe(1)
    expect(second.get(ref)).toBeUndefined()
    expect(second.get(keep)).toBeDefined()
    // 随主体删除
    expect(second.erase()).toBe(0)
    expect(second.erase(keep)).toBe(1)
    expect(second.all()).toEqual([])
    // prune 没有 clock 就得显式给一个
    const noClock = track(new SqliteRawStore())
    expect(() => noClock.prune(1000)).toThrow()
    expect(noClock.prune(1000, clock)).toBe(0)
  })

  it('close 幂等；共用连接的 store 不越权关库', () => {
    const a = new SqliteQueueStore()
    a.close()
    expect(() => {
      a.close()
    }).not.toThrow()
    const shared = createSqliteChannelStores()
    open.push(shared)
    const q = new SqliteQueueStore({ database: shared.queue.database })
    q.close()
    expect(shared.queue.size).toBe(0) // 库还开着
  })
})

describe('入站管线跑在 SQLite 档上（18 §2.2）', () => {
  let dir = ''
  const open: { close(): void }[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-pipe-'))
  })
  afterEach(() => {
    for (const s of open.splice(0)) s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const makePipeline = (
    dbPath: string,
    onEvent?: (e: InboundEvent) => Promise<void>,
  ): {
    pipeline: ChannelInboundPipeline
    clock: FakeClock
    events: MemoryEventSink
    queue: SqliteQueueStore
    close(): void
  } => {
    const clock = new FakeClock()
    const stores = createSqliteChannelStores({ dbPath, clock })
    const rawStore = new SqliteRawStore({ dbPath: join(dir, 'raw.sqlite'), clock })
    const events = new MemoryEventSink()
    const pipeline = new ChannelInboundPipeline({
      clock,
      adapters: [
        new EmailChannelAdapter({
          clock,
          rawStore,
          address: 'support@shop.example',
          source: new MemoryMailSource(),
          mailer: new RecordingMailer(),
        }),
      ],
      workspace_id: WS,
      events,
      rawStore,
      queue: stores.queue,
      dedupe: stores.dedupe,
      ...(onEvent === undefined ? {} : { onEvent }),
    })
    const handle = {
      pipeline,
      clock,
      events,
      queue: stores.queue,
      close(): void {
        stores.close()
        rawStore.close()
      },
    }
    open.push(handle)
    return handle
  }

  it('去重：重启后同一封信仍然被判重（去重键落盘）', async () => {
    const dbPath = join(dir, 'channels.sqlite')
    const raw = rawEmail(1, { from: 'ann@customer.com', message_id: '<dup@mail.example>' })
    const first = makePipeline(dbPath)
    const a = await first.pipeline.ingest('email', raw, WS)
    expect(a.deduped).toBe(false)
    first.close()

    const second = makePipeline(dbPath)
    const b = await second.pipeline.ingest('email', raw, WS)
    expect(b.deduped).toBe(true)
    expect(second.events.ofType('inbound.deduped')).toHaveLength(1)
  })

  it('重试与死信：失败的项跨重启接着退避，用尽后进死信且死信也落盘', async () => {
    const dbPath = join(dir, 'channels.sqlite')
    const first = makePipeline(dbPath, async () => {
      throw new Error('下游炸了')
    })
    await first.pipeline.ingest(
      'email',
      rawEmail(1, { from: 'ann@customer.com', message_id: '<retry@mail.example>' }),
      WS,
    )
    let pending = await first.pipeline.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.attempts).toBe(1)
    first.close()

    const second = makePipeline(dbPath, async () => {
      throw new Error('还是炸')
    })
    pending = await second.pipeline.pending()
    expect(pending[0]?.attempts).toBe(1) // 重试计数跨重启保持
    // 一直推到重试用尽
    for (let i = 0; i < 8; i += 1) {
      second.clock.advance(60 * 60_000)
      await second.pipeline.pump()
    }
    expect(await second.pipeline.pending()).toEqual([])
    const dead = await second.pipeline.deadLetterRecords(WS)
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ reason: 'retries_exhausted', attempts: 5 })
    second.close()

    const third = makePipeline(dbPath)
    expect(await third.pipeline.deadLetters(WS)).toHaveLength(1)
    expect(await third.pipeline.deadLetters('ws_other')).toEqual([])
  })

  it('无路由：直接进死信，重启后还在', async () => {
    const dbPath = join(dir, 'channels.sqlite')
    const rig = makePipeline(dbPath)
    // 默认路由只认 email → 用一个路由不出职责的管线
    const stores = createSqliteChannelStores({ dbPath: join(dir, 'other.sqlite') })
    open.push(stores)
    const clock = new FakeClock()
    const rawStore = new SqliteRawStore({ dbPath: join(dir, 'other-raw.sqlite'), clock })
    open.push(rawStore)
    const pipeline = new ChannelInboundPipeline({
      clock,
      adapters: [
        new EmailChannelAdapter({
          clock,
          rawStore,
          address: 'support@shop.example',
          source: new MemoryMailSource(),
          mailer: new RecordingMailer(),
        }),
      ],
      workspace_id: WS,
      rawStore,
      queue: stores.queue,
      dedupe: stores.dedupe,
      route: () => ({ confidence: 0 }),
    })
    await pipeline.ingest('email', rawEmail(1, { from: 'ann@customer.com' }), WS)
    expect(await pipeline.deadLetters(WS)).toHaveLength(1)
    expect((await pipeline.deadLetterRecords(WS))[0]?.reason).toBe('no_route')
    expect(await rig.pipeline.deadLetters(WS)).toEqual([]) // 两张库互不影响
  })
})
