/**
 * WP210（Luoye 09-30）：失败的信**自动**重投，不再要人一封封点；彻底投不进的只进日志，
 * 只有客户来信最终失败才出卡（`sweepDeadLetters` 返回的 `gave_up` 里 `customer: true`）。
 */
import type { InboundEvent } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { isCustomerLetter } from '../src/dead-letter-policy.js'
import { EmailChannelAdapter } from '../src/email/adapter.js'
import { ChannelInboundPipeline } from '../src/pipeline.js'
import { autoRequeueDelayMs, DEFAULT_AUTO_REQUEUE, MemoryQueueStore } from '../src/queue.js'
import { MemoryRawStore } from '../src/raw-store.js'
import { SqliteQueueStore } from '../src/sqlite-queue.js'
import {
  FakeClock,
  MemoryEventSink,
  MemoryMailSource,
  RecordingMailer,
  rawEmail,
} from './helpers.js'

const WS = 'ws_1'
const MIN = 60_000
let seq = 0

function rig(opts: { fail: () => boolean; queue?: MemoryQueueStore | SqliteQueueStore }) {
  const clock = new FakeClock()
  const rawStore = new MemoryRawStore()
  const adapter = new EmailChannelAdapter({
    clock,
    rawStore,
    address: 'support@shop.example',
    source: new MemoryMailSource(),
    mailer: new RecordingMailer(),
  })
  const events = new MemoryEventSink()
  const delivered: InboundEvent[] = []
  const pipeline = new ChannelInboundPipeline({
    clock,
    adapters: [adapter],
    workspace_id: WS,
    events,
    rawStore,
    queue: opts.queue ?? new MemoryQueueStore(),
    // 一次就进死信，省得在测试里推五轮退避
    retry: { max_attempts: 1 },
    onEvent: async (e) => {
      if (opts.fail()) throw new Error('canonicalJson 炸了')
      delivered.push(e)
    },
  })
  return { clock, pipeline, events, delivered }
}

async function killOne(
  r: ReturnType<typeof rig>,
  from = 'Alice <alice@customer.example>',
): Promise<string> {
  seq += 1
  await r.pipeline.ingest(
    'email',
    rawEmail(seq, {
      from,
      subject: '我的订单呢',
      text: '三天了还没发货',
      message_id: `<m${seq}@x>`,
    }),
    WS,
  )
  const dead = await r.pipeline.deadLetterRecords(WS)
  expect(dead).toHaveLength(1)
  return dead[0]?.id ?? ''
}

describe('死信自动重投（WP210）', () => {
  it('修好之后自己回来：到点自动重投，不用人按', async () => {
    let broken = true
    const r = rig({ fail: () => broken })
    await killOne(r)
    // 还没到第一轮的等待时间：不动
    expect((await r.pipeline.sweepDeadLetters()).requeued).toEqual([])
    broken = false
    r.clock.advance(autoRequeueDelayMs(0, DEFAULT_AUTO_REQUEUE))
    const out = await r.pipeline.sweepDeadLetters()
    expect(out.requeued).toHaveLength(1)
    expect(r.delivered).toHaveLength(1)
    expect(await r.pipeline.deadLetterRecords(WS)).toEqual([])
    const requeued = r.events.events.find((e) => e.type === 'inbound.requeued')
    expect(requeued?.payload).toMatchObject({ auto: true, round: 1 })
  })

  it('一直投不进：按退避投满四轮后放弃，只进日志；客户来信出一次卡', async () => {
    const r = rig({ fail: () => true })
    await killOne(r)
    const delays: number[] = []
    for (let round = 0; round < DEFAULT_AUTO_REQUEUE.max_rounds; round++) {
      delays.push(autoRequeueDelayMs(round, DEFAULT_AUTO_REQUEUE))
      r.clock.advance(autoRequeueDelayMs(round, DEFAULT_AUTO_REQUEUE))
      expect((await r.pipeline.sweepDeadLetters()).requeued).toHaveLength(1)
    }
    // 30 分钟 → 2 小时 → 8 小时 → 24 小时
    expect(delays).toEqual([30 * MIN, 120 * MIN, 480 * MIN, 1440 * MIN])
    r.clock.advance(48 * 60 * MIN)
    const last = await r.pipeline.sweepDeadLetters()
    expect(last.requeued).toEqual([])
    expect(last.gave_up).toHaveLength(1)
    expect(last.gave_up[0]?.customer).toBe(true)
    expect(r.events.events.filter((e) => e.type === 'inbound.dead_letter_gave_up')).toHaveLength(1)
    // 放弃了就不再投、也不再出第二张卡
    r.clock.advance(48 * 60 * MIN)
    expect(await r.pipeline.sweepDeadLetters()).toEqual({ requeued: [], gave_up: [] })
    const [record] = await r.pipeline.deadLetterRecords(WS)
    expect(record?.retry).toMatchObject({ rounds: 4, gave_up: true, notified: true })
    expect(record === undefined ? 'x' : r.pipeline.nextAutoRequeueAt(record)).toBeUndefined()
  })

  it('换了版本：放弃过的也立刻再投一次，轮数从头数；不再出第二张卡', async () => {
    let broken = true
    const r = rig({ fail: () => broken })
    await killOne(r)
    for (let round = 0; round < DEFAULT_AUTO_REQUEUE.max_rounds; round++) {
      r.clock.advance(autoRequeueDelayMs(round, DEFAULT_AUTO_REQUEUE))
      await r.pipeline.sweepDeadLetters({ release: '0.1.0' })
    }
    r.clock.advance(48 * 60 * MIN)
    expect((await r.pipeline.sweepDeadLetters({ release: '0.1.0' })).gave_up).toHaveLength(1)
    broken = false
    const out = await r.pipeline.sweepDeadLetters({ release: '0.1.1' })
    expect(out.requeued).toHaveLength(1)
    expect(r.delivered).toHaveLength(1)
  })

  it('系统 / 营销通知彻底投不进：只进日志，不出卡', async () => {
    const r = rig({ fail: () => true })
    await killOne(r, 'Shopify <no-reply@shopify.com>')
    for (let round = 0; round <= DEFAULT_AUTO_REQUEUE.max_rounds; round++) {
      r.clock.advance(autoRequeueDelayMs(round, DEFAULT_AUTO_REQUEUE))
      await r.pipeline.sweepDeadLetters()
    }
    const logged = r.events.events.filter((e) => e.type === 'inbound.dead_letter_gave_up')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.payload).toMatchObject({ customer: false })
  })

  it('SQLite 档：重启（换一个管线实例）后接着数轮', async () => {
    const queue = new SqliteQueueStore({})
    const a = rig({ fail: () => true, queue })
    await killOne(a)
    a.clock.advance(autoRequeueDelayMs(0, DEFAULT_AUTO_REQUEUE))
    await a.pipeline.sweepDeadLetters()
    const [record] = await a.pipeline.deadLetterRecords(WS)
    expect(record?.retry?.rounds).toBe(1)
    queue.close()
  })
})

describe('isCustomerLetter', () => {
  const base = {
    id: 'in_1',
    schema_version: 1,
    workspace_id: WS,
    channel: 'email',
    kind: 'message',
    received_at: '2026-09-30T00:00:00.000Z',
    occurred_at: '2026-09-30T00:00:00.000Z',
    dedupe_key: 'k',
    parts: [],
    raw_ref: 'raw://1',
    routing: { confidence: 1 },
    secrets_scrubbed: false,
  } as const satisfies InboundEvent

  it('客户发来的邮件 / 聊天算；机器地址、IM 自己人、webhook、系统事件不算', () => {
    expect(isCustomerLetter({ ...base, actor: { external_id: 'alice@example.com' } })).toBe(true)
    expect(isCustomerLetter({ ...base, channel: 'chat' })).toBe(true)
    for (const from of [
      'no-reply@shopify.com',
      'noreply@stripe.com',
      'mailer-daemon@googlemail.com',
      'notifications@github.com',
      'marketing@brand.example',
    ]) {
      expect(isCustomerLetter({ ...base, actor: { external_id: from } }), from).toBe(false)
    }
    expect(isCustomerLetter({ ...base, channel: 'wecom' })).toBe(false)
    expect(isCustomerLetter({ ...base, channel: 'shopify_webhook' })).toBe(false)
    expect(isCustomerLetter({ ...base, kind: 'system_event' })).toBe(false)
    expect(
      isCustomerLetter({
        ...base,
        sub_channel: 'amazon',
        channel_meta: { generates_draft: false },
      }),
    ).toBe(false)
  })
})
