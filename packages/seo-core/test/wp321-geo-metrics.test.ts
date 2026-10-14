/** WP321（docs/99 §5.3 / §5.4）：GEO / SEO 指标——规则算、分母只算拿到回答的、覆盖 < 90% 不出变化、变化大才出卡。 */
import type {
  AiPlatform,
  GeoAnswerRecord,
  GeoCitationRecord,
  GeoMentionRecord,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  brandGscWeeks,
  brandShares,
  cellChanges,
  citedSources,
  geoAlerts,
  geoTrends,
  type MetricAnswer,
  mondayOf,
  type RankPoint,
  rankMetrics,
  sentimentCounts,
  weekPoints,
} from '../src/index.js'

const W1 = '2026-09-28'
const W2 = '2026-10-05'

let n = 0
function row(input: {
  week: string
  prompt: string
  platform: AiPlatform
  market?: string
  status?: GeoAnswerRecord['status']
  ours?: Partial<GeoMentionRecord>
  rival?: boolean
  cites?: [string, GeoCitationRecord['site_kind'], GeoCitationRecord['where']?][]
  hash?: string
  branded?: boolean
}): MetricAnswer {
  n += 1
  const id = `a${n}`
  const answer: GeoAnswerRecord = {
    id,
    run_id: `r_${input.week}`,
    prompt_id: input.prompt,
    prompt_text: `Q ${input.prompt}?`,
    asked_text: `Q ${input.prompt}?`,
    platform: input.platform,
    model: 'web',
    via: 'web_ui',
    market: input.market ?? 'US',
    language: 'en',
    status: input.status ?? 'ok',
    answer_md: 'x',
    answer_hash: input.hash ?? id,
    fetched_at: `${input.week}T09:00:00Z`,
    credits: 0.2,
  }
  const mentions: GeoMentionRecord[] = [
    {
      answer_id: id,
      entity: 'ours',
      name_snapshot: 'Voltbrick',
      mentioned: false,
      cited: false,
      rules_version: 1,
      ...input.ours,
    },
    {
      answer_id: id,
      entity: 'c1',
      name_snapshot: 'Anker',
      mentioned: input.rival ?? false,
      cited: false,
      rules_version: 1,
    },
  ]
  const citations: GeoCitationRecord[] = (input.cites ?? []).map(([domain, kind, where], i) => ({
    answer_id: id,
    position: i + 1,
    url: `https://${domain}/p`,
    url_norm: `https://${domain}/p`,
    domain,
    where: where ?? 'inline',
    site_kind: kind,
  }))
  return { answer, week: input.week, mentions, citations, branded: input.branded }
}

const yes = { mentioned: true, rank: 1 }

describe('WP321 GEO 指标', () => {
  it('提及率 / 引用率分母只算拿到回答的；平均名次只在提到的里平均；声量份额只在已知品牌里算', () => {
    const rows = [
      row({
        week: W1,
        prompt: 'p1',
        platform: 'chatgpt',
        ours: { ...yes, cited: true },
        rival: true,
      }),
      row({ week: W1, prompt: 'p2', platform: 'chatgpt', ours: { mentioned: true, rank: 3 } }),
      row({ week: W1, prompt: 'p3', platform: 'chatgpt', rival: true }),
      row({ week: W1, prompt: 'p4', platform: 'chatgpt', status: 'failed' }),
    ]
    const [p] = weekPoints(rows)
    expect(p).toMatchObject({ week: W1, planned: 4, ok: 3, mentioned: 2, cited: 1 })
    expect(p?.mention_rate).toBeCloseTo(0.667, 3)
    expect(p?.citation_rate).toBeCloseTo(0.333, 3)
    expect(p?.avg_rank).toBe(2)
    expect(p?.sov).toBe(0.5)
    expect(p?.coverage).toBe(0.75)
    const shares = brandShares(
      rows,
      W1,
      new Map([
        ['ours', 'Voltbrick'],
        ['c1', 'Anker'],
      ]),
    )
    expect(shares.map((s) => [s.entity, s.mentioned, s.sov])).toEqual([
      ['ours', 2, 0.5],
      ['c1', 2, 0.5],
    ])
  })

  it('同一周同一格跑了两轮取最新；周对比只比两期都有回答的格；覆盖 < 90% 不出变化', () => {
    const later = row({ week: W2, prompt: 'p1', platform: 'gemini', ours: yes })
    later.answer.fetched_at = `${W2}T12:00:00Z`
    const rows = [
      row({ week: W1, prompt: 'p1', platform: 'gemini', ours: yes }),
      row({ week: W1, prompt: 'p2', platform: 'gemini', ours: yes }),
      row({ week: W2, prompt: 'p1', platform: 'gemini' }),
      later,
      row({ week: W2, prompt: 'p2', platform: 'gemini' }),
    ]
    const pts = weekPoints(rows)
    expect(pts.map((p) => p.planned)).toEqual([2, 2])
    expect(pts[1]?.change_pp).toBe(-50)
    expect(pts[1]?.mention_rate_4w).toBe(0.75)
    // 第二周一格没查成 → 覆盖 50% → 不出变化
    const thin = [
      ...rows.slice(0, 2),
      row({ week: W2, prompt: 'p1', platform: 'gemini' }),
      row({ week: W2, prompt: 'p2', platform: 'gemini', status: 'empty' }),
    ]
    expect(weekPoints(thin)[1]?.change_pp).toBeUndefined()
  })

  it('趋势按 AI、按市场（两个以上才分）、按带不带品牌名分开', () => {
    const rows = [
      row({ week: W1, prompt: 'p1', platform: 'chatgpt', market: 'US', ours: yes, branded: true }),
      row({ week: W1, prompt: 'p1', platform: 'claude', market: 'DE', branded: false }),
    ]
    const keys = geoTrends(rows).map((l) => `${l.kind}:${l.key}`)
    expect(keys).toEqual([
      'all:all',
      'platform:chatgpt',
      'platform:claude',
      'market:DE',
      'market:US',
      'branded:branded',
      'branded:unbranded',
    ])
  })

  it('被引用最多的站 / 页：只数正文与来源里的（搜索结果不算）、一条回答同一站只数一次、和上一段比标「新」', () => {
    const rows = [
      row({ week: W1, prompt: 'p1', platform: 'chatgpt', cites: [['reddit.com', 'forum']] }),
      row({
        week: W2,
        prompt: 'p1',
        platform: 'chatgpt',
        cites: [
          ['reddit.com', 'forum'],
          ['voltbrick.com', 'ours'],
          ['hidden.com', 'other', 'searched'],
        ],
      }),
      row({ week: W2, prompt: 'p2', platform: 'gemini', cites: [['reddit.com', 'forum']] }),
    ]
    const sites = citedSources(rows, { from: W2, to: W2 }, 'domain')
    expect(
      sites.map((s) => [s.domain, s.citations, s.prompts, s.group, s.previous, s.new]),
    ).toEqual([
      ['reddit.com', 2, 2, 'offsite', 1, false],
      ['voltbrick.com', 1, 1, 'ours', 0, true],
    ])
    expect(citedSources(rows, { from: W2, to: W2 }, 'page')[0]?.url_norm).toBe(
      'https://reddit.com/p',
    )
  })

  it('前后对比：提及从有到无排前面；引用来源的增减；情感 AI 判断按周数', () => {
    const rows = [
      row({ week: W1, prompt: 'p1', platform: 'chatgpt', ours: yes, cites: [['a.com', 'media']] }),
      row({ week: W2, prompt: 'p1', platform: 'chatgpt', cites: [['b.com', 'media']] }),
      row({ week: W1, prompt: 'p2', platform: 'chatgpt', hash: 'h' }),
      row({ week: W2, prompt: 'p2', platform: 'chatgpt', hash: 'h' }),
      row({ week: W2, prompt: 'p3', platform: 'chatgpt', ours: { ...yes, sentiment: 'negative' } }),
    ]
    const ch = cellChanges(rows, W2)
    expect(ch).toHaveLength(1)
    expect(ch[0]).toMatchObject({
      prompt_id: 'p1',
      mentioned: { before: true, after: false },
      sources_added: ['b.com'],
      sources_removed: ['a.com'],
      same_text: false,
    })
    expect(sentimentCounts(rows, W2)).toEqual({ positive: 0, neutral: 0, negative: 1, by: 'ai' })
  })

  it('变化大才出：某 AI 周跌 ≥ 15 个百分点；同一 Prompt 连续 2 周在 ≥ 2 个 AI 缺位；新竞品 ≥ 3 条回答', () => {
    const rows = [
      row({ week: W1, prompt: 'p1', platform: 'chatgpt', ours: yes }),
      row({ week: W1, prompt: 'p2', platform: 'chatgpt', ours: yes }),
      row({ week: W2, prompt: 'p1', platform: 'chatgpt' }),
      row({ week: W2, prompt: 'p2', platform: 'chatgpt', ours: yes }),
      // p3 两周都在 gemini / claude 上缺位
      ...[W1, W2].flatMap((week) =>
        (['gemini', 'claude'] as const).map((platform) =>
          row({ week, prompt: 'p3', platform, rival: true, cites: [['rtings.com', 'media']] }),
        ),
      ),
    ]
    const alerts = geoAlerts({
      rows,
      week: W2,
      others: new Map([
        ['Zendure', 3],
        ['Baseus', 2],
      ]),
      names: new Map([['c1', 'Anker']]),
    })
    expect(alerts).toContainEqual({
      kind: 'platform_drop',
      platform: 'chatgpt',
      change_pp: -50,
      lost: [{ prompt_id: 'p1', prompt_text: 'Q p1?', market: 'US' }],
    })
    expect(alerts).toContainEqual({
      kind: 'prompt_missing',
      prompt_id: 'p3',
      prompt_text: 'Q p3?',
      market: 'US',
      platforms: ['gemini', 'claude'],
      cited_domains: ['rtings.com'],
      competitors: ['Anker'],
    })
    expect(alerts).toContainEqual({ kind: 'new_competitor', name: 'Zendure', answers: 3 })
    expect(alerts.some((a) => a.kind === 'new_competitor' && a.name === 'Baseus')).toBe(false)
    // 只是小波动：不出
    expect(
      geoAlerts({ rows: rows.slice(0, 4).filter((r) => r.answer.prompt_id === 'p2'), week: W2 }),
    ).toEqual([])
  })
})

describe('WP321 排名与品牌词', () => {
  const snap = (week: string, keyword: string, rank?: number): RankPoint => ({
    week,
    run_id: `r_${week}`,
    keyword,
    market: 'US',
    device: 'mobile',
    ...(rank === undefined ? {} : { rank, url: `https://voltbrick.com/${keyword}` }),
    serp_features: { ai_overview: true, people_also_ask: false, shopping: false, video: false },
    aio_mentions_us: false,
    aio_cites_us: false,
    fetched_at: `${week}T09:00:00Z`,
  })

  it('只平均进了前 20 的；20 名外另数；进前 10 / 掉出前 10；上周在前 5 掉出前 10 出卡', () => {
    const view = rankMetrics(
      [
        snap(W1, 'power bank', 4),
        snap(W2, 'power bank', 14),
        snap(W1, 'travel charger', 12),
        snap(W2, 'travel charger', 8),
        snap(W2, 'usb c battery'),
      ],
      (k) => (k === 'power bank' ? 9.4 : undefined),
    )
    expect(view).toMatchObject({
      week: W2,
      avg_rank: 11,
      in_top20: 2,
      out_of_20: 1,
      entered_top10: 1,
      left_top10: 1,
    })
    expect(view.rows[0]).toMatchObject({
      keyword: 'travel charger',
      rank: 8,
      previous: 12,
      change: 4,
    })
    expect(view.rows[1]).toMatchObject({ keyword: 'power bank', change: -10, gsc_position: 9.4 })
    const alerts = geoAlerts({ rows: [], week: W2, ranks: view })
    expect(alerts).toEqual([
      {
        kind: 'rank_drop',
        keyword: 'power bank',
        market: 'US',
        device: 'mobile',
        was: 4,
        now: 14,
        url: 'https://voltbrick.com/power bank',
      },
    ])
  })

  it('品牌词 Search Console 周数据按周合计、排名按曝光加权；周一日期', () => {
    expect(mondayOf('2026-10-14T08:30:00Z')).toBe('2026-10-12')
    expect(mondayOf('2026-10-12T00:00:00Z')).toBe('2026-10-12')
    const weeks = brandGscWeeks([
      { week: W1, query: 'voltbrick', impressions: 300, clicks: 30, position: 1, fetched_at: W1 },
      {
        week: W1,
        query: 'voltbrick review',
        impressions: 100,
        clicks: 5,
        position: 5,
        fetched_at: W1,
      },
    ])
    expect(weeks).toEqual([{ week: W1, impressions: 400, clicks: 35, position: 2 }])
  })
})
