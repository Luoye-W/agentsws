/** WP159：违规宣称规则按市场分组——按目标市场开组、知识库里的卡能改能关、每条有出处。 */
import { describe, expect, it } from 'vitest'
import {
  CLAIM_MARKET_GROUPS,
  claimGroupsForMarkets,
  MARKET_CLAIM_RULES,
  resolveClaimRules,
} from '../src/claim-rules.js'
import { checkContentQuality, DEFAULT_CLAIM_RULES } from '../src/quality.js'

const OFFICIAL =
  /^https:\/\/(www\.)?(gov\.cn|ftc\.gov|ecfr\.gov|eur-lex\.europa\.eu|asa\.org\.uk|gov\.uk|competition-bureau\.canada\.ca|accc\.gov\.au|tga\.gov\.au)\//

describe('自带规则表', () => {
  it('每个市场组都有规则；每条都有出处（官方站点）与一句人话；正则都编得过', () => {
    for (const g of CLAIM_MARKET_GROUPS)
      expect(
        MARKET_CLAIM_RULES.some((r) => r.market === g),
        g,
      ).toBe(true)
    for (const r of MARKET_CLAIM_RULES) {
      expect(r.source_url, r.id).toMatch(OFFICIAL)
      expect(r.source_title.length, r.id).toBeGreaterThan(3)
      expect(r.reason.length, r.id).toBeGreaterThan(5)
      if (r.regex === true) expect(() => new RegExp(r.pattern, 'i'), r.id).not.toThrow()
    }
    expect(new Set(MARKET_CLAIM_RULES.map((r) => r.id)).size).toBe(MARKET_CLAIM_RULES.length)
  })

  it('通用组就是原来的默认表（同 id、同 pattern），只补了出处', () => {
    const global = MARKET_CLAIM_RULES.filter((r) => r.market === 'global')
    expect(global.map((r) => [r.id, r.pattern])).toEqual(
      DEFAULT_CLAIM_RULES.map((r) => [r.id, r.pattern]),
    )
  })
})

describe('按目标市场开组', () => {
  it('美国 → us；德国 / 英国 → eu_uk；认不出的只开通用', () => {
    expect(claimGroupsForMarkets(['US'])).toEqual(['global', 'us'])
    expect(claimGroupsForMarkets(['de', 'GB', 'ca'])).toEqual(['global', 'eu_uk', 'ca'])
    expect(claimGroupsForMarkets(['JP'])).toEqual(['global'])
  })

  it('只卖美国：「Made in USA」拦，「carbon neutral」不拦；加上德国就拦', () => {
    const us = resolveClaimRules({ markets: ['US'], cards: [] })
    const text = 'Made in USA and carbon neutral.'
    const hits = (rules: typeof us.rules) =>
      checkContentQuality({ body: text, facts: [], rules, now: 'x' }).issues.map((i) => i.detail)
    expect(hits(us.rules).join()).toMatch(/Made in USA/)
    expect(hits(us.rules).join()).not.toMatch(/碳中和/)
    const both = resolveClaimRules({ markets: ['US', 'DE'], cards: [] })
    expect(hits(both.rules).join()).toMatch(/碳中和/)
  })

  it('人在知识库里拨过组开关：以人为准，标 manual', () => {
    const r = resolveClaimRules({
      markets: ['US'],
      cards: [],
      group_overrides: { us: false, au: true },
    })
    expect(r.groups.find((g) => g.id === 'us')).toMatchObject({ enabled: false, why: 'manual' })
    expect(r.groups.find((g) => g.id === 'au')).toMatchObject({ enabled: true, why: 'manual' })
    expect(r.rules.some((x) => x.market === 'us')).toBe(false)
    expect(r.rules.some((x) => x.market === 'au')).toBe(true)
  })
})

describe('知识库里的卡盖过自带的', () => {
  it('同 key 的卡：改写法 → edited；enabled: false → 关掉不用；自己加的 → custom', () => {
    const r = resolveClaimRules({
      markets: ['US'],
      cards: [
        {
          id: 'k1',
          subject: { type: 'content_rule', key: 'us.made_in_usa' },
          statement: 'x',
          structured: { reason: '我们只在美国组装，照实写', pattern: 'made in usa!' },
        },
        {
          id: 'k2',
          subject: { type: 'content_rule', key: 'abs_zh_top' },
          statement: 'x',
          structured: { enabled: false },
        },
        {
          id: 'k3',
          subject: { type: 'content_rule', key: '军工级' },
          statement: '「军工级」没法证明',
          structured: { pattern: '军工级' },
        },
      ],
    })
    const row = (id: string) => r.rows.find((x) => x.id === id)
    expect(row('us.made_in_usa')).toMatchObject({
      origin: 'edited',
      reason: '我们只在美国组装，照实写',
      source_url: expect.stringContaining('ftc.gov'),
    })
    expect(row('abs_zh_top')).toMatchObject({ enabled: false, origin: 'edited' })
    expect(r.rules.some((x) => x.id === 'abs_zh_top')).toBe(false)
    expect(row('k3')).toMatchObject({ origin: 'custom', market: 'global', enabled: true })
    expect(r.rules.some((x) => x.pattern === '军工级')).toBe(true)
  })
})
