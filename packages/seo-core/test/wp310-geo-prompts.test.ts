/** WP310（决策 463）：候选 Prompt 的纯函数——按方向分组、不塞品牌名的占多数、默认选 5、合并不复活。 */
import type { GeoQuestion } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  generatePromptCandidates,
  groupPromptsByTopic,
  guessPromptTopic,
  maxBrandedSelected,
  newPromptCandidates,
  pickDefaultPrompts,
  promptId,
  promptIsBranded,
} from '../src/index.js'

const BRAND = { name: 'Voltbrick', aliases: ['VB 20K'] }
const SEED = {
  brand: BRAND,
  category: 'power bank',
  competitors: ['Anker', 'Belkin', 'Mophie'],
  use_cases: ['travel', 'camping'],
  language: 'en' as const,
  top_queries: [
    'how long does a 20000mah power bank last on a flight',
    'voltbrick 20k review',
    'can i bring a power bank on a plane',
  ],
}

describe('WP310 候选 Prompt', () => {
  it('按方向出、按展示顺序排；不带品牌名的占多数；查询里像问句的才收、方向按字面猜', () => {
    const c = generatePromptCandidates(SEED)
    const topics = [...new Set(c.map((q) => q.topic))]
    expect(topics).toEqual([
      'category',
      'buying_guide',
      'comparison',
      'use_case',
      'price_value',
      'reviews',
      'branded',
      'other',
    ])
    expect(c.every((q) => q.selected === false && q.enabled)).toBe(true)
    const branded = c.filter((q) => q.branded === true)
    expect(branded.every((q) => q.topic === 'branded')).toBe(true)
    expect(branded.length * 2).toBeLessThan(c.length)
    expect(c.map((q) => q.text)).toContain('What is the best power bank for travel?')
    expect(c.map((q) => q.text)).toContain('Anker vs Belkin: which power bank is better?')
    // 「voltbrick 20k review」不像问句，不收；另两句收进来
    expect(c.filter((q) => q.origin === 'top_query').map((q) => q.text)).toEqual([
      'How long does a 20000mah power bank last on a flight?',
      'Can i bring a power bank on a plane?',
    ])
    expect(new Set(c.map((q) => q.id)).size).toBe(c.length)
  })

  it('中文档案出中文句子；没有品类只出带品牌名的', () => {
    const zh = generatePromptCandidates({
      brand: { name: '沃特砖' },
      category: '充电宝',
      language: 'zh',
    })
    expect(zh[0]?.text).toBe('充电宝哪个牌子好？')
    expect(zh.find((q) => q.topic === 'branded')?.text).toBe('沃特砖怎么样，值得买吗？')
    const bare = generatePromptCandidates({ brand: BRAND, language: 'en' })
    expect(bare.every((q) => q.topic === 'branded')).toBe(true)
  })

  it('带没带品牌名（名字或别名、按词）；方向猜法', () => {
    expect(promptIsBranded('Is the vb 20k any good?', BRAND)).toBe(true)
    expect(promptIsBranded('Voltbricks are bricks', BRAND)).toBe(false)
    expect(guessPromptTopic('Is Voltbrick worth it?', BRAND)).toBe('branded')
    expect(guessPromptTopic('Anker vs Belkin?', BRAND)).toBe('comparison')
    expect(guessPromptTopic('What is the cheapest power bank?', BRAND)).toBe('price_value')
    expect(guessPromptTopic('Which power banks are most reliable?', BRAND)).toBe('reviews')
    expect(guessPromptTopic('How do I choose a power bank?', BRAND)).toBe('buying_guide')
    expect(guessPromptTopic('Best power bank for camping?', BRAND)).toBe('use_case')
    expect(guessPromptTopic('Top power banks 2026?', BRAND)).toBe('category')
    expect(guessPromptTopic('Can I bring one on a plane?', BRAND)).toBe('other')
    expect(promptId('What is X?')).toBe(promptId('  what is x? '))
  })

  it('默认选 5：方向轮流、带品牌名的只 1 条；人已经选的先留；10 / 20 档带品牌名上限 2 / 4', () => {
    const c = generatePromptCandidates(SEED)
    const five = pickDefaultPrompts(c)
    expect(five).toHaveLength(5)
    const chosen = five.map((id) => c.find((q) => q.id === id))
    expect(chosen.filter((q) => q?.branded === true)).toHaveLength(1)
    expect(new Set(chosen.filter((q) => q?.branded !== true).map((q) => q?.topic)).size).toBe(4)

    const mine = c.map((q) => (q.topic === 'reviews' ? { ...q, selected: true } : q))
    expect(pickDefaultPrompts(mine)[0]).toBe(c.find((q) => q.topic === 'reviews')?.id)

    expect(maxBrandedSelected(10)).toBe(2)
    expect(maxBrandedSelected(20)).toBe(4)
    const twenty = pickDefaultPrompts(c, 20).map((id) => c.find((q) => q.id === id))
    expect(twenty.filter((q) => q?.branded === true).length).toBeLessThanOrEqual(4)
    // 归档的、关掉的不挑
    const off = c.map((q, i) =>
      i < 2 ? { ...q, enabled: false } : i < 4 ? { ...q, archived_at: 't' } : q,
    )
    const picked = new Set(pickDefaultPrompts(off, 20))
    expect(c.slice(0, 4).some((q) => picked.has(q.id))).toBe(false)
  })

  it('合并：已有的（含归档的）按字面比，见过的不再加；按方向分组', () => {
    const c = generatePromptCandidates(SEED)
    const existing: GeoQuestion[] = [
      { id: 'x1', text: 'what is the best POWER BANK?', origin: 'human', enabled: false },
      {
        id: 'x2',
        text: 'Is Voltbrick worth it?',
        origin: 'brand',
        enabled: true,
        archived_at: 't',
      },
    ]
    const fresh = newPromptCandidates(existing, c)
    expect(fresh.map((q) => q.text)).not.toContain('What is the best power bank?')
    expect(fresh.map((q) => q.text)).not.toContain('Is Voltbrick worth it?')
    expect(fresh).toHaveLength(c.length - 2)
    const groups = groupPromptsByTopic(c)
    expect(groups[0]).toMatchObject({ topic: 'category', label_zh: '品类推荐' })
    expect(groups.reduce((n, g) => n + g.prompts.length, 0)).toBe(c.length)
  })
})
