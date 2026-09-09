/**
 * 入站队列 / 去重表 / 受控原始材料区的**契约一致性套件**（WP18）：
 * 接受任意实现，对内存档与 SQLite 档各跑一遍。18 §2.2「去重 / 死信 / 重试要落盘」。
 */
import type { InboundEvent } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { DedupeStore } from '../src/pipeline.js'
import type { DeadLetterRecord, QueueItem, QueueStore } from '../src/queue.js'
import type { RawRecord, RawStore } from '../src/raw-store.js'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')

export function inbound(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    id: 'in_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    channel: 'email',
    direction: 'inbound',
    received_at: '2026-09-07T09:00:00.000Z',
    dedupe_key: 'dk_1',
    parts: [{ type: 'text', text: 'hello' }],
    raw_ref: 'raw://inbound/email/message/1',
    routing: { role_id: 'dtc.aftersales', confidence: 0.6 },
    secrets_scrubbed: false,
    ...over,
  } as InboundEvent
}

export function queueItem(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'q_1',
    lane: 'ws_1:dtc.aftersales',
    workspace_id: 'ws_1',
    role_id: 'dtc.aftersales',
    event: inbound(),
    attempts: 0,
    next_at_ms: T0,
    ...over,
  }
}

const dead = (over: Partial<DeadLetterRecord> = {}): DeadLetterRecord => ({
  id: 'dl_1',
  lane: 'ws_1:owner',
  workspace_id: 'ws_1',
  event: inbound(),
  reason: 'no_route',
  attempts: 0,
  at_ms: T0,
  ...over,
})

export interface QueueHarness {
  name: string
  make(): QueueStore
  dispose?(store: QueueStore): void
}

export function runQueueConformance(h: QueueHarness): void {
  const live: QueueStore[] = []
  const make = (): QueueStore => {
    const s = h.make()
    live.push(s)
    return s
  }
  afterEach(() => {
    for (const s of live.splice(0)) h.dispose?.(s)
  })

  describe(`QueueStore 契约一致性 · ${h.name}`, () => {
    it('put / all：往返一致，可选字段可省', async () => {
      const s = make()
      await s.put(queueItem())
      await s.put(queueItem({ id: 'q_2', role_id: undefined, last_error: 'boom' }))
      const all = await s.all()
      expect(all.map((i) => i.id)).toEqual(['q_1', 'q_2'])
      expect(all[0]).toEqual(queueItem())
      expect(all[1]?.role_id).toBeUndefined()
      expect(all[1]?.last_error).toBe('boom')
    })

    it('put：同 id 再写是更新（退避重排），不是新增', async () => {
      const s = make()
      await s.put(queueItem())
      await s.put(queueItem({ attempts: 2, next_at_ms: T0 + 5000 }))
      const all = await s.all()
      expect(all).toHaveLength(1)
      expect(all[0]?.attempts).toBe(2)
      expect(all[0]?.next_at_ms).toBe(T0 + 5000)
    })

    it('remove：删掉就没了；删不存在的不抛', async () => {
      const s = make()
      await s.put(queueItem())
      await s.remove('q_1')
      expect(await s.all()).toEqual([])
      await expect(Promise.resolve(s.remove('q_none'))).resolves.toBeUndefined()
    })

    it('due：只出到期的，按 next_at_ms 升序', async () => {
      const s = make()
      await s.put(queueItem({ id: 'q_late', next_at_ms: T0 + 10_000 }))
      await s.put(queueItem({ id: 'q_soon', next_at_ms: T0 + 1000 }))
      await s.put(queueItem({ id: 'q_now', next_at_ms: T0 }))
      expect((await s.due(T0)).map((i) => i.id)).toEqual(['q_now'])
      expect((await s.due(T0 + 1000)).map((i) => i.id)).toEqual(['q_now', 'q_soon'])
      expect((await s.due(T0 + 10_000)).map((i) => i.id)).toEqual(['q_now', 'q_soon', 'q_late'])
    })

    it('claim：领走的打上租约，同一时刻不会被第二次领到', async () => {
      const s = make()
      await s.put(queueItem({ id: 'q_1' }))
      await s.put(queueItem({ id: 'q_2' }))
      const first = await s.claim(T0, 30_000)
      expect(first.map((i) => i.id)).toEqual(['q_1', 'q_2'])
      expect(first[0]?.lease_until_ms).toBe(T0 + 30_000)
      expect(await s.claim(T0, 30_000)).toEqual([])
      expect(await s.due(T0)).toEqual([])
      // 租约没过期之前一直不可领
      expect(await s.claim(T0 + 29_999, 30_000)).toEqual([])
    })

    it('claim：租约过期后这条回到可领取状态（处理方崩在半路）', async () => {
      const s = make()
      await s.put(queueItem())
      await s.claim(T0, 30_000)
      const again = await s.claim(T0 + 30_000, 30_000)
      expect(again.map((i) => i.id)).toEqual(['q_1'])
      expect(again[0]?.attempts).toBe(0)
    })

    it('claim：limit 限制一次领几条', async () => {
      const s = make()
      await s.put(queueItem({ id: 'q_1' }))
      await s.put(queueItem({ id: 'q_2' }))
      await s.put(queueItem({ id: 'q_3' }))
      expect((await s.claim(T0, 30_000, 2)).map((i) => i.id)).toEqual(['q_1', 'q_2'])
      expect((await s.claim(T0, 30_000)).map((i) => i.id)).toEqual(['q_3'])
    })

    it('claim：未到期的不领', async () => {
      const s = make()
      await s.put(queueItem({ next_at_ms: T0 + 1000 }))
      expect(await s.claim(T0, 30_000)).toEqual([])
      expect((await s.claim(T0 + 1000, 30_000)).map((i) => i.id)).toEqual(['q_1'])
    })

    it('put 清租约：退避重排后这条立刻回到「等到期」', async () => {
      const s = make()
      await s.put(queueItem())
      const [claimed] = await s.claim(T0, 30_000)
      if (!claimed) throw new Error('没领到')
      const { lease_until_ms: _l, ...rest } = claimed
      await s.put({ ...rest, attempts: 1, next_at_ms: T0 + 1000, last_error: 'boom' })
      const all = await s.all()
      expect(all[0]?.lease_until_ms).toBeUndefined()
      expect((await s.claim(T0 + 1000, 30_000)).map((i) => i.id)).toEqual(['q_1'])
    })

    it('putDead / deadLetters：按 workspace 过滤，按进入顺序，带原因与最后一次错误', async () => {
      const s = make()
      await s.putDead(dead())
      await s.putDead(
        dead({
          id: 'dl_2',
          reason: 'retries_exhausted',
          attempts: 5,
          last_error: 'boom',
          at_ms: T0 + 1,
        }),
      )
      await s.putDead(dead({ id: 'dl_3', workspace_id: 'ws_2' }))
      const list = await s.deadLetters('ws_1')
      expect(list.map((d) => d.id)).toEqual(['dl_1', 'dl_2'])
      expect(list[0]?.reason).toBe('no_route')
      expect(list[1]).toMatchObject({ attempts: 5, last_error: 'boom' })
      expect((await s.deadLetters('ws_2')).map((d) => d.id)).toEqual(['dl_3'])
      expect(await s.deadLetters('ws_none')).toEqual([])
    })

    it('死信与队列是两张账：进死信不影响队列', async () => {
      const s = make()
      await s.put(queueItem())
      await s.putDead(dead())
      expect((await s.all()).map((i) => i.id)).toEqual(['q_1'])
      expect((await s.deadLetters('ws_1')).map((d) => d.id)).toEqual(['dl_1'])
    })
  })
}

export interface DedupeHarness {
  name: string
  make(): DedupeStore
  dispose?(store: DedupeStore): void
}

export function runDedupeConformance(h: DedupeHarness): void {
  const live: DedupeStore[] = []
  const make = (): DedupeStore => {
    const s = h.make()
    live.push(s)
    return s
  }
  afterEach(() => {
    for (const s of live.splice(0)) h.dispose?.(s)
  })

  describe(`DedupeStore 契约一致性 · ${h.name}`, () => {
    it('set / get：往返一致；没见过的返回 undefined', async () => {
      const s = make()
      expect(await s.get('dk_1')).toBeUndefined()
      await s.set('dk_1', { at_ms: T0, event: inbound() })
      expect(await s.get('dk_1')).toEqual({ at_ms: T0, event: inbound() })
    })

    it('set：同键重写是覆盖', async () => {
      const s = make()
      await s.set('dk_1', { at_ms: T0, event: inbound() })
      await s.set('dk_1', { at_ms: T0 + 5, event: inbound({ id: 'in_2' }) })
      expect((await s.get('dk_1'))?.at_ms).toBe(T0 + 5)
      expect((await s.get('dk_1'))?.event.id).toBe('in_2')
    })

    it('prune：丢窗口外的，留窗口内的（24h 窗口）', async () => {
      const s = make()
      await s.set('old', { at_ms: T0, event: inbound() })
      await s.set('new', { at_ms: T0 + 1000, event: inbound({ id: 'in_2' }) })
      await s.prune(T0 + 1000)
      expect(await s.get('old')).toBeUndefined()
      expect(await s.get('new')).toBeDefined()
    })

    it('prune 空表不抛', async () => {
      await expect(Promise.resolve(make().prune(T0))).resolves.toBeUndefined()
    })
  })
}

export interface RawHarness {
  name: string
  make(): RawStore
  dispose?(store: RawStore): void
}

const rawInput = (over: Partial<Omit<RawRecord, 'ref'>> = {}): Omit<RawRecord, 'ref'> => ({
  channel: 'email',
  kind: 'message',
  stored_at: '2026-09-07T09:00:00.000Z',
  payload: 'From: a@example.com\r\n\r\nhello',
  ...over,
})

export function runRawConformance(h: RawHarness): void {
  const live: RawStore[] = []
  const make = (): RawStore => {
    const s = h.make()
    live.push(s)
    return s
  }
  afterEach(() => {
    for (const s of live.splice(0)) h.dispose?.(s)
  })

  describe(`RawStore 契约一致性 · ${h.name}`, () => {
    it('put 回一个 ref，get 按 ref 取回原样；ref 形如 raw://inbound/<channel>/<kind>/<n>', async () => {
      const s = make()
      const ref = await s.put(rawInput())
      expect(ref).toMatch(/^raw:\/\/inbound\/email\/message\/\d+$/)
      expect(await s.get(ref)).toMatchObject({ ref, channel: 'email', kind: 'message' })
      expect((await s.get(ref))?.payload).toBe(rawInput().payload)
    })

    it('put：每条一个新 ref，不覆盖', async () => {
      const s = make()
      const a = await s.put(rawInput())
      const b = await s.put(rawInput())
      expect(a).not.toBe(b)
      expect(await s.get(a)).toBeDefined()
      expect(await s.get(b)).toBeDefined()
    })

    it('附件字节按二进制存取；mime / name 带回', async () => {
      const s = make()
      const bytes = new Uint8Array([1, 2, 3, 250])
      const ref = await s.put(
        rawInput({ kind: 'attachment', payload: bytes, mime: 'image/png', name: 'a.png' }),
      )
      const got = await s.get(ref)
      expect(got?.payload).toBeInstanceOf(Uint8Array)
      expect(Array.from((got?.payload ?? []) as Uint8Array)).toEqual([1, 2, 3, 250])
      expect(got).toMatchObject({ mime: 'image/png', name: 'a.png' })
    })

    it('get：不存在的 ref 返回 undefined', async () => {
      expect(await make().get('raw://nope')).toBeUndefined()
    })

    it('scrub：就地脱敏并标 secrets_scrubbed；二进制不动；不存在的 ref 抛 not_found', async () => {
      const s = make()
      const ref = await s.put(rawInput({ payload: 'token=sk_live_123' }))
      await s.scrub?.(ref, (t) => t.replace('sk_live_123', '[REDACTED]'))
      const got = await s.get(ref)
      expect(got?.payload).toBe('token=[REDACTED]')
      expect(got?.secrets_scrubbed).toBe(true)

      const bin = await s.put(rawInput({ kind: 'attachment', payload: new Uint8Array([9]) }))
      await s.scrub?.(bin, () => 'x')
      const binGot = await s.get(bin)
      expect(Array.from((binGot?.payload ?? []) as Uint8Array)).toEqual([9])

      // 同步抛或返回 rejected promise 都算（两档实现都同步抛）
      await expect((async () => s.scrub?.('raw://nope', (t) => t))()).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it('scrub 幂等：洗两遍结果一样', async () => {
      const s = make()
      const ref = await s.put(rawInput({ payload: 'token=sk_live_123' }))
      const redact = (t: string): string => t.replace('sk_live_123', '[REDACTED]')
      await s.scrub?.(ref, redact)
      await s.scrub?.(ref, redact)
      expect((await s.get(ref))?.payload).toBe('token=[REDACTED]')
    })
  })
}
