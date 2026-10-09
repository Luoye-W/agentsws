/**
 * WP287：岗位输入框里的话是「问」还是「交办」；岗位入口永远不出选择卡（`settleAlways`）。
 */
import { describe, expect, it } from 'vitest'
import {
  classifyEntryIntent,
  type RouteWithinPositionResult,
  settleAlways,
  settleCloseCall,
  settleNoHit,
} from '../src/index.js'

describe('WP287 问一句还是交一件事', () => {
  it.each([
    '现在店铺里有哪些产品',
    '今天有几单',
    '上周卖得怎么样？',
    '怎么给商品改价格',
    '如何设置运费',
    '最近发了几封开发信',
    '这个月退款的订单有没有超过 10 单',
    '店铺里的商品价格改过吗',
    '客户问退货',
    '看看这周',
    'what products are in my store?',
  ])('「%s」是问', (text) => {
    expect(classifyEntryIntent(text).intent).toBe('ask')
  })

  it.each([
    '帮我做一份 Reddit 调研，看看大家怎么评价我们',
    '把这款耳机的价格改成 59.9',
    '把 A 商品降价 10%',
    '下架所有缺货的商品',
    '给这位客户回复一下物流情况',
    '写一篇新品上市的博客',
    '新建一个首页模板',
    'update the price of the blue case to $19',
  ])('「%s」是交办', (text) => {
    expect(classifyEntryIntent(text).intent).toBe('task')
  })

  it('一大段需求（多行、没问号）按交办', () => {
    const long = '首页想要三屏：\n第一屏大图和一句口号\n第二屏三款主推'
    expect(classifyEntryIntent(long)).toEqual({ intent: 'task', why: 'long' })
  })

  it('一大段但以问号结尾，仍是问', () => {
    const q = `${'我们店最近的转化率一直在掉，广告也开着，流量看着没少，'.repeat(2)}到底是哪一步出了问题？`
    expect(classifyEntryIntent(q).intent).toBe('ask')
  })

  it('判不准的短句默认按问（先答）', () => {
    expect(classifyEntryIntent('Reddit 那边')).toEqual({ intent: 'ask', why: 'default' })
  })
})

const roles = [
  { role_id: 'dtc.fulfillment', role_name: '订单履约' },
  { role_id: 'dtc.store', role_name: '店铺管理' },
  { role_id: 'site.shopify-build', role_name: 'Shopify 整站搭建' },
  { role_id: 'site.shopify-theme', role_name: 'Shopify 网页模板' },
]

describe('WP287 岗位入口不出选择卡', () => {
  it('四条各 0.25（真机现场）→ 按岗位里职责的先后取第一条，其余三条留作「换一条」', () => {
    const flat: RouteWithinPositionResult = {
      candidates: [
        {
          role_id: 'site.shopify-theme',
          role_name: 'Shopify 网页模板',
          score: 0.25,
          why: ['店铺'],
        },
        { role_id: 'dtc.store', role_name: '店铺管理', score: 0.25, why: ['店铺'] },
        { role_id: 'dtc.fulfillment', role_name: '订单履约', score: 0.25, why: ['店铺'] },
        {
          role_id: 'site.shopify-build',
          role_name: 'Shopify 整站搭建',
          score: 0.25,
          why: ['店铺'],
        },
      ],
      ambiguous: true,
      reason: '这件事像「Shopify 网页模板」也像「店铺管理」，你定',
    }
    const order = roles.map((r) => r.role_id)
    const out = settleAlways(settleNoHit(settleCloseCall(flat, order), roles), roles)
    expect(out.ambiguous).toBe(false)
    expect(out.picked).toBe('dtc.fulfillment')
    expect(out.settled).toBe(true)
    expect(out.alternatives?.map((a) => a.role_id)).toEqual([
      'dtc.store',
      'site.shopify-build',
      'site.shopify-theme',
    ])
  })

  it('有分高的就取分高的（哪怕不到 0.3）', () => {
    const out = settleAlways(
      {
        candidates: [
          { role_id: 'dtc.store', role_name: '店铺管理', score: 0.28, why: ['商品'] },
          { role_id: 'dtc.fulfillment', role_name: '订单履约', score: 0.24, why: [] },
          { role_id: 'site.shopify-build', role_name: 'Shopify 整站搭建', score: 0.24, why: [] },
          { role_id: 'site.shopify-theme', role_name: 'Shopify 网页模板', score: 0.24, why: [] },
        ],
        ambiguous: true,
        reason: '',
      },
      roles,
    )
    expect(out.picked).toBe('dtc.store')
    expect(out.reason).toContain('按「店铺管理」')
  })

  it('一个都没命中：取第一条', () => {
    const out = settleAlways({ candidates: [], ambiguous: true, reason: '' }, roles)
    expect(out.picked).toBe('dtc.fulfillment')
    expect(out.alternatives).toHaveLength(3)
  })

  it('判得准的原样返回', () => {
    const sure: RouteWithinPositionResult = {
      picked: 'dtc.store',
      candidates: [],
      ambiguous: false,
      reason: 'x',
    }
    expect(settleAlways(sure, roles)).toBe(sure)
  })
})
