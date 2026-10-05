/**
 * WP220（Luoye 10-05）：Reddit 取数两路（接口中台 → 浏览器只读）与研究取数白名单的契约常量。
 */
import { describe, expect, it } from 'vitest'
import {
  clampRedditBrowserReadLimits,
  DATA_CAPABILITY_CATALOG,
  DEFAULT_REDDIT_BROWSER_READ_LIMITS,
  DEFAULT_REDDIT_READ_ORDER,
  dataCapabilitySpec,
  normalizeDataInput,
  REDDIT_READ_CAPABILITIES,
  REDDIT_READ_HOSTS,
  REDDIT_READ_ROUTE_KEY,
  REDDIT_READ_ROUTE_LEVELS,
  RESEARCH_FETCH_ROUTES,
} from '../src/index.js'

describe('WP220 Reddit 取数路由', () => {
  it('键是 reddit.read；默认 ①接口中台 → ②浏览器只读；只认这两级（没有品牌自带 key 那一路）', () => {
    expect(REDDIT_READ_ROUTE_KEY).toBe('reddit.read')
    expect([...DEFAULT_REDDIT_READ_ORDER]).toEqual(['workshop', 'browser_readonly'])
    expect([...REDDIT_READ_ROUTE_LEVELS].sort()).toEqual(['browser_readonly', 'workshop'])
    expect(REDDIT_READ_ROUTE_LEVELS).not.toContain('byo_source')
    expect(REDDIT_READ_ROUTE_LEVELS).not.toContain('official_key')
  })

  it('接口中台那三项能力都在目录里：同步、按行计价、有上限', () => {
    for (const id of REDDIT_READ_CAPABILITIES) {
      const spec = dataCapabilitySpec(id)
      expect(spec, id).toBeDefined()
      expect(spec?.group).toBe('social')
      expect(spec?.mode).toBe('sync')
      expect(spec?.unit).toBe('row')
      expect(spec?.max_items).toBeGreaterThan(0)
    }
    const ids = DATA_CAPABILITY_CATALOG.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('输入白名单：版名去 r/ 归小写；时间窗与排序只认枚举；多给的字段丢掉', () => {
    const search = dataCapabilitySpec('social.reddit.search')
    if (search === undefined) throw new Error('缺能力')
    expect(
      normalizeDataInput(search, {
        query: ' INMO Air3 ',
        subreddit: 'r/AugmentedReality',
        time_window: 'WEEK',
        limit: 25,
        cookie: 'x',
      }),
    ).toEqual({
      ok: true,
      input: { query: 'INMO Air3', subreddit: 'augmentedreality', time_window: 'week', limit: 25 },
    })
    expect(normalizeDataInput(search, { query: 'x', time_window: 'decade' })).toMatchObject({
      ok: false,
      field: 'time_window',
    })
    const comments = dataCapabilitySpec('social.reddit.comments')
    if (comments === undefined) throw new Error('缺能力')
    expect(normalizeDataInput(comments, {})).toMatchObject({ ok: false, field: 'post_url' })
  })

  it('浏览器只读的限速：默认保守；设置里调出界按边界收；缺的格用默认', () => {
    expect(DEFAULT_REDDIT_BROWSER_READ_LIMITS).toEqual({
      min_interval_seconds: 20,
      max_pages_per_hour: 30,
      max_pages_per_day: 200,
    })
    expect(
      clampRedditBrowserReadLimits({ min_interval_seconds: 1, max_pages_per_hour: 9999 }),
    ).toEqual({ min_interval_seconds: 5, max_pages_per_hour: 120, max_pages_per_day: 200 })
    expect(clampRedditBrowserReadLimits('乱填')).toEqual(DEFAULT_REDDIT_BROWSER_READ_LIMITS)
    expect(REDDIT_READ_HOSTS).toContain('*.reddit.com')
  })
})

describe('WP220 研究取数白名单', () => {
  it('只有五种取数方式', () => {
    expect([...RESEARCH_FETCH_ROUTES]).toEqual([
      'web_search',
      'web_fetch',
      'workshop',
      'browser_readonly',
      'official_api',
    ])
  })
})
