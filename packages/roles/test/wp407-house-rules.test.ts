/**
 * WP407（决策 1179）：「回复语言」「下一步建议」两句全职责公共规矩并进 `roles.house_rules` 表。
 *
 * 三节（回复语言 22、说话规矩 25、下一步建议 27）的位置、标题、正文与并表前逐字节相同；
 * 表能按品牌覆盖；覆盖表缺某一节就照旧用随软件带的那几行；`section` 写错整张覆盖不用。
 * 全部职责 × 中英的字节另由 `wp404-prompt-bytes.test.ts` 钉着。
 */
import { NEXT_SUGGESTION_RULE } from '@agentsws/contracts'
import { registerContentTableProvider } from '@agentsws/core'
import { afterEach, describe, expect, it } from 'vitest'
import HOUSE_RULES_FILE from '../src/house-rules.content.json' with { type: 'json' }
import {
  HOUSE_RULE_SECTIONS,
  HOUSE_RULES,
  HOUSE_RULES_ORDER,
  houseRulesSection,
  NEXT_SUGGESTION_ORDER,
  nextSuggestionSection,
  REPLY_LANGUAGE_ORDER,
  REPLY_LANGUAGE_RULE,
  replyLanguageSection,
} from '../src/index.js'

let off: (() => void) | undefined
afterEach(() => {
  off?.()
  off = undefined
})

const rows = HOUSE_RULES_FILE.rows as { id: string; zh: string; en: string; section?: string }[]

describe('WP407 公共规矩表：三节同一张表', () => {
  it('表里三行、各进一节；section 只用认得的值', () => {
    expect(rows.map((r) => [r.id, r.section ?? 'house'])).toEqual([
      ['no_tool_names', 'house'],
      ['reply_language', 'reply_language'],
      ['next_suggestion', 'next_step'],
    ])
    for (const r of rows) expect(HOUSE_RULE_SECTIONS).toContain(r.section ?? 'house')
  })

  it('说话规矩那一节只有不写 section 的那行（与并表前相同）', () => {
    expect(HOUSE_RULES.zh).toBe(rows[0]?.zh)
    expect(HOUSE_RULES.en).toBe(rows[0]?.en)
    expect(houseRulesSection('zh')).toEqual({
      id: 'house',
      name: '说话规矩',
      order: HOUSE_RULES_ORDER,
      text: rows[0]?.zh,
    })
  })

  it('回复语言：位置、标题不变，正文来自表', () => {
    expect(REPLY_LANGUAGE_ORDER).toBe(22)
    expect(REPLY_LANGUAGE_RULE.zh).toBe(rows[1]?.zh)
    expect(REPLY_LANGUAGE_RULE.en).toBe(rows[1]?.en)
    expect(replyLanguageSection('en')).toEqual({
      id: 'reply_language',
      name: 'reply language',
      order: 22,
      text: rows[1]?.en,
    })
  })

  it('下一步建议：中文与契约 NEXT_SUGGESTION_RULE 逐字节相同，位置 27、标题「下一步建议」', () => {
    expect(nextSuggestionSection('zh')).toEqual({
      id: 'next_step',
      name: '下一步建议',
      order: NEXT_SUGGESTION_ORDER,
      text: NEXT_SUGGESTION_RULE,
    })
    expect(NEXT_SUGGESTION_ORDER).toBe(27)
    expect(nextSuggestionSection('en').text).toContain('<next>')
  })
})

describe('WP407 公共规矩表：按品牌覆盖', () => {
  it('覆盖表改了回复语言那一行 → 那个品牌用新的，别的品牌照旧', () => {
    off = registerContentTableProvider((table, brand) =>
      table === 'roles.house_rules' && brand === 'b1'
        ? [
            ...rows.filter((r) => r.id !== 'reply_language'),
            { id: 'reply_language', section: 'reply_language', zh: '新的回复语言', en: 'new' },
          ]
        : undefined,
    )
    expect(replyLanguageSection('zh', 'b1').text).toBe('新的回复语言')
    expect(replyLanguageSection('zh', 'b2').text).toBe(rows[1]?.zh)
    expect(houseRulesSection('zh', 'b1').text).toBe(rows[0]?.zh)
  })

  it('覆盖表里某一节一行都没有 → 那一节照旧用随软件带的', () => {
    off = registerContentTableProvider((table) =>
      table === 'roles.house_rules'
        ? [{ id: 'no_tool_names', zh: '只改了这条', en: 'x' }]
        : undefined,
    )
    expect(houseRulesSection('zh', 'b1').text).toBe('只改了这条')
    expect(replyLanguageSection('zh', 'b1').text).toBe(rows[1]?.zh)
    expect(nextSuggestionSection('zh', 'b1').text).toBe(NEXT_SUGGESTION_RULE)
  })

  it('section 写成认不得的值 → 整张覆盖不用', () => {
    off = registerContentTableProvider((table) =>
      table === 'roles.house_rules'
        ? [...rows, { id: 'x', section: 'nowhere', zh: '不该出现', en: 'x' }]
        : undefined,
    )
    expect(houseRulesSection('zh', 'b1').text).toBe(rows[0]?.zh)
    expect(
      [replyLanguageSection('zh', 'b1'), nextSuggestionSection('zh', 'b1')].some((s) =>
        s.text.includes('不该出现'),
      ),
    ).toBe(false)
  })
})
