/**
 * 52 O1（WP65）：品牌是顶层——公司 = 组织，品牌 = 工作区。
 *
 * 这一组只钉契约层能钉的三件事：
 * 1. `Organization` 的形状（人、钱、发现三样，别的一律不在这里）；
 * 2. `Workspace.org_id` / `brand` 是**可选**的——存量工作区（没迁过）照样是合法的 `Workspace`；
 * 3. 两个纯函数：品牌名怎么读（`brandNameOf`）、同一个品牌怎么认（`brandKey`）。
 */
import { describe, expect, it } from 'vitest'
import type {
  Brand,
  KnownEventType,
  Organization,
  OrganizationMember,
  Workspace,
  WorkspaceProfile,
} from '../src/index.js'
import {
  brandKey,
  brandNameOf,
  DEFAULT_STOREFRONT_PLATFORM,
  isStorefrontService,
  STOREFRONT_PLATFORMS,
  storefrontNotBuilt,
  storefrontUnsupportedNote,
  storefrontUsableService,
} from '../src/index.js'

const ORG: Organization = {
  id: 'org_1',
  legal_name: '深圳诺伏特科技',
  domain: 'nordvolt.cn',
  discoverable: true,
  owner_id: 'p_wang',
  members: [{ person_id: 'p_wang', role: 'owner', joined_at: '2026-09-15T00:00:00Z' }],
  created_at: '2026-09-15T00:00:00Z',
}

describe('52 O1 组织与品牌', () => {
  it('组织上只有人、钱、发现三样（O3）', () => {
    const member: OrganizationMember = {
      person_id: 'p_li',
      role: 'member',
      joined_at: '2026-09-15T01:00:00Z',
    }
    const org: Organization = { ...ORG, members: [...ORG.members, member], cloud_org_id: 'corg_1' }
    // 发现
    expect(org.discoverable).toBe(true)
    expect(org.legal_name).toBe('深圳诺伏特科技')
    // 人
    expect(org.members.map((m) => m.role)).toEqual(['owner', 'member'])
    // 钱（49 M1 的云侧组织）
    expect(org.cloud_org_id).toBe('corg_1')
  })

  it('离职不删行：写 left_at（40 E2）', () => {
    const left: OrganizationMember = {
      person_id: 'p_li',
      role: 'member',
      joined_at: '2026-09-15T01:00:00Z',
      left_at: '2026-09-20T01:00:00Z',
    }
    expect(left.left_at).toBeDefined()
  })

  it('org_id 与 brand 是可选的：没迁过的工作区照样合法', () => {
    const legacy: Pick<Workspace, 'id' | 'name' | 'kind'> = {
      id: 'ws_1',
      name: '默认工作区',
      kind: 'personal',
    }
    expect(brandNameOf(legacy)).toBe('默认工作区')
    const brand: Brand = { name: '诺伏特户外' }
    expect(brandNameOf({ ...legacy, brand })).toBe('诺伏特户外')
    // 空串 / 只有空白也回落到工作区名——回落只有一条路
    expect(brandNameOf({ ...legacy, brand: { name: '   ' } })).toBe('默认工作区')
  })

  it('brandKey：写法不同不影响，域名参与判定（45 H2 改写）', () => {
    expect(brandKey('诺伏特 户外', 'Nordvolt.cn')).toBe(brandKey('诺伏特户外', 'www.nordvolt.cn'))
    // 同名不同店 = 两个品牌，不撞车
    expect(brandKey('诺伏特户外', 'a.com')).not.toBe(brandKey('诺伏特户外', 'b.com'))
    // 没有域名就只按名字
    expect(brandKey('诺伏特户外')).toBe('诺伏特户外')
  })

  it('公司级三字段留在档案上但已废弃：读以组织为准', () => {
    const profile: WorkspaceProfile = {
      legal_name: ORG.legal_name,
      discoverable: ORG.discoverable,
      vertical: 'goods',
      storefront_platform: 'shopify',
      set_at: '2026-09-15T00:00:00Z',
    }
    // 品牌级那两样才是这里的正事
    expect(profile.vertical).toBe('goods')
    expect(profile.storefront_platform).toBe('shopify')
  })

  it('两条内核事件在册；切品牌不进内核（O2）', () => {
    const created: KnownEventType[] = ['organization.created', 'brand.created']
    expect(created).toHaveLength(2)
    // @ts-expect-error 52 §4：brand.switched 只是客户端事件，不在 KnownEventType 里
    const clientOnly: KnownEventType = 'brand.switched'
    expect(clientOnly).toBe('brand.switched')
  })
})

/**
 * 51 §1 N0 + WP79：「网站是用什么搭的」那一张表。
 *
 * 三档说的是三件不同的事，别混：
 *
 * - **你还没连**（Shopify）：有卡可点，该说"去连接"；
 * - **你还没搭网站**（`none`，WP79 新增）：选得动，但根本没有店铺后台可连；
 * - **我们还没接**（WooCommerce / Magento / 其它）：灰显标"待增加"，你在等我们。
 */
describe('51 §1 N0 / WP79 网站是用什么搭的', () => {
  it('`none`「还没开始搭建」选得动，却没有连接器——它不是"待增加"', () => {
    const none = STOREFRONT_PLATFORMS.find((p) => p.id === 'none')
    expect(none).toBeDefined()
    // 选得动：界面上不灰显、不标"待增加"
    expect(none?.supported).toBe(true)
    // 却没有店铺后台可连——与 Shopify 的分水岭就在这一个字段上
    expect(none?.connector_service).toBeUndefined()
    // 契约只加不删：原来那四条一条没少，而且默认值还是 Shopify
    expect(STOREFRONT_PLATFORMS.map((p) => p.id)).toEqual(
      expect.arrayContaining(['shopify', 'woocommerce', 'magento', 'other', 'none']),
    )
    expect(DEFAULT_STOREFRONT_PLATFORM).toBe('shopify')
  })

  it('storefrontNotBuilt 只对 `none` 为真：它问的是用户的状态，不是我们的缺口', () => {
    expect(storefrontNotBuilt('none')).toBe(true)
    expect(storefrontNotBuilt('shopify')).toBe(false)
    // 「我们还没接」的那三个都不算"还没搭网站"——他有网站，是我们没做
    expect(storefrontNotBuilt('woocommerce')).toBe(false)
    expect(storefrontNotBuilt('magento')).toBe(false)
    expect(storefrontNotBuilt('other')).toBe(false)
    // 存量工作区没有这个字段 → 按 Shopify 算，行为与这一版上线前一模一样
    expect(storefrontNotBuilt(undefined)).toBe(false)
  })

  it('`none` 没有点得动的店铺连接：`storefrontUsableService` 回 undefined', () => {
    expect(storefrontUsableService('shopify')).toBe('shopify_admin')
    expect(storefrontUsableService('none')).toBeUndefined()
    // 连接目录那一侧也不该把 `none` 当成"某个平台的店铺卡"
    expect(isStorefrontService('shopify_admin')).toBe(true)
  })

  it('那一句人话：`none` 说"还没搭网站"，不许说成"这个平台还没接"', () => {
    const note = storefrontUnsupportedNote('none')
    expect(note).toContain('还没搭网站')
    expect(note).not.toContain('这个平台还没接')
    // Shopify 仍然回 undefined（该说的是"去连接"，不是"还没接"）
    expect(storefrontUnsupportedNote('shopify')).toBeUndefined()
    expect(storefrontUnsupportedNote(undefined)).toBeUndefined()
    // 不支持的那几个照旧
    expect(storefrontUnsupportedNote('magento')).toContain('这个平台还没接')
  })
})
