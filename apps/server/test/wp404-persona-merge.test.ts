/**
 * WP404（docs/107 §4）：persona 的官方更新直接复用技能的按段三方合并（`planContentMerge`）——
 * 公司按段改过的那几段，在官方新版里撞没撞。
 */
import { personaMergeSections, personaSectionDiff, personaSectionEdits } from '@agentsws/roles'
import { planContentMerge } from '@agentsws/skills'
import { describe, expect, it } from 'vitest'

const OLD = {
  zh: '你是谁：甲。\n你负责：乙。\n你不负责：丙。\n怎么做：丁。\n口气：戊。\n必须出卡：己。',
  en: '',
}

describe('WP404 persona 按段合并复用 planContentMerge', () => {
  it('官方只改了你没碰的段 → 干净；改了你改过的段 → 冲突；你改成和新版一样 → 干净', () => {
    const mine = { zh: OLD.zh.replace('口气：戊。', '口气：像老朋友。'), en: '' }
    const edits = personaSectionEdits(personaSectionDiff(OLD, mine), 'zh', {
      tier: 'company',
      owner: 'ws_1',
    })
    expect(edits).toEqual([
      {
        tier: 'company',
        owner: 'ws_1',
        source: 'layer',
        op: 'replace',
        section_id: 'tone',
        body: '像老朋友。',
      },
    ])
    const before = personaMergeSections(OLD, 'zh')
    const touchOther = { zh: OLD.zh.replace('怎么做：丁。', '怎么做：新做法。'), en: '' }
    expect(
      planContentMerge(before, personaMergeSections(touchOther, 'zh'), edits).conflicts,
    ).toEqual([])
    const touchMine = { zh: OLD.zh.replace('口气：戊。', '口气：更正式。'), en: '' }
    const plan = planContentMerge(before, personaMergeSections(touchMine, 'zh'), edits)
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toMatchObject({
      section_id: 'tone',
      heading: '口气',
      base_before: '戊。',
      base_after: '更正式。',
      mine: '像老朋友。',
    })
    const sameAsNew = { zh: OLD.zh.replace('口气：戊。', '口气：像老朋友。'), en: '' }
    expect(
      planContentMerge(before, personaMergeSections(sameAsNew, 'zh'), edits).conflicts,
    ).toEqual([])
  })
})
