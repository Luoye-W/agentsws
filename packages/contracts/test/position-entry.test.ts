/**
 * 54（WP69）：岗位是任务主入口——契约层能钉的四件事。
 *
 * 1. `Matter.entry` / `role_id` / `position_template_id` 都是**可选**的：存量事项
 *    （没有这三个字段）照样是合法的 `Matter`，"默认 role"是读的一侧的事，不是写的一侧的。
 * 2. `SkillTier` 六层**只加不删**：原来那四个值一个不少，新加的两个在中间。
 * 3. `PositionInstance` 是算出来的视图：岗位 id 是**模板 id** 不是 Assignment id，
 *    职责下挂的是 `assignment_ids[]`（不是并集，是"这个岗位下有哪几条分配"）。
 * 4. 两条新事件在 `KnownEventType` 里。
 */
import { describe, expect, it } from 'vitest'
import type {
  KnownEventType,
  Matter,
  MatterEntry,
  PositionInstance,
  PromotionTarget,
  PromotionTier,
  SkillTier,
} from '../src/index.js'

/** 存量事项：WP69 之前落的那一份，一个新字段都没有。 */
const LEGACY: Matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  position_id: 'asg_support_1',
  kind: 'conversation',
  title: '客户问退货',
  status: 'open',
  context: {
    summary: '',
    pinned: [],
    participants: ['p_li'],
    last_activity: '2026-09-15T01:00:00Z',
  },
  created_at: '2026-09-15T01:00:00Z',
  updated_at: '2026-09-15T01:00:00Z',
}

describe('54 §2 事项的两个入口', () => {
  it('存量事项不动：三个新字段都可省', () => {
    expect(LEGACY.entry).toBeUndefined()
    expect(LEGACY.role_id).toBeUndefined()
    expect(LEGACY.position_template_id).toBeUndefined()
    // 读的一侧默认按 role 算
    const entry: MatterEntry = LEGACY.entry ?? 'role'
    expect(entry).toBe('role')
  })

  it('岗位入口：entry = position，职责由路由填，岗位单独记', () => {
    const opened: Matter = {
      ...LEGACY,
      id: 'mat_2',
      entry: 'position',
      // 权限与额度仍然只来自这一条分配（05 §4 不做并集）
      position_id: 'asg_store_1',
      role_id: 'dtc.store',
      position_template_id: 'web-ops',
    }
    expect(opened.entry).toBe('position')
    expect(opened.position_template_id).toBe('web-ops')
    // 岗位与分配是两件事：一个是"哪个岗位"，一个是"用谁的哪条分配在做"
    expect(opened.position_template_id).not.toBe(opened.position_id)
  })

  it('职责入口：entry = role，跳过路由', () => {
    const opened: Matter = { ...LEGACY, id: 'mat_3', entry: 'role', role_id: 'dtc.support' }
    expect(opened.entry).toBe('role')
  })
})

describe('54 §1 技能层六层', () => {
  it('只加不删：原来四层一个不少，新的两层在部门与个人之间', () => {
    const all: SkillTier[] = ['package', 'company', 'department', 'position', 'role', 'personal']
    for (const old of ['package', 'company', 'department', 'personal'] as const) {
      expect(all).toContain(old)
    }
    expect(all.indexOf('position')).toBeGreaterThan(all.indexOf('department'))
    expect(all.indexOf('role')).toBeGreaterThan(all.indexOf('position'))
    expect(all.indexOf('personal')).toBeGreaterThan(all.indexOf('role'))
  })

  it('提升目标四档：不含 package（上游不被下游改写）也不含 personal（提到自己等于没提）', () => {
    const tiers: PromotionTier[] = ['company', 'department', 'position', 'role']
    expect(tiers).toHaveLength(4)
    const target: PromotionTarget = { tier: 'position', scope_id: 'web-ops' }
    expect(target.scope_id).toBe('web-ops')
    // 公司 / 部门层不需要 scope_id
    const company: PromotionTarget = { tier: 'company' }
    expect(company.scope_id).toBeUndefined()
  })
})

describe('54 §1 岗位实体', () => {
  it('岗位 id 是模板 id；职责下挂的是分配 id 列表', () => {
    const instance: PositionInstance = {
      position_id: 'web-ops',
      workspace_id: 'ws_1',
      name: { zh: '网站运营', en: 'Web Operations' },
      template_version: '1.1.0',
      holders: ['p_li'],
      roles: [
        {
          role_id: 'dtc.store',
          role_name: '店铺管理',
          default: true,
          assignment_ids: ['asg_store_1'],
        },
        {
          role_id: 'dtc.content',
          role_name: '内容与博客',
          default: true,
          assignment_ids: ['asg_content_1'],
        },
      ],
      open_matters: 2,
      pending_cards: 3,
      memory_summary: '岗位层：1 个技能、2 条教训',
    }
    expect(instance.position_id).toBe('web-ops')
    // 不并集：每条职责各自的分配分开列着，没有一个"岗位的权限"字段
    expect(instance.roles.flatMap((r) => r.assignment_ids)).toEqual([
      'asg_store_1',
      'asg_content_1',
    ])
    expect(Object.keys(instance)).not.toContain('scopes')
  })
})

describe('54 §2 路由留痕', () => {
  it('两条新事件在已知事件表里', () => {
    const routed: KnownEventType = 'matter.routed'
    const rerouted: KnownEventType = 'matter.rerouted'
    expect(routed).toBe('matter.routed')
    expect(rerouted).toBe('matter.rerouted')
  })
})
