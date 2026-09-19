/**
 * 编排：分流、算钱、封顶，以及**重新分析不覆盖手改**（70 §3）。
 *
 * 最后那一条是整个 WP121 最要紧的一条用例。它保护的不是数据，是那个按钮：
 * "重新分析"只要吃掉过一次用户的手工修改，之后就再没有人敢按它。
 */

import { describe, expect, it } from 'vitest'
import {
  analyzeBrand,
  applyEdits,
  CREDITS_PER_PAGE,
  classifyUrl,
  estimateCredits,
  field,
  mergeProfile,
  needsConfirm,
} from '../src/index.js'
import { AMAZON_PAGES, replayFetch, SHOP, SHOP_PAGES } from './fixtures.js'

const ALL = { ...SHOP_PAGES, ...AMAZON_PAGES }

describe('WP121 · 分流与预估', () => {
  it('三种链接各归各的', () => {
    expect(classifyUrl(`${SHOP}/`)).toBe('website')
    expect(classifyUrl('https://www.amazon.com/dp/B08XYZ1234')).toBe('amazon_listing')
    expect(classifyUrl('https://www.amazon.com/stores/nordvik')).toBe('amazon_storefront')
    expect(classifyUrl('随便打的几个字')).toBe('none')
  })

  it('预估是给用户开跑前看的，官网比 Amazon 贵（页面多）', () => {
    expect(estimateCredits([`${SHOP}/`])).toBeGreaterThan(
      estimateCredits(['https://www.amazon.com/dp/B08XYZ1234']),
    )
    // 正常情况下不该撞上 2 积分的封顶
    expect(estimateCredits([`${SHOP}/`])).toBeLessThanOrEqual(2)
  })
})

describe('WP121 · 跑一遍', () => {
  it('官网 + Amazon 一起贴：先到的填格子，后到的只补空格', async () => {
    const { fetch } = replayFetch(ALL)
    const out = await analyzeBrand(fetch, [`${SHOP}/`, 'https://www.amazon.com/dp/B08XYZ1234'])
    // 品牌名两边都有，官网先到，所以留官网那个
    expect(out.profile.brand_name?.value).toBe('Nordvik Supply')
    // 评分只有 Amazon 有 → 补上了
    expect(out.profile.rating?.value).toBe(4.6)
    expect(out.stopped_for_budget).toBe(false)
  })

  it('封顶：到顶就停，但**已经抓到的照样交**', async () => {
    const { fetch } = replayFetch(ALL)
    // 只够抓两页
    const out = await analyzeBrand(fetch, [`${SHOP}/`], { capCredits: CREDITS_PER_PAGE * 2 })
    expect(out.stopped_for_budget).toBe(true)
    expect(out.budget.spent_credits).toBeLessThanOrEqual(out.budget.cap_credits)
    // 停了，但首页那几格是有的——两头落空才是最糟的结果
    expect(out.profile.brand_name?.value).toBe('Nordvik Supply')
  })

  it('花的钱只按**真抓着的**页面算', async () => {
    const { fetch } = replayFetch(SHOP_PAGES, { [`${SHOP}/pages/contact`]: 404 })
    const out = await analyzeBrand(fetch, [`${SHOP}/`])
    const ok = out.pages.filter((p) => p.ok).length
    expect(out.budget.spent_credits).toBeCloseTo(ok * CREDITS_PER_PAGE, 5)
    // 没抓着的那一页不收钱
    expect(out.pages.some((p) => !p.ok)).toBe(true)
  })

  it('一条都认不出来：不跑，也不炸', async () => {
    const { fetch, calls } = replayFetch(ALL)
    const out = await analyzeBrand(fetch, ['这不是网址'])
    expect(calls).toHaveLength(0)
    expect(out.pages).toHaveLength(0)
    expect(out.budget.spent_credits).toBe(0)
  })
})

describe('WP121 · 重新分析不覆盖手改', () => {
  const at = '2026-09-19T00:00:00.000Z'

  it('用户改过的那一格：重跑之后原样留着', () => {
    const first = { brand_name: field('Nordvic Suply', 'selector', { url: 'https://x.example/' }) }
    // 用户把拼错的名字改对了
    const edited = applyEdits(first, { brand_name: 'Nordvik Supply' }, at)
    expect(edited.brand_name?.edited).toBe(true)
    expect(edited.brand_name?.confidence).toBe('high')

    // 一周后换了新品重跑一次，机器又抽出了那个拼错的名字
    const second = { brand_name: field('Nordvic Suply', 'selector', { url: 'https://x.example/' }) }
    const merged = mergeProfile(edited, second)
    // **不动**。只要吃掉过一次手改，这个按钮就没人敢按了
    expect(merged.brand_name?.value).toBe('Nordvik Supply')
    expect(merged.brand_name?.edited).toBe(true)
  })

  it('没改过的格子照常被新值覆盖——这才是「重新分析」要的效果', () => {
    const first = { one_liner: field('旧的一句话', 'og', { url: 'https://x.example/' }) }
    const second = { one_liner: field('新的一句话', 'og', { url: 'https://x.example/' }) }
    expect(mergeProfile(first, second).one_liner?.value).toBe('新的一句话')
  })

  it('这一轮没抓到、上一轮有：留着上一轮的', () => {
    const first = { support_email: field('a@x.example', 'selector', { url: 'https://x.example/' }) }
    // 联系页这次 502 了——那不等于"这家店现在没有客服邮箱"
    expect(mergeProfile(first, {}).support_email?.value).toBe('a@x.example')
  })

  it('改成空 = 这一格我不要，删掉而不是留个空值', () => {
    const first = { support_email: field('a@x.example', 'selector', { url: 'https://x.example/' }) }
    const out = applyEdits(first, { support_email: null }, at)
    // 留一个空字符串的话界面会画出一行空格子，比没有更糟
    expect('support_email' in out).toBe(false)
  })

  it('低把握的标「请确认」，改过的不标', () => {
    const low = field('猜的', 'model', { url: 'https://x.example/' })
    expect(needsConfirm(low)).toBe(true)
    expect(needsConfirm(field('明写的', 'jsonld', { url: 'https://x.example/' }))).toBe(false)
    expect(
      needsConfirm(applyEdits({ one_liner: low }, { one_liner: '改过了' }, at).one_liner),
    ).toBe(false)
    expect(needsConfirm(undefined)).toBe(false)
  })
})
