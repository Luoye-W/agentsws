/**
 * 54 §1（WP69）：技能层从四层变六层。
 *
 * 钉三件事：
 * 1. 叠加顺序就是 `package → company → department → position → role → personal`，
 *    **只加不删**——原来那四层一个不少、相对次序一个没变；
 * 2. 六层真的一层压一层：同一段被六层各写一遍，解析出来的是最后一层那一版；
 * 3. `actor` 上没有 `position_id` / `role_id` 时那一层**自然被跳过**
 *    （54 §3：分配上没记岗位就跳过岗位层），而且不会误吃别的岗位那一份。
 */
import { describe, expect, it } from 'vitest'
import { type Actor, skillScopeDir, TIER_ORDER } from '../src/index.js'
import { makeSkills } from './helpers.js'

const SKILL = `---
name: web-ops
description: 网站运营说明书
---

## 改价之前

先看一眼竞品。
`

const ACTOR: Actor = {
  person_id: 'p_li',
  workspace_id: 'ws1',
  department_id: 'dept.ops',
  position_id: 'web-ops',
  role_id: 'dtc.store',
}

/** 六层各写一遍同一段，返回段 id。 */
async function seedAllTiers(registry: Awaited<ReturnType<typeof setup>>['registry']) {
  await registry.putFromMarkdown({
    markdown: SKILL,
    tier: 'package',
    owner: 'package',
    version: '1.0.0',
  })
  const section = registry.listSections('web-ops')[0]
  if (section === undefined) throw new Error('没有段')
  const write = async (
    tier: Parameters<typeof registry.put>[0]['tier'],
    body: string,
    scope?: string,
  ) => {
    await registry.put({
      name: 'web-ops',
      tier,
      owner: scope ?? 'ws1',
      version: '1.0.0',
      sections: [{ ...section, body }],
      evals: [],
      workspace_id: 'ws1',
      ...(scope === undefined ? {} : { scope_id: scope }),
    })
  }
  await write('company', '公司层')
  await write('department', '部门层', 'dept.ops')
  await write('position', '岗位层', 'web-ops')
  await write('role', '职责层', 'dtc.store')
  await registry.put({
    name: 'web-ops',
    tier: 'personal',
    owner: 'p_li',
    version: '1.0.0',
    sections: [{ ...section, body: '个人层' }],
    evals: [],
    workspace_id: 'ws1',
  })
  return section.id
}

function setup() {
  const { skills } = makeSkills()
  return skills
}

describe('54 §1 六层的顺序', () => {
  it('只加不删：原来四层一个不少，相对次序一个没变', () => {
    expect([...TIER_ORDER]).toEqual([
      'package',
      'company',
      'department',
      'position',
      'role',
      'personal',
    ])
    // 老的那四层彼此之间的先后一个字没变
    const old = TIER_ORDER.filter((t) => t !== 'position' && t !== 'role')
    expect([...old]).toEqual(['package', 'company', 'department', 'personal'])
  })

  it('目录约定：岗位层在 skills/positions/<id>，职责层在 skills/roles/<id>', () => {
    expect(skillScopeDir('position', 'web-ops')).toBe('skills/positions/web-ops')
    expect(skillScopeDir('role', 'dtc.store')).toBe('skills/roles/dtc.store')
    // 老的三层一个字没动
    expect(skillScopeDir('company')).toBe('skills/company')
    expect(skillScopeDir('department', 'dept.ops')).toBe('skills/departments/dept.ops')
  })
})

describe('54 §1 六层真的一层压一层', () => {
  it('六层各写一遍：解析出来的是个人层那一版，六层全部参与', async () => {
    const skills = setup()
    await seedAllTiers(skills.registry)
    const resolved = await skills.registry.resolve('web-ops', ACTOR)
    expect(resolved?.markdown).toContain('个人层')
    expect(resolved?.layers_applied).toEqual([
      'package',
      'company',
      'department',
      'position',
      'role',
      'personal',
    ])
  })

  it('职责层压在岗位层上面：没有个人层时，赢的是职责层', async () => {
    const skills = setup()
    const section_id = await seedAllTiers(skills.registry)
    expect(section_id).not.toBe('')
    // 把个人层那份换成空——这次没人在个人层写东西
    const { skills: fresh } = makeSkills()
    await fresh.registry.putFromMarkdown({
      markdown: SKILL,
      tier: 'package',
      owner: 'package',
      version: '1.0.0',
    })
    const section = fresh.registry.listSections('web-ops')[0]
    if (section === undefined) throw new Error('没有段')
    for (const [tier, body, scope] of [
      ['position', '岗位层', 'web-ops'],
      ['role', '职责层', 'dtc.store'],
    ] as const) {
      await fresh.registry.put({
        name: 'web-ops',
        tier,
        owner: scope,
        version: '1.0.0',
        sections: [{ ...section, body }],
        evals: [],
        workspace_id: 'ws1',
        scope_id: scope,
      })
    }
    const resolved = await fresh.registry.resolve('web-ops', ACTOR)
    expect(resolved?.markdown).toContain('职责层')
    expect(resolved?.markdown).not.toContain('岗位层')
  })
})

describe('54 §3 没记岗位就跳过那一层', () => {
  it('actor 上没有 position_id：岗位层不参与，也不会误吃别的岗位那一份', async () => {
    const skills = setup()
    await seedAllTiers(skills.registry)
    const { position_id: _drop, ...noPosition } = ACTOR
    const resolved = await skills.registry.resolve('web-ops', noPosition)
    expect(resolved?.layers_applied).not.toContain('position')
    // 职责层照旧生效——跳过的只有一层
    expect(resolved?.layers_applied).toContain('role')
  })

  it('actor 上的岗位是别的岗位：这一层就是空的', async () => {
    const skills = setup()
    await seedAllTiers(skills.registry)
    const resolved = await skills.registry.resolve('web-ops', {
      ...ACTOR,
      position_id: 'customer-care',
    })
    expect(resolved?.layers_applied).not.toContain('position')
  })
})
