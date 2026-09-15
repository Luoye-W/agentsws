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
import { brandKey, brandNameOf } from '../src/index.js'

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
