/**
 * WP243：推荐回话改成紧凑的数组 JSON；老格式照样认；被输出上限截断时救回写完整了的职责。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSuggestPrompt,
  parseSuggestion,
  SUGGEST_MAX_OUTPUT_TOKENS,
} from '../src/onboarding-suggest.js'
import { ROLLOUT_COMPACT_ANSWER } from './wp243-fixtures.js'

describe('WP243 推荐的紧凑写法', () => {
  it('提示词要的是紧凑数组 JSON，理由与原话限字数', () => {
    const prompt = buildSuggestPrompt('要做社媒', [
      {
        id: 'social.tiktok',
        name: 'TikTok',
        category_id: 'social-media',
        category: '社媒运营',
        what_it_does: '发 TikTok',
      },
    ])
    expect(prompt).toContain(
      '{"r":[["职责id","理由","原话"]],"p":[["岗位名",["职责id","职责id"]]]}',
    )
    expect(prompt).toContain('15 字以内')
    expect(SUGGEST_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(2048)
  })

  it('新格式：职责三格、岗位两格', () => {
    const got = parseSuggestion(ROLLOUT_COMPACT_ANSWER)
    expect(got?.roles).toHaveLength(21)
    expect(got?.roles[0]).toEqual({
      role_id: 'site.shopify-build',
      reason: '独立站刚建好要搭骨架',
      quote: 'Shopify 独立站',
    })
    expect(got?.positions?.[0]?.name).toBe('建站')
    expect(got?.positions?.[0]?.role_ids).toHaveLength(4)
  })

  it('老格式照样认（包在 ``` 里也行）', () => {
    const got = parseSuggestion(
      '```json\n{"roles":[{"role_id":"a.b","reason":"r","quote":"q"}],"positions":[{"name":"甲","role_ids":["a.b"]}]}\n```',
    )
    expect(got).toEqual({
      roles: [{ role_id: 'a.b', reason: 'r', quote: 'q' }],
      positions: [{ name: '甲', role_ids: ['a.b'] }],
    })
  })

  it('被截断（JSON 没收尾）：救回写完整了的职责，岗位交给算法版', () => {
    const cut = ROLLOUT_COMPACT_ANSWER.slice(0, ROLLOUT_COMPACT_ANSWER.indexOf('kol.tiktok') + 6)
    const got = parseSuggestion(cut)
    expect(got?.roles.map((r) => r.role_id)).toContain('kol.instagram')
    expect(got?.roles.map((r) => r.role_id)).not.toContain('kol.tiktok')
    expect(got?.positions).toBeUndefined()
    // 截在岗位那段里：职责全救回，岗位那段里的 id 数组不会被当成职责
    const inPositions = ROLLOUT_COMPACT_ANSWER.slice(0, ROLLOUT_COMPACT_ANSWER.length - 30)
    expect(parseSuggestion(inPositions)?.roles).toHaveLength(21)
    expect(parseSuggestion('{"r":[["a.b","理')).toBeUndefined()
    expect(parseSuggestion('什么都没有')).toBeUndefined()
  })
})
