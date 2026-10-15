/**
 * WP316（docs/101 §5.3，决策 552 / 553）：上传表 / 开始投放 / 撤销三条动作挂在 Google / Meta 两条投放职责上，
 * 动作 id 对得上 ChangeKind（对不上会兜底成 high、悄悄落 L1 以外的地方），三条都是写死的 L1。
 */
import { HARD_L1, KIND_RISK } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import { changeKindOf, loadBundledRole } from '../src/index.js'

const ACTIONS = {
  stage_ads_sheet: 'ads_sheet',
  stage_ads_activate: 'ads_activate',
  stage_ads_undo: 'ads_undo',
} as const

describe('WP316 三条插件执行的动作', () => {
  it('动作 id → ChangeKind 对得上；三条都在硬顶里、按 high', () => {
    for (const [action, kind] of Object.entries(ACTIONS)) {
      expect(changeKindOf(action)).toBe(kind)
      expect(HARD_L1.has(kind)).toBe(true)
      expect(KIND_RISK[kind]).toBe('high')
    }
  })

  it('Google / Meta 两条职责上都有，并且职责这一层也写死 L1', () => {
    for (const id of ['ads.google', 'ads.meta']) {
      const role = loadBundledRole(id)
      for (const action of Object.keys(ACTIONS)) {
        expect(role.actions.some((a) => a.id === action)).toBe(true)
        const auto = role.automation[action]
        expect(auto?.ceiling).toBe('L1')
        expect(auto?.hard_ceiling).toBe(true)
      }
    }
  })
})
