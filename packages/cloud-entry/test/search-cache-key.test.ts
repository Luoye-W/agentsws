/**
 * WP166：缓存键带市场——每个目标市场分别探，美国的结果不能拿去当英国的；国家码大小写是同一个市场。
 */
import { describe, expect, it } from 'vitest'
import { answerCacheKey, serpCacheKey } from '../src/search/routes.js'

describe('WP166 · 搜索数据缓存键带市场', () => {
  it('SERP：US 与 us 同一个键，英国另一个键', () => {
    const q = { query: 'Best Tote', engine: 'google' as const, country: 'US', language: 'en' }
    expect(serpCacheKey('dataforseo', q)).toBe(serpCacheKey('dataforseo', { ...q, country: 'us' }))
    expect(serpCacheKey('dataforseo', q)).not.toBe(
      serpCacheKey('dataforseo', { ...q, country: 'gb' }),
    )
  })

  it('AI 问答：同上', () => {
    const p = { question: 'Is it good?', country: 'GB', language: 'en' }
    expect(answerCacheKey('dataforseo', 'chatgpt', p)).toBe(
      answerCacheKey('dataforseo', 'chatgpt', { ...p, country: 'gb' }),
    )
    expect(answerCacheKey('dataforseo', 'chatgpt', p)).not.toBe(
      answerCacheKey('dataforseo', 'chatgpt', { ...p, country: 'de' }),
    )
  })
})
