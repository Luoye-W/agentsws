import { describe, expect, it } from 'vitest'
import {
  channelOfRole,
  checkSuggestedPositions,
  MAX_DUTIES_PER_POSITION,
  type PositionCatalogEntry,
  proposePositions,
  rolesOfPlan,
} from '../src/position-plan.js'

const ids = (...xs: string[]) => xs.map((id) => ({ id }))
const CATALOG: PositionCatalogEntry[] = [
  { id: 'customer-care', name: '客服', roles: ids('dtc.support', 'dtc.live-chat', 'amz.support') },
  { id: 'web-ops', name: '网站运营', roles: ids('dtc.store', 'dtc.content') },
  {
    id: 'social-media',
    name: '社媒运营',
    roles: ids(
      'social.facebook',
      'social.instagram',
      'social.threads',
      'social.linkedin',
      'social.tiktok',
      'social.x',
      'social.youtube',
      'social.reddit',
      'social.discord',
    ),
  },
  { id: 'pr', name: '公共关系', roles: ids('pr.reddit', 'pr.press', 'pr.monitoring') },
  { id: 'kol-marketing', name: '红人营销', roles: ids('kol.youtube', 'kol.instagram') },
  { id: 'site', name: '建站', roles: ids('site.shopify-build', 'site.shopify-theme') },
]

describe('WP234 岗位划分建议（docs/54 §6.3）', () => {
  it('INMO 只做 Reddit：公关的 Reddit + 社媒的 Reddit 并成一个「Reddit 运营」', () => {
    expect(proposePositions(['pr.reddit', 'social.reddit'], CATALOG)).toEqual([
      { name: 'Reddit 运营', role_ids: ['social.reddit', 'pr.reddit'] },
    ])
  })

  it('建站 + 营销推广：按类别拆成两个岗位，复用模板 id', () => {
    const out = proposePositions(['site.shopify-build', 'social.tiktok', 'social.youtube'], CATALOG)
    expect(out.map((p) => p.name)).toEqual(['社媒运营', '建站'])
    expect(out[1]?.template_id).toBe('site')
  })

  it('类别里不止一个渠道就不按渠道拆：红人 YouTube + Instagram 留在红人营销', () => {
    const out = proposePositions(['kol.youtube', 'kol.instagram', 'social.youtube'], CATALOG)
    expect(out.map((p) => p.name)).toEqual(['社媒运营', '红人营销'])
  })

  it(`超过 ${MAX_DUTIES_PER_POSITION} 条就建议拆，均分；阈值可调`, () => {
    const social = CATALOG[2]?.roles.map((r) => r.id) ?? []
    const out = proposePositions(social, CATALOG)
    expect(out.map((p) => [p.name, p.role_ids.length])).toEqual([
      ['社媒运营 · 1', 5],
      ['社媒运营 · 2', 4],
    ])
    expect(proposePositions(social, CATALOG, { max: 9 })).toHaveLength(1)
  })

  it('目录里没有的职责不丢，归「其他」；去重、顺序稳定', () => {
    const out = proposePositions(['x.unknown', 'dtc.store', 'dtc.store'], CATALOG)
    expect(out).toEqual([
      { name: '网站运营', role_ids: ['dtc.store'], template_id: 'web-ops' },
      { name: '其他', role_ids: ['x.unknown'] },
    ])
    expect(rolesOfPlan(out)).toEqual(['dtc.store', 'x.unknown'])
  })

  it('一条都没选就是空清单', () => {
    expect(proposePositions([], CATALOG)).toEqual([])
  })

  it('渠道只认得出那几个后缀', () => {
    expect(channelOfRole('pr.reddit')).toBe('reddit')
    expect(channelOfRole('dtc.support')).toBeUndefined()
  })

  it('AI 给的划分：每条恰好一次、只用推荐的、每个不超阈值、名字非空', () => {
    const allowed = ['pr.reddit', 'social.reddit']
    expect(
      checkSuggestedPositions(
        [{ name: 'Reddit', role_ids: ['pr.reddit', 'social.reddit'] }],
        allowed,
      ),
    ).toEqual({ ok: true })
    expect(checkSuggestedPositions([{ name: 'A', role_ids: ['pr.reddit'] }], allowed).ok).toBe(
      false,
    )
    expect(
      checkSuggestedPositions(
        [
          { name: 'A', role_ids: ['pr.reddit'] },
          { name: 'B', role_ids: ['pr.reddit', 'social.reddit'] },
        ],
        allowed,
      ).ok,
    ).toBe(false)
    expect(
      checkSuggestedPositions([{ name: ' ', role_ids: ['pr.reddit', 'social.reddit'] }], allowed)
        .ok,
    ).toBe(false)
    expect(
      checkSuggestedPositions([{ name: 'A', role_ids: ['pr.reddit', 'dtc.store'] }], allowed).ok,
    ).toBe(false)
    expect(
      checkSuggestedPositions([{ name: 'A', role_ids: allowed }], allowed, { max: 1 }).ok,
    ).toBe(false)
  })
})
