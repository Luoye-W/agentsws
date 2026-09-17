/**
 * WP76（58 §1 / §6）：五条设计职责 + 岗位模板 + 三条「向设计岗下需求单」。
 *
 * 四组断言分别钉住四件事：
 * 1. 五条骨架**完全相同**（58 §1 第一句），不同的只有规格族、来源与意图词；
 * 2. 04 §6 那条纪律在 yml 里也硬着（入库 `hard_ceiling`、变体升不上 L3）；
 * 3. 动作 id → ChangeKind 接上了（接不上会**悄悄降级**成永远 L1）；
 * 4. 三条 `request_design` 是独立段落，没动别人的行。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DESIGN_CAPS, DESIGN_ROLE_IDS, designDutyOfRole } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_ROLES_DIR,
  changeKindOf,
  loadBundledPosition,
  loadBundledRole,
  riskClassOf,
} from '../src/index.js'

const roles = DESIGN_ROLE_IDS.map((id) => loadBundledRole(id))

describe('58 §1 五条设计职责', () => {
  it('五条都装得起来，id 与契约那张表一个字不差', () => {
    expect(roles.map((r) => r.id)).toEqual(DESIGN_ROLE_IDS)
    expect(roles.every((r) => r.domain === 'design')).toBe(true)
  })

  it('骨架完全相同：三个动作、五块面板、同一套 scopes', () => {
    for (const role of roles) {
      expect(role.actions.map((a) => a.id)).toEqual([
        'draft_brief',
        'generate_variants',
        'stage_asset',
      ])
      expect(role.home_blocks).toHaveLength(5)
      expect(role.scopes.map((s) => s.domain)).toEqual(roles[0]?.scopes.map((s) => s.domain) ?? [])
    }
  })

  it('三个数据域各一把闸（一个域一把，19 §3 的过滤下推才切得动）', () => {
    const domains = roles[0]?.scopes.map((s) => s.domain) ?? []
    expect(domains).toContain('design_request')
    expect(domains).toContain('design_brief')
    expect(domains).toContain('design_asset')
    // 品牌系统是公司层技能，**只读**；商品也只读（设计一辈子不改一件商品）
    const skill = roles[0]?.scopes.find((s) => s.domain === 'skill')
    expect(skill?.ops).toEqual(['read'])
    const product = roles[0]?.scopes.find((s) => s.domain === 'product')
    expect(product?.ops).toEqual(['read'])
  })

  it('连接器是空的，而且是故意的（出图走模型网关，那不是一条连接）', () => {
    expect(roles.every((r) => r.connectors.length === 0)).toBe(true)
  })

  it('意图词是唯一分得开五条的东西——每条的第一条 grounding 都不一样', () => {
    const firsts = roles.map((r) => (r.grounding ?? [])[0]?.intent_terms.join('|') ?? '')
    expect(new Set(firsts).size).toBe(5)
    // 写不足 = 路由不到 = 这条职责收不到单
    for (const role of roles) {
      expect((role.grounding ?? [])[0]?.intent_terms.length ?? 0).toBeGreaterThanOrEqual(8)
      expect(role.description.length).toBeGreaterThan(30)
    }
  })

  it('五条的 description 各不相同（54 §2 路由按它判）', () => {
    expect(new Set(roles.map((r) => r.description)).size).toBe(5)
  })
})

describe('04 §6「视觉决定永远是人」在 yml 里也硬着', () => {
  it('入库 L1 + hard_ceiling（两处都说，改一处忘另一处时有人喊）', () => {
    for (const role of roles) {
      const a = role.automation.stage_asset
      expect(a?.ceiling).toBe('L1')
      expect(a?.initial).toBe('L1')
      expect(a?.hard_ceiling).toBe(true)
    }
  })

  it('变体 L2 —— **升不上 L3**（自动出图并自动用上正是这条纪律要防的事）', () => {
    for (const role of roles) expect(role.automation.generate_variants?.ceiling).toBe('L2')
  })

  it('brief L3 自动（它只产生一段给人看的文字）', () => {
    for (const role of roles) expect(role.automation.draft_brief?.ceiling).toBe('L3')
  })

  it('人点头那两格 Agent 提都不许提', () => {
    for (const role of roles) {
      const stage = role.actions.find((a) => a.id === 'stage_asset')
      expect(stage?.protected_fields).toContain('picked_by')
      expect(stage?.protected_fields).toContain('picked_at')
    }
  })

  it('58 §6 的三个额度写在动作上，与契约那份默认值对得上', () => {
    for (const role of roles) {
      const brief = role.actions.find((a) => a.id === 'draft_brief')
      expect(brief?.mandate.caps.max_brief_per_day).toBe(DESIGN_CAPS.max_brief_per_day)
      const variants = role.actions.find((a) => a.id === 'generate_variants')
      expect(variants?.mandate.caps.max_variants_per_brief).toBe(DESIGN_CAPS.max_variants_per_brief)
      expect(variants?.mandate.caps.max_generations_per_day).toBe(
        DESIGN_CAPS.max_generations_per_day,
      )
    }
  })
})

describe('动作 id → ChangeKind 接上了（接不上会悄悄降级成永远 L1）', () => {
  it('四个动作各自对上自己那条 kind', () => {
    expect(changeKindOf('draft_brief')).toBe('design_brief')
    expect(changeKindOf('generate_variants')).toBe('design_variant')
    expect(changeKindOf('stage_asset')).toBe('asset_publish')
    expect(changeKindOf('request_design')).toBe('design_request')
  })

  it('风险级：三条 low（所以 L2 / L3 真的生效），入库 medium', () => {
    expect(riskClassOf({ id: 'draft_brief', kind: 'staged_change' })).toBe('low')
    expect(riskClassOf({ id: 'generate_variants', kind: 'staged_change' })).toBe('low')
    expect(riskClassOf({ id: 'request_design', kind: 'staged_change' })).toBe('low')
    expect(riskClassOf({ id: 'stage_asset', kind: 'staged_change' })).toBe('medium')
  })
})

describe('设计岗位模板（58 §5：默认全勾）', () => {
  const position = loadBundledPosition('design')

  it('五条，顺序 = 契约 DESIGN_DUTIES', () => {
    expect(position.roles.map((r) => r.role)).toEqual(DESIGN_ROLE_IDS)
  })

  it('默认全勾（这五条不对应任何账号，一个人做设计本来就都会碰到）', () => {
    expect(position.roles.every((r) => r.default)).toBe(true)
  })
})

describe('三条「向设计岗下需求单」是独立段落', () => {
  const sources = ['dtc.store', 'social.meta', 'kol.youtube']

  it('三条都加上了，动作与自动化等级一致', () => {
    for (const id of sources) {
      const role = loadBundledRole(id)
      const action = role.actions.find((a) => a.id === 'request_design')
      expect(action?.target).toBe('design_request')
      expect(role.automation.request_design?.ceiling).toBe('L3')
      expect(role.automation.request_design?.initial).toBe('L3')
    }
  })

  it('每条来源都查得到该落哪条设计职责（54 §2：查不到就问一句，不猜）', () => {
    expect(designDutyOfRole('design.dtc')?.request_sources).toContain('dtc.store')
    expect(designDutyOfRole('design.social')?.request_sources).toContain('social.meta')
    expect(designDutyOfRole('design.social')?.request_sources).toContain('kol.youtube')
  })

  it('只动了这三个文件——别的职责一条 request_design 都没有', () => {
    const withAction: string[] = []
    for (const domain of readdirSync(BUNDLED_ROLES_DIR)) {
      const dir = join(BUNDLED_ROLES_DIR, domain)
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.yml')) continue
        const id = `${domain}.${file.replace(/\.yml$/, '')}`
        if (loadBundledRole(id).actions.some((a) => a.id === 'request_design')) withAction.push(id)
      }
    }
    expect(withAction.sort()).toEqual([...sources].sort())
  })
})
