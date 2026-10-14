/**
 * WP310（docs/99 §5.5，决策 463 / 467 / 468 / 473）：品牌目录里的 `geo.sqlite`——迁移、
 * 老 `seo-state.json` 搬家不丢、Prompt 改字 = 归档 + 新建、回答全文 / 引用 / 判定存取、
 * 导出（JSON / CSV）、删除（按品牌 / 按时间段）、不做过期清理。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GeoAnswerRecord, GeoQuestion } from '@agentsws/contracts'
import { analyzeAnswer } from '@agentsws/search-providers'
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerHash,
  createGeoStore,
  defaultWatchSettings,
  GEO_STORE_VERSION,
  type GeoStore,
  importSeoState,
  SEO_STATE_IMPORTED_KEY,
  toCsv,
} from '../src/geo-store.js'

const dirs: string[] = []
const stores: GeoStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const open = (path?: string): GeoStore => {
  const s = createGeoStore(path)
  stores.push(s)
  return s
}

const AT = '2026-10-14T08:30:00.000Z'
const BRAND = { name: 'Voltbrick', aliases: ['Volt Brick'], domains: ['voltbrick.com'] }
const WATCH = {
  brand: BRAND,
  competitors: [{ id: 'c_anker', name: 'Anker', aliases: ['MagGo'], domains: ['anker.com'] }],
}

/** 老版 `seo-state.json` 里的问题清单（WP154：人改过的、关掉的都在）。 */
const LEGACY: GeoQuestion[] = [
  { id: 'gq_h1', text: 'Which power bank is best for flights?', origin: 'human', enabled: true },
  { id: 'gq_b1', text: 'What is the best power bank?', origin: 'brand', enabled: true },
  { id: 'gq_off', text: 'Is Voltbrick worth it?', origin: 'brand', enabled: false },
  {
    id: 'gq_t1',
    text: 'How long does a 20000mah power bank last?',
    origin: 'top_query',
    enabled: true,
  },
  { id: 'gq_t2', text: 'Can I bring a power bank on a plane?', origin: 'top_query', enabled: true },
]

function answer(id: string, at: string, over: Partial<GeoAnswerRecord> = {}): GeoAnswerRecord {
  const md = over.answer_md ?? `Voltbrick and Anker MagGo, ${id}`
  return {
    id,
    run_id: 'wr_1',
    prompt_id: 'gq_b1',
    prompt_text: 'What is the best power bank?',
    asked_text: 'What is the best power bank?',
    platform: 'claude',
    model: 'claude-sonnet-5',
    via: 'model_api',
    market: 'US',
    language: 'en',
    status: 'ok',
    answer_md: md,
    answer_hash: answerHash(md),
    fetched_at: at,
    credits: 3.6,
    ...over,
  }
}

/** 一条回答用 analyzeAnswer 判完、按表存（O2 每周探测就是这么写历史的）。 */
function store1(
  s: GeoStore,
  a: GeoAnswerRecord,
  citations: { url: string; title?: string }[],
): void {
  const r = analyzeAnswer(WATCH, {
    text: a.answer_md,
    citations: citations.map((c) => ({ ...c, where: 'inline' as const })),
  })
  s.recordAnswer(
    a,
    r.citations.map((c) => ({ ...c, answer_id: a.id })),
    r.mentions.map((m) => ({ ...m, answer_id: a.id, rules_version: r.rules_version })),
  )
}

describe('WP310 geo.sqlite：迁移与老数据', () => {
  it('新库跑到最新版本；重开同一个文件不重跑、数据还在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-'))
    dirs.push(dir)
    const path = join(dir, 'geo.sqlite')
    const a = createGeoStore(path)
    expect(a.version()).toBe(GEO_STORE_VERSION)
    a.saveSettings(defaultWatchSettings({ brand: BRAND, markets: ['us'], at: AT }))
    a.close()
    const b = open(path)
    expect(b.version()).toBe(GEO_STORE_VERSION)
    expect(b.watch()?.brand.name).toBe('Voltbrick')
  })

  it('新品牌的默认：四个 AI、选 5 条、每周、手机、上限 20', () => {
    const w = defaultWatchSettings({ brand: BRAND, markets: ['us', 'de'], at: AT })
    expect(w).toMatchObject({
      platforms: ['chatgpt', 'gemini', 'claude', 'google_ai_overview'],
      prompt_limit: 5,
      prompt_cap: 20,
      frequency: 'weekly',
      rank_device: 'mobile',
      markets: ['US', 'DE'],
      enabled: true,
    })
  })

  it('seo-state.json 搬进来：问题一条不丢（含关掉的、人改的）；真在问的前 N 条是已选；开关照旧；只搬一次', () => {
    const s = open()
    const out = importSeoState(
      s,
      {
        geo_settings: { enabled: false, max_questions: 2, markets_off: ['de'] },
        geo_questions: LEGACY,
      },
      { at: AT, brand: BRAND, markets: ['US', 'DE'], isBranded: (t) => /voltbrick/iu.test(t) },
    )
    expect(out).toEqual({ imported: true, prompts: 5 })
    const w = s.watch()
    if (w === undefined) throw new Error('没搬出关注设置')
    expect(w.enabled).toBe(false)
    expect(w.prompt_limit).toBe(2)
    expect(w.markets_off).toEqual(['DE'])
    // 老用户的 AI 仍是老三家（Claude 不替他悄悄打开）
    expect(w.platforms).toEqual(['chatgpt', 'gemini', 'google_ai_overview'])
    expect(w.prompts.map((p) => p.id)).toEqual(['gq_h1', 'gq_b1'])
    expect(w.prompt_candidates.map((p) => p.id)).toEqual(['gq_off', 'gq_t1', 'gq_t2'])
    const all = s.prompts({ archived: true })
    expect(all.map((p) => [p.id, p.text, p.origin, p.enabled])).toEqual(
      LEGACY.map((q) => [q.id, q.text, q.origin, q.enabled]),
    )
    expect(s.prompt('gq_off')?.branded).toBe(true)
    expect(s.prompt('gq_b1')?.branded).toBe(false)
    expect(s.meta(SEO_STATE_IMPORTED_KEY)).toBe(AT)
    expect(
      importSeoState(s, { geo_questions: LEGACY }, { at: AT, brand: BRAND, markets: [] }),
    ).toEqual({
      imported: false,
      prompts: 0,
    })
  })

  it('老数据只有问题没有开关：按老版默认 6 条选', () => {
    const s = open()
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `gq_${i}`,
      text: `Question number ${i}?`,
      origin: 'brand' as const,
      enabled: true,
    }))
    importSeoState(s, { geo_questions: many }, { at: AT, brand: BRAND, markets: ['US'] })
    expect(s.watch()?.prompts).toHaveLength(6)
    expect(s.watch()?.prompt_limit).toBe(6)
  })

  it('什么老数据都没有：不建关注设置，只记搬过', () => {
    const s = open()
    expect(importSeoState(s, {}, { at: AT, brand: BRAND, markets: [] })).toEqual({
      imported: true,
      prompts: 0,
    })
    expect(s.watch()).toBeUndefined()
  })
})

describe('WP310 geo.sqlite：Prompt 候选 / 已选、改字 = 归档 + 新建', () => {
  it('改字归档旧的、新的继承方向与已选；归档的不在候选也不在已选；selectPrompts 换已选', () => {
    const s = open()
    s.saveSettings(defaultWatchSettings({ brand: BRAND, markets: ['US'], at: AT }))
    s.addPrompt({
      id: 'p1',
      text: 'Best power bank?',
      origin: 'ai_suggest',
      enabled: true,
      topic: 'category',
      branded: false,
      selected: true,
      created_at: AT,
    })
    s.addPrompt({
      id: 'p2',
      text: 'Power bank for camping?',
      origin: 'ai_suggest',
      enabled: true,
      topic: 'use_case',
      branded: false,
      selected: false,
      created_at: AT,
    })
    expect(
      s.addPrompt({ id: 'p1', text: 'changed?', origin: 'human', enabled: true, created_at: AT }),
    ).toBe(false)
    expect(s.prompt('p1')?.text).toBe('Best power bank?')

    const fresh = s.editPromptText('p1', { id: 'p1b', text: 'Best power bank for travel?', at: AT })
    expect(fresh).toMatchObject({
      id: 'p1b',
      origin: 'human',
      topic: 'category',
      selected: true,
      replaces: 'p1',
    })
    expect(s.prompt('p1')?.archived_at).toBe(AT)
    expect(s.watch()?.prompts.map((p) => p.id)).toEqual(['p1b'])
    expect(s.watch()?.prompt_candidates.map((p) => p.id)).toEqual(['p2'])

    s.selectPrompts(['p2', 'p1'])
    expect(s.watch()?.prompts.map((p) => p.id)).toEqual(['p2'])
    s.archivePrompt('p2', AT)
    expect(s.watch()?.prompts).toEqual([])
    expect(s.prompts({ archived: true })).toHaveLength(3)
    s.updatePrompt('p1b', { selected: true, branded: true })
    expect(s.watch()?.prompts[0]).toMatchObject({ id: 'p1b', branded: true })
  })
})

describe('WP310 geo.sqlite：回答全文、引用、判定', () => {
  it('全文与引用（url_norm、类型）、各品牌判定（别名、名次）原样存取；同一格一轮只一条', () => {
    const s = open()
    const a = answer('ga_1', AT, { answer_md: 'Top: Anker MagGo, then Volt Brick. [1]' })
    store1(s, a, [
      { url: 'https://www.reddit.com/r/x/?utm_source=claude', title: 'Thread' },
      { url: 'https://voltbrick.com/p/' },
    ])
    expect(s.answers()).toEqual([a])
    expect(s.citations('ga_1').map((c) => [c.position, c.url_norm, c.site_kind, c.where])).toEqual([
      [1, 'https://reddit.com/r/x', 'forum', 'inline'],
      [2, 'https://voltbrick.com/p', 'ours', 'inline'],
    ])
    expect(
      s.mentions('ga_1').map((m) => [m.entity, m.mentioned, m.cited, m.rank, m.alias_hit]),
    ).toEqual([
      ['ours', true, true, 2, 'Volt Brick'],
      ['c_anker', true, false, 1, 'Anker'],
    ])
    // 同一格（run × prompt × platform × market）再来一条不同 id 的：拒
    expect(() => s.recordAnswer(answer('ga_dup', AT), [], [])).toThrow()
    // 重算：判定整条换掉
    s.replaceMentions('ga_1', [
      {
        answer_id: 'ga_1',
        entity: 'ours',
        name_snapshot: 'Voltbrick',
        mentioned: false,
        cited: false,
        rules_version: 2,
      },
    ])
    expect(s.mentions('ga_1')).toEqual([
      {
        answer_id: 'ga_1',
        entity: 'ours',
        name_snapshot: 'Voltbrick',
        mentioned: false,
        cited: false,
        rules_version: 2,
      },
    ])
  })

  it('运行、排名、品牌词 Search Console 周数据、域名分类缓存（人改过的不被盖）', () => {
    const s = open()
    s.startRun({
      id: 'wr_1',
      kind: 'geo',
      trigger: 'manual',
      period: '2026-10-12',
      status: 'running',
      planned: 4,
      answered: 0,
      credits: 0,
      started_at: AT,
    })
    s.finishRun('wr_1', { status: 'done', answered: 3, credits: 4.2, finished_at: AT })
    expect(s.runs({ kind: 'geo' })[0]).toMatchObject({ status: 'done', answered: 3, credits: 4.2 })
    s.recordRank({
      run_id: 'wr_2',
      keyword: 'voltbrick',
      market: 'US',
      device: 'mobile',
      serp_features: { ai_overview: true, people_also_ask: false, shopping: true, video: false },
      aio_mentions_us: true,
      aio_cites_us: false,
      fetched_at: AT,
    })
    expect(s.ranks()[0]).toMatchObject({ keyword: 'voltbrick', serp_features: { shopping: true } })
    expect(s.ranks()[0]?.rank).toBeUndefined()
    s.recordBrandGscWeeks([
      {
        week: '2026-10-05',
        query: 'voltbrick',
        impressions: 100,
        clicks: 9,
        position: 1.6,
        fetched_at: AT,
      },
    ])
    s.recordBrandGscWeeks([
      {
        week: '2026-10-05',
        query: 'voltbrick',
        impressions: 120,
        clicks: 10,
        position: 1.5,
        fetched_at: AT,
      },
    ])
    expect(s.brandGscWeeks()).toEqual([
      {
        week: '2026-10-05',
        query: 'voltbrick',
        impressions: 120,
        clicks: 10,
        position: 1.5,
        fetched_at: AT,
      },
    ])
    s.setDomainKind('Gearblog.net', 'media', 'human', AT)
    s.setDomainKind('gearblog.net', 'other', 'model', AT)
    expect(s.domainKind('gearblog.net')).toBe('media')
  })

  it('不做过期清理：两年前的回答重开库后照样在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-'))
    dirs.push(dir)
    const path = join(dir, 'geo.sqlite')
    const a = createGeoStore(path)
    store1(a, answer('ga_old', '2024-10-07T08:30:00.000Z'), [])
    a.close()
    expect(
      open(path)
        .answers()
        .map((x) => x.id),
    ).toEqual(['ga_old'])
  })
})

describe('WP310 geo.sqlite：导出与删除（决策 473）', () => {
  const seed = (s: GeoStore): void => {
    s.saveSettings(defaultWatchSettings({ brand: BRAND, markets: ['US'], at: AT }))
    s.startRun({
      id: 'wr_1',
      kind: 'geo',
      trigger: 'scheduled',
      period: '2026-09-28',
      status: 'done',
      planned: 1,
      answered: 1,
      credits: 3.6,
      started_at: '2026-09-28T08:30:00.000Z',
    })
    s.startRun({
      id: 'wr_2',
      kind: 'geo',
      trigger: 'scheduled',
      period: '2026-10-12',
      status: 'done',
      planned: 1,
      answered: 1,
      credits: 3.6,
      started_at: '2026-10-12T08:30:00.000Z',
    })
    store1(s, answer('ga_sep', '2026-09-28T08:31:00.000Z'), [{ url: 'https://anker.com/x' }])
    store1(
      s,
      answer('ga_oct', '2026-10-12T08:31:00.000Z', {
        run_id: 'wr_2',
        answer_md: '=cmd, "quoted"\nline 2',
      }),
      [{ url: 'https://reddit.com/r/y' }],
    )
    s.recordBrandGscWeeks([
      {
        week: '2026-09-28',
        query: 'voltbrick',
        impressions: 1,
        clicks: 0,
        position: 2,
        fetched_at: AT,
      },
      {
        week: '2026-10-12',
        query: 'voltbrick',
        impressions: 2,
        clicks: 1,
        position: 1,
        fetched_at: AT,
      },
    ])
  }

  it('JSON：全部表；按时间段只出那一段（引用与判定跟着回答走）', () => {
    const s = open()
    seed(s)
    const all = s.exportHistory('json', AT)
    expect(all.tables?.answers.map((a) => a.id)).toEqual(['ga_sep', 'ga_oct'])
    expect(all.tables?.watch?.brand.name).toBe('Voltbrick')
    expect(all.range).toBeUndefined()
    const oct = s.exportHistory('json', AT, { from: '2026-10-01T00:00:00.000Z' })
    expect(oct.range).toEqual({ from: '2026-10-01T00:00:00.000Z' })
    expect(oct.tables?.answers.map((a) => a.id)).toEqual(['ga_oct'])
    expect(oct.tables?.citations.map((c) => c.answer_id)).toEqual(['ga_oct'])
    expect(oct.tables?.mentions.every((m) => m.answer_id === 'ga_oct')).toBe(true)
    expect(oct.tables?.runs.map((r) => r.id)).toEqual(['wr_2'])
    expect(oct.tables?.brand_gsc.map((g) => g.week)).toEqual(['2026-10-12'])
  })

  it('CSV：每张表一份、带 BOM 与表头、逗号 / 引号 / 换行转义、公式开头加引号', () => {
    const s = open()
    seed(s)
    const csv = s.exportHistory('csv', AT).csv ?? {}
    expect(Object.keys(csv).sort()).toEqual(
      ['answers', 'brand_gsc', 'citations', 'mentions', 'prompts', 'ranks', 'runs'].sort(),
    )
    const answers = csv.answers ?? ''
    expect(answers.startsWith('﻿id,run_id,prompt_id,')).toBe(true)
    expect(answers).toContain(`"'=cmd, ""quoted""\nline 2"`)
    expect(toCsv([{ a: [1, 2], b: null }])).toBe('﻿a,b\r\n"[1,2]",\r\n')
  })

  it('按时间段删：只删那一段的回答、引用、判定、运行、周数据；按品牌删：全部历史，可连设置一起（不会再从老文件搬回来）', () => {
    const s = open()
    seed(s)
    expect(() => s.deleteHistory({ scope: 'range' })).toThrow()
    const r = s.deleteHistory({ scope: 'range', to: '2026-10-01T00:00:00.000Z' })
    expect(r).toEqual({ runs: 1, answers: 1, citations: 1, mentions: 2, ranks: 0, brand_gsc: 1 })
    expect(s.answers().map((a) => a.id)).toEqual(['ga_oct'])
    expect(s.citations('ga_sep')).toEqual([])

    s.setMeta(SEO_STATE_IMPORTED_KEY, AT)
    const all = s.deleteHistory({ scope: 'brand' })
    expect(all.answers).toBe(1)
    expect(s.answers()).toEqual([])
    expect(s.watch()).toBeDefined()
    s.deleteHistory({ scope: 'brand', include_settings: true })
    expect(s.watch()).toBeUndefined()
    expect(
      importSeoState(s, { geo_questions: LEGACY }, { at: AT, brand: BRAND, markets: [] }).imported,
    ).toBe(false)
  })
})
