/**
 * WP335（docs/99 §5.4 / §5.6，O3）：看板的 Prompt × AI 方格与简报那一行、「一条回答」的读口
 * （全文、编号引用、上一期、时间线、高亮用的名字）。历史直接写进内存里的 `geo.sqlite`，不跑探测、不联网。
 */
import type {
  AiPlatform,
  GeoAnswerRecord,
  GeoCitationRecord,
  GeoMentionRecord,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createGeoMonitor } from '../src/geo-monitor.js'
import { createGeoStore } from '../src/geo-store.js'

const W1 = '2026-09-28'
const W2 = '2026-10-05'

function setup() {
  const store = createGeoStore()
  let id = 0
  const monitor = createGeoMonitor({
    clock: { now: () => `${W2}T10:00:00.000Z` },
    nextId: (p) => `${p}_${++id}`,
    store: async () => store,
    brand: async () => ({
      name: 'NordVolt',
      domains: ['nordvolt.example'],
      language: 'en',
      country: 'us',
      markets: ['US'],
    }),
    searchData: () =>
      ({
        status: async () => ({ configured: false, route: 'none', platforms: [] }),
      }) as never,
    translate: async (text) => ({ asked: text, language: 'en', untranslated: false }),
    languageOf: () => 'en',
    gsc: async () => ({ connected: false, rows: [] }),
  })
  const runOf = (week: string) => {
    const run = `run_${week}`
    if (store.runs().some((r) => r.id === run)) return run
    store.startRun({
      id: run,
      kind: 'geo',
      trigger: 'scheduled',
      period: week,
      status: 'running',
      planned: 0,
      answered: 0,
      credits: 0,
      started_at: `${week}T08:30:00Z`,
    })
    return run
  }
  const answer = (input: {
    id: string
    week: string
    prompt: string
    platform: AiPlatform
    md?: string
    status?: GeoAnswerRecord['status']
    ours?: Partial<GeoMentionRecord>
    cites?: [string, GeoCitationRecord['site_kind']][]
  }) => {
    const a: GeoAnswerRecord = {
      id: input.id,
      run_id: runOf(input.week),
      prompt_id: input.prompt,
      prompt_text: `Best ${input.prompt}?`,
      asked_text: `Best ${input.prompt}?`,
      platform: input.platform,
      model: 'web',
      via: 'web_ui',
      market: 'US',
      language: 'en',
      status: input.status ?? 'ok',
      answer_md: input.md ?? 'Anker is popular.',
      answer_hash: input.id,
      fetched_at: `${input.week}T09:00:00Z`,
      credits: 0.2,
    }
    // 引用按倒序写进去，读回来要按位置排好
    const citations: GeoCitationRecord[] = (input.cites ?? [])
      .map(([domain, kind], i) => ({
        answer_id: input.id,
        position: i + 1,
        url: `https://${domain}/p`,
        url_norm: `https://${domain}/p`,
        domain,
        title: domain,
        where: 'inline' as const,
        site_kind: kind,
      }))
      .reverse()
    store.recordAnswer(a, citations, [
      {
        answer_id: input.id,
        entity: 'ours',
        name_snapshot: 'NordVolt',
        mentioned: false,
        cited: false,
        rules_version: 1,
        ...input.ours,
      },
    ])
  }
  return { store, monitor, answer }
}

describe('WP335 方格与一条回答', () => {
  it('看板带最新一周的方格与简报那一行；回答读口带全文、按位置排好的引用、上一期、时间线与高亮名字', async () => {
    const { monitor, answer } = setup()
    await monitor.ensureWatch()
    answer({ id: 'a1', week: W1, prompt: 'p1', platform: 'chatgpt', md: 'Anker is popular.' })
    answer({ id: 'a2', week: W1, prompt: 'p1', platform: 'claude', status: 'failed', md: '' })
    answer({
      id: 'a3',
      week: W2,
      prompt: 'p1',
      platform: 'chatgpt',
      md: 'NordVolt Air is great. Anker is popular.',
      ours: { mentioned: true, rank: 1, cited: true },
      cites: [
        ['reddit.com', 'forum'],
        ['nordvolt.example', 'ours'],
      ],
    })
    answer({ id: 'a4', week: W2, prompt: 'p1', platform: 'claude' })

    const m = await monitor.metrics()
    expect(m.week).toBe(W2)
    expect(m.grid?.platforms).toEqual(['chatgpt', 'claude'])
    expect(m.grid?.rows[0]?.cells.map((c) => [c.answer_id, c.state, c.change])).toEqual([
      ['a3', 'mentioned', 'up'],
      ['a4', 'absent', undefined],
    ])
    expect(m.brief).toMatch(/^AI 里提到我们 50%/)

    const d = await monitor.answer('a3')
    expect(d?.week).toBe(W2)
    expect(d?.answer.answer_md).toContain('NordVolt Air')
    expect(d?.citations.map((c) => [c.position, c.domain])).toEqual([
      [1, 'reddit.com'],
      [2, 'nordvolt.example'],
    ])
    expect(d?.mentions.find((x) => x.entity === 'ours')).toMatchObject({ mentioned: true, rank: 1 })
    expect(d?.previous?.answer.id).toBe('a1')
    expect(d?.previous?.week).toBe(W1)
    expect(d?.history.map((h) => [h.week, h.state])).toEqual([
      [W1, 'absent'],
      [W2, 'mentioned'],
    ])
    expect(d?.names[0]).toMatchObject({ entity: 'ours', name: 'NordVolt' })
    expect(d?.names[0]?.terms).toContain('nordvolt.example')
  })

  it('上一期没查成就往前找拿到回答的那一期；没有这条回 undefined', async () => {
    const { monitor, answer } = setup()
    await monitor.ensureWatch()
    answer({ id: 'b1', week: W1, prompt: 'p1', platform: 'claude', status: 'empty', md: '' })
    answer({ id: 'b2', week: W2, prompt: 'p1', platform: 'claude' })
    const d = await monitor.answer('b2')
    expect(d?.previous).toBeUndefined()
    expect(d?.history.map((h) => h.state)).toEqual(['failed', 'absent'])
    expect(await monitor.answer('nope')).toBeUndefined()
  })
})
