import { describe, expect, it } from 'vitest'
import { loadBundledRole, loadBundledRoles } from '../src/index.js'

/**
 * WP246（决策 87）：YouTube 字幕这个只读工具挂在红人营销与社媒运营的 YouTube 那两条上；
 * 意图词写窄（整句短语），挂工具不改岗位路由。网页转文字不挂 grounding——能抓网页（`web_tools`
 * 里有 `web_fetch`）的职责运行时自动多一个 `read_webpage`。
 */
describe('WP246 只读工具的挂载', () => {
  it('read_youtube_transcript 只挂 kol.youtube 与 social.youtube', () => {
    const got = loadBundledRoles()
      .filter((r) => r.grounding.some((g) => g.tool === 'read_youtube_transcript'))
      .map((r) => r.id)
      .sort()
    expect(got).toEqual(['kol.youtube', 'social.youtube'])
  })

  it('意图词是窄短语、不带 cue 词（stub 不会被「字幕」这类常用词带去调它）', () => {
    for (const id of ['kol.youtube', 'social.youtube']) {
      const g = loadBundledRole(id).grounding.find((x) => x.tool === 'read_youtube_transcript')
      expect(g?.cue_terms).toEqual([])
      expect(g?.intent_terms).not.toContain('字幕')
      expect(g?.prefetch).toBe(false)
    }
  })

  it('read_webpage 不进任何职责的 grounding（跟着 web_fetch 走）', () => {
    expect(loadBundledRoles().some((r) => r.grounding.some((g) => g.tool === 'read_webpage'))).toBe(
      false,
    )
  })
})
