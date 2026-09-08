import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillRegistry } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { Actor, OverlayEx } from '../src/index.js'
import { createSkills } from '../src/index.js'
import {
  CUSTOMER_CARE_V1,
  CUSTOMER_CARE_V1_1,
  FakeClock,
  headingId,
  makeSkills,
  seededRandom,
} from './helpers.js'

const ACTOR: Actor = { person_id: 'p1', workspace_id: 'ws1', department_id: 'dept.ops' }

describe('契约一致性', () => {
  it('registry 与 SkillRegistry 同形（resolve 返回类型除外）', () => {
    const { skills } = makeSkills()
    const conforming: Omit<SkillRegistry, 'resolve'> = skills.registry
    expect(typeof conforming.parse).toBe('function')
  })
})

describe('24 §6.1 公司版改标题不改段 id → 个人 overlay 仍叠上', () => {
  it('公司 1.0 → 1.1 改标题，个人 overlay 继续生效', async () => {
    const { skills } = makeSkills()
    const { registry } = skills
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'company',
      owner: 'boss',
      version: '1.0',
      workspace_id: 'ws1',
    })
    const v1 = await registry.get('customer-care', 'company', { workspace_id: 'ws1' })
    const sectionId = headingId(v1?.sections ?? [], '退换货判定')

    await registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: 'p1',
      base_version: '1.0',
      version: 0,
      ops: [{ op: 'replace', section_id: sectionId, body: '德国站按 14 天算。' }],
    })
    const before = await registry.resolve('customer-care', ACTOR)
    expect(before?.sections.find((s) => s.id === sectionId)?.body).toBe('德国站按 14 天算。')

    // 公司发 1.1：把"退换货判定"改名为"退换货规则"
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1_1,
      tier: 'company',
      owner: 'boss',
      version: '1.1',
      workspace_id: 'ws1',
    })
    const v11 = await registry.get('customer-care', 'company', { workspace_id: 'ws1' })
    expect(headingId(v11?.sections ?? [], '退换货规则')).toBe(sectionId)

    const after = await registry.resolve('customer-care', ACTOR)
    const section = after?.sections.find((s) => s.id === sectionId)
    expect(section?.heading).toBe('退换货规则')
    expect(section?.body).toBe('德国站按 14 天算。')
    expect(after?.layers_applied).toEqual(['company', 'personal'])
    expect(after?.conflicts).toEqual([])
    expect(after?.markdown).toContain('## 退换货规则\n\n德国站按 14 天算。')
  })
})

describe('24 §6.2 同段两边都改 → conflict，不自动合', () => {
  it('公司与个人都 replace 同一段且 base_version 落后 → 记 conflict，正文取更近的层', async () => {
    const { skills } = makeSkills()
    const { registry } = skills
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'package',
      owner: 'package',
      version: '1.0',
    })
    const base = await registry.get('customer-care', 'package')
    const sectionId = headingId(base?.sections ?? [], '退换货判定')

    await registry.setOverlay({
      skill: 'customer-care',
      tier: 'company',
      owner: 'ws1',
      base_version: '1.0',
      version: 0,
      ops: [{ op: 'replace', section_id: sectionId, body: '公司口径：按签收日算。' }],
    })
    await registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: 'p1',
      base_version: '1.0',
      version: 0,
      ops: [{ op: 'replace', section_id: sectionId, body: '我的口径：德国站 14 天。' }],
    })
    // 上游出新版
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1.replace('条款窗口算。', '条款窗口算（1.1 修订）。'),
      tier: 'package',
      owner: 'package',
      version: '1.1',
    })

    const resolved = await registry.resolve('customer-care', ACTOR)
    expect(resolved?.conflicts).toHaveLength(1)
    const conflict = resolved?.conflicts[0]
    expect(conflict?.section_id).toBe(sectionId)
    expect(conflict?.tiers).toEqual(['company', 'personal'])
    expect(conflict?.versions.map((v) => v.body)).toEqual([
      '公司口径：按签收日算。',
      '我的口径：德国站 14 天。',
    ])
    // 不自动合：正文取更近的层（个人）
    expect(resolved?.sections.find((s) => s.id === sectionId)?.body).toBe(
      '我的口径：德国站 14 天。',
    )
  })

  it('两层都 replace 但 base_version 都是当前上游版本 → 只是叠加，不算冲突', async () => {
    const { skills } = makeSkills()
    const { registry } = skills
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'package',
      owner: 'package',
      version: '1.0',
    })
    const base = await registry.get('customer-care', 'package')
    const sectionId = headingId(base?.sections ?? [], '禁止事项')
    for (const [tier, owner, body] of [
      ['company', 'ws1', '公司禁令'],
      ['personal', 'p1', '我的禁令'],
    ] as const) {
      await registry.setOverlay({
        skill: 'customer-care',
        tier,
        owner,
        base_version: '1.0',
        version: 0,
        ops: [{ op: 'replace', section_id: sectionId, body }],
      })
    }
    const resolved = await registry.resolve('customer-care', ACTOR)
    expect(resolved?.conflicts).toEqual([])
    expect(resolved?.sections.find((s) => s.id === sectionId)?.body).toBe('我的禁令')
  })
})

describe('overlay 的三种操作与版本', () => {
  it('setOverlay 每次写入版本 +1', async () => {
    const { skills } = makeSkills()
    const overlay: OverlayEx = {
      skill: 'customer-care',
      tier: 'personal',
      owner: 'p1',
      base_version: '1.0',
      version: 0,
      ops: [],
    }
    expect((await skills.registry.setOverlay(overlay)).version).toBe(1)
    expect((await skills.registry.setOverlay(overlay)).version).toBe(2)
    expect(skills.registry.getOverlay('customer-care', 'personal', 'p1')?.version).toBe(2)
    expect(skills.registry.listOverlays('customer-care')).toHaveLength(1)
  })

  it('append / remove / 指向不存在段的 op', async () => {
    const { skills } = makeSkills()
    const { registry } = skills
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'package',
      owner: 'package',
      version: '1.0',
    })
    const base = await registry.get('customer-care', 'package')
    const forbid = headingId(base?.sections ?? [], '禁止事项')
    const order = headingId(base?.sections ?? [], '回答顺序')
    await registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: 'p1',
      base_version: '1.0',
      version: 0,
      ops: [
        { op: 'append', section_id: forbid, body: '不承诺时效。', origin: 'learned' },
        { op: 'remove', section_id: order },
        { op: 'replace', section_id: 'GHOST', body: '上游删掉的段' },
      ],
    })
    const resolved = await registry.resolve('customer-care', ACTOR)
    expect(resolved?.sections.map((s) => s.heading)).toEqual([
      '退换货判定',
      '额度与策略',
      '禁止事项',
    ])
    const appended = resolved?.sections.find((s) => s.id === forbid)
    expect(appended?.body).toBe('不发明补偿，不写道歉段，不回显卡号。\n\n不承诺时效。')
    expect(appended?.origin).toBe('learned')
    expect(resolved?.unresolved_ops).toHaveLength(1)
    expect(resolved?.unresolved_ops[0]?.op.section_id).toBe('GHOST')
    // append 不算 replace，不产生冲突
    expect(resolved?.conflicts).toEqual([])
  })
})

describe('下沉 rebase', () => {
  it('上游新版 → base_version 更新，被改过的段进冲突', async () => {
    const { skills } = makeSkills()
    const { registry } = skills
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'company',
      owner: 'boss',
      version: '1.0',
      workspace_id: 'ws1',
    })
    const v1 = await registry.get('customer-care', 'company', { workspace_id: 'ws1' })
    const changed = headingId(v1?.sections ?? [], '退换货判定')
    const untouched = headingId(v1?.sections ?? [], '禁止事项')
    await registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: 'p1',
      base_version: '1.0',
      version: 0,
      ops: [
        { op: 'replace', section_id: changed, body: '我的口径' },
        { op: 'replace', section_id: untouched, body: '我的禁令' },
      ],
    })
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1.replace('条款窗口算。', '条款窗口算（1.1）。'),
      tier: 'company',
      owner: 'boss',
      version: '1.1',
      workspace_id: 'ws1',
    })

    const result = await registry.rebase('customer-care', 'personal')
    expect(result.rebased).toHaveLength(1)
    expect(result.rebased[0]?.base_version).toBe('1.1')
    expect(result.rebased[0]?.version).toBe(2)
    expect(result.conflicts.map((c) => c.section_id)).toEqual([changed])
    expect(result.conflicts[0]?.versions.map((v) => v.tier)).toEqual(['company', 'personal'])
    // rebase 后同段不再算冲突
    expect((await registry.resolve('customer-care', ACTOR))?.conflicts).toEqual([])
  })

  it('没有上游 → not_found', async () => {
    const { skills } = makeSkills()
    await expect(skills.registry.rebase('nope', 'personal')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('24 §6.7 排除', () => {
  it('排除某 skill → resolve 返回 undefined，不影响他人；取消排除后恢复', async () => {
    const { skills } = makeSkills()
    const { registry } = skills
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'package',
      owner: 'package',
      version: '1.0',
    })
    await registry.exclude('customer-care', 'p1', true)
    expect(await registry.resolve('customer-care', ACTOR)).toBeUndefined()
    expect(registry.isExcluded('customer-care', 'p1')).toBe(true)
    const other: Actor = { person_id: 'p2', workspace_id: 'ws1' }
    expect((await registry.resolve('customer-care', other))?.sections).toHaveLength(4)
    await registry.exclude('customer-care', 'p1', false)
    expect((await registry.resolve('customer-care', ACTOR))?.sections).toHaveLength(4)
  })

  it('未知 skill → not_found', async () => {
    const { skills } = makeSkills()
    await expect(skills.registry.resolve('nope', ACTOR)).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('put / 部门层 / sidecar', () => {
  it('put 给没有 id 的段补 id 并复用同名段的 id', async () => {
    const { skills } = makeSkills()
    const { registry } = skills
    await registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'package',
      owner: 'package',
      version: '1.0',
    })
    const base = await registry.get('customer-care', 'package')
    const forbid = headingId(base?.sections ?? [], '禁止事项')
    await registry.put({
      name: 'customer-care',
      tier: 'department',
      owner: 'lead',
      version: '1.0+1',
      base: { tier: 'package', version: '1.0' },
      evals: [],
      workspace_id: 'ws1',
      scope_id: 'dept.ops',
      sections: [{ id: '', heading: '禁止事项', body: '部门禁令', origin: 'authored' }],
    })
    const dept = await registry.get('customer-care', 'department', {
      workspace_id: 'ws1',
      scope_id: 'dept.ops',
    })
    expect(dept?.sections[0]?.id).toBe(forbid)
    const resolved = await registry.resolve('customer-care', ACTOR)
    expect(resolved?.layers_applied).toEqual(['package', 'department'])
    expect(resolved?.sections.find((s) => s.id === forbid)?.body).toBe('部门禁令')
  })

  it('sidecar 落盘后新进程重解析仍保持段 id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-skills-'))
    const first = createSkills({ clock: new FakeClock(), random: seededRandom(1), dir })
    await first.registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1,
      tier: 'package',
      owner: 'package',
      version: '1.0',
    })
    const ids = (await first.registry.get('customer-care', 'package'))?.sections.map((s) => s.id)
    expect(readdirSync(dir)).toEqual(['customer-care.sections.json'])
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'customer-care.sections.json'), 'utf8'))
    expect((raw as { sections: unknown[] }).sections).toHaveLength(4)

    const second = createSkills({ clock: new FakeClock(), random: seededRandom(99), dir })
    const reparsed = await second.registry.putFromMarkdown({
      markdown: CUSTOMER_CARE_V1_1,
      tier: 'package',
      owner: 'package',
      version: '1.1',
    })
    expect(reparsed.skill.sections.map((s) => s.id)).toEqual(ids)
    expect(reparsed.splits).toEqual([])
  })

  it('putFromMarkdown 缺 name 直接报错', async () => {
    const { skills } = makeSkills()
    await expect(
      skills.registry.putFromMarkdown({
        markdown: '---\ndescription: x\n---\n\n## a\n\nb\n',
        tier: 'package',
        owner: 'package',
        version: '1.0',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
