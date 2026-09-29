/**
 * WP192：官方数据接口统一能力口的契约常量（只加不删）。
 */
import { describe, expect, it } from 'vitest'
import {
  DATA_CAPABILITY_CATALOG,
  DATA_CAPABILITY_ROUTE_LEVELS,
  DATA_SERVICE_CLOUD_PATHS,
  DATA_SERVICE_SCOPE,
  DATA_TASK_STATUSES,
  DATA_TASK_TERMINAL_STATUSES,
  DEFAULT_DATA_CAPABILITY_ORDER,
  dataCapabilityRouteKey,
  dataCapabilitySpec,
  KOL_PUBLIC_SCOPE,
  normalizeDataInput,
} from '../src/index.js'

describe('WP192 数据能力契约', () => {
  it('状态机六个状态，终态是后四个', () => {
    expect([...DATA_TASK_STATUSES]).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ])
    expect([...DATA_TASK_TERMINAL_STATUSES]).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ])
  })

  it('与公共红人库、搜索数据同一个 data 动作集；路径都在 /v1/data 下', () => {
    expect(DATA_SERVICE_SCOPE).toBe(KOL_PUBLIC_SCOPE)
    for (const path of Object.values(DATA_SERVICE_CLOUD_PATHS))
      expect(path.startsWith('/v1/data/')).toBe(true)
  })

  it('本机路由键是 data.<能力>；默认只有「Agents 工坊（用积分）」一级', () => {
    expect(dataCapabilityRouteKey('maps.places')).toBe('data.maps.places')
    expect([...DEFAULT_DATA_CAPABILITY_ORDER]).toEqual(['workshop'])
    expect(DATA_CAPABILITY_ROUTE_LEVELS).toContain('workshop')
    expect(DATA_CAPABILITY_ROUTE_LEVELS).not.toContain('official_key')
  })
})

describe('WP192 能力目录与输入白名单', () => {
  it('id 不重复；异步能力都有上限与默认条数；LinkedIn 默认关', () => {
    const ids = DATA_CAPABILITY_CATALOG.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of DATA_CAPABILITY_CATALOG.filter((x) => x.mode === 'async')) {
      expect(c.unit).toBe('item')
      expect(c.max_items).toBeGreaterThan(0)
      expect(c.default_items).toBeLessThanOrEqual(c.max_items ?? 0)
    }
    expect(dataCapabilitySpec('social.linkedin.profile')?.default_off).toBe(true)
    expect(dataCapabilitySpec('nope')).toBeUndefined()
  })

  it('白名单以外的字段丢掉；列表去空去重排序；账号名去 @ 小写；枚举归一', () => {
    const ig = dataCapabilitySpec('social.instagram.profile')
    if (ig === undefined) throw new Error('缺能力')
    expect(normalizeDataInput(ig, { usernames: [' @Bob ', 'alice', 'bob', ''], evil: 1 })).toEqual({
      ok: true,
      input: { usernames: ['alice', 'bob'] },
    })
    const product = dataCapabilitySpec('amazon.product')
    if (product === undefined) throw new Error('缺能力')
    expect(normalizeDataInput(product, { asins: ['b0abc12345'], marketplace: 'de' })).toEqual({
      ok: true,
      input: { asins: ['B0ABC12345'], marketplace: 'DE' },
    })
  })

  it('缺必填、超长、不在枚举、数字越界都回一句人话（不抛）', () => {
    const serp = dataCapabilitySpec('serp.google')
    const backlinks = dataCapabilitySpec('seo.backlinks')
    if (serp === undefined || backlinks === undefined) throw new Error('缺能力')
    expect(normalizeDataInput(serp, {})).toMatchObject({ ok: false, field: 'query' })
    expect(
      normalizeDataInput(serp, { query: 'x', country: 'US', language: 'en', device: 'tv' }),
    ).toMatchObject({ ok: false, field: 'device' })
    expect(
      normalizeDataInput(serp, { query: 'x'.repeat(401), country: 'us', language: 'en' }),
    ).toMatchObject({ ok: false, field: 'query' })
    expect(normalizeDataInput(backlinks, { target: 'a.com', limit: 5000 })).toMatchObject({
      ok: false,
      field: 'limit',
    })
    expect(normalizeDataInput(serp, 'not an object')).toMatchObject({ ok: false })
  })
})
