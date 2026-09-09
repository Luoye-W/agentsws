/**
 * 39 待办 H + I：保留期定时清理，和「删这个人」的跨库编排。
 *
 * 两件事都要在**服务进程真装配出来的那条线**上跑：调度器上真有那条任务，
 * `POST /v1/privacy/erase` 真把三个库都清一遍。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createServer,
  DEFAULT_RAW_RETENTION_DAYS,
  HANDLERS,
  type PrivacyEraseView,
  type Server,
} from '../src/index.js'

const T0 = '2026-09-10T00:00:00.000Z'
const DAY = 86_400_000

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

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

let server: Server | undefined
let dir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function start(clock = makeClock()): Promise<Server> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-erase-'))
  const s = await createServer({
    clock,
    random: seeded(),
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    dbDir: dir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
  })
  server = s
  return s
}

/** 往邮件原始区塞一条（相当于收过一封信）。 */
async function putRaw(s: Server, subject: string, stored_at: string): Promise<string> {
  return await s.channels.raw.put({
    channel: 'email',
    kind: 'message',
    stored_at,
    payload: `From: ${subject}\r\n\r\n订单 #1042 寄到柏林 Torstrasse 12`,
    mime: 'message/rfc822',
    subject_ref: subject,
  })
}

describe('保留期定时清理（39 待办 H）', () => {
  it('调度器上有一条每天 03:00 的清理任务，处理器已登记', async () => {
    const s = await start()
    const task = s.schedule.scheduler.get('sched_raw_prune')
    expect(task?.handler).toBe(HANDLERS.rawPrune)
    expect(task?.trigger).toMatchObject({ kind: 'cron', expr: '0 3 * * *' })
    expect(s.schedule.scheduler.handlers()).toContain(HANDLERS.rawPrune)
  })

  it('缺省保留 90 天：过了的清掉，窗口内的留着', async () => {
    const clock = makeClock()
    const s = await start(clock)
    const stale = await putRaw(s, 'old@customer.com', '2026-01-01T00:00:00.000Z')
    const fresh = await putRaw(s, 'ann@customer.com', clock.now())

    const out = await s.schedule.scheduler.runNow('sched_raw_prune')
    expect(out.ok).toBe(true)
    expect(out.result).toMatchObject({ retention_days: DEFAULT_RAW_RETENTION_DAYS, failed: [] })
    expect((out.result as { channels: number }).channels).toBe(1)
    expect(await s.channels.raw.get(stale)).toBeUndefined()
    expect(await s.channels.raw.get(fresh)).toBeDefined()
  })

  it('保留天数进策略层：global_caps.raw_retention_days 改小了就按新的清', async () => {
    const clock = makeClock()
    const s = await start(clock)
    const ref = await putRaw(s, 'ann@customer.com', clock.now())
    const policy = s.roles.policies.get(s.bootstrap.workspace.id)
    expect(policy).toBeDefined()
    if (policy !== undefined) {
      s.roles.policies.set({
        ...policy,
        global_caps: { ...policy.global_caps, raw_retention_days: 7 },
      })
    }
    // 材料落库 10 天了：90 天留着，7 天就该清掉
    clock.advance(10 * DAY)
    const out = await s.schedule.scheduler.runNow('sched_raw_prune')
    expect(out.result).toMatchObject({ retention_days: 7, channels: 1 })
    expect(await s.channels.raw.get(ref)).toBeUndefined()
  })
})

describe('「删这个人」的跨库编排（39 待办 I）', () => {
  const call = async (s: Server, body: unknown): Promise<Response> =>
    s.gateway.fetch(
      new Request('http://127.0.0.1/v1/privacy/erase', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
        },
        body: JSON.stringify(body),
      }),
    )

  it('一条请求把邮件原始区清掉，别的主体不受影响，出一份墓碑', async () => {
    const s = await start()
    const mine = await putRaw(s, 'ann@customer.com', T0)
    const other = await putRaw(s, 'bob@customer.com', T0)

    const res = await call(s, { subject: 'ann@customer.com' })
    expect(res.status).toBe(200)
    const out = ((await res.json()) as { data: PrivacyEraseView }).data
    expect(out.status).toBe('done')
    expect(out.steps.find((x) => x.store === 'channels')).toMatchObject({
      status: 'done',
      rows: 1,
    })
    // 没给数据层的记录 → 那一步 skipped（不给动，不是失败）
    expect(out.steps.find((x) => x.store === 'data')?.status).toBe('skipped')
    expect(out.steps.find((x) => x.store === 'meetings')?.status).toBe('done')

    expect(await s.channels.raw.get(mine)).toBeUndefined()
    expect(await s.channels.raw.get(other)).toBeDefined()

    // 21 §4：删除本身留痕，但 payload 里没有被删的内容
    const events: EventEnvelope[] = []
    for await (const e of s.kernel.eventLog.read({
      workspace_id: s.bootstrap.workspace.id,
      type: 'privacy.erased',
    }))
      events.push(e)
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain('Torstrasse')
  })

  it('主体密钥销毁之后备份里的密文也读不出来（crypto-shredding）', async () => {
    const s = await start()
    await putRaw(s, 'ann@customer.com', T0)
    await call(s, { subject: 'ann@customer.com' })
    expect(s.data.keyring.isShredded('ann@customer.com')).toBe(true)
    // 销毁过的主体不能又发新钥，否则删除会被下一次写入撤销
    expect(() => s.data.keyring.ensure('ann@customer.com')).toThrow()
  })

  it('可重跑：同一个主体删第二次不炸，仍然 done（每一步都幂等）', async () => {
    const s = await start()
    await putRaw(s, 'ann@customer.com', T0)
    expect(
      (
        (await (await call(s, { subject: 'ann@customer.com' })).json()) as {
          data: PrivacyEraseView
        }
      ).data.status,
    ).toBe('done')
    const again = (
      (await (await call(s, { subject: 'ann@customer.com' })).json()) as {
        data: PrivacyEraseView
      }
    ).data
    expect(again.status).toBe('done')
    expect(again.steps.find((x) => x.store === 'channels')?.rows).toBe(0)
  })

  it('数据层那一步失败 → 整体 partial（可重跑），别的库照删', async () => {
    const s = await start()
    const ref = await putRaw(s, 'ann@customer.com', T0)
    const out = (
      (await (
        await call(s, {
          subject: 'ann@customer.com',
          record: { collection: '不存在的集合', id: 'x' },
        })
      ).json()) as { data: PrivacyEraseView }
    ).data
    expect(out.status).toBe('partial')
    expect(out.steps.find((x) => x.store === 'data')?.status).toBe('failed')
    // 一步失败不该让别的库留着不删
    expect(out.steps.find((x) => x.store === 'channels')?.status).toBe('done')
    expect(await s.channels.raw.get(ref)).toBeUndefined()
  })

  it('没带凭据的请求进不来', async () => {
    const s = await start()
    const res = await s.gateway.fetch(
      new Request('http://127.0.0.1/v1/privacy/erase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'ann@customer.com' }),
      }),
    )
    expect(res.status).toBe(401)
  })
})
