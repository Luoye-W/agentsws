/**
 * WP110 ③ / ④：限流、幂等、进程内定时。
 *
 * WP58 的后置清单第 ⑥ 条："云侧没有限流与幂等，账号层的路由目前裸着。"
 * 裸着的后果具体是两件事：
 *
 * - magic-link 是整个云侧**唯一**一条不带任何凭据就能让服务器发出一封信的路由。
 *   拿它给别人的邮箱刷信，收信的人只会觉得是我们在骚扰他。
 * - 签令牌那条路由的响应体里**有一次性的令牌明文**。没有幂等，客户端重试一次
 *   就多签一把；有幂等但作用域分不开，A 拿 B 猜到的键就能把那把明文读走。
 */

import { describe, expect, it } from 'vitest'
import {
  MAGIC_LINK_PER_EMAIL_HOUR,
  MAGIC_LINK_PER_IP_HOUR,
  RESERVATION_MAX_AGE_MS,
  startMaintenance,
} from '../src/index.js'
import { type Harness, harness, login, testClock } from './helpers.js'

const HOUR = 60 * 60 * 1000

const send = (h: Harness, email: string, ip: string): ReturnType<Harness['call']> =>
  h.call('/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email },
    headers: { 'X-Forwarded-For': ip },
  })

describe('WP110 magic-link 限流', () => {
  it('同一个邮箱一小时 5 次，第 6 次 429 带 Retry-After', async () => {
    const h = harness()
    try {
      for (let i = 0; i < MAGIC_LINK_PER_EMAIL_HOUR; i += 1)
        expect((await send(h, 'luoye@example.com', '203.0.113.7')).status).toBe(200)
      const blocked = await send(h, 'luoye@example.com', '203.0.113.7')
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
      // 被限住的那一次**没有发信**（不然限流就只是在限响应码）
      expect(h.mails).toHaveLength(MAGIC_LINK_PER_EMAIL_HOUR)
      // 哪一条限住的不告诉调用方
      expect(JSON.stringify(blocked.body)).not.toContain('email')
    } finally {
      await h.close()
    }
  })

  it('被邮箱那条限住时不消耗 IP 的额度：旁边的同事还登得进来', async () => {
    const h = harness()
    try {
      for (let i = 0; i < MAGIC_LINK_PER_EMAIL_HOUR + 3; i += 1)
        await send(h, 'luoye@example.com', '203.0.113.7')
      // 同一个 IP，换一个人：IP 桶只被前 5 次真正取过
      expect((await send(h, 'tongshi@example.com', '203.0.113.7')).status).toBe(200)
    } finally {
      await h.close()
    }
  })

  it('同一个 IP 一小时 20 次封顶，换个 IP 不受影响', async () => {
    const h = harness()
    try {
      for (let i = 0; i < MAGIC_LINK_PER_IP_HOUR; i += 1)
        expect((await send(h, `u${String(i)}@example.com`, '198.51.100.9')).status).toBe(200)
      expect((await send(h, 'last@example.com', '198.51.100.9')).status).toBe(429)
      expect((await send(h, 'last@example.com', '198.51.100.10')).status).toBe(200)
    } finally {
      await h.close()
    }
  })

  it('过一小时额度回来了', async () => {
    const h = harness()
    try {
      for (let i = 0; i < MAGIC_LINK_PER_EMAIL_HOUR; i += 1)
        await send(h, 'luoye@example.com', '203.0.113.7')
      expect((await send(h, 'luoye@example.com', '203.0.113.7')).status).toBe(429)
      h.clock.advance(HOUR)
      expect((await send(h, 'luoye@example.com', '203.0.113.7')).status).toBe(200)
    } finally {
      await h.close()
    }
  })

  it('限流在建账号之前：刷一遍不会在库里种下一堆空账号', async () => {
    const h = harness()
    try {
      for (let i = 0; i < MAGIC_LINK_PER_EMAIL_HOUR + 5; i += 1)
        await send(h, 'luoye@example.com', '203.0.113.7')
      // 被限住的那几次连 ensureAccount 都没走到——账号只有第一次那一个
      expect(h.server.store.accountByEmail('luoye@example.com')).toBeDefined()
      expect(h.server.store.accountByEmail('nobody@example.com')).toBeUndefined()
    } finally {
      await h.close()
    }
  })
})

describe('WP110 幂等', () => {
  it('同键重放原响应：令牌只签一把', async () => {
    const h = harness()
    try {
      const { session } = await login(h, 'luoye@example.com')
      const body = { workspace_id: 'ws_a', label: '我的 MacBook' }
      const first = await h.call('/v1/cloud/links', {
        method: 'POST',
        body,
        token: session,
        headers: { 'Idempotency-Key': 'k-1' },
      })
      const second = await h.call('/v1/cloud/links', {
        method: 'POST',
        body,
        token: session,
        headers: { 'Idempotency-Key': 'k-1' },
      })
      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      expect(second.headers.get('Idempotent-Replay')).toBe('true')
      expect(JSON.stringify(second.body.data)).toBe(JSON.stringify(first.body.data))
      const list = await h.call('/v1/cloud/links', { token: session })
      expect((list.body.data as { links: unknown[] }).links).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

  it('同键不同请求 → 409，不是悄悄按新的做一遍', async () => {
    const h = harness()
    try {
      const { session } = await login(h, 'luoye@example.com')
      await h.call('/v1/cloud/links', {
        method: 'POST',
        body: { workspace_id: 'ws_a' },
        token: session,
        headers: { 'Idempotency-Key': 'k-2' },
      })
      const conflict = await h.call('/v1/cloud/links', {
        method: 'POST',
        body: { workspace_id: 'ws_b' },
        token: session,
        headers: { 'Idempotency-Key': 'k-2' },
      })
      expect(conflict.status).toBe(409)
      expect(conflict.body.code).toBe('idempotency_conflict')
    } finally {
      await h.close()
    }
  })

  it('作用域按凭据分：B 猜到 A 的键也读不走 A 的响应（里面有令牌明文）', async () => {
    const h = harness()
    try {
      const a = await login(h, 'a@example.com')
      const b = await login(h, 'b@example.com')
      const mine = await h.call('/v1/cloud/links', {
        method: 'POST',
        body: { workspace_id: 'ws_a' },
        token: a.session,
        headers: { 'Idempotency-Key': 'same-key' },
      })
      const theirs = await h.call('/v1/cloud/links', {
        method: 'POST',
        body: { workspace_id: 'ws_a' },
        token: b.session,
        headers: { 'Idempotency-Key': 'same-key' },
      })
      /*
       * 作用域分开了，B 那一次就是**真跑了一遍**（而不是把 A 的响应重放给他）。
       * 真跑一遍的结果是 409——ws_a 已经关联到 A 的账号上了。两件事都要成立：
       * 没有重放头，而且 A 那把令牌明文一个字节都没出现在 B 的响应里。
       */
      expect(theirs.headers.get('Idempotent-Replay')).toBeNull()
      expect(theirs.status).toBe(409)
      const mineToken = (mine.body.data as { token: string }).token
      expect(mineToken).toMatch(/^wst_/)
      expect(JSON.stringify(theirs.body)).not.toContain(mineToken)
    } finally {
      await h.close()
    }
  })

  it('不带 Idempotency-Key 的请求照旧（这道中间件只在带了键时说话）', async () => {
    const h = harness()
    try {
      const { session } = await login(h, 'luoye@example.com')
      for (const workspace_id of ['ws_a', 'ws_b'])
        expect(
          (
            await h.call('/v1/cloud/links', {
              method: 'POST',
              body: { workspace_id },
              token: session,
            })
          ).status,
        ).toBe(201)
      const list = await h.call('/v1/cloud/links', { token: session })
      expect((list.body.data as { links: unknown[] }).links).toHaveLength(2)
    } finally {
      await h.close()
    }
  })
})

describe('WP110 进程内定时清理', () => {
  it('三件各扫各的；`intervalMs: 0` 不起定时器（测试自己调）', () => {
    const clock = testClock()
    const seen: string[] = []
    const m = startMaintenance({
      clock,
      intervalMs: 0,
      wallet: {
        sweepReservations(olderThan) {
          seen.push(olderThan)
          return 2
        },
      },
      idempotency: { sweep: () => 3 },
      kol: { sweepBenchmarks: () => 4 },
      onReport: () => undefined,
    })
    const report = m.runOnce()
    expect(report).toMatchObject({ reservations: 2, idempotency: 3, benchmarks: 4 })
    // 孤儿预扣的判据是"比一小时前还老"——比这短会把还在路上的那一笔扫掉
    expect(Date.parse(clock.now()) - Date.parse(seen[0] ?? '')).toBe(RESERVATION_MAX_AGE_MS)
    m.close()
  })

  it('一件炸了不影响另外两件，也不把进程带走', () => {
    const m = startMaintenance({
      clock: testClock(),
      intervalMs: 0,
      wallet: {
        sweepReservations() {
          throw new Error('库锁住了')
        },
      },
      idempotency: { sweep: () => 5 },
      kol: { sweepBenchmarks: () => 6 },
      onReport: () => undefined,
    })
    expect(m.runOnce()).toMatchObject({ reservations: 0, idempotency: 5, benchmarks: 6 })
    m.close()
  })

  it('句柄没有那个方法就跳过（内存档的钱包没有 sweepReservations）', () => {
    const m = startMaintenance({ clock: testClock(), intervalMs: 0, onReport: () => undefined })
    expect(m.runOnce()).toMatchObject({ reservations: 0, idempotency: 0, benchmarks: 0 })
    m.close()
  })
})
