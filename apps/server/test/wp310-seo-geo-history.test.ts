/**
 * WP310：内容与搜索服务里的 GEO 历史——第一次用时把 `seo-state.json` 里的问题清单与开关搬进
 * 品牌目录的 `geo.sqlite`（老文件原样不动、只搬一次），导出 / 删除走同一份。
 * 替身沿用 seo-markets 那一组（官方数据接口的替身，不联网）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiAnswerProbe, AiAnswerResult, EventEnvelope } from '@agentsws/contracts'
import { DEMO_GSC_ROWS, DEMO_PAGES, standInSearchConsole } from '@agentsws/seo-core'
import { createTxn } from '@agentsws/txn'
import { afterEach, describe, expect, it } from 'vitest'
import { createGeoStore } from '../src/geo-store.js'
import { createSeoService, type SeoServiceOptions } from '../src/seo-service.js'

const NOW = '2026-09-28T00:00:00.000Z'
const CONTENT = {
  workspace_id: 'ws_1',
  person_id: 'p_li',
  assignment_id: 'asg_content',
  role_id: 'dtc.content',
}

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 0x100000000
  }
}

/** 官方数据接口的替身：英国的 ChatGPT 提到我们，其余都没提。 */
function official() {
  const probes: AiAnswerProbe[] = []
  const port = {
    status: async () => ({
      configured: true,
      route: 'official' as const,
      platforms: ['chatgpt', 'gemini', 'google_ai_overview'] as const,
      prices: { serp: 0.2, ai_answer: 0.2 },
    }),
    serp: async () => {
      throw new Error('这一组不查 SERP')
    },
    aiAnswers: async (p: AiAnswerProbe): Promise<AiAnswerResult[]> => {
      probes.push(p)
      return p.platforms.map((platform) => ({
        platform,
        answer_excerpt: '',
        brand_mentioned: p.country === 'gb' && platform === 'chatgpt',
        our_domain_cited: false,
        cited_urls: ['https://review.example/x'],
        competitors_mentioned: [],
        fetched_at: NOW,
        source: 'official',
      }))
    },
  }
  return { port, probes }
}

function setup(markets: string[] | undefined, over: Partial<SeoServiceOptions> = {}) {
  const events: EventEnvelope[] = []
  const txn = createTxn({
    clock: { now: () => NOW },
    random: seeded(),
    eventSink: (e) => events.push(e),
    readRecord: () => ({}),
    backendApply: () => ({ status: 'ok', execution_id: 'exec_1' }),
    deliverOutbound: () => ({ status: 'ok', execution_id: 'exec_1' }),
  })
  const o = official()
  const service = createSeoService({
    workspace_id: 'ws_1',
    clock: { now: () => NOW },
    random: seeded(3),
    approvals: txn.approvals,
    ledger: txn.ledger,
    actionOf: () => ({ mandate: { caps: {} }, level: 'L1' }),
    holderOf: (role) => (role === 'dtc.content' ? CONTENT : undefined),
    thresholds: () => ({}),
    searchConsole: () => standInSearchConsole({ rows: DEMO_GSC_ROWS, pages: DEMO_PAGES }),
    searchData: () => o.port as never,
    orders: () => [],
    brand: () => ({
      name: 'NordVolt',
      language: 'en',
      domains: ['nordvolt.example'],
      shop_host: 'nordvolt.example',
      currency: 'USD',
      country: 'us',
      ...(markets === undefined ? {} : { markets }),
    }),
    appendEvent: (e) => events.push(e as EventEnvelope),
    ...over,
  })
  return { service, txn, probes: o.probes }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('WP310 · seo-state.json → geo.sqlite', () => {
  it('第一次用时搬：问题与开关一条不丢、老文件不动；再用不重搬；WP321（决策 532）一律按新设置；导出带上搬来的 Prompt；按品牌删连设置', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seo-geo-'))
    dirs.push(dir)
    // 老版（WP154 / 166）面板写下的那一份
    const legacy = Array.from({ length: 7 }, (_, i) => ({
      id: `gq_${i}`,
      text: i === 0 ? 'Is NordVolt worth it?' : `What is the best power bank number ${i}?`,
      origin: i === 1 ? ('human' as const) : ('brand' as const),
      enabled: i !== 2,
    }))
    const stateFile = join(dir, 'seo-state.json')
    writeFileSync(
      stateFile,
      `${JSON.stringify({ geo_settings: { enabled: true, max_questions: 6, markets_off: ['DE'] }, geo_questions: legacy }, null, 2)}\n`,
    )
    const raw = readFileSync(stateFile, 'utf8')
    const { service } = setup(['US', 'DE'], {
      dir,
      geoStore: () => createGeoStore(join(dir, 'geo.sqlite')),
    })
    const store = await service.geoHistory()
    expect(existsSync(join(dir, 'geo.sqlite'))).toBe(true)
    expect(readFileSync(stateFile, 'utf8')).toBe(raw)
    const w = store.watch()
    if (w === undefined) throw new Error('没搬出关注设置')
    expect(w.brand).toEqual({ name: 'NordVolt', aliases: [], domains: ['nordvolt.example'] })
    expect(w.markets).toEqual(['US', 'DE'])
    expect(w.markets_off).toEqual(['DE'])
    // 决策 532：不留老默认 6 条、不留老三家
    expect(w.prompt_limit).toBe(5)
    expect(w.platforms).toEqual(['chatgpt', 'gemini', 'claude', 'google_ai_overview'])
    const ids = [...w.prompts, ...w.prompt_candidates].map((p) => p.id).sort()
    expect(ids).toEqual(legacy.map((q) => q.id).sort())
    expect(w.prompts.map((p) => p.id)).toEqual(['gq_0', 'gq_1', 'gq_3', 'gq_4', 'gq_5'])
    // 带品牌名的问题（「NordVolt 值得买吗」那一句）记成 branded
    expect(store.prompt('gq_0')?.branded).toBe(true)

    // 面板读的是新设置（老问题一条不丢）；再用不重搬
    expect((await service.geoQuestions()).map((q) => q.id).sort()).toEqual(ids)
    await service.setGeoQuestions([])
    expect((await service.geoHistory()).prompts({ archived: true })).toHaveLength(legacy.length)

    const exp = await service.geoHistoryExport({ format: 'json' })
    expect(exp.tables?.watch?.prompts).toHaveLength(0)
    const csv = await service.geoHistoryExport({ format: 'csv' })
    expect(csv.csv?.prompts?.split('\r\n').length).toBe(legacy.length + 2)

    await service.geoHistoryDelete({ scope: 'brand', include_settings: true })
    expect((await service.geoHistory()).watch()).toBeUndefined()
    service.close()
  })

  it('没给存储工厂（内存档）也能用', async () => {
    const { service } = setup(['US'])
    await service.geoView()
    const store = await service.geoHistory()
    expect(store.watch()?.markets).toEqual(['US'])
    service.close()
  })
})
