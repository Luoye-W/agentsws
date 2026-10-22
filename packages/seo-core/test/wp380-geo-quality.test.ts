/**
 * WP380：比较胜率 / 描述准确度（用录好的模型回文打分）、官方事实表、对外说法一致性、改完复查、
 * 报告数字标来路、站外来源地图、缺位主因与先后。全是纯函数，不调模型、不联网。
 */
import type {
  GeoAnswerInsight,
  GeoAnswerRecord,
  GeoCitationRecord,
  GeoMentionRecord,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  consistencyPrompt,
  factValuesOf,
  GEO_SAMPLE_ANSWERS,
  GEO_SAMPLE_BRAND,
  GEO_SAMPLE_FACTS,
  GEO_SAMPLE_PAGES,
  gapCause,
  geoQualityOf,
  groupFindings,
  judgeMessages,
  judgePrompt,
  type MetricAnswer,
  mergeFindings,
  parseConsistencyReply,
  parseInsightReply,
  patchFacts,
  rankGaps,
  recheckAdvice,
  recheckSide,
  reportFigures,
  ruleFindings,
  sourceMap,
  surfaceOf,
  syncFacts,
  weekPoints,
} from '../src/index.js'

const W = '2026-10-12'

/** 录好的回答 + 录好的回文 → 指标要的一行（提到我们的都判过）。 */
function sampleRows(week = W): MetricAnswer[] {
  return GEO_SAMPLE_ANSWERS.map((s) => {
    const mentioned = s.text.includes(GEO_SAMPLE_BRAND.name)
    const answer: GeoAnswerRecord = {
      id: `${week}_${s.id}`,
      run_id: `r_${week}`,
      prompt_id: s.prompt,
      prompt_text: s.prompt,
      asked_text: s.prompt,
      platform: s.platform,
      model: 'web',
      via: 'web_ui',
      market: 'US',
      language: 'en',
      status: 'ok',
      answer_md: s.text,
      answer_hash: s.id,
      fetched_at: `${week}T09:00:00Z`,
      credits: 0.2,
    }
    const mentions: GeoMentionRecord[] = [
      {
        answer_id: answer.id,
        entity: 'ours',
        name_snapshot: 'NordVolt',
        mentioned,
        cited: false,
        rules_version: 1,
      },
    ]
    const parsed = parseInsightReply(s.reply, s.text, {
      mentioned,
      facts: GEO_SAMPLE_FACTS,
      rivals: s.rivals,
    })
    const insight: GeoAnswerInsight = {
      answer_id: answer.id,
      ...parsed,
      judged_at: answer.fetched_at,
    }
    return { answer, week, mentions, citations: [], insight }
  })
}

describe('WP380 一条回答的 AI 判断（录好的回文）', () => {
  it('提示词：不给官方事实与竞品时和 WP321 一字不差；给了才多两格', () => {
    const base = {
      brand: { name: 'NordVolt' },
      competitors: ['Anker'],
      answer: 'NordVolt and Anker.',
      mentioned: true,
    }
    const plain = judgePrompt(base)
    expect(plain).not.toContain('compare')
    expect(plain).not.toContain('FACTS')
    const full = judgePrompt({ ...base, facts: GEO_SAMPLE_FACTS, rivals: ['Anker'] })
    expect(full).toContain('"compare"')
    expect(full).toContain('"claims"')
    expect(full).toContain('price: $45–$69 (since 2026-10-01); earlier: $39–$59 (until 2026-10-01)')
    // 没提到我们：照旧不判比较与说法
    expect(
      judgePrompt({ ...base, mentioned: false, facts: GEO_SAMPLE_FACTS, rivals: ['Anker'] }),
    ).toBe(judgePrompt({ ...base, mentioned: false }))
  })

  it('WP471（决策 1549）：同一品牌两条回答——系统提示逐字相同；事实表在前、竞品其次、原文最后', () => {
    const base = { brand: { name: 'NordVolt' }, competitors: ['Anker'], facts: GEO_SAMPLE_FACTS }
    const a = judgeMessages({
      ...base,
      answer: 'NordVolt and Anker.',
      mentioned: true,
      rivals: ['Anker'],
    })
    const b = judgeMessages({ ...base, answer: 'Only Zendure.', mentioned: false })
    expect(b.system).toBe(a.system)
    expect(a.system).toContain('"NordVolt"')
    expect(a.system).toContain('"Anker"')
    const u = a.user
    expect(u.indexOf('<<<FACTS')).toBeLessThan(u.indexOf('"compare"'))
    expect(u.indexOf('"compare"')).toBeLessThan(u.indexOf('sentiment: how the answer'))
    expect(u.indexOf('sentiment: how the answer')).toBeLessThan(u.indexOf('<<<ANSWER'))
    expect(u.trimEnd().endsWith('ANSWER>>>')).toBe(true)
    // 每一行的字和原来一样，只调位置：拼起来就是一整段的版本
    expect(judgePrompt({ ...base, answer: 'Only Zendure.', mentioned: false })).toBe(
      `${b.system}\n${b.user}`,
    )
  })

  it('比较：原话对得上才算；摘错的那条不算；没在比较的不写', () => {
    const rows = sampleRows()
    const byId = (id: string) => rows.find((r) => r.answer.id === `${W}_${id}`)?.insight
    expect(byId('s1')?.compare).toMatchObject({ verdict: 'ours', rival: 'Anker' })
    expect(byId('s2')?.compare).toMatchObject({ verdict: 'competitor', rival: 'Belkin' })
    expect(byId('s4')?.compare?.verdict).toBe('tie')
    expect(byId('s5')?.compare).toBeUndefined()
    expect(byId('s6')?.compare).toBeUndefined()
  })

  it('说法：只收官方事实表里有的格子；说的是以前的价 → 过时；原话对不上不收', () => {
    const s2 = sampleRows().find((r) => r.answer.id === `${W}_s2`)?.insight
    expect(s2?.claims.map((c) => [c.field, c.verdict])).toEqual([
      ['category', 'correct'],
      ['price', 'outdated'],
    ])
    const noFacts = parseInsightReply(
      GEO_SAMPLE_ANSWERS[1]?.reply ?? '',
      GEO_SAMPLE_ANSWERS[1]?.text ?? '',
      {
        mentioned: true,
        facts: GEO_SAMPLE_FACTS.filter((f) => f.key !== 'price'),
        rivals: ['Belkin'],
      },
    )
    expect(noFacts.claims.map((c) => c.field)).toEqual(['category'])
    expect(parseInsightReply('不是 JSON', 'x', { mentioned: true })).toEqual({ claims: [] })
  })

  it('周指标：胜率 = 赢 ÷ 分了高下的（平局不进分母）；准确度 = 对 ÷ 说到的', () => {
    const [p] = weekPoints(sampleRows())
    // WP421：少于 5 条只给条数、不出百分比
    expect(p).toMatchObject({ compared: 2, wins: 1 })
    expect(p?.win_rate).toBeUndefined()
    // 说到 6 句：对 3（s1 卖点、s2 品类、s5 价格）、错 2（s3 品类、市场）、过时 1（s2 价格）
    expect(p).toMatchObject({
      claims: 6,
      claims_correct: 3,
      claims_wrong: 2,
      claims_outdated: 1,
      accuracy: 0.5,
    })
  })

  it('看板那一块：逐项、说错的几句带官方说法、和各竞品比', () => {
    const q = geoQualityOf(sampleRows(), W, GEO_SAMPLE_FACTS)
    expect(q.fields.find((f) => f.field === 'category')).toEqual({
      field: 'category',
      correct: 1,
      wrong: 1,
      outdated: 0,
    })
    expect(q.bad_claims.map((b) => [b.field, b.verdict])).toEqual([
      ['price', 'outdated'],
      ['category', 'wrong'],
      ['markets', 'wrong'],
    ])
    expect(q.bad_claims[0]?.official).toBe('$45–$69')
    expect(q.rivals).toEqual(
      expect.arrayContaining([
        { name: 'Anker', wins: 1, losses: 0, ties: 1 },
        { name: 'Belkin', wins: 0, losses: 1, ties: 0 },
      ]),
    )
    expect(geoQualityOf(sampleRows(), undefined, GEO_SAMPLE_FACTS).fields).toEqual([])
  })
})

describe('WP380 官方事实表', () => {
  it('从档案取值；档案改了旧值进 previous；人改的不被档案盖；空值退回跟档案', () => {
    const v = factValuesOf({
      name: 'NordVolt',
      category: 'power bank',
      subcategory: 'travel power bank',
      price_band: '$39–$59',
      positioning: 'Flight-safe power banks',
      markets: ['us', 'DE', 'US'],
    })
    expect(v).toEqual({
      name: 'NordVolt',
      category: 'power bank（travel power bank）',
      price: '$39–$59',
      selling_points: 'Flight-safe power banks',
      markets: 'US, DE',
    })
    const first = syncFacts([], v, '2026-09-01')
    const next = syncFacts(first, { ...v, price: '$45–$69' }, '2026-10-01')
    expect(next.find((f) => f.key === 'price')).toEqual({
      key: 'price',
      value: '$45–$69',
      as_of: '2026-10-01',
      source: 'profile',
      previous: [{ value: '$39–$59', until: '2026-10-01' }],
    })
    const human = patchFacts(
      next,
      { facts: [{ key: 'name', value: 'NordVolt Labs' }] },
      '2026-10-02',
    )
    expect(syncFacts(human, v, '2026-10-03').find((f) => f.key === 'name')?.value).toBe(
      'NordVolt Labs',
    )
    const back = patchFacts(human, { facts: [{ key: 'name', value: '' }] }, '2026-10-04')
    expect(syncFacts(back, v, '2026-10-05').find((f) => f.key === 'name')).toMatchObject({
      value: 'NordVolt',
      source: 'profile',
    })
  })
})

describe('WP380 对外说法一致性', () => {
  it('页面归类与归属：结构化数据 → 建站；官网 / 商品页 / 上架页 → 网站运营；站外 → 公关', () => {
    expect(surfaceOf('https://nordvolt.example/products/air', ['nordvolt.example'])).toBe(
      'product_page',
    )
    expect(surfaceOf('https://www.nordvolt.example/about', ['nordvolt.example'])).toBe('site')
    expect(surfaceOf('https://www.amazon.com/dp/X', ['nordvolt.example'])).toBe('listing')
    expect(surfaceOf('https://travelgear.example/r', ['nordvolt.example'])).toBe('review')
  })

  it('规则：页面写着以前的官方价 → 过时；结构化数据里的价离价格带太远 → 说法不一（建站）', () => {
    const page = GEO_SAMPLE_PAGES[0]
    const f = ruleFindings(
      { url: page.url, surface: 'product_page', text: page.text, jsonld: page.jsonld },
      GEO_SAMPLE_FACTS,
    )
    expect(f.map((x) => [x.surface, x.field, x.verdict, x.owner])).toEqual([
      ['product_page', 'price', 'outdated', 'web-ops'],
      ['structured_data', 'price', 'wrong', 'site'],
    ])
    expect(f[0]?.quote).toContain('Was $39–$59')
  })

  it('模型：只收页面里对得上原话的；按岗位分组', () => {
    const page = GEO_SAMPLE_PAGES[1]
    const input = { url: page.url, surface: 'review' as const, text: page.text, jsonld: [] }
    expect(consistencyPrompt(input, GEO_SAMPLE_FACTS)).toContain('PAGE>>>')
    const ai = parseConsistencyReply(page.reply, input, GEO_SAMPLE_FACTS)
    expect(ai.map((x) => x.field)).toEqual(['markets', 'selling_points'])
    const all = mergeFindings(
      [
        ...ruleFindings(
          {
            url: GEO_SAMPLE_PAGES[0].url,
            surface: 'product_page',
            text: GEO_SAMPLE_PAGES[0].text,
            jsonld: GEO_SAMPLE_PAGES[0].jsonld,
          },
          GEO_SAMPLE_FACTS,
        ),
        ...ai,
      ],
      (_f, i) => `f${i}`,
    )
    expect(groupFindings(all).map((g) => [g.owner, g.findings.length])).toEqual([
      ['site', 1],
      ['web-ops', 1],
      ['pr', 2],
    ])
  })
})

describe('WP380 改完复查', () => {
  const mention = (week: string, prompt: string, on: boolean): MetricAnswer => ({
    answer: {
      id: `${week}_${prompt}_${Math.random()}`,
      run_id: `r_${week}`,
      prompt_id: prompt,
      prompt_text: prompt,
      asked_text: prompt,
      platform: 'chatgpt',
      model: 'web',
      via: 'web_ui',
      market: 'US',
      language: 'en',
      status: 'ok',
      answer_md: 'x',
      answer_hash: 'x',
      fetched_at: `${week}T09:00:00Z`,
      credits: 0,
    },
    week,
    mentions: [
      {
        answer_id: 'x',
        entity: 'ours',
        name_snapshot: 'NordVolt',
        mentioned: on,
        cited: false,
        rules_version: 1,
      },
    ],
    citations: [],
  })

  it('那组问题上的数：只看那组、取最新一周', () => {
    const rows = [
      ...['p1', 'p2', 'p3', 'p4'].map((p, i) => ({
        ...mention('2026-09-28', p, i === 0),
        answer: { ...mention('2026-09-28', p, i === 0).answer, platform: 'gemini' as const },
      })),
      mention('2026-09-28', 'other', true),
    ]
    expect(recheckSide(rows, 'mention_rate', ['p1', 'p2', 'p3', 'p4'])).toEqual({
      value: 0.25,
      n: 4,
      week: '2026-09-28',
    })
    expect(
      recheckSide(
        sampleRows(),
        'accuracy',
        GEO_SAMPLE_ANSWERS.map((s) => s.prompt),
      ),
    ).toMatchObject({
      value: 0.5,
      n: 6,
    })
    expect(recheckSide([], 'win_rate', ['p1'])).toEqual({ n: 0 })
  })

  it('建议：≥ +20 扩大、≥ +5 保留、−5 到 +5 修改、≤ −5 停；样本太少不下结论', () => {
    const b = { value: 0.25, n: 4 }
    expect(recheckAdvice(b, { value: 0.75, n: 4 })?.advice).toBe('expand')
    expect(recheckAdvice(b, { value: 0.35, n: 4 })).toMatchObject({ advice: 'keep', delta_pp: 10 })
    expect(recheckAdvice(b, { value: 0.25, n: 4 })?.advice).toBe('modify')
    expect(recheckAdvice(b, { value: 0, n: 4 })?.advice).toBe('stop')
    expect(recheckAdvice(b, { value: 1, n: 2 })).toBeUndefined()
    expect(recheckAdvice({ n: 0 }, { value: 0.8, n: 5 })?.advice).toBe('keep')
  })
})

describe('WP380 周报模板：数字标来路、站外来源地图、缺位主因', () => {
  it('每个数带实测 / 推算 / 估算、样本量、日期', () => {
    const [p] = weekPoints(sampleRows())
    const figs = reportFigures({
      point: p,
      estimate: {
        route: 'official',
        prompts: 5,
        markets: 1,
        platforms: [],
        credits: 4,
        needs_confirm: false,
      },
      as_of: W,
    })
    expect(figs.map((f) => [f.key, f.basis])).toEqual([
      ['mention_rate', 'measured'],
      ['citation_rate', 'measured'],
      ['sov', 'measured'],
      // WP421：只有 2 条分出高下的样本——不出胜率百分比
      ['accuracy', 'derived'],
      ['credits', 'estimated'],
    ])
  })

  it('站外来源地图：按市场 × 类型分、竞品站不进、带交给谁', () => {
    const cite = (domain: string, kind: GeoCitationRecord['site_kind']): GeoCitationRecord => ({
      answer_id: 'a',
      position: 1,
      url: `https://${domain}/x`,
      url_norm: `https://${domain}/x`,
      domain,
      where: 'inline',
      site_kind: kind,
    })
    const rows = sampleRows().map((r, i) => ({
      ...r,
      citations:
        i % 2 === 0
          ? [cite('reddit.com', 'forum'), cite('anker.com', 'competitor')]
          : [cite('travelgear.example', 'media')],
    }))
    const map = sourceMap(rows, { from: W, to: W })
    expect(map.map((m) => [m.group, m.owner, m.citations])).toEqual([
      ['community', 'community', 3],
      ['media', 'pr', 3],
    ])
  })

  it('缺位主因：硬信号优先，按严重度 × 重要度 ÷ 工作量排，带岗位与复查日期', () => {
    expect(gapCause({ lane: 'fix_page' }, { blocked: true })).toBe('not_crawlable')
    expect(gapCause({ lane: 'fix_page' }, { wrong_fields: ['category'] })).toBe('not_recognized')
    expect(gapCause({ lane: 'fix_page' }, { outdated_fields: ['price'] })).toBe('outdated')
    expect(gapCause({ lane: 'fix_page' }, { losses: 2, wins: 0 })).toBe('no_difference')
    expect(gapCause({ lane: 'pr_handoff' })).toBe('no_corroboration')
    const gaps = rankGaps(
      [
        {
          question: 'Q1',
          platforms: ['chatgpt'],
          lane: 'pr_handoff',
          cited_domains: ['reddit.com'],
          competitors: [],
          suggestion: '',
        },
        {
          question: 'Q2',
          platforms: ['chatgpt', 'gemini', 'claude'],
          lane: 'fix_page',
          page: 'https://nordvolt.example/a',
          cited_domains: [],
          competitors: [],
          suggestion: '',
        },
      ],
      (g) => (g.question === 'Q2' ? { topic: 'comparison' } : { topic: 'use_case' }),
      W,
    )
    expect(gaps.map((g) => [g.question, g.cause, g.owner, g.priority, g.recheck_on])).toEqual([
      ['Q2', 'not_useful', 'content', 9, '2026-10-26'],
      ['Q1', 'no_corroboration', 'pr', 0.3, '2026-11-09'],
    ])
  })
})
