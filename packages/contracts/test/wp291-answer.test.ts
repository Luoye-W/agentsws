/**
 * WP291：当场回答 = 一句话 + 组件。组件按契约校验，模型不吐 HTML。
 */
import { describe, expect, it } from 'vitest'
import {
  ANSWER_LIMITS,
  QUICK_ANSWER_RULE,
  splitAnswer,
  validateAnswerComponent,
  validateAnswerComponents,
} from '../src/index.js'

describe('WP291 回答组件', () => {
  it('```answer 段取出组件，正文第一段是那一句话', () => {
    const raw = [
      '店里现在有 3 件商品，2 件在卖。',
      '',
      '```answer',
      '{"components":[{"kind":"table","columns":["商品","价格","状态"],"rows":[["蓝牙耳机",129,"在卖"],["手机壳",29,"在卖"],["充电器",59,"草稿"]]},{"kind":"metric","items":[{"label":"在卖","value":2,"unit":"件"}]}]}',
      '```',
    ].join('\n')
    const a = splitAnswer(raw)
    expect(a.lead).toBe('店里现在有 3 件商品，2 件在卖。')
    expect(a.components.map((c) => c.kind)).toEqual(['table', 'metric'])
    expect(a.text).not.toContain('```')
  })

  it('坏 JSON 那段整个不要，只留一句话', () => {
    const a = splitAnswer('今天 8 单。\n```answer\n{"components":[{"kind":"table",\n```')
    expect(a.lead).toBe('今天 8 单。')
    expect(a.components).toEqual([])
  })

  it('没写 ```answer 但画了 Markdown 表格 → 收成表格', () => {
    const a = splitAnswer(
      '店里有这些商品：\n\n| 商品 | 价格 |\n|---|---|\n| **蓝牙耳机** | 129 |\n| 手机壳 | 29 |\n\n要改价跟我说。',
    )
    expect(a.lead).toBe('店里有这些商品：')
    expect(a.components[0]).toEqual({
      kind: 'table',
      columns: ['商品', '价格'],
      rows: [
        ['蓝牙耳机', '129'],
        ['手机壳', '29'],
      ],
    })
    expect(a.components[1]).toEqual({ kind: 'text', text: '要改价跟我说。' })
  })

  it('不认识的 kind、空表、空数字不画；HTML 只是字', () => {
    expect(validateAnswerComponent({ kind: 'html', html: '<b>x</b>' })).toBeUndefined()
    expect(validateAnswerComponent({ kind: 'table', columns: ['a'], rows: [] })).toBeUndefined()
    expect(
      validateAnswerComponent({ kind: 'metric', items: [{ label: '', value: 1 }] }),
    ).toBeUndefined()
    expect(validateAnswerComponent({ kind: 'text', text: '<script>x</script>' })).toEqual({
      kind: 'text',
      text: '<script>x</script>',
    })
  })

  it('超了就截：行数、列数、数字块数、组件数', () => {
    const rows = Array.from({ length: 80 }, (_, i) => [i, 'x', 'y', 'z', 1, 2, 3, 4, 5, 6])
    const t = validateAnswerComponent({
      kind: 'table',
      columns: Array(10).fill('c'),
      rows,
      total: 80,
    })
    expect(t).toMatchObject({ kind: 'table', total: 80 })
    if (t?.kind !== 'table') throw new Error('not a table')
    expect(t.rows).toHaveLength(ANSWER_LIMITS.rows)
    expect(t.columns).toHaveLength(ANSWER_LIMITS.columns)
    const m = validateAnswerComponent({
      kind: 'metric',
      items: Array.from({ length: 9 }, (_, i) => ({ label: `m${i}`, value: i, delta_pct: 1.234 })),
    })
    if (m?.kind !== 'metric') throw new Error('not metric')
    expect(m.items).toHaveLength(ANSWER_LIMITS.metrics)
    expect(m.items[0]?.delta_pct).toBe(1.2)
    expect(validateAnswerComponents(Array(9).fill({ kind: 'text', text: 'a' }))).toHaveLength(
      ANSWER_LIMITS.components,
    )
  })

  it('给模型的规矩：只查只答、附 ```answer、数字照原样', () => {
    expect(QUICK_ANSWER_RULE).toContain('```answer')
    expect(QUICK_ANSWER_RULE).toContain('不出卡')
    expect(QUICK_ANSWER_RULE).toContain('原样')
  })
})
