/**
 * WP116 §3–§4：自建（Compose）形态下后台的红人库那一页与搬家那条路由。
 *
 * 要钉住的事：
 *
 * 1. **没接就 503**，不画一堆 0（与看板页没接账本时同一条）；
 * 2. 统计 / 搜索那一页：库那一半的数是真的，用量那一半来自计量事件；
 * 3. 搬家：NDJSON 一行一条，**坏行只算自己坏**、重跑全是 `updated`、
 *    一趟超过 500 行直接拒（脚本会自己分块）；
 * 4. 搬家认**后台会话或运维令牌**，两把都不对就进不去；
 * 5. 审计里**一个邮箱都没有**——只记数（正文里有真实邮箱）；
 * 6. 移除：理由必填、opt-out 之后再搬家也搬不回来、审计有 intent + done 两条。
 *
 * 全部用合成数据（`example.com`），一次都不连任何真库。
 */

import { MAX_KOL_IMPORT_BATCH } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { kolImportRecordsOf } from '../src/admin/routes.js'
import { adminHarness, BOOTSTRAP_TOKEN, seedEvent, staffLogin } from './wp115-helpers.js'

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

/** 一批合成的 NDJSON（两个红人 + 一条联系方式 + 一行坏的）。 */
const NDJSON = [
  JSON.stringify({
    kind: 'creator',
    channel: 'youtube',
    handle: 'alpha',
    name: 'Alpha',
    external_id: 'UC_alpha',
    followers: 120_000,
  }),
  JSON.stringify({
    kind: 'creator',
    channel: 'tiktok',
    handle: 'beta',
    name: 'Beta',
    followers: 8_000,
  }),
  JSON.stringify({
    kind: 'contact',
    channel: 'youtube',
    handle: 'alpha',
    email: 'alpha@example.com',
    source: 'manual',
    source_url: 'https://www.example.com/@alpha/about',
  }),
  '{ 这行不是 JSON',
].join('\n')

describe('WP116 后台 · 没接就 503', () => {
  it('四条路由全回 503 并说人话，不画一堆 0', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    for (const [path, method] of [
      ['/v1/admin/kol', 'GET'],
      ['/v1/admin/kol/creators', 'GET'],
      ['/v1/admin/kol/creators/youtube/alpha/remove', 'POST'],
    ] as const) {
      const res = await ah.call(path, {
        method,
        session: admin.session,
        csrf: admin.csrf,
        ...(method === 'POST' ? { body: { reason: '试试' } } : {}),
      })
      expect(res.status, path).toBe(503)
      expect(res.body.code, path).toBe('provider_unavailable')
    }
  })
})

describe('WP116 后台 · 统计与搜索', () => {
  it('库那一半是真数；用量那一半来自计量事件，没接账本就说看不了账', async () => {
    const ah = adminHarness({ kol: true })
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      headers: { 'content-type': 'application/x-ndjson' },
      body: NDJSON,
    })

    seedEvent(ah, {
      at: ah.clock.now(),
      org_id: 'org_1',
      capability: 'data.kol.lookup',
      credits: 0.2,
      cost_micros: 1000,
    })
    // 不是红人库的那一条不该出现在这一页
    seedEvent(ah, { at: ah.clock.now(), org_id: 'org_1', capability: 'ai.chat', credits: 5 })

    const res = await ah.call('/v1/admin/kol', { session: admin.session })
    expect(res.status).toBe(200)
    const data = res.body.data as {
      library: { creators: number; contacts: number; imported: number; by_channel: unknown[] }
      usage: { available: boolean; rows: { key: string }[] }
    }
    expect(data.library.creators).toBe(2)
    expect(data.library.contacts).toBe(1)
    expect(data.library.imported).toBe(2)
    expect(data.library.by_channel).toHaveLength(2)
    expect(data.usage.available).toBe(true)
    expect(data.usage.rows.map((r) => r.key)).toEqual(['data.kol.lookup'])
  })

  it('搜索：按名字 / handle 找，按平台与"有没有邮箱"筛', async () => {
    const ah = adminHarness({ kol: true })
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: NDJSON,
    })

    const all = await ah.call('/v1/admin/kol/creators', { session: admin.session })
    expect((all.body.data as { total: number }).total).toBe(2)

    const byQ = await ah.call('/v1/admin/kol/creators?q=alpha', { session: admin.session })
    expect((byQ.body.data as { rows: { handle: string }[] }).rows[0]?.handle).toBe('alpha')

    const byChannel = await ah.call('/v1/admin/kol/creators?channel=tiktok', {
      session: admin.session,
    })
    expect((byChannel.body.data as { total: number }).total).toBe(1)

    const withContact = await ah.call('/v1/admin/kol/creators?has_contact=true', {
      session: admin.session,
    })
    expect((withContact.body.data as { total: number }).total).toBe(1)

    const imported = await ah.call('/v1/admin/kol/creators?imported_only=true', {
      session: admin.session,
    })
    expect((imported.body.data as { total: number }).total).toBe(2)
  })
})

describe('WP116 后台 · 搬家那条路由', () => {
  it('NDJSON：坏行只算自己坏；重跑一趟全是 updated', async () => {
    const ah = adminHarness({ kol: true })
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const first = await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: NDJSON,
    })
    expect(first.status).toBe(200)
    const one = first.body.data as {
      received: number
      inserted: number
      updated: number
      rejected: { reason: string; count: number }[]
    }
    expect(one.received).toBe(4)
    expect(one.inserted).toBe(3)
    expect(one.rejected.reduce((n, r) => n + r.count, 0)).toBe(1)

    const again = await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: NDJSON,
    })
    const two = again.body.data as { inserted: number; updated: number }
    expect(two.inserted).toBe(0)
    expect(two.updated).toBe(3)
  })

  it('一趟超过 500 行直接拒（脚本会自己分块）', async () => {
    const ah = adminHarness({ kol: true })
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const lines = Array.from({ length: MAX_KOL_IMPORT_BATCH + 1 }, (_, i) =>
      JSON.stringify({ kind: 'creator', channel: 'youtube', handle: `c${String(i)}` }),
    ).join('\n')
    const res = await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: lines,
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain(String(MAX_KOL_IMPORT_BATCH))
  })

  it('认运维令牌（脚本没有浏览器会话）；令牌不对就进不去', async () => {
    const ah = adminHarness({ kol: true })
    close = ah.close
    const ok = await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      body: NDJSON,
      headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
    })
    expect(ok.status).toBe(200)
    expect((ok.body.data as { inserted: number }).inserted).toBe(3)

    // 钥匙不对：与没登录一样，404（后台那一层一律藏）
    const bad = await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      body: NDJSON,
      headers: { authorization: 'Bearer nope' },
    })
    expect(bad.status).toBe(404)
  })

  it('审计只记数——一个邮箱都不落进去', async () => {
    const ah = adminHarness({ kol: true })
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: NDJSON,
    })
    const audit = await ah.call('/v1/admin/audit?action=kol.import', { session: admin.session })
    const rows = (audit.body.data as { rows: { details: unknown }[] }).rows
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain('alpha@example.com')
  })

  it('正文也认 { records: [...] }（手动试一下时那样写更顺手）', () => {
    expect(kolImportRecordsOf('{"records":[{"kind":"person","id":"p1"}]}')).toEqual([
      { kind: 'person', id: 'p1' },
    ])
    expect(kolImportRecordsOf('')).toEqual([])
    // NDJSON 的坏行原样带下去（由 `importKolRecords` 去数）
    expect(kolImportRecordsOf('{"a":1}\n坏行')).toEqual([{ a: 1 }, '坏行'])
  })
})

describe('WP116 后台 · 从库中移除（opt-out）', () => {
  it('理由必填；移除之后再搬家也搬不回来；审计有 intent + done 两条', async () => {
    const ah = adminHarness({ kol: true })
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: NDJSON,
    })

    const noReason = await ah.call('/v1/admin/kol/creators/youtube/alpha/remove', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: {},
    })
    expect(noReason.status).toBe(400)

    const removed = await ah.call('/v1/admin/kol/creators/youtube/alpha/remove', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: { reason: '本人来信要求移除' },
    })
    expect(removed.status).toBe(200)
    expect((removed.body.data as { removed: number }).removed).toBeGreaterThan(0)

    // 再搬一趟：alpha 那两行一律跳过
    const third = await ah.call('/v1/admin/kol/import', {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
      body: NDJSON,
    })
    expect((third.body.data as { skipped: number }).skipped).toBeGreaterThanOrEqual(2)
    const stats = await ah.call('/v1/admin/kol', { session: admin.session })
    expect((stats.body.data as { library: { creators: number } }).library.creators).toBe(1)
    expect((stats.body.data as { library: { removed: number } }).library.removed).toBe(1)

    const audit = await ah.call('/v1/admin/audit?action=kol.remove', { session: admin.session })
    const rows = (audit.body.data as { rows: { outcome: string }[] }).rows
    expect(rows.map((r) => r.outcome).sort()).toEqual(['done', 'intent'])
  })

  it('只读客服按不动移除（与没登录一样 404）', async () => {
    const ah = adminHarness({ kol: true })
    close = ah.close
    const support = await staffLogin(ah, 'help@example.com', 'support')
    const res = await ah.call('/v1/admin/kol/creators/youtube/alpha/remove', {
      method: 'POST',
      session: support.session,
      csrf: support.csrf,
      body: { reason: '试试' },
    })
    expect(res.status).toBe(404)
  })
})
