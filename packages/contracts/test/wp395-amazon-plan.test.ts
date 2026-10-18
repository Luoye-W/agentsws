/**
 * WP395（docs/106 A3 / docs/104 C2）：Amazon 运营岗位在划分建议里的两条规矩。
 *
 * 1. `amz.support` 挂在「客服」（默认勾）与「Amazon 运营」（列着、默认不勾）两个模板里——它的家是客服，
 *    与目录顺序无关；
 * 2. 只做 Amazon、没设客服岗：`amz.support` 跟着亚马逊店铺运营进「Amazon 运营」，不单独成一个只有它的「客服」。
 */
import { describe, expect, it } from 'vitest'
import {
  categoryOfRole,
  mentionsAmazon,
  type PositionCatalogEntry,
  proposePositions,
} from '../src/position-plan.js'

const CARE: PositionCatalogEntry = {
  id: 'customer-care',
  name: '客服',
  roles: [
    { id: 'dtc.support', default: true },
    { id: 'amz.support', default: true },
  ],
}
const WEB: PositionCatalogEntry = {
  id: 'web-ops',
  name: '网站运营',
  roles: [{ id: 'dtc.store', default: true }],
}
const AMZ: PositionCatalogEntry = {
  id: 'amazon-ops',
  name: 'Amazon 运营',
  roles: [
    { id: 'amz.store', default: true },
    { id: 'amz.support', default: false },
  ],
}

describe('amz.support 的家', () => {
  it('客服默认勾、Amazon 运营只列着 → 归客服，Amazon 运营排前面也一样', () => {
    expect(categoryOfRole('amz.support', [CARE, WEB, AMZ])?.id).toBe('customer-care')
    expect(categoryOfRole('amz.support', [AMZ, CARE, WEB])?.id).toBe('customer-care')
    expect(categoryOfRole('amz.store', [CARE, WEB, AMZ])?.id).toBe('amazon-ops')
  })
})

describe('划分建议（A3）', () => {
  it('只做 Amazon、没客服岗：amz.support 挂到 Amazon 运营', () => {
    expect(proposePositions(['amz.support', 'amz.store'], [CARE, WEB, AMZ])).toEqual([
      { name: 'Amazon 运营', role_ids: ['amz.store', 'amz.support'], template_id: 'amazon-ops' },
    ])
  })

  it('也有网站客服：amz.support 留在客服', () => {
    expect(proposePositions(['dtc.support', 'amz.support', 'amz.store'], [CARE, WEB, AMZ])).toEqual(
      [
        { name: '客服', role_ids: ['dtc.support', 'amz.support'], template_id: 'customer-care' },
        { name: 'Amazon 运营', role_ids: ['amz.store'], template_id: 'amazon-ops' },
      ],
    )
  })

  it('只选了 Amazon 客服（没有亚马逊店铺运营）：照旧是客服', () => {
    expect(proposePositions(['amz.support'], [CARE, WEB, AMZ])).toEqual([
      { name: '客服', role_ids: ['amz.support'], template_id: 'customer-care' },
    ])
  })

  it('没有职责挂在两个模板里时，结果与以前逐字相同', () => {
    expect(proposePositions(['dtc.store', 'dtc.support'], [CARE, WEB])).toEqual([
      { name: '客服', role_ids: ['dtc.support'], template_id: 'customer-care' },
      { name: '网站运营', role_ids: ['dtc.store'], template_id: 'web-ops' },
    ])
  })
})

describe('算不算提到了 Amazon', () => {
  it.each([
    ['我们在 Amazon 美国站卖电动自行车', true],
    ['亚马逊上有两个店', true],
    ['主要做FBA', true],
    ['手上有 20 个 ASIN', true],
    ['卖家后台天天看', true],
    ['Seller Central 的通知', true],
    ['我们做独立站', false],
    ['独立站的 listing 要优化', false],
  ])('%s → %s', (text, want) => {
    expect(mentionsAmazon(text)).toBe(want)
  })
})
