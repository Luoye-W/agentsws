/**
 * WP78（60 §2）：新闻稿六段与两条硬规矩。
 */
import { describe, expect, it } from 'vitest'
import { checkFacts, checkRelease, composeRelease, renderRelease } from '../src/index.js'

const now = '2026-09-17T09:00:00Z'
const quote = {
  speaker: '王岚，Nordvolt 创始人',
  text: '我们做这件事三年了。',
  provided_by: 'p_wang',
  provided_at: now,
}
const draft = {
  headline: 'Nordvolt 发布第二代户外电源',
  dek: '2026 年 9 月 17 日，Nordvolt 在深圳发布第二代户外电源。',
  body: '新机型续航提升 18%，首批售出 3,200 台。',
  quotes: [quote],
  boilerplate: 'Nordvolt 是一家做户外电源的公司。',
  contact: { name: '王岚', email: 'pr@nordvolt.example' },
  facts_cited: [
    { figure: '18%', fact_card_id: 'fc_battery' },
    { figure: '3,200', fact_card_id: 'fc_units' },
  ],
}

describe('checkFacts（数字只引事实卡）', () => {
  it('每个数都有出处 → 过', () => {
    const r = checkFacts(draft.body, draft.facts_cited)
    expect(r.ok).toBe(true)
    expect(r.figures).toEqual(['18%', '3,200'])
  })

  it('多写一个数 → 不过，理由里原样带着那个数', () => {
    const r = checkFacts('复购率 47%，售出 3,200 台', draft.facts_cited)
    expect(r.ok).toBe(false)
    expect(r.uncited).toEqual(['47%'])
    expect(r.problems[0]?.message).toContain('47%')
    expect(r.problems[0]?.rule).toBe('press_release_facts_required')
  })

  it('千分位与不带千分位对得上（3,200 ↔ 3200）', () => {
    expect(checkFacts('售出 3200 台', [{ figure: '3,200', fact_card_id: 'x' }]).ok).toBe(true)
  })

  it('日期与一位数不算数字——不然没人愿意引事实卡了', () => {
    expect(checkFacts('2026-09-17 发布，共 3 款', []).ok).toBe(true)
  })
})

describe('checkRelease（六段齐不齐 + 引语必须是人给的）', () => {
  it('齐的稿子过', () => {
    expect(checkRelease(draft).ok).toBe(true)
  })

  it('引语没写是谁给的 → 不过', () => {
    const r = checkRelease({ ...draft, quotes: [{ ...quote, provided_by: '' }] })
    expect(r.ok).toBe(false)
    expect(r.problems.some((p) => p.rule === 'press_release_quote_needs_human')).toBe(true)
  })

  it('一条引语都没有是允许的', () => {
    expect(checkRelease({ ...draft, quotes: [] }).ok).toBe(true)
  })

  it('没留联系方式 → 不过（记者会照着那一行打过来）', () => {
    const r = checkRelease({ ...draft, contact: { name: '', email: '' } })
    expect(r.problems.some((p) => p.rule === 'contact_required')).toBe(true)
  })
})

describe('composeRelease / renderRelease', () => {
  it('拼出来的稿子恒为草稿——这个函数发不出去', () => {
    const r = composeRelease({ id: 'pr_1', workspace_id: 'ws', ...draft, now })
    expect(r.status).toBe('draft')
    expect(r.distributed_at).toBeUndefined()
  })

  it('渲染出来的顺序是新闻稿的老规矩，末尾是 ###', () => {
    const text = renderRelease(draft)
    expect(text.startsWith(draft.headline)).toBe(true)
    expect(text).toContain('「我们做这件事三年了。」——王岚，Nordvolt 创始人')
    expect(text).toContain('关于我们')
    expect(text.trimEnd().endsWith('###')).toBe(true)
  })

  it('有禁发期就写在最前面', () => {
    expect(renderRelease({ ...draft, embargo_until: now })).toContain('【禁发至')
  })
})
