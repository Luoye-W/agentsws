/**
 * WP162：按需技能真的够得着。
 *
 * - 索引只列这条职责登记的按需技能（名字 + 一句说明），排序固定、字节稳定；
 * - `read_skill` 只认登记了的名字，回六层叠加后的正文；被本人排除的读不到；
 * - always 技能照旧进 persona，按需的不进。
 */
import type { SkillRef } from '@agentsws/contracts'
import { createSkills, seedBundledSkills } from '@agentsws/skills'
import { describe, expect, it } from 'vitest'
import {
  onDemandSkillIndex,
  readSkillForRun,
  SKILL_INDEX_ORDER,
  skillIndexSection,
  skillPromptSections,
} from '../src/index.js'

const ACTOR = { person_id: 'per_1', workspace_id: 'ws_1', role_id: 'dtc.support' }

async function fixture() {
  const skills = createSkills({
    clock: { now: () => '2026-09-27T00:00:00.000Z' },
    random: () => 0.5,
  })
  await seedBundledSkills(skills.registry)
  return skills
}

const SUPPORT: SkillRef[] = [
  { name: 'customer-care', tier: 'open', load: 'always' },
  { name: 'returns-policy-calc', tier: 'open', load: 'on_demand' },
  { name: 'chargeback-evidence', tier: 'open', load: 'on_demand' },
]

describe('可用技能索引', () => {
  it('只列按需的、按名字排、每行带 description', async () => {
    const skills = await fixture()
    const entries = await onDemandSkillIndex({
      skills: SUPPORT,
      actor: ACTOR,
      registry: skills.registry,
    })
    expect(entries.map((e) => e.name)).toEqual(['chargeback-evidence', 'returns-policy-calc'])
    expect(entries[0]?.description).toMatch(/^拒付举证/)
    const section = skillIndexSection(entries, 'read_skill')
    expect(section?.id).toBe('skill_index')
    expect(section?.order).toBe(SKILL_INDEX_ORDER)
    expect(section?.text).toContain('read_skill')
    expect(section?.text).toContain('- returns-policy-calc：退换货规则怎么算')
    expect(section?.text).not.toContain('customer-care')
  })

  it('字节稳定：登记顺序打乱、重复登记，结果逐字相同', async () => {
    const skills = await fixture()
    const a = skillIndexSection(
      await onDemandSkillIndex({ skills: SUPPORT, actor: ACTOR, registry: skills.registry }),
      'read_skill',
    )
    const b = skillIndexSection(
      await onDemandSkillIndex({
        skills: [...SUPPORT].reverse().concat(SUPPORT),
        actor: ACTOR,
        registry: skills.registry,
      }),
      'read_skill',
    )
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('库里没有的、被本人排除的不列；一本都没有就整段不出', async () => {
    const skills = await fixture()
    await skills.registry.exclude('chargeback-evidence', 'per_1', true)
    const entries = await onDemandSkillIndex({
      skills: [...SUPPORT, { name: 'no-such-skill', tier: 'open', load: 'on_demand' }],
      actor: ACTOR,
      registry: skills.registry,
    })
    expect(entries.map((e) => e.name)).toEqual(['returns-policy-calc'])
    expect(skillIndexSection([], 'read_skill')).toBeUndefined()
  })

  it('always 技能照旧进 persona，按需的不进', async () => {
    const skills = await fixture()
    const sections = await skillPromptSections({
      skills: SUPPORT,
      actor: ACTOR,
      registry: skills.registry,
    })
    expect(sections.map((s) => s.name)).toEqual(['customer-care'])
  })
})

describe('read_skill 的判定', () => {
  it('登记了的：回六层叠加后的正文（公司层那一段也在）', async () => {
    const skills = await fixture()
    await skills.registry.putFromMarkdown({
      markdown: '---\nname: returns-policy-calc\n---\n\n## 本店口径\n\n定制品不退。\n',
      tier: 'company',
      owner: 'per_owner' as never,
      version: '1.0',
      workspace_id: 'ws_1',
    })
    const r = await readSkillForRun({
      name: ' returns-policy-calc ',
      skills: SUPPORT,
      actor: ACTOR,
      registry: skills.registry,
    })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.markdown).toContain('## 窗口怎么算')
    expect(r.markdown).toContain('定制品不退。')
  })

  it('没登记的名字：not_registered（库里有也不给）', async () => {
    const skills = await fixture()
    const r = await readSkillForRun({
      name: 'email-sms',
      skills: SUPPORT,
      actor: ACTOR,
      registry: skills.registry,
    })
    expect(r).toEqual({ status: 'not_registered', name: 'email-sms' })
  })

  it('被本人排除的：unavailable', async () => {
    const skills = await fixture()
    await skills.registry.exclude('chargeback-evidence', 'per_1', true)
    const r = await readSkillForRun({
      name: 'chargeback-evidence',
      skills: SUPPORT,
      actor: ACTOR,
      registry: skills.registry,
    })
    expect(r.status).toBe('unavailable')
  })

  it('以后多挂一个技能：只往 skills 里加一个名字，索引与读都跟着有', async () => {
    const skills = await fixture()
    const more: SkillRef[] = [...SUPPORT, { name: 'email-sms', tier: 'open', load: 'on_demand' }]
    const entries = await onDemandSkillIndex({
      skills: more,
      actor: ACTOR,
      registry: skills.registry,
    })
    expect(entries.map((e) => e.name)).toContain('email-sms')
    const r = await readSkillForRun({
      name: 'email-sms',
      skills: more,
      actor: ACTOR,
      registry: skills.registry,
    })
    expect(r.status).toBe('ok')
  })
})
