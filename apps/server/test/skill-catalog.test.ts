/**
 * WP209：技能按岗位分组的真源（`enrichSkillSummaries`）。
 *
 * 钉住五件：
 * 1. 职责 yml 的 `skills:` 反查出「哪几条职责在用」与「归哪几个岗位」；
 * 2. 一个技能挂在几个岗位下就在几个岗位里（界面据此标「共用」）；
 * 3. 只挂在 `common.*` 上的、谁都没挂的 → 通用；frontmatter 的 `positions` 只加不减；
 * 4. 本人的岗位 `mine`、本人的职责 `in_use`；
 * 5. 显示名 / 一句话从 frontmatter 来，没有就不回（工作台退回英文 id）；段落正文补上。
 */
import type { SkillSummary } from '@agentsws/api'
import { type Frontmatter, readBundledSkill, splitFrontmatter } from '@agentsws/skills'
import { describe, expect, it } from 'vitest'
import {
  COMMON_POSITION_ID,
  enrichSkillSummaries,
  parsePositionsField,
} from '../src/skill-catalog.js'

const base = (name: string): SkillSummary => ({
  name,
  tier: 'package',
  version: '1.0.0',
  excluded: false,
  sections: [{ id: 's1', heading: '你是谁', origin: 'authored' }],
  overlays: [],
  pending_proposals: 0,
})

const POSITIONS = [
  {
    id: 'customer-care',
    name: { zh: '客服', en: 'Customer Care' },
    roles: [{ role: 'dtc.support' }, { role: 'dtc.community-support' }],
  },
  {
    id: 'social-media',
    name: { zh: '社媒运营', en: 'Social Media' },
    roles: [{ role: 'social.x' }],
  },
  { id: 'dtc-ops', name: { zh: '独立站运营', en: 'DTC Ops' }, roles: [{ role: 'dtc.support' }] },
]

const ROLES = [
  {
    id: 'dtc.support',
    name: { zh: '网站客服', en: 'Web support' },
    skills: [{ name: 'customer-care' }],
  },
  {
    id: 'dtc.community-support',
    name: { zh: '社群管理', en: 'Community' },
    skills: [{ name: 'customer-care' }, { name: 'brand-voice' }],
  },
  { id: 'social.x', name: { zh: 'X', en: 'X' }, skills: [{ name: 'brand-voice' }] },
  {
    id: 'common.owner',
    name: { zh: '公司设置', en: 'Owner' },
    skills: [{ name: 'policy-review' }],
  },
]

const fmOf = (name: string): Frontmatter | undefined => {
  try {
    return splitFrontmatter(readBundledSkill(name).markdown).frontmatter
  } catch {
    return undefined
  }
}

const run = (names: string[], held: string[] = ['dtc.support']): SkillSummary[] =>
  enrichSkillSummaries(names.map(base), {
    positions: POSITIONS,
    roles: ROLES,
    held_roles: held,
    frontmatterOf: fmOf,
    sectionBody: (name, id) => (id === 's1' ? `${name} 的第一段正文` : undefined),
    superseded: ['dtc-ops'],
  })

describe('WP209 技能按岗位分组', () => {
  it('反查职责与岗位；拆掉的岗位模板（dtc-ops）不算', () => {
    const [care] = run(['customer-care'])
    expect(care?.roles?.map((r) => r.role_id)).toEqual(['dtc.support', 'dtc.community-support'])
    expect(care?.positions?.map((p) => p.id)).toEqual(['customer-care'])
    expect(care?.roles?.[0]?.position_ids).toEqual(['customer-care'])
  })

  it('挂在两个岗位下的技能两个岗位都有（界面标「共用」）', () => {
    const [voice] = run(['brand-voice'])
    expect(voice?.positions?.map((p) => p.id)).toEqual(['customer-care', 'social-media'])
  })

  it('只挂在 common.* 上 / frontmatter 写了 common / 谁都没挂 → 通用', () => {
    const [policy, basics, orphan] = run(['policy-review', 'workspace-basics', 'no-one-uses-me'])
    expect(policy?.positions?.map((p) => p.id)).toEqual([COMMON_POSITION_ID])
    expect(basics?.positions?.map((p) => p.id)).toEqual([COMMON_POSITION_ID])
    expect(orphan?.positions?.map((p) => p.id)).toEqual([COMMON_POSITION_ID])
    expect(orphan?.roles).toEqual([])
  })

  it('本人的岗位标 mine、本人在用的标 in_use', () => {
    const [care, voice] = run(['customer-care', 'brand-voice'], ['social.x'])
    expect(care?.in_use).toBe(false)
    expect(voice?.in_use).toBe(true)
    const social = voice?.positions?.find((p) => p.id === 'social-media')
    expect(social?.mine).toBe(true)
    expect(voice?.positions?.find((p) => p.id === 'customer-care')?.mine).toBe(false)
  })

  it('显示名、一句话、原描述从 frontmatter 来；段落正文补上', () => {
    const [care, orphan] = run(['customer-care', 'no-one-uses-me'])
    expect(care?.display_name).toEqual({ zh: '客服回信', en: 'Customer care' })
    expect(care?.summary?.zh).toContain('写回信')
    expect(care?.description).toContain('网站客服')
    expect(care?.sections[0]?.body).toBe('customer-care 的第一段正文')
    expect(orphan?.display_name).toBeUndefined()
  })

  it('frontmatter 的 positions：逗号 / 空白都认', () => {
    expect(parsePositionsField('b2b, ads  site，pr')).toEqual(['b2b', 'ads', 'site', 'pr'])
    expect(parsePositionsField(undefined)).toEqual([])
  })
})
