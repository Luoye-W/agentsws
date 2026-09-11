/**
 * 45 H2 / H4 的唯一键与相似度：**表驱动**。
 *
 * 一行一个真实会遇到的写法差异（大小写、协议、尾斜杠、全角、后缀、站点），
 * 于是"这条为什么被判成同一个"在测试里读得出来，不用去追函数。
 */
import type { ProductLineRule, RangeRef } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  compareProductLines,
  compareRangeGroups,
  compareStoreRanges,
  deriveStoreRanges,
  findOrgDuplicatePairs,
  findOrgSimilar,
  MEMBER_OVERLAP_SIMILAR,
  matchOrgObjects,
  memberOverlap,
  normalizeAmazonId,
  normalizeName,
  normalizeShopifyDomain,
  type OrgExisting,
  orgUniqueKey,
  platformOfRange,
  productLineKey,
  rangeGroupKey,
  ruleCriteria,
  storeRangeKey,
} from '../src/index.js'

const store = (id: string): RangeRef => ({ kind: 'store', id })

describe('45 H2 唯一键：店铺 / 平台账号范围 = 平台 + 归一化 id', () => {
  const shopify: [string, string, string][] = [
    ['原样', 'glass-bowl.myshopify.com', 'glass-bowl.myshopify.com'],
    ['大写', 'Glass-Bowl.MyShopify.com', 'glass-bowl.myshopify.com'],
    ['带协议', 'https://glass-bowl.myshopify.com', 'glass-bowl.myshopify.com'],
    ['带协议与尾斜杠', 'https://glass-bowl.myshopify.com/', 'glass-bowl.myshopify.com'],
    ['带 www', 'https://www.glass-bowl.myshopify.com/', 'glass-bowl.myshopify.com'],
    ['带后台路径', 'http://glass-bowl.myshopify.com/admin/orders', 'glass-bowl.myshopify.com'],
    ['带查询串', 'glass-bowl.myshopify.com?utm=1', 'glass-bowl.myshopify.com'],
    ['只有 handle', 'glass-bowl', 'glass-bowl.myshopify.com'],
    ['前后空白', '  glass-bowl.myshopify.com  ', 'glass-bowl.myshopify.com'],
    ['空串还是空串', '', ''],
  ]
  it.each(shopify)('Shopify %s', (_label, raw, expected) => {
    expect(normalizeShopifyDomain(raw)).toBe(expected)
  })

  const amazon: [string, string, string][] = [
    ['账号 + 站点', 'amz_na:US', 'AMZ_NA:US'],
    ['小写站点', 'amz_na:us', 'AMZ_NA:US'],
    ['带空白', ' amz_na : US ', 'AMZ_NA:US'],
    ['只有账号，站点留空', 'amz_na', 'AMZ_NA:'],
  ]
  it.each(amazon)('亚马逊 %s', (_label, raw, expected) => {
    expect(normalizeAmazonId(raw)).toBe(expected)
  })

  it('同一家店换十种写法都是同一把键；只有账号 ≠ 账号下的某个站', () => {
    const keys = new Set(
      shopify
        .filter(([label]) => label !== '空串还是空串')
        .map(([, raw]) => storeRangeKey({ platform: 'shopify', external_id: raw })),
    )
    expect(keys.size).toBe(1)
    expect(storeRangeKey({ platform: 'amazon', external_id: 'amz_na' })).not.toBe(
      storeRangeKey({ platform: 'amazon', external_id: 'amz_na:US' }),
    )
  })

  it('平台猜错的代价是当成两条，不会错合', () => {
    expect(platformOfRange({ kind: 'market', id: 'amz_na:US' })).toBe('amazon')
    expect(platformOfRange({ kind: 'account', id: 'amz_na' })).toBe('amazon')
    expect(platformOfRange(store('glass-bowl.myshopify.com'))).toBe('shopify')
    // 认不出的走 other：键不同 → 当两条
    expect(platformOfRange(store('store_main'))).toBe('other')
    expect(platformOfRange(store('store_main'), 'shopify')).toBe('shopify')
  })

  it('有一边平台没认出来（other）时按原样 id 比——公司那边的店铺范围是推出来的', () => {
    // 公司这边从岗位范围推出 `store_a`（推不出平台 → other），导入的包自报 shopify
    expect(
      compareStoreRanges(
        { platform: 'other', external_id: 'store_a' },
        { platform: 'shopify', external_id: 'store_a' },
      ).verdict,
    ).toBe('same')
    // 两边都认出平台且不同 → 仍然是两条
    expect(
      compareStoreRanges(
        { platform: 'amazon', external_id: 'store_a' },
        { platform: 'shopify', external_id: 'store_a' },
      ).verdict,
    ).toBe('none')
    // id 不同就还是不同
    expect(
      compareStoreRanges(
        { platform: 'other', external_id: 'store_a' },
        { platform: 'shopify', external_id: 'store_b' },
      ).verdict,
    ).toBe('none')
  })

  it('店铺范围只有 same / none：域名是身份证，不给"相似"', () => {
    const a = { platform: 'shopify', external_id: 'https://Glass-Bowl.myshopify.com/' } as const
    const b = { platform: 'shopify', external_id: 'glass-bowl' } as const
    const c = { platform: 'shopify', external_id: 'glass-bowl-eu.myshopify.com' } as const
    expect(compareStoreRanges(a, b).verdict).toBe('same')
    // 差一个词的两个域名不是"相似"，是两家店
    expect(compareStoreRanges(a, c).verdict).toBe('none')
  })
})

describe('45 H2 唯一键：品牌 = 名字归一化，或成员重合 ≥ 50%', () => {
  const names: [string, string, string][] = [
    ['原样', '品牌乙', '品牌乙'],
    ['带空格', '品牌 乙', '品牌乙'],
    ['全角空格', '品牌　乙', '品牌乙'],
    ['大小写', 'GlassBowl', 'glassbowl'],
    ['全角字母', 'ＧｌａｓｓＢｏｗｌ', 'glassbowl'],
    ['后缀「品牌」', '甲品牌', '甲'],
    ['后缀 Brand', 'Glass Bowl Brand', 'glassbowl'],
    ['后缀叠着写', '甲牌子品牌', '甲'],
    ['连接号', 'glass-bowl', 'glassbowl'],
  ]
  it.each(names)('名字归一化 %s', (_label, raw, expected) => {
    expect(normalizeName(raw)).toBe(expected)
  })

  it('归一化后同名 = same（可以直接合并成员取并集）', () => {
    const m = compareRangeGroups(
      { name: 'Glass Bowl Brand', members: [store('a')] },
      { name: 'ｇｌａｓｓ-ｂｏｗｌ', members: [store('b')] },
    )
    expect(m.verdict).toBe('same')
    expect(m.similarity).toBe(1)
    expect(rangeGroupKey('Glass Bowl Brand')).toBe(rangeGroupKey('glassbowl'))
  })

  it('「品牌乙」与「品牌B」名字不同，但成员重合 50% → similar（给人选）', () => {
    const mine = { name: '品牌乙', members: [store('store_a'), store('store_b')] }
    const theirs = { name: '品牌B', members: [store('store_a'), store('store_c')] }
    const m = compareRangeGroups(mine, theirs)
    expect(m.verdict).toBe('similar')
    // 交集 1 ÷ 较小那边 2 = 0.5，正好压线
    expect(m.similarity).toBe(MEMBER_OVERLAP_SIMILAR)
    expect(m.reasons.join('')).toContain('store_a')
  })

  const overlaps: [string, RangeRef[], RangeRef[], number][] = [
    ['一边为空', [], [store('a')], 0],
    ['完全一样', [store('a'), store('b')], [store('b'), store('a')], 1],
    ['一半', [store('a'), store('b')], [store('a'), store('c')], 0.5],
    ['小的被大的包住 = 1', [store('a')], [store('a'), store('b'), store('c')], 1],
    ['毫无重合', [store('a')], [store('b')], 0],
  ]
  it.each(overlaps)('成员重合度 %s', (_label, a, b, expected) => {
    expect(memberOverlap(a, b)).toBe(expected)
    expect(memberOverlap(b, a)).toBe(expected)
  })

  it('名字不同、成员也不重合 = 两个品牌，不打扰人', () => {
    expect(
      compareRangeGroups(
        { name: '品牌甲', members: [store('a')] },
        { name: '品牌丙', members: [store('z')] },
      ).verdict,
    ).toBe('none')
  })
})

describe('45 H2 唯一键：产品线 = 父范围 + 判据平台 + 判据集合', () => {
  const kitchen: ProductLineRule = { platform: 'shopify', tags: ['kitchen'] }
  const kitchenUpper: ProductLineRule = { platform: 'shopify', tags: ['Kitchen'] }
  const kitchenPlus: ProductLineRule = { platform: 'shopify', tags: ['kitchen', 'cookware'] }
  const outdoor: ProductLineRule = { platform: 'shopify', tags: ['outdoor'] }
  const amazonKitchen: ProductLineRule = { platform: 'amazon', asins: ['B01'] }

  it('判据摊平后排序，写的顺序不影响键', () => {
    expect(ruleCriteria({ platform: 'shopify', tags: ['b', 'a'] })).toEqual(['tag=a', 'tag=b'])
    expect(ruleCriteria({ platform: 'amazon', asins: ['B2'], brand: 'X' })).toEqual([
      'asin=b2',
      'brand=x',
    ])
    expect(ruleCriteria({ platform: 'manual', product_ids: ['p1'] })).toEqual(['product_id=p1'])
  })

  const table: [string, RangeRef, ProductLineRule, RangeRef, ProductLineRule, string][] = [
    ['父范围与判据都一样', store('s'), kitchen, store('s'), kitchen, 'same'],
    ['判据只差大小写', store('s'), kitchen, store('s'), kitchenUpper, 'same'],
    ['父范围不同 = 两条不相干的线', store('s'), kitchen, store('t'), kitchen, 'none'],
    ['判据平台不同 = 两条', store('s'), kitchen, store('s'), amazonKitchen, 'none'],
    ['判据有重叠不相等 = similar', store('s'), kitchen, store('s'), kitchenPlus, 'similar'],
    ['同一家店里毫无重叠的两条线 = none', store('s'), kitchen, store('s'), outdoor, 'none'],
  ]
  it.each(table)('%s', (_label, pa, ra, pb, rb, verdict) => {
    const m = compareProductLines({ parent: pa, rule: ra }, { parent: pb, rule: rb })
    expect(m.verdict).toBe(verdict)
    // 对称：谁在前谁在后结论一样
    expect(compareProductLines({ parent: pb, rule: rb }, { parent: pa, rule: ra }).verdict).toBe(
      verdict,
    )
  })

  it('唯一键相同 ⇔ same', () => {
    const a = { parent: store('s'), rule: kitchen }
    const b = { parent: store('s'), rule: kitchenUpper }
    expect(productLineKey(a)).toBe(productLineKey(b))
    expect(productLineKey(a)).not.toBe(productLineKey({ parent: store('s'), rule: kitchenPlus }))
  })

  it('相似的理由说得出重叠在哪、重合多少', () => {
    const m = compareProductLines(
      { parent: store('s'), rule: kitchen },
      { parent: store('s'), rule: kitchenPlus },
    )
    expect(m.similarity).toBe(1)
    expect(m.reasons.join('')).toContain('tag=kitchen')
  })

  it('两条都还没填判据 = same（都是空产品线）', () => {
    const empty: ProductLineRule = { platform: 'shopify' }
    expect(
      compareProductLines({ parent: store('s'), rule: empty }, { parent: store('s'), rule: empty })
        .verdict,
    ).toBe('same')
  })
})

describe('45 H4 建之前先查：同唯一键或相似的三类对象', () => {
  const brandB: OrgExisting = {
    kind: 'range_group',
    id: 'rg_b',
    name: '品牌B',
    members: [store('store_a'), store('store_c')],
    created_by: 'per_wang',
    holders: 3,
  }
  const brandA: OrgExisting = {
    kind: 'range_group',
    id: 'rg_a',
    name: '品牌甲',
    members: [store('store_main')],
    holders: 1,
  }

  it('唯一键：三类各算各的，同一把键 = 同一个东西', () => {
    expect(orgUniqueKey({ kind: 'range_group', name: '品牌乙', members: [] })).toBe(
      rangeGroupKey('品牌乙'),
    )
    expect(
      orgUniqueKey({
        kind: 'product_line',
        name: '厨房线',
        parent: store('s'),
        rule: { platform: 'shopify', tags: ['kitchen'] },
      }),
    ).toBe(productLineKey({ parent: store('s'), rule: { platform: 'shopify', tags: ['kitchen'] } }))
    expect(
      orgUniqueKey({
        kind: 'store_range',
        name: '店 A',
        platform: 'shopify',
        external_id: 'glass-bowl',
      }),
    ).toBe(storeRangeKey({ platform: 'shopify', external_id: 'glass-bowl.myshopify.com' }))
  })

  it('kind 是道门：不同类的永远 none', () => {
    expect(
      matchOrgObjects(
        { kind: 'range_group', name: 'x', members: [] },
        { kind: 'store_range', name: 'x', platform: 'other', external_id: 'x' },
      ).verdict,
    ).toBe('none')
  })

  it('命中说得出"谁建的、几个岗位挂着"，same 排在 similar 前面', () => {
    // 名字归一化后一样 → same；成员大半重合 → similar
    const hits = findOrgSimilar(
      { kind: 'range_group', name: '品牌 B', members: [store('store_a'), store('store_b')] },
      [brandA, brandB],
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      id: 'rg_b',
      verdict: 'same',
      created_by: 'per_wang',
      holders: 3,
    })
    // 名字不同、成员重合 50% → similar
    const similar = findOrgSimilar(
      { kind: 'range_group', name: '品牌乙', members: [store('store_a'), store('store_b')] },
      [brandA, brandB],
    )
    expect(similar.map((h) => h.verdict)).toEqual(['similar'])
    expect(similar[0]?.reasons.join('')).toContain('成员重合')
    // 什么都不像 → 一条都不回，照常建
    expect(
      findOrgSimilar({ kind: 'range_group', name: '品牌丙', members: [store('store_x')] }, [
        brandA,
        brandB,
      ]),
    ).toEqual([])
  })

  it('改一条已有对象时把它自己排掉（不然它永远和自己一模一样）', () => {
    const q = { kind: 'range_group' as const, name: '品牌B', members: brandB.members }
    expect(findOrgSimilar(q, [brandB])).toHaveLength(1)
    expect(findOrgSimilar(q, [brandB], { exclude_id: 'rg_b' })).toEqual([])
  })

  it('limit 截断，但截的是排过序的（第一条永远是最该直接用的那个）', () => {
    const many: OrgExisting[] = [
      brandB,
      { kind: 'range_group', id: 'rg_c', name: '品牌 B ', members: [], holders: 0 },
    ]
    expect(findOrgSimilar(q0(), many, { limit: 1 }).map((h) => h.verdict)).toEqual(['same'])
    function q0() {
      return { kind: 'range_group' as const, name: '品牌B', members: [store('store_a')] }
    }
  })

  it('夜间扫描：两两比，每对只出一次，顺序稳定', () => {
    const dupes = findOrgDuplicatePairs([
      { kind: 'range_group', id: 'rg_2', name: '品牌 B', members: [], holders: 0 },
      brandB,
      brandA,
    ])
    expect(dupes).toHaveLength(1)
    // 对里两条按 id 排定：谁先扫到都是同一对，于是去重键每晚算出来都一样
    expect([dupes[0]?.a.id, dupes[0]?.b.id]).toEqual(['rg_2', 'rg_b'])
    expect(dupes[0]?.verdict).toBe('same')
    expect(dupes[0]?.unique_key).toBe(rangeGroupKey('品牌B'))
    expect(findOrgDuplicatePairs([brandA])).toEqual([])
    expect(findOrgDuplicatePairs([brandB, brandA], { limit: 0 })).toEqual([])
  })

  it('店铺范围是推出来的：岗位范围、品牌成员、产品线归属并起来，部门与产品线不算', () => {
    const rows = deriveStoreRanges({
      assignment_ranges: [
        store('glass-bowl.myshopify.com'),
        { kind: 'department', id: 'dept_ops' },
        { kind: 'product_line', id: 'pl_kitchen' },
      ],
      range_groups: [{ ...brandB, workspace_id: 'ws', created_at: '', updated_at: '' }],
      product_lines: [
        {
          id: 'pl_1',
          workspace_id: 'ws',
          name: '厨房线',
          parent: { kind: 'account', id: 'AMZ1:US' },
          rule: { platform: 'manual', product_ids: [] },
          created_at: '',
          updated_at: '',
        },
      ],
    })
    expect(rows.map((r) => r.range.id).sort()).toEqual([
      'AMZ1:US',
      'glass-bowl.myshopify.com',
      'store_a',
      'store_c',
    ])
    expect(rows.find((r) => r.range.id === 'AMZ1:US')?.platform).toBe('amazon')
    // 同一家店两种写法只留一条（归一化后是同一把键）
    const once = deriveStoreRanges({
      assignment_ranges: [store('Glass-Bowl.MyShopify.com/')],
      range_groups: [],
      product_lines: [],
      extra: [
        {
          range: store('glass-bowl.myshopify.com'),
          platform: 'shopify',
          external_id: 'glass-bowl.myshopify.com',
          name: '主店',
        },
      ],
    })
    expect(once).toHaveLength(1)
    expect(once[0]?.name).toBe('主店')
  })
})
