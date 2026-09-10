/**
 * 40 §1.2 / E2「个人层 overlay 归档成『前员工层』只读」。
 *
 * 归档不是删：人走了，他攒在技能上的改动还看得见、还能被采纳进部门层；
 * 但它**不再参与叠加**——那一层的主人已经不在，谁也不该以他的身份跑。
 */
import { describe, expect, it } from 'vitest'
import { makeSkills } from './helpers.js'

const WS = 'ws_1'
const LEAVER = 'p_limo'
const AT = '2026-09-10T09:00:00.000Z'

const MD = `---
name: customer-care
description: 售后客服技能
---

## 退货窗口计算

以送达日为起点，14 天内可退。
`

const seed = async () => {
  const { skills } = makeSkills()
  const { skill } = await skills.registry.putFromMarkdown({
    markdown: MD,
    tier: 'package',
    owner: 'package',
    version: '1.0',
    workspace_id: WS,
  })
  const section = skill.sections[0]?.id as string
  await skills.registry.setOverlay({
    skill: 'customer-care',
    tier: 'personal',
    owner: LEAVER,
    ops: [{ op: 'replace', section_id: section, body: '以签收日为起点，30 天内可退。' }],
    base_version: '1.0',
    version: 0,
  })
  return { skills, section }
}

describe('归档区（前员工层）', () => {
  it('归档之后个人层不再叠加，解析回到上游那一版', async () => {
    const { skills, section } = await seed()
    const before = await skills.registry.resolve('customer-care', {
      person_id: LEAVER,
      workspace_id: WS,
    })
    expect(before?.sections.find((s) => s.id === section)?.body).toContain('30 天内可退')

    const archived = skills.registry.archivePersonalOverlays(LEAVER, AT, { reason: '李默离职' })
    expect(archived).toHaveLength(1)
    expect(archived[0]?.from_tier).toBe('personal')
    expect(archived[0]?.reason).toBe('李默离职')

    expect(skills.registry.getOverlay('customer-care', 'personal', LEAVER)).toBeUndefined()
    const after = await skills.registry.resolve('customer-care', {
      person_id: LEAVER,
      workspace_id: WS,
    })
    expect(after?.sections.find((s) => s.id === section)?.body).toContain('14 天内可退')
  })

  it('幂等：再跑一次归档 0 条，已归档的那条不被覆盖', async () => {
    const { skills } = await seed()
    skills.registry.archivePersonalOverlays(LEAVER, AT, { reason: '李默离职' })
    const again = skills.registry.archivePersonalOverlays(LEAVER, '2026-10-01T00:00:00.000Z')
    expect(again).toHaveLength(0)
    expect(skills.registry.getArchivedOverlay('customer-care', LEAVER)?.archived_at).toBe(AT)
  })

  it('只读：拿到的是副本，改它改不动库里的那份', async () => {
    const { skills } = await seed()
    skills.registry.archivePersonalOverlays(LEAVER, AT)
    const copy = skills.registry.getArchivedOverlay('customer-care', LEAVER)
    ;(copy?.ops[0] as { body?: string }).body = '被改坏的'
    expect(skills.registry.getArchivedOverlay('customer-care', LEAVER)?.ops[0]?.body).toContain(
      '30 天内可退',
    )
  })

  it('清单可按人、按技能筛；销毁那一档连归档一起丢', async () => {
    const { skills } = await seed()
    skills.registry.archivePersonalOverlays(LEAVER, AT)
    expect(skills.registry.listArchivedOverlays()).toHaveLength(1)
    expect(skills.registry.listArchivedOverlays({ owner: 'p_nobody' })).toHaveLength(0)
    expect(skills.registry.listArchivedOverlays({ skill: 'customer-care' })).toHaveLength(1)
    expect(skills.registry.dropArchivedOverlays(LEAVER)).toBe(1)
    expect(skills.registry.listArchivedOverlays()).toHaveLength(0)
    expect(skills.registry.getArchivedOverlay('customer-care', LEAVER)).toBeUndefined()
  })

  it('别人的个人层不受影响', async () => {
    const { skills, section } = await seed()
    await skills.registry.setOverlay({
      skill: 'customer-care',
      tier: 'personal',
      owner: 'p_other',
      ops: [{ op: 'replace', section_id: section, body: '别人的那一版' }],
      base_version: '1.0',
      version: 0,
    })
    skills.registry.archivePersonalOverlays(LEAVER, AT)
    expect(skills.registry.getOverlay('customer-care', 'personal', 'p_other')).toBeDefined()
  })
})
