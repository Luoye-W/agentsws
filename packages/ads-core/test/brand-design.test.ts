import type { BrandDesignCheckFinding, BrandDesignContext } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  adDesignPrompt,
  designNoteEn,
  designNoteZh,
  MAX_DESIGN_NOTES,
} from '../src/brand-design.js'

const finding = (n: number): BrandDesignCheckFinding => ({
  kind: 'color_off_palette',
  message_zh: `第 ${String(n)} 条`,
  message_en: `finding ${String(n)}`,
})

const present: BrandDesignContext = {
  present: true,
  prompt: '【品牌设计规范】色：primary #b8422e',
  tokens: {},
  palette: ['#b8422e'],
  fonts: [],
}

describe('71 §5：投放怎么用那份 DESIGN.md（WP122）', () => {
  it('没有规范就回空串', () => {
    expect(adDesignPrompt()).toBe('')
  })

  it('有规范就原样接上', () => {
    expect(adDesignPrompt(present)).toBe(present.prompt)
  })
})

describe('卡片上那一行提示：只提示，不拦人', () => {
  it('一条都没有时回 undefined —— 界面按"在不在"决定画不画那一行', () => {
    expect(designNoteZh([])).toBeUndefined()
    expect(designNoteEn([])).toBeUndefined()
  })

  it('最多显示三条，剩下的折成一个数', () => {
    const note = designNoteZh([1, 2, 3, 4, 5].map(finding))
    expect(note).toContain('第 1 条')
    expect(note).toContain('第 3 条')
    expect(note).not.toContain('第 4 条')
    expect(note).toContain('另有 2 条')
    expect(MAX_DESIGN_NOTES).toBe(3)
  })

  it('中英两行分开存，不在渲染时拼字符串', () => {
    expect(designNoteEn([1, 2, 3, 4].map(finding))).toContain('+1 more')
  })

  it('这个模块里没有一个函数回 boolean —— 它没有任何一条通路能变成一道闸', () => {
    expect(typeof adDesignPrompt(present)).toBe('string')
    expect(typeof designNoteZh([finding(1)])).toBe('string')
    expect(typeof designNoteEn([finding(1)])).toBe('string')
    // 空输入回 undefined（"没有"），也不是 false（"不合格"）
    expect(designNoteZh([])).toBeUndefined()
  })
})
