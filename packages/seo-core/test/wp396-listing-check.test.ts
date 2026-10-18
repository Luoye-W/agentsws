/**
 * WP396（docs/106 §13）：Listing 体检规则逐条判；规则表带出处与日期、过期标出来；建议值能改；
 * 文案给草稿、图片给设计需求单；和上一次比「修了几处」。
 */
import type { AmazonListingFacts, ListingRule } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_LISTING_RULES,
  checkListing,
  compareListingIssues,
  isListingRuleStale,
  listingTitleDraft,
  resolveClaimRules,
  resolveListingRules,
  summarizeListingCheckup,
} from '../src/index.js'

const NOW = '2026-10-18T08:00:00.000Z'

const facts = (patch: Partial<AmazonListingFacts> = {}): AmazonListingFacts => ({
  asin: 'B0NORDV001',
  marketplace: 'US',
  url: 'https://www.amazon.com/dp/B0NORDV001',
  read_at: NOW,
  title: 'Nordvik Granite Wallet for Men, RFID Blocking Slim Bifold Leather Wallet, Black',
  bullets: [
    'Full-grain leather that softens instead of cracking',
    'RFID blocking layer tested to ISO 14443',
    'Holds 8 cards plus folded bills',
  ],
  has_description: true,
  has_aplus: true,
  image_count: 7,
  has_main_image: true,
  has_video: true,
  variants: { present: true, child_asins: ['B0NORDV001', 'B0NORDV002'], unavailable_count: 0 },
  rating: 4.6,
  reviews_count: 2481,
  price: '$54.99',
  currency: 'USD',
  availability: 'in_stock',
  buybox: { present: true, seller: 'Nordvik Official', ships_from: 'Amazon' },
  undeliverable: false,
  ...patch,
})

const rules = resolveListingRules()
const claimRules = resolveClaimRules({ markets: ['US'], cards: [] }).rules
const run = (
  f: AmazonListingFacts,
  extra: { siblings?: AmazonListingFacts[]; own?: string[] } = {},
) =>
  checkListing({
    facts: f,
    rules,
    claimRules,
    ownSellers: extra.own ?? ['Nordvik'],
    ...(extra.siblings === undefined ? {} : { siblings: extra.siblings }),
    now: NOW,
  })
const ids = (f: AmazonListingFacts, extra?: Parameters<typeof run>[1]) =>
  run(f, extra).issues.map((i) => i.rule_id)

describe('WP396 · 规则表是数据，每条带出处与核对日期', () => {
  it('每条都有出处标题、核对日期、建议怎么改；官方的带链接', () => {
    expect(BUILTIN_LISTING_RULES.length).toBeGreaterThanOrEqual(20)
    for (const r of BUILTIN_LISTING_RULES) {
      expect(r.source.title).not.toBe('')
      expect(r.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r.advice.zh).not.toBe('')
      if (r.source.kind === 'official') expect(r.source.url).toMatch(/^https:\/\//)
    }
    // 一期至少这几块都有
    const areas = new Set(BUILTIN_LISTING_RULES.map((r) => r.area))
    for (const a of [
      'title',
      'bullets',
      'content',
      'images',
      'variants',
      'reviews',
      'offer',
      'claims',
    ])
      expect(areas.has(a as ListingRule['area'])).toBe(true)
  })

  it('一切正常：没有问题，只提示人看一眼主图', () => {
    const r = run(facts())
    expect(r.issues).toEqual([])
    expect(r.human_checks).toHaveLength(1)
    expect(r.human_checks[0]).toContain('白底')
  })
})

describe('WP396 · 逐条判', () => {
  it('标题：超长、重复词、特殊符号、促销字眼、全大写；草稿只给一次', () => {
    const long = `${facts().title} Wallet Wallet, Best Gift for Dad, #1 Slim Wallet!!! ${'Minimalist Front Pocket Card Holder '.repeat(4)}`
    const r = run(facts({ title: long }))
    const got = r.issues.map((i) => i.rule_id)
    expect(got).toEqual(
      expect.arrayContaining([
        'title.max_chars',
        'title.repeat_words',
        'title.special_chars',
        'title.promo_words',
      ]),
    )
    const drafts = r.issues.filter((i) => i.draft !== undefined)
    expect(drafts).toHaveLength(1)
    const d = drafts[0]?.draft ?? ''
    expect(d.length).toBeLessThanOrEqual(200)
    expect(d).not.toMatch(/[!#]|\bbest\b/i)
    expect(ids(facts({ title: 'NORDVIK GRANITE WALLET FOR MEN SLIM BIFOLD' }))).toContain(
      'title.all_caps',
    )
  })

  it('标题草稿：去符号 / 促销 / 多余重复、全大写改首字母大写', () => {
    expect(listingTitleDraft('NORDVIK BEST WALLET WALLET WALLET {SLIM}!', rules)).toBe(
      'Nordvik Wallet Wallet Slim',
    )
  })

  it('五点：条数不够、空着、太长（给草稿）、表情符号（给草稿）', () => {
    expect(ids(facts({ bullets: ['', 'Holds 8 cards'] }))).toEqual(
      expect.arrayContaining(['bullets.min_count', 'bullets.empty']),
    )
    const long = run(facts({ bullets: [...facts().bullets, 'word '.repeat(80)] }))
    const len = long.issues.find((i) => i.rule_id === 'bullets.length')
    expect(len?.draft?.length).toBeLessThanOrEqual(255)
    const emoji = run(facts({ bullets: [...facts().bullets, 'Gift ready ✅ for Dad'] }))
    expect(emoji.issues.find((i) => i.rule_id === 'bullets.special_chars')?.draft).toBe(
      'Gift ready for Dad',
    )
  })

  it('描述 / A+：都没有两条；只缺 A+ 一条，A+ 带设计需求单', () => {
    expect(ids(facts({ has_aplus: false, has_description: false }))).toEqual(
      expect.arrayContaining(['content.description_or_aplus', 'content.aplus']),
    )
    const r = run(facts({ has_aplus: false }))
    expect(r.issues.map((i) => i.rule_id)).toEqual(['content.aplus'])
    expect(r.issues[0]?.design_request?.title).toContain('A+')
  })

  it('图片：没主图（最严重）、张数不够、没视频——都带设计需求单', () => {
    const r = run(facts({ has_main_image: false, image_count: 0, has_video: false }))
    expect(r.issues[0]?.rule_id).toBe('images.main')
    expect(r.issues[0]?.severity).toBe('blocker')
    for (const id of ['images.main', 'images.min_count', 'images.video'])
      expect(r.issues.find((i) => i.rule_id === id)?.design_request).toBeDefined()
    // 主图没读到时不提示看主图
    expect(r.human_checks).toEqual([])
  })

  it('变体：几乎同名的另一款不在同一组变体里 → 断了（标「建议人看一眼」）；有子体买不了', () => {
    const a = facts({
      asin: 'B0NORDVBR1',
      title: 'Nordvik Granite Wallet for Men, RFID Blocking Slim Bifold Leather Wallet, Brown',
      variants: { present: false, child_asins: [], unavailable_count: 0 },
    })
    const b = facts({
      asin: 'B0NORDVTN1',
      title: 'Nordvik Granite Wallet for Men, RFID Blocking Slim Bifold Leather Wallet, Tan',
      variants: { present: false, child_asins: [], unavailable_count: 0 },
    })
    const r = run(a, { siblings: [a, b] })
    const broken = r.issues.find((i) => i.rule_id === 'variants.broken')
    expect(broken?.needs_human).toBe(true)
    expect(broken?.now).toContain('B0NORDVTN1')
    // 在同一组里就不算
    expect(
      ids(facts(), {
        siblings: [facts({ asin: 'B0NORDV002', title: `${facts().title}!` })],
      }),
    ).not.toContain('variants.broken')
    expect(
      ids(
        facts({ variants: { present: true, child_asins: ['A', 'B', 'C'], unavailable_count: 1 } }),
      ),
    ).toContain('variants.unavailable')
  })

  it('评分 / 评论数：照页面原样写', () => {
    const r = run(facts({ rating: 3.6, reviews_count: 7 }))
    expect(r.issues.find((i) => i.rule_id === 'reviews.rating_min')?.now).toBe(
      '评分 3.6（建议 4 以上）',
    )
    expect(r.issues.find((i) => i.rule_id === 'reviews.count_min')?.now).toContain('7 个评分')
    // 读不到就不判
    const { rating: _r, reviews_count: _n, ...rest } = facts()
    expect(ids({ ...rest })).toEqual([])
  })

  it('没货、购物车不在、购物车不是自己；不知道店铺名就让人说一声', () => {
    expect(
      ids(
        facts({
          availability: 'out_of_stock',
          availability_text: 'Currently unavailable.',
          buybox: { present: false },
        }),
      ),
    ).toEqual(['offer.in_stock'])
    expect(ids(facts({ buybox: { present: false } }))).toEqual(['offer.buybox_present'])
    expect(ids(facts({ buybox: { present: true, seller: 'QuickDeals Store' } }))).toEqual([
      'offer.buybox_own',
    ])
    const unknown = run(facts({ buybox: { present: true, seller: 'QuickDeals Store' } }), {
      own: [],
    })
    expect(unknown.issues).toEqual([])
    expect(unknown.human_checks.some((h) => h.includes('店铺名'))).toBe(true)
  })

  it('违规宣称：按站点的市场组，出处用那条宣称规则自己的', () => {
    const r = run(
      facts({
        bullets: [...facts().bullets, 'Clinically proven RFID shield, eco-friendly leather'],
      }),
    )
    const claim = r.issues.find((i) => i.rule_id === 'claims.market')
    expect(claim).toBeDefined()
    expect(claim?.source.url).toMatch(/^https:\/\//)
  })
})

describe('WP396 · 建议值能改、规则会过时', () => {
  it('改标题长度建议值、关掉一条', () => {
    const custom = resolveListingRules({
      'title.max_chars': { params: { max_chars: 60 } },
      'images.video': { enabled: false },
      // 类型不对的值不收
      'title.repeat_words': { params: { max_repeat: 'two' } },
    })
    expect(custom.find((r) => r.id === 'title.max_chars')?.params.max_chars).toBe(60)
    expect(custom.find((r) => r.id === 'title.repeat_words')?.params.max_repeat).toBe(2)
    const r = checkListing({
      facts: facts({ has_video: false }),
      rules: custom,
      claimRules,
      ownSellers: ['Nordvik'],
      now: NOW,
    })
    expect(r.issues.map((i) => i.rule_id)).toEqual(['title.max_chars'])
    expect(r.issues[0]?.now).toContain('建议不超过 60')
  })

  it('核对日期改到一年前：这条标「可能过时」', () => {
    const old = resolveListingRules({ 'title.max_chars': { checked_at: '2025-10-18' } })
    expect(
      isListingRuleStale(old.find((r) => r.id === 'title.max_chars') ?? { checked_at: '' }, NOW),
    ).toBe(true)
    const r = checkListing({
      facts: facts({ title: 'x'.repeat(250) }),
      rules: old,
      claimRules,
      ownSellers: ['Nordvik'],
      now: NOW,
    })
    expect(r.issues.find((i) => i.rule_id === 'title.max_chars')?.rule_stale).toBe(true)
    expect(rules.every((x) => !isListingRuleStale(x, NOW))).toBe(true)
  })
})

describe('WP396 · 和上一次比、摘要', () => {
  it('上次 6 处、修了 4 处、新冒出 1 处', () => {
    const p = (rule_id: string, now = 'x') => ({ rule_id, now })
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => p(x))
    const after = [p('e'), p('f'), p('g')]
    expect(compareListingIssues(before, after)).toEqual({ issues: 6, fixed: 4, added: 1 })
    // 数字变了（标题从 250 字变 230 字）还算同一处
    expect(
      compareListingIssues([p('t', '标题 250 个字符')], [p('t', '标题 230 个字符')]).fixed,
    ).toBe(0)
  })

  it('摘要：最严重的一条是影响能不能买的那条', () => {
    const r1 = run(facts({ has_video: false }))
    const r2 = run(facts({ availability: 'out_of_stock', buybox: { present: false } }))
    const s = summarizeListingCheckup([
      {
        asin: 'A',
        marketplace: 'US',
        url: 'u',
        status: 'checked',
        issues: r1.issues,
        human_checks: [],
      },
      {
        asin: 'B',
        marketplace: 'US',
        url: 'u',
        status: 'checked',
        issues: r2.issues,
        human_checks: [],
      },
      { asin: 'C', marketplace: 'US', url: 'u', status: 'skipped', issues: [], human_checks: [] },
    ])
    expect(s).toMatchObject({ asins: 3, checked: 2, issues: 2, blockers: 1 })
    expect(s.worst?.asin).toBe('B')
  })
})
