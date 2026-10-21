/** WP438：报表那几条路由——看板那几行、一整份、快照、跟 AI 说想看什么 → 固定 → 接着改 → 拿掉。 */
import type { ReportData, ReportSpec, ReportSummary } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import { lastSlot } from '../src/routes/reports.js'
import type { ReportStorePort, SavedReport } from '../src/types.js'
import { harness } from './helpers.js'

const json = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

function memoryStore(): ReportStorePort {
  const saved = new Map<string, SavedReport>()
  const drafts = new Map<string, ReportSpec>()
  const snaps: ReportData[] = []
  return {
    list: (ws, p) => [...saved.values()].filter((r) => r.workspace_id === ws && r.person_id === p),
    get: (_ws, id) => saved.get(id),
    save: (r) => {
      saved.set(r.spec.id, r)
    },
    remove: (_ws, id) => {
      saved.delete(id)
    },
    putDraft: (_ws, spec) => {
      drafts.set(spec.id, spec)
    },
    draft: (_ws, id) => drafts.get(id),
    snapshots: (_ws, id) =>
      snaps.filter((s) => s.id === id).map((s) => ({ at: s.computed_at, range: s.range })),
    snapshot: (_ws, id, at) => snaps.find((s) => s.id === id && s.computed_at === at),
    addSnapshot: (_ws, d) => {
      snaps.push(d)
    },
  }
}

async function withStore() {
  const h = await harness()
  const store = memoryStore()
  ;(h.workstation as unknown as { reports: ReportStorePort }).reports = store
  return { h, store }
}

describe('GET /v1/reports（看板「报表」卡）', () => {
  it('只列本人持有职责的那几份：售后客服 → 客服的两份，网站运营一份都没有', async () => {
    const { h } = await withStore()
    const care = await json<{ reports: ReportSummary[]; limit: number }>(
      await h.get('/v1/reports?position=customer-care'),
    )
    expect(care.reports.map((r) => r.id)).toEqual(['customer-care.service', 'customer-care.ai'])
    expect(care.limit).toBe(5)
    const web = await json<{ reports: ReportSummary[] }>(
      await h.get('/v1/reports?position=web-ops'),
    )
    expect(web.reports).toEqual([])
  })

  it('无权的数据源那一格不出（售后客服读不到满意度那个域）；有的数照算', async () => {
    const { h } = await withStore()
    const data = await json<ReportData>(await h.get('/v1/reports/customer-care.service?range=7d'))
    const kpis = data.blocks.find((b) => b.kind === 'kpis')?.payload as {
      items: { key: string; status: string; value?: number }[]
    }
    expect(kpis.items.some((i) => i.key === 'csat')).toBe(false)
    expect(kpis.items.find((i) => i.key === 'pending_replies')?.status).toBe('ok')
    expect(data.range).toBe('7d')
  })

  it('打开时补最新：第一次打开留一张快照，同一个点再打开不重复留', async () => {
    const { h } = await withStore()
    await h.get('/v1/reports/customer-care.service')
    await h.get('/v1/reports/customer-care.service')
    const snaps = await json<{ snapshots: { at: string; range: string }[] }>(
      await h.get('/v1/reports/customer-care.service/snapshots'),
    )
    expect(snaps.snapshots).toHaveLength(1)
    const at = snaps.snapshots[0]?.at ?? ''
    const old = await h.get(`/v1/reports/customer-care.service?at=${encodeURIComponent(at)}`)
    expect(((await old.json()) as { data: { snapshot: boolean } }).data.snapshot).toBe(true)
  })

  it('range 只认那几档；没有的报表 404', async () => {
    const { h } = await withStore()
    expect((await h.get('/v1/reports/customer-care.service?range=1y')).status).toBe(400)
    expect((await h.get('/v1/reports/nope')).status).toBe(404)
  })
})

describe('跟 AI 说想看什么 → 固定 → 接着改 → 拿掉（决策 1336 甲）', () => {
  it('compose 出草稿（3 个数 + 1 张图）并预选固定到哪；pin 之后看板最上面多这一份', async () => {
    const { h } = await withStore()
    const out = await json<{
      draft: ReportData
      reads: string[]
      matched: boolean
      suggest: { position: string; duty?: string; refresh: string }
    }>(await h.post('/v1/reports/compose', { prompt: '最近回信快不快', position: 'customer-care' }))
    expect(out.matched).toBe(true)
    expect(out.draft.origin).toBe('ai')
    expect(out.draft.blocks).toHaveLength(2)
    expect(out.suggest).toEqual({
      position: 'customer-care',
      duty: 'dtc.support',
      refresh: 'daily',
    })
    expect(out.reads[0]).toContain('工作队列')

    const pinned = await json<ReportSummary>(
      await h.post(`/v1/reports/${out.draft.id}/pin`, {
        position: 'customer-care',
        duty: 'dtc.support',
        refresh: 'weekly',
      }),
    )
    expect(pinned.origin).toBe('ai')
    expect(pinned.refresh).toBe('weekly')
    const list = await json<{ reports: ReportSummary[] }>(
      await h.get('/v1/reports?position=customer-care'),
    )
    expect(list.reports[0]?.id).toBe(pinned.id)

    const revised = await json<{ changed: boolean; answer: string }>(
      await h.post(`/v1/reports/${pinned.id}/revise`, { prompt: '加一块：退款情况' }),
    )
    expect(revised.changed).toBe(true)
    const data = await json<ReportData>(await h.get(`/v1/reports/${pinned.id}`))
    expect(data.blocks).toHaveLength(3)

    const del = await h.delete(`/v1/reports/${pinned.id}`)
    expect(del.status).toBe(200)
    const after = await json<{ reports: ReportSummary[] }>(
      await h.get('/v1/reports?position=customer-care'),
    )
    expect(after.reports.some((r) => r.id === pinned.id)).toBe(false)
  })

  it('默认报表拿不掉、改不了', async () => {
    const { h } = await withStore()
    expect((await h.delete('/v1/reports/customer-care.service')).status).toBe(404)
  })
})

describe('首页关键数字', () => {
  it('每岗位最多 1 个、有数的优先', async () => {
    const { h } = await withStore()
    const o = await json<{ key: { position: string }[]; positions: { position: string }[] }>(
      await h.get('/v1/reports/overview?range=7d'),
    )
    expect(o.positions.map((p) => p.position)).toEqual(['customer-care'])
    expect(o.key.length).toBeLessThanOrEqual(1)
  })
})

describe('重算的点', () => {
  it('每天 06:00（工作区时区）；每周一 06:00', () => {
    // 10-21（周三）09:00 +8 → 每天的点 = 10-21 06:00 +8 = 10-20 22:00Z
    expect(new Date(lastSlot('daily', '2026-10-21T01:00:00.000Z', 480) ?? 0).toISOString()).toBe(
      '2026-10-20T22:00:00.000Z',
    )
    // 每周一：10-19 06:00 +8 = 10-18 22:00Z
    expect(new Date(lastSlot('weekly', '2026-10-21T01:00:00.000Z', 480) ?? 0).toISOString()).toBe(
      '2026-10-18T22:00:00.000Z',
    )
  })
})
