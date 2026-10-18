/** WP406 × WP407：官方规则表带 section 的行按节拼（说话规矩只拿自己那几行）。 */
import { houseRulesSection, nextSuggestionSection, replyLanguageSection } from '@agentsws/roles'
import { describe, expect, it, vi } from 'vitest'
import { decideDigest, harness, POSITION } from './wp406-harness.js'

vi.setConfig({ testTimeout: 60_000 })

describe('WP406 × WP407 公共规矩表分节', () => {
  it('官方新版改了「下一步建议」那一行：只进那一节；说话规矩不混进别的节', async () => {
    const h = harness()
    const rows = [
      { id: 'no_tool_names', zh: '说话规矩官方新版。', en: 'x' },
      { id: 'reply_language', section: 'reply_language', zh: '回复语言官方新版。', en: 'y' },
      { id: 'next_suggestion', section: 'next_step', zh: '下一步官方新版。', en: 'z' },
    ]
    h.publish(1, [
      {
        kind: 'rules',
        name: 'roles.house_rules',
        version: '1.0.1',
        files: { 'content.json': JSON.stringify({ table: 'roles.house_rules', rows }) },
        positions: [POSITION],
      },
    ])
    h.setNow('2026-10-19T02:00:00.000Z')
    await h.oc.check()
    await decideDigest(h, h.bus.open()[0] as never, 'apply_all')
    const house = houseRulesSection('zh').text
    expect(house).toContain('说话规矩官方新版。')
    expect(house).not.toContain('回复语言官方新版。')
    expect(house).not.toContain('下一步官方新版。')
    expect(replyLanguageSection('zh').text).toContain('回复语言官方新版。')
    expect(nextSuggestionSection('zh').text).toContain('下一步官方新版。')
  })
})
