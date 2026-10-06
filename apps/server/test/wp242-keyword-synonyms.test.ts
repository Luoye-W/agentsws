/**
 * WP242：AI 不在、退回按词对时认得常见说法（Fable 10-06 真机：Rollout 那句话一条都推不准）。
 * 「独立站 / Shopify / 建站 / 主题」→ 建站；「社媒」→ 社媒运营；「红人 / 达人 / KOL」→ 红人营销；
 * 「广告 / 投放」→ 投放；「客服 / 售前售后」→ 客服（Amazon 客服只在提到 Amazon 时推）；「设计 / 出图」→ 设计。
 */
import { describe, expect, it } from 'vitest'
import { type SuggestCatalogRole, suggestPositions } from '../src/onboarding-suggest.js'
import { ROLLOUT_TEXT } from './wp242-fixtures.js'

const role = (
  id: string,
  name: string,
  category_id: string,
  category: string,
  isDefault = true,
): SuggestCatalogRole => ({
  id,
  name,
  category_id,
  category,
  what_it_does: name,
  default: isDefault,
})

/** 与出厂目录同形的一小份（类别名、默认勾不勾都照真的抄）。 */
const ROLES: SuggestCatalogRole[] = [
  role('dtc.support', '网站客服', 'customer-care', '客服'),
  role('dtc.live-chat', '网站在线客服', 'customer-care', '客服'),
  role('amz.support', 'Amazon 客服', 'customer-care', '客服'),
  role('kol.youtube', 'YouTube 红人', 'kol-marketing', '红人营销'),
  role('kol.instagram', 'Instagram 红人', 'kol-marketing', '红人营销'),
  role('kol.x', 'X 红人', 'kol-marketing', '红人营销', false),
  role('social.instagram', 'Instagram 运营', 'social-media', '社媒运营'),
  role('social.youtube', 'YouTube 运营', 'social-media', '社媒运营'),
  role('social.discord', 'Discord 运营', 'social-media', '社媒运营', false),
  role('ads.meta', 'Meta Ads', 'ads', '投放'),
  role('ads.google', 'Google Ads', 'ads', '投放'),
  role('site.shopify-build', 'Shopify 整站搭建', 'site', '建站'),
  role('site.shopify-theme', 'Shopify 网页模板', 'site', '建站'),
  role('design.dtc', '独立站设计', 'design', '设计'),
  role('design.amazon', 'Amazon 设计', 'design', '设计'),
]
const CATALOG = [...new Map(ROLES.map((r) => [r.category_id, r.category])).entries()].map(
  ([id, name]) => ({
    id,
    name,
    roles: ROLES.filter((r) => r.category_id === id).map((r) => ({ id: r.id })),
  }),
)

const ids = async (text: string): Promise<string[]> => {
  const out = await suggestPositions({ text, catalog: CATALOG, roles: ROLES, suggester: undefined })
  expect(out.source).toBe('keyword')
  for (const r of out.roles) if (r.quote !== undefined) expect(text).toContain(r.quote)
  return out.roles.map((r) => r.role_id).sort()
}

describe('WP242 按词对：常见说法', () => {
  it('Rollout 那句话：建站、社媒、红人、投放、客服都推上；不推 Amazon 客服、不推非默认的', async () => {
    const got = await ids(ROLLOUT_TEXT)
    expect(got).toEqual(
      [
        'site.shopify-build',
        'site.shopify-theme',
        'social.instagram',
        'social.youtube',
        'kol.youtube',
        'kol.instagram',
        'ads.meta',
        'ads.google',
        'dtc.support',
        'dtc.live-chat',
      ].sort(),
    )
    expect(got).not.toContain('amz.support')
    expect(got).not.toContain('kol.x')
    expect(got).not.toContain('social.discord')
  })

  it('一个说法一个说法地认', async () => {
    expect(await ids('我们有个独立站')).toEqual(['site.shopify-build', 'site.shopify-theme'])
    expect(await ids('想换个主题')).toEqual(['site.shopify-build', 'site.shopify-theme'])
    expect(await ids('找几个 KOL')).toEqual(['kol.instagram', 'kol.youtube'])
    expect(await ids('做做社媒')).toEqual(['social.instagram', 'social.youtube'])
    expect(await ids('要投广告')).toEqual(['ads.google', 'ads.meta'])
    expect(await ids('售前售后')).toEqual(['dtc.live-chat', 'dtc.support'])
    expect(await ids('帮我出图')).toEqual(['design.dtc'])
  })

  it('提到 Amazon 才推 Amazon 那几条', async () => {
    expect(await ids('Amazon 店的客服也要管')).toContain('amz.support')
    expect(await ids('亚马逊上的图也要设计')).toContain('design.amazon')
    expect(await ids('客服')).not.toContain('amz.support')
  })
})
