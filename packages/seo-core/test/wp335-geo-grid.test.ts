/** WP335（docs/99 §5.4 / §5.6）：Prompt × AI 方格、一格的时间线、简报那一行——规则算。 */
import type {
  AiPlatform,
  GeoAnswerRecord,
  GeoMentionRecord,
  RankMetricsView,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildStrategy,
  cellChangeOf,
  cellHistory,
  geoBriefLine,
  geoGrid,
  type MetricAnswer,
  parseStrategyReply,
  strategyPrompt,
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
  branded?: boolean
  at?: string
}): MetricAnswer {
  n += 1
  const id = `a${n}`
  return {
    answer: {
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
      answer_hash: id,
      fetched_at: input.at ?? `${input.week}T09:00:00Z`,
      credits: 0.2,
    },
    week: input.week,
    mentions: [
      {
        answer_id: id,
        entity: 'ours',
        name_snapshot: 'Voltbrick',
        mentioned: false,
        cited: false,
        rules_version: 1,
        ...input.ours,
      },
    ],
    citations: [],
    branded: input.branded,
  }
}

describe('WP335 方格', () => {
  it('最新一周一行一个 Prompt、列按平台顺序；没查成单列一态；和上一期比出箭头', () => {
    const rows = [
      row({ week: W1, prompt: 'p1', platform: 'chatgpt' }),
      row({ week: W1, prompt: 'p1', platform: 'claude', ours: { mentioned: true, rank: 3 } }),
      row({ week: W1, prompt: 'p2', platform: 'chatgpt', ours: { mentioned: true, rank: 1 } }),
      row({ week: W2, prompt: 'p1', platform: 'claude', ours: { mentioned: true, rank: 1 } }),
      row({
        week: W2,
        prompt: 'p1',
        platform: 'chatgpt',
        ours: { mentioned: true, rank: 2, cited: true },
      }),
      row({ week: W2, prompt: 'p2', platform: 'chatgpt', status: 'failed' }),
      row({ week: W2, prompt: 'p0', platform: 'gemini', branded: true }),
    ]
    const g = geoGrid(rows)
    expect(g?.week).toBe(W2)
    expect(g?.platforms).toEqual(['chatgpt', 'gemini', 'claude'])
    // 不带品牌名的在前；带品牌名的排最后
    expect(g?.rows.map((r) => r.prompt_id)).toEqual(['p1', 'p2', 'p0'])
    const p1 = g?.rows[0]
    expect(p1?.cells.map((c) => [c.platform, c.state, c.rank, c.cited, c.change])).toEqual([
      ['chatgpt', 'mentioned', 2, true, 'up'],
      ['claude', 'mentioned', 1, false, 'up'],
    ])
    expect(p1?.change).toBe('up')
    // 没查成：不算没提到、不出箭头
    expect(g?.rows[1]?.cells[0]).toMatchObject({ state: 'failed', cited: false })
    expect(g?.rows[1]?.cells[0]?.change).toBeUndefined()
    expect(g?.rows[1]?.change).toBeUndefined()
  })

  it('同一周同一格两条取最新；没有数回 undefined；指定周', () => {
    const rows = [
      row({ week: W1, prompt: 'p1', platform: 'gemini', ours: { mentioned: true, rank: 1 } }),
      row({ week: W1, prompt: 'p1', platform: 'gemini', at: `${W1}T12:00:00Z` }),
    ]
    expect(geoGrid(rows)?.rows[0]?.cells[0]?.state).toBe('absent')
    expect(geoGrid([])).toBeUndefined()
    expect(geoGrid(rows, W2)).toBeUndefined()
  })

  it('名次往后 = down；两期都没提到不出箭头', () => {
    const b = row({
      week: W1,
      prompt: 'p',
      platform: 'chatgpt',
      ours: { mentioned: true, rank: 1 },
    })
    const a = row({
      week: W2,
      prompt: 'p',
      platform: 'chatgpt',
      ours: { mentioned: true, rank: 3 },
    })
    expect(cellChangeOf(b, a)).toBe('down')
    expect(
      cellChangeOf(
        row({ week: W1, prompt: 'p', platform: 'chatgpt' }),
        row({ week: W2, prompt: 'p', platform: 'chatgpt' }),
      ),
    ).toBeUndefined()
  })

  it('一格的时间线：只这一格、每周一个点、旧的在前、最多几周', () => {
    const rows = [
      row({ week: W2, prompt: 'p', platform: 'claude', ours: { mentioned: true, rank: 2 } }),
      row({ week: W1, prompt: 'p', platform: 'claude', status: 'empty' }),
      row({ week: W1, prompt: 'p', platform: 'chatgpt' }),
      row({ week: W1, prompt: 'p', platform: 'claude', market: 'DE' }),
    ]
    const h = cellHistory(rows, { prompt_id: 'p', platform: 'claude', market: 'US' })
    expect(h.map((x) => [x.week, x.state, x.rank])).toEqual([
      [W1, 'failed', undefined],
      [W2, 'mentioned', 2],
    ])
    expect(cellHistory(rows, { prompt_id: 'p', platform: 'claude', market: 'US' }, 1)).toHaveLength(
      1,
    )
  })
})

describe('WP335 简报那一行', () => {
  const rank: RankMetricsView = {
    week: W2,
    rows: [
      {
        keyword: 'a',
        market: 'US',
        device: 'mobile',
        rank: 10,
        previous: 12,
        features: { ai_overview: false, people_also_ask: false, shopping: false, video: false },
        aio_mentions_us: false,
        aio_cites_us: false,
      },
      {
        keyword: 'b',
        market: 'US',
        device: 'mobile',
        rank: 14,
        previous: 14,
        features: { ai_overview: false, people_also_ask: false, shopping: false, video: false },
        aio_mentions_us: false,
        aio_cites_us: false,
      },
    ],
    avg_rank: 12,
    in_top20: 2,
    out_of_20: 0,
    entered_top10: 0,
    left_top10: 0,
  }
  const point = {
    week: W2,
    planned: 10,
    ok: 10,
    mentioned: 4,
    cited: 1,
    mention_rate: 0.38,
    change_pp: 5,
  }
  it('提及率与周变化 · 关注词平均排名与周变化', () => {
    expect(geoBriefLine(point, rank)).toBe('AI 里提到我们 38%（+5）· 关注词平均第 12（−1）')
  })
  it('没变化不带括号的符号；没有排名只出前半句；这周没拿到回答不出', () => {
    const { change_pp: _c, ...noChange } = point
    expect(geoBriefLine(noChange)).toBe('AI 里提到我们 38%')
    expect(geoBriefLine({ ...point, change_pp: -3.4 })).toBe('AI 里提到我们 38%（−3）')
    expect(geoBriefLine({ week: W2, planned: 4, ok: 0, mentioned: 0, cited: 0 })).toBeUndefined()
    expect(geoBriefLine(undefined, rank)).toBeUndefined()
  })
})

describe('WP335（决策 659）GEO 策略读品牌档案的品类', () => {
  const profile = {
    brand: { name: 'Voltbrick', domains: ['voltbrick.example'] },
    category: 'power bank',
    markets: ['US'],
    language: 'en' as const,
  }
  it('档案里写着品类：提示词里照它来，策略用它（不被模型认的盖掉）', () => {
    expect(strategyPrompt(profile)).toContain(
      'category (from the brand profile, use as-is): power bank',
    )
    const reply = parseStrategyReply(
      JSON.stringify({ category: 'chargers', prompt_limit: 5, branded: 1 }),
    )
    const s = buildStrategy({
      profile,
      reply,
      existing: [],
      platforms: ['chatgpt'],
      at: '2026-10-15T00:00:00Z',
    })
    expect(s.category).toBe('power bank')
  })
  it('档案没写：才用模型认的', () => {
    const { category: _c, ...bare } = profile
    const reply = parseStrategyReply(
      JSON.stringify({ category: 'chargers', prompt_limit: 5, branded: 1 }),
    )
    const s = buildStrategy({
      profile: bare,
      reply,
      existing: [],
      platforms: ['chatgpt'],
      at: '2026-10-15T00:00:00Z',
    })
    expect(s.category).toBe('chargers')
  })
})
