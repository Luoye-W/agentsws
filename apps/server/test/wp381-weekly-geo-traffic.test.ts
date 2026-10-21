/**
 * WP381 ③：GEO 周报里并排一行 AI 来源流量（实测）——这周没问 AI 也照写；读不到 / 抛了就不写、周报照出。
 * 上游全是替身（搜索数据口没接、Search Console 替身），不联网。
 */
import type { AiTrafficSummary, EventEnvelope, SeoWeeklyGeoPayload } from '@agentsws/contracts'
import { standInSearchConsole } from '@agentsws/seo-core'
import { createTxn } from '@agentsws/txn'
import { describe, expect, it, vi } from 'vitest'
import { createSeoService, type SeoServiceOptions } from '../src/seo-service.js'

vi.setConfig({ testTimeout: 120_000 })

const CONTENT = {
  workspace_id: 'ws_1',
  person_id: 'p_li',
  assignment_id: 'asg_content',
  role_id: 'dtc.seo',
}
const TRAFFIC: AiTrafficSummary = {
  measured: true,
  since: '2026-10-05T00:00:00.000Z',
  until: '2026-10-12T00:00:00.000Z',
  currency: 'USD',
  rows: [{ platform: 'ChatGPT', orders: 2, revenue: 99.98 }],
  total_orders: 10,
  ai_orders: 2,
  ai_revenue: 99.98,
  visits: 'no_scope',
  computed_at: '2026-10-12T08:30:00.000Z',
}

function setup(over: Partial<SeoServiceOptions>) {
  const clock = { now: () => '2026-10-12T08:30:00.000Z' }
  const events: EventEnvelope[] = []
  const txn = createTxn({
    clock,
    random: () => 0.5,
    eventSink: (e) => events.push(e),
    readRecord: () => ({}),
    backendApply: () => ({ status: 'ok', execution_id: 'exec_1' }),
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  const service = createSeoService({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.3,
    approvals: txn.approvals,
    ledger: txn.ledger,
    actionOf: () => ({ mandate: { caps: {} }, level: 'L1' }),
    holderOf: (role) => (role === 'dtc.seo' ? CONTENT : undefined),
    thresholds: () => ({}),
    work: { createMatter: (input) => ({ id: 'mat_1', ...input }) },
    searchConsole: () => standInSearchConsole({ rows: [], pages: [] }),
    searchData: () =>
      ({ status: async () => ({ configured: false, route: 'none', platforms: [] }) }) as never,
    orders: () => [],
    brand: () => ({
      name: 'NordVolt',
      language: 'en',
      domains: ['nordvolt.example'],
      shop_host: 'nordvolt.example',
      currency: 'USD',
      country: 'us',
      markets: ['US'],
    }),
    appendEvent: (e) => events.push(e as EventEnvelope),
    ...over,
  })
  const card = async () => {
    const items = await txn.approvals.queue({
      workspace_id: 'ws_1',
      person_id: 'p_li',
      lane: 'mine',
    })
    return items.find((i) => (i.payload as { variant?: string }).variant === 'weekly_geo')
  }
  return { service, card }
}

describe('WP381 GEO 周报并排 AI 来源流量（实测）', () => {
  it('这周没问 AI：周报照出，带上 ai_traffic 与一行「实测」', async () => {
    const { service, card } = setup({ aiTraffic: async () => TRAFFIC })
    await service.weeklyGeo()
    const c = await card()
    expect((c?.payload as SeoWeeklyGeoPayload | undefined)?.ai_traffic).toEqual(TRAFFIC)
    expect(c?.summary).toContain('AI 带来 2 单 / USD 99.98（实测）')
  })

  it('读不到 / 抛了：周报照出，那一格不写', async () => {
    for (const aiTraffic of [
      async () => undefined,
      async () => Promise.reject(new Error('店铺掉线')),
    ]) {
      const { service, card } = setup({ aiTraffic })
      await service.weeklyGeo()
      const c = await card()
      expect(c).toBeDefined()
      expect((c?.payload as SeoWeeklyGeoPayload | undefined)?.ai_traffic).toBeUndefined()
    }
  })
})
