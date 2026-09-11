/**
 * WP47 / 44：品牌（范围组）与产品线。
 *
 * 钉四件事：
 * 1. 挂品牌 = 判权限时展开成成员，岗位上存的是展开后的那一份（G1）；
 * 2. 一个岗位挂店铺 + 品牌 + 产品线取并集（G3）；
 * 3. 品牌加了一家店 → 挂它的岗位自动多这家店，而且**留痕**（G5）；
 * 4. 产品线算范围（不是"未分配范围"），写动作的目标不在线里就拒（G2）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMarketId } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRoleStore,
  expandRanges,
  productLineMatches,
  type RangeExpanded,
  RoleError,
  type RoleStore,
  rangeCoversRef,
  shopifyLineQuery,
} from '../src/index.js'
import { aftersales, fixedClock, member, owner } from './helpers.js'

const dirs: string[] = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-ranges-'))
  dirs.push(dir)
  return join(dir, 'roles.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const WS = 'ws_1'
const store = (extra: { onRangeExpanded?: (e: RangeExpanded) => void; dbPath?: string } = {}) =>
  createRoleStore({
    clock: fixedClock(),
    roles: [aftersales(), member(), owner()],
    ...extra,
  })

const grant = (s: RoleStore, input: Parameters<RoleStore['assignments']['create']>[0]) =>
  s.assignments.create(input)

describe('44 G1 品牌 = 范围组', () => {
  it('挂品牌的岗位存的是展开后的范围，另记从哪个品牌来的', () => {
    const s = store()
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [
        { kind: 'store', id: 'store_b1' },
        { kind: 'account', id: 'amz_na' },
      ],
    })
    const a = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    expect(a.ranges).toEqual([
      { kind: 'store', id: 'store_b1' },
      { kind: 'account', id: 'amz_na' },
    ])
    expect(a.range_groups).toEqual([brand.id])
    // 展开进了 EffectiveConfig，于是 assigned 范围的查询立刻有效
    const config = s.effectiveConfig(a.id)
    expect(config.unassigned_range).toBe(false)
    expect(config.range_groups).toEqual([brand.id])
    expect(s.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(true)
    s.close()
  })

  it('挂不存在的品牌直接 not_found；跨工作区的品牌不给挂', () => {
    const s = store()
    expect(() =>
      grant(s, {
        person_id: 'p_li',
        workspace_id: WS,
        role_id: 'dtc.aftersales',
        range_groups: ['rg_nope'],
        granted_by: 'p_wang',
      }),
    ).toThrow(RoleError)
    const other = s.rangeGroups.create({ workspace_id: 'ws_2', name: '别家的品牌' })
    expect(() =>
      grant(s, {
        person_id: 'p_li',
        workspace_id: WS,
        role_id: 'dtc.aftersales',
        range_groups: [other.id],
        granted_by: 'p_wang',
      }),
    ).toThrow(/不属于工作区/)
    s.close()
  })

  it('还有岗位挂着的品牌 / 产品线不给删', () => {
    const s = store()
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌甲',
      members: [{ kind: 'store', id: 'store_a' }],
    })
    grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    expect(() => {
      s.rangeGroups.delete(brand.id)
    }).toThrow(/还有 1 个岗位挂着/)
    s.close()
  })
})

describe('44 G3 一岗位多范围取并集', () => {
  it('店铺 + 品牌 + 产品线三种入口并在一起，去重保序', () => {
    const s = store()
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [
        { kind: 'store', id: 'store_b1' },
        // 与显式挂的那条重复：并集去重
        { kind: 'store', id: 'store_main' },
      ],
    })
    const line = s.productLines.create({
      workspace_id: WS,
      name: '厨房线',
      parent: { kind: 'market', id: 'amz_na:US' },
      rule: { platform: 'amazon', asins: ['B0KITCHEN'] },
    })
    const a = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [
        { kind: 'store', id: 'store_main' },
        { kind: 'product_line', id: line.id },
      ],
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    expect(a.ranges).toEqual([
      { kind: 'store', id: 'store_main' },
      { kind: 'product_line', id: line.id },
      { kind: 'store', id: 'store_b1' },
    ])
    s.close()
  })

  it('摘掉品牌，它贡献的那几个范围一起走', () => {
    const s = store()
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [{ kind: 'store', id: 'store_b1' }],
    })
    const a = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'store_main' }],
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    expect(a.ranges).toHaveLength(2)
    const after = s.assignments.update(a.id, { range_groups: [] })
    expect(after.ranges).toEqual([{ kind: 'store', id: 'store_main' }])
    expect(after.range_groups).toBeUndefined()
    s.close()
  })

  it('老调用方只传 ranges（已展开的那一份）时语义不变', () => {
    const s = store()
    const a = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'store_main' }],
      granted_by: 'p_wang',
    })
    const after = s.assignments.update(a.id, {
      ranges: [
        { kind: 'store', id: 'store_main' },
        { kind: 'store', id: 'store_eu' },
      ],
    })
    expect(after.ranges.map((r) => r.id)).toEqual(['store_main', 'store_eu'])
    s.close()
  })
})

describe('44 G5 品牌变了自动跟、留痕', () => {
  it('品牌新开一家店 → 挂它的岗位自动多这家店，每条分配喊一声', () => {
    const seen: RangeExpanded[] = []
    const s = store({
      onRangeExpanded: (e) => {
        seen.push(e)
      },
    })
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [{ kind: 'store', id: 'store_b1' }],
    })
    const a = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    const b = grant(s, {
      person_id: 'p_chen',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    s.rangeGroups.update(brand.id, {
      members: [
        { kind: 'store', id: 'store_b1' },
        { kind: 'store', id: 'store_b2' },
      ],
    })
    expect(seen).toHaveLength(2)
    expect(seen.map((e) => e.assignment_id).sort()).toEqual([a.id, b.id].sort())
    expect(seen[0]?.added).toEqual([{ kind: 'store', id: 'store_b2' }])
    expect(seen[0]?.removed).toEqual([])
    expect(seen[0]?.range_group_name).toBe('品牌乙')
    expect(s.assignments.require(a.id).ranges.map((r) => r.id)).toEqual(['store_b1', 'store_b2'])
    s.close()
  })

  it('品牌关掉一家店 → 挂它的岗位跟着少一家；没挂它的岗位一个字不动', () => {
    const seen: RangeExpanded[] = []
    const s = store({
      onRangeExpanded: (e) => {
        seen.push(e)
      },
    })
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [
        { kind: 'store', id: 'store_b1' },
        { kind: 'store', id: 'store_b2' },
      ],
    })
    const attached = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    const loner = grant(s, {
      person_id: 'p_chen',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'store_b2' }],
      granted_by: 'p_wang',
    })
    s.rangeGroups.update(brand.id, { members: [{ kind: 'store', id: 'store_b1' }] })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.removed).toEqual([{ kind: 'store', id: 'store_b2' }])
    expect(s.assignments.require(attached.id).ranges).toEqual([{ kind: 'store', id: 'store_b1' }])
    expect(s.assignments.require(loner.id).ranges).toEqual([{ kind: 'store', id: 'store_b2' }])
    s.close()
  })

  it('只改名字不动成员时不算一次扩范围', () => {
    const seen: RangeExpanded[] = []
    const s = store({
      onRangeExpanded: (e) => {
        seen.push(e)
      },
    })
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [{ kind: 'store', id: 'store_b1' }],
    })
    grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    expect(s.rangeGroups.update(brand.id, { name: 'Brand B' }).name).toBe('Brand B')
    expect(seen).toHaveLength(0)
    s.close()
  })

  it('已撤销的岗位不跟着变', () => {
    const seen: RangeExpanded[] = []
    const s = store({
      onRangeExpanded: (e) => {
        seen.push(e)
      },
    })
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [{ kind: 'store', id: 'store_b1' }],
    })
    const a = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    s.assignments.revoke(a.id)
    s.rangeGroups.update(brand.id, {
      members: [
        { kind: 'store', id: 'store_b1' },
        { kind: 'store', id: 'store_b2' },
      ],
    })
    expect(seen).toHaveLength(0)
    s.close()
  })
})

describe('44 G2 产品线', () => {
  it('只挂产品线的岗位不是"未分配范围"，assigned 查询照常判得过', () => {
    const s = store()
    const line = s.productLines.create({
      workspace_id: WS,
      name: '厨房线',
      parent: { kind: 'store', id: 'store_main' },
      rule: { platform: 'manual', product_ids: ['prod_1', 'prod_2'] },
    })
    const a = grant(s, {
      person_id: 'p_zhao',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'product_line', id: line.id }],
      granted_by: 'p_wang',
    })
    expect(s.effectiveConfig(a.id).unassigned_range).toBe(false)
    expect(s.can(a.id, 'order', 'read', { range: 'assigned', sensitivity: 'internal' })).toBe(true)
    s.close()
  })

  it('产品线只能切在店铺 / 账号 / 市场里面', () => {
    const s = store()
    expect(() =>
      s.productLines.create({
        workspace_id: WS,
        name: '不合法',
        parent: { kind: 'department', id: 'dep_1' },
        rule: { platform: 'manual', product_ids: [] },
      }),
    ).toThrow(/只能切在/)
    s.close()
  })

  it('targetInRange：自己线里的商品放行，别人线里的拒，理由是人话', () => {
    const s = store()
    const kitchen = s.productLines.create({
      workspace_id: WS,
      name: '厨房线',
      parent: { kind: 'store', id: 'store_main' },
      rule: { platform: 'manual', product_ids: ['prod_1', 'prod_2'] },
    })
    const outdoor = s.productLines.create({
      workspace_id: WS,
      name: '户外线',
      parent: { kind: 'store', id: 'store_main' },
      rule: { platform: 'manual', product_ids: ['prod_7', 'prod_8'] },
    })
    const zhao = grant(s, {
      person_id: 'p_zhao',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'product_line', id: kitchen.id }],
      granted_by: 'p_wang',
    })
    expect(s.targetInRange(zhao.id, { platform: 'manual', product_ids: ['prod_1'] })).toMatchObject(
      { ok: true, matched: { kind: 'product_line', id: kitchen.id } },
    )
    const denied = s.targetInRange(zhao.id, { platform: 'manual', product_ids: ['prod_7'] })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('target_out_of_range')
    expect(denied.reason).toContain('厨房线')
    expect(outdoor.name).toBe('户外线')
    s.close()
  })

  it('targetInRange：一条范围都没有 → unassigned_range；撤销了也一样拒', () => {
    const s = store()
    const a = grant(s, {
      person_id: 'p_feng',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      granted_by: 'p_wang',
    })
    expect(s.targetInRange(a.id, { platform: 'shopify', product_ids: ['prod_1'] })).toMatchObject({
      ok: false,
      code: 'unassigned_range',
    })
    s.assignments.revoke(a.id)
    expect(s.targetInRange(a.id, { platform: 'shopify', product_ids: ['prod_1'] }).ok).toBe(false)
    expect(s.targetInRange('asg_nope', { platform: 'shopify' }).ok).toBe(false)
    s.close()
  })

  it('targetInRange：挂整店的岗位照旧放行（商品级只有产品线切得动）', () => {
    const s = store()
    const a = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'store', id: 'store_main' }],
      granted_by: 'p_wang',
    })
    expect(s.targetInRange(a.id, { platform: 'shopify', product_ids: ['prod_9'] }).ok).toBe(true)
    // 但别家店的目标盖不住
    expect(
      s.targetInRange(a.id, {
        platform: 'shopify',
        product_ids: ['prod_9'],
        parent: { kind: 'store', id: 'store_eu' },
      }).ok,
    ).toBe(false)
    s.close()
  })

  it('产品线定义丢了不等于全放开', () => {
    const s = store()
    const line = s.productLines.create({
      workspace_id: WS,
      name: '厨房线',
      parent: { kind: 'store', id: 'store_main' },
      rule: { platform: 'manual', product_ids: ['prod_1'] },
    })
    const a = grant(s, {
      person_id: 'p_zhao',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'product_line', id: line.id }],
      granted_by: 'p_wang',
    })
    s.assignments.update(a.id, { ranges: [] })
    s.productLines.delete(line.id)
    // 手动塞回一条指向已删产品线的范围（模拟库里留下的坏引用）
    const revived = s.assignments.require(a.id)
    expect(revived.ranges).toEqual([])
    s.close()
  })
})

describe('44 G4 账号 ⊃ 市场', () => {
  it('挂账号的岗位盖得住它下面的市场，反过来不行', () => {
    expect(
      rangeCoversRef({ kind: 'account', id: 'amz_na' }, { kind: 'market', id: 'amz_na:US' }),
    ).toBe(true)
    expect(
      rangeCoversRef({ kind: 'account', id: 'amz_eu' }, { kind: 'market', id: 'amz_na:US' }),
    ).toBe(false)
    expect(
      rangeCoversRef({ kind: 'market', id: 'amz_na:US' }, { kind: 'account', id: 'amz_na' }),
    ).toBe(false)
    expect(parseMarketId('amz_na:US')).toEqual({ account: 'amz_na', site: 'US' })
  })

  it('产品线挂在市场下面时，账号级的目标不当命中', () => {
    const s = store()
    const line = s.productLines.create({
      workspace_id: WS,
      name: '北美厨房线',
      parent: { kind: 'market', id: 'amz_na:US' },
      rule: { platform: 'amazon', asins: ['B0KITCHEN'] },
    })
    const a = grant(s, {
      person_id: 'p_zhao',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'product_line', id: line.id }],
      granted_by: 'p_wang',
    })
    expect(
      s.targetInRange(a.id, {
        platform: 'amazon',
        asins: ['B0KITCHEN'],
        parent: { kind: 'market', id: 'amz_na:US' },
      }).ok,
    ).toBe(true)
    expect(
      s.targetInRange(a.id, {
        platform: 'amazon',
        asins: ['B0KITCHEN'],
        parent: { kind: 'market', id: 'amz_eu:DE' },
      }).ok,
    ).toBe(false)
    s.close()
  })
})

describe('判据与过滤下推（纯函数）', () => {
  it('Shopify 的四种判据都认', () => {
    const target = {
      platform: 'shopify' as const,
      product_ids: ['prod_1'],
      attributes: { tags: ['kitchen'], vendor: 'Nordvolt', product_type: 'Charger' },
    }
    expect(productLineMatches({ platform: 'shopify', tags: ['kitchen'] }, target)).toBe(true)
    expect(productLineMatches({ platform: 'shopify', vendors: ['Nordvolt'] }, target)).toBe(true)
    expect(productLineMatches({ platform: 'shopify', product_types: ['Charger'] }, target)).toBe(
      true,
    )
    expect(productLineMatches({ platform: 'shopify', collection_ids: ['c1'] }, target)).toBe(false)
    // 判据一条都没填 = 空产品线，谁都不命中
    expect(productLineMatches({ platform: 'shopify' }, target)).toBe(false)
    // 只给 id、判据却是标签 → 判不出来就当不在（不放行）
    expect(
      productLineMatches(
        { platform: 'shopify', tags: ['kitchen'] },
        {
          platform: 'shopify',
          product_ids: ['prod_1'],
        },
      ),
    ).toBe(false)
  })

  it('亚马逊认 ASIN / SKU 前缀 / 品牌', () => {
    expect(
      productLineMatches(
        { platform: 'amazon', sku_prefixes: ['KIT-'] },
        { platform: 'amazon', skus: ['KIT-0001'] },
      ),
    ).toBe(true)
    expect(
      productLineMatches(
        { platform: 'amazon', sku_prefixes: ['KIT-'] },
        { platform: 'amazon', skus: ['OUT-0001'] },
      ),
    ).toBe(false)
    expect(
      productLineMatches(
        { platform: 'amazon', brand: 'Nordvolt' },
        { platform: 'amazon', attributes: { brand: 'Nordvolt' } },
      ),
    ).toBe(true)
  })

  it('能下推的翻成 Shopify 搜索语法，翻不了的回 undefined', () => {
    expect(shopifyLineQuery({ platform: 'shopify', tags: ['kitchen', 'home'] })).toBe(
      '(tag:kitchen OR tag:home)',
    )
    expect(
      shopifyLineQuery({ platform: 'shopify', vendors: ['Nord Volt'], product_types: ['Charger'] }),
    ).toBe('(vendor:"Nord Volt") OR (product_type:Charger)')
    expect(shopifyLineQuery({ platform: 'shopify', collection_ids: ['123'] })).toBe(
      '(collection_id:123)',
    )
    expect(shopifyLineQuery({ platform: 'shopify' })).toBeUndefined()
    expect(shopifyLineQuery({ platform: 'amazon', asins: ['B01'] })).toBeUndefined()
    expect(shopifyLineQuery({ platform: 'manual', product_ids: ['p1'] })).toBeUndefined()
  })

  it('expandRanges 是并集去重', () => {
    expect(
      expandRanges(
        [{ kind: 'store', id: 'a' }],
        [
          {
            id: 'rg',
            workspace_id: WS,
            name: 'x',
            members: [
              { kind: 'store', id: 'a' },
              { kind: 'store', id: 'b' },
            ],
            created_at: 'x',
            updated_at: 'x',
          },
        ],
      ),
    ).toEqual([
      { kind: 'store', id: 'a' },
      { kind: 'store', id: 'b' },
    ])
  })
})

describe('SQLite 后端', () => {
  it('品牌与产品线落盘，重开进程还在，岗位范围也还在', () => {
    const dbPath = tempDb()
    const first = store({ dbPath })
    const brand = first.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [{ kind: 'store', id: 'store_b1' }],
    })
    const line = first.productLines.create({
      workspace_id: WS,
      name: '厨房线',
      parent: { kind: 'store', id: 'store_b1' },
      rule: { platform: 'shopify', tags: ['kitchen'] },
    })
    const a = first.assignments.create({
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      ranges: [{ kind: 'product_line', id: line.id }],
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    first.close()

    const second = store({ dbPath })
    expect(second.rangeGroups.get(brand.id)?.name).toBe('品牌乙')
    expect(second.rangeGroups.list(WS)).toHaveLength(1)
    expect(second.rangeGroups.list('ws_other')).toHaveLength(0)
    expect(second.productLines.get(line.id)?.rule).toEqual({
      platform: 'shopify',
      tags: ['kitchen'],
    })
    expect(second.productLines.list(WS)).toHaveLength(1)
    expect(second.assignments.require(a.id).range_groups).toEqual([brand.id])
    // 重开之后改品牌，范围照样跟着走
    second.rangeGroups.update(brand.id, {
      members: [
        { kind: 'store', id: 'store_b1' },
        { kind: 'store', id: 'store_b2' },
      ],
    })
    expect(second.assignments.require(a.id).ranges.map((r) => r.id)).toContain('store_b2')
    second.productLines.update(line.id, { name: '厨房线（改名）' })
    expect(second.productLines.get(line.id)?.name).toBe('厨房线（改名）')
    second.assignments.update(a.id, { ranges: [] })
    second.productLines.delete(line.id)
    expect(second.productLines.get(line.id)).toBeUndefined()
    second.close()
  })
})

describe('外围守则', () => {
  it('留痕回调抛异常不会让改品牌这件事失败', () => {
    const s = store({
      onRangeExpanded: () => {
        throw new Error('事件日志挂了')
      },
    })
    const brand = s.rangeGroups.create({
      workspace_id: WS,
      name: '品牌乙',
      members: [{ kind: 'store', id: 'store_b1' }],
    })
    const a = grant(s, {
      person_id: 'p_li',
      workspace_id: WS,
      role_id: 'dtc.aftersales',
      range_groups: [brand.id],
      granted_by: 'p_wang',
    })
    expect(() => {
      s.rangeGroups.update(brand.id, {
        members: [
          { kind: 'store', id: 'store_b1' },
          { kind: 'store', id: 'store_b2' },
        ],
      })
    }).not.toThrow()
    expect(s.assignments.require(a.id).ranges).toHaveLength(2)
    s.close()
  })

  it('名字不能是空的；同名建两次是 conflict；改不存在的是 not_found', () => {
    const s = store()
    expect(() => s.rangeGroups.create({ workspace_id: WS, name: '  ' })).toThrow(/要有名字/)
    s.rangeGroups.create({ workspace_id: WS, name: '品牌乙' })
    expect(() => s.rangeGroups.create({ workspace_id: WS, name: '品牌乙' })).toThrow(/已经有了/)
    expect(() => s.rangeGroups.update('rg_nope', { name: 'x' })).toThrow(/没有这个品牌/)
    expect(() => {
      s.rangeGroups.delete('rg_nope')
    }).toThrow(/没有这个品牌/)
    expect(() =>
      s.productLines.create({
        workspace_id: WS,
        name: ' ',
        parent: { kind: 'store', id: 's' },
        rule: { platform: 'manual', product_ids: [] },
      }),
    ).toThrow(/要有名字/)
    expect(() => s.productLines.update('pl_nope', { name: 'x' })).toThrow(/没有这条产品线/)
    expect(() => {
      s.productLines.delete('pl_nope')
    }).toThrow(/没有这条产品线/)
    s.close()
  })

  it('挂不存在的产品线直接 not_found', () => {
    const s = store()
    expect(() =>
      grant(s, {
        person_id: 'p_li',
        workspace_id: WS,
        role_id: 'dtc.aftersales',
        ranges: [{ kind: 'product_line', id: 'pl_nope' }],
        granted_by: 'p_wang',
      }),
    ).toThrow(/没有这条产品线/)
    s.close()
  })

  it('member() / owner() 两份内置职责在这一组题里也照常加载', () => {
    expect(member().id).toBe('common.member')
    expect(owner().id).toBe('common.owner')
  })
})
