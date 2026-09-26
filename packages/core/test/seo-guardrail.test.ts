/**
 * WP154「内容与搜索」：三条改页面的 ChangeKind 与发布前质检的兜底门。
 *
 * 钉死四件事：
 * 1. `page_seo_edit` 只改标题 / 描述 / H1 / 开头四格，开头最多两句，夹带正文 → block；
 * 2. `page_section_add` 要有小标题与正文；
 * 3. `internal_link_edit` 至少一条、不许链回自己；
 * 4. `publish_post` 要发出去而质检没过 → block（草稿不受影响）。
 */
import type { Mandate } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  evaluateGuardrail,
  HARD_L1,
  KIND_RISK,
  Provenance,
  RECORD_READ_KINDS,
  sentenceCount,
} from '../src/index.js'

const now = '2026-09-26T08:00:00Z'
const page = { type: 'page', id: 'pg_charger_guide' } as const
const article = { type: 'article', id: 'art_1' } as const

const prov = (target: { type: string; id: string }) => {
  const p = new Provenance('run_1')
  p.see([target as never], { full: true })
  return p
}
const facts = (target: { type: string; id: string }, windowCount = 0) => ({
  now,
  changeSet: [],
  windowCount,
  provenance: prov(target),
})
const mandate: Mandate = { caps: { max_page_edits_per_day: 3, max_links_per_change: 5 } }

const change = (
  kind: 'page_seo_edit' | 'page_section_add' | 'internal_link_edit',
  after: object,
) => ({
  kind,
  target: page,
  before: { title: '快充头怎么挑' },
  after,
})

describe('WP154 三条改页面的动作：风险与改前必读', () => {
  it('三条都是 low、都不在 HARD_L1、都要改前必读', () => {
    for (const k of ['page_seo_edit', 'page_section_add', 'internal_link_edit'] as const) {
      expect(KIND_RISK[k]).toBe('low')
      expect(HARD_L1.has(k)).toBe(false)
      expect(RECORD_READ_KINDS.has(k)).toBe(true)
    }
  })
})

describe('page_seo_edit：只改那四格', () => {
  it('改标题与开头两句 → allow', () => {
    const r = evaluateGuardrail(
      change('page_seo_edit', {
        title: '快充头怎么挑：PD 与 PPS 的区别',
        opening: '快充头先看协议。PD 通用，PPS 是三星要的那一种。',
      }),
      mandate,
      facts(page),
      'stage',
    )
    expect(r.verdict).toBe('allow')
  })

  it('一格都没改 → block', () => {
    const r = evaluateGuardrail(change('page_seo_edit', {}), mandate, facts(page), 'stage')
    expect(r.verdict).toBe('block')
    expect(r.hits.some((h) => h.rule === 'page_seo_edit_nothing')).toBe(true)
  })

  it('开头写成三句 → block', () => {
    const r = evaluateGuardrail(
      change('page_seo_edit', { opening: '第一句。第二句。第三句。' }),
      mandate,
      facts(page),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.find((h) => h.rule === 'page_seo_opening_two_sentences')?.actual).toBe(3)
  })

  it('夹带正文 → block（改正文不借这条的额度）', () => {
    const r = evaluateGuardrail(
      change('page_seo_edit', { title: '新标题', body: '整页重写' }),
      mandate,
      facts(page),
      'stage',
    )
    expect(r.hits.some((h) => h.rule === 'page_seo_edit_body_untouched')).toBe(true)
  })

  it('当天超过额度 → 转人审', () => {
    const r = evaluateGuardrail(
      change('page_seo_edit', { title: '新标题' }),
      mandate,
      facts(page, 3),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
    expect(r.hits.some((h) => h.rule === 'max_page_edits_per_day')).toBe(true)
  })
})

describe('page_section_add 与 internal_link_edit', () => {
  it('小节缺正文 → block；齐了 → allow', () => {
    const bad = evaluateGuardrail(
      change('page_section_add', { heading: 'PD 与 PPS 有什么区别' }),
      mandate,
      facts(page),
      'stage',
    )
    expect(bad.hits.some((h) => h.rule === 'page_section_needs_heading_and_body')).toBe(true)
    const ok = evaluateGuardrail(
      change('page_section_add', { heading: 'PD 与 PPS 有什么区别', body: 'PD 是通用协议。' }),
      mandate,
      facts(page),
      'stage',
    )
    expect(ok.verdict).toBe('allow')
  })

  it('内链链回自己 → block；链到别页 → allow', () => {
    const self = evaluateGuardrail(
      change('internal_link_edit', { links: [{ to: page.id, anchor: '快充头' }] }),
      mandate,
      facts(page),
      'stage',
    )
    expect(self.hits.some((h) => h.rule === 'internal_link_self')).toBe(true)
    const ok = evaluateGuardrail(
      change('internal_link_edit', { links: [{ to: 'pg_cable_guide', anchor: '线怎么配' }] }),
      mandate,
      facts(page),
      'stage',
    )
    expect(ok.verdict).toBe('allow')
  })

  it('一次改太多条链接 → 转人审', () => {
    const links = Array.from({ length: 6 }, (_, i) => ({ to: `pg_${i}`, anchor: `a${i}` }))
    const r = evaluateGuardrail(
      change('internal_link_edit', { links }),
      mandate,
      facts(page),
      'stage',
    )
    expect(r.verdict).toBe('require_review')
  })
})

describe('publish_post：质检没过就发不出去', () => {
  const post = (after: object) => ({
    kind: 'publish_post' as const,
    target: article,
    before: { title: 't', published: false },
    after,
  })
  const failed = {
    passed: false,
    issues: [{ rule: 'banned_claim', sentence: '全网最好的快充头。', detail: '绝对化用语' }],
  }

  it('要发出去而质检没过 → block，理由带那一句', () => {
    const r = evaluateGuardrail(
      post({ title: 't', published: true, quality_gate: failed }),
      { caps: { max_posts_per_day: 2 } },
      facts(article),
      'stage',
    )
    expect(r.verdict).toBe('block')
    expect(r.hits.find((h) => h.rule === 'content_quality_gate')?.actual).toBe('全网最好的快充头。')
  })

  it('草稿不受质检影响（挡在草稿，不是连草稿都不让存）', () => {
    const r = evaluateGuardrail(
      post({ title: 't', published: false, quality_gate: failed }),
      { caps: { max_posts_per_day: 2 } },
      facts(article),
      'stage',
    )
    expect(r.verdict).toBe('allow')
  })
})

describe('sentenceCount', () => {
  it('中英文句末标点都认', () => {
    expect(sentenceCount('一句。两句！')).toBe(2)
    expect(sentenceCount('One. Two? Three!')).toBe(3)
    expect(sentenceCount('v2.0 is here')).toBe(1)
  })
})
