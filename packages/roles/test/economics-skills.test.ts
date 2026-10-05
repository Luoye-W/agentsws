import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_ROLES_DIR, loadBundledRole } from '../src/index.js'

/**
 * WP224（docs/91 §2.2 #1 / #3、§7 #1 #2）：后台两样落成技能挂到现有职责上，不开新岗位；
 * 自动止损线一个数没动（先并排两周再定）。
 */
const BUNDLED_SKILLS_DIR = join(BUNDLED_ROLES_DIR, '..', '..', 'skills', 'bundled')
const ADS = ['ads.meta', 'ads.google', 'ads.tiktok', 'ads.x']

describe('WP224 单位经济与经营一页纸挂在哪', () => {
  it('unit-economics 挂店铺管理与投放四条，按需加载；正文在技能包里', () => {
    for (const id of ['dtc.store', ...ADS]) {
      const ref = loadBundledRole(id).skills.find((s) => s.name === 'unit-economics')
      expect(ref, id).toMatchObject({ tier: 'open', load: 'on_demand' })
    }
    expect(existsSync(join(BUNDLED_SKILLS_DIR, 'unit-economics', 'SKILL.md'))).toBe(true)
  })

  it('公司设置与授权：weekly-review 技能 + 只读的「本周经营一页纸」（不是写动作）', () => {
    const owner = loadBundledRole('common.owner')
    expect(owner.skills.find((s) => s.name === 'weekly-review')).toBeDefined()
    expect(owner.quick_prompts?.find((q) => q.id === 'weekly_review')).toMatchObject({
      kind: 'review',
      label: { zh: '本周经营一页纸' },
    })
    // 只读：没有多出任何写动作
    expect(owner.actions.map((a) => a.id)).toEqual([
      'change_policy',
      'grant_assignment',
      'authorize_connector',
    ])
    expect(existsSync(join(BUNDLED_SKILLS_DIR, 'weekly-review', 'SKILL.md'))).toBe(true)
  })

  it('自动止损线没动：投放四条仍是 ROAS < 1（盈亏线只并排显示）', () => {
    for (const id of ADS) {
      const pause = loadBundledRole(id).actions.find((a) => a.id === 'pause_ads')
      expect(pause?.mandate.caps?.stop_loss_roas_below, id).toBe(1)
    }
  })
})
