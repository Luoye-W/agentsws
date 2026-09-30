/**
 * WP209：技能 / 知识「先分类、再展开」的判定（`lib/library.ts`，纯函数）。
 */
import { describe, expect, it } from 'vitest'
import type { KnowledgeCardRow, SkillSummary } from '@/lib/api'
import {
  countByStatus,
  filterKnowledge,
  filterSkills,
  groupKnowledge,
  groupSkills,
  knowledgeGroupOf,
  knowledgeGroupsForPosition,
  knowledgeOriginOf,
  knowledgeStatusOf,
  policyKindOf,
  SCOPE_GENERAL,
  scopeOptions,
  sharedAcross,
  skillLabel,
  skillsForScope,
} from '@/lib/library'

const pos = (id: string, zh: string, mine = false) => ({ id, name: { zh, en: id }, mine })

const skill = (name: string, extra: Partial<SkillSummary> = {}): SkillSummary => ({
  name,
  tier: 'package',
  version: '1.0.0',
  excluded: false,
  sections: [{ id: 's1', heading: '你是谁', origin: 'authored', body: `${name} 正文` }],
  overlays: [],
  pending_proposals: 0,
  ...extra,
})

const CARE = skill('customer-care', {
  display_name: { zh: '客服回信', en: 'Customer care' },
  positions: [pos('customer-care', '客服', true)],
  roles: [
    { role_id: 'dtc.support', name: { zh: '网站客服', en: 'Web' }, position_ids: [], mine: true },
  ],
  in_use: true,
  pending_proposals: 2,
})
const VOICE = skill('brand-voice', {
  positions: [
    pos('customer-care', '客服', true),
    pos('social-media', '社媒运营'),
    pos('pr', '公关'),
  ],
  roles: [{ role_id: 'social.x', name: { zh: 'X', en: 'X' }, position_ids: [], mine: false }],
})
const QUOTE = skill('quotation', { positions: [pos('b2b', 'B2B')] })
const BASICS = skill('workspace-basics', { positions: [pos('common', '通用')] })

describe('技能按岗位分组', () => {
  it('本人的岗位在前、通用单独一组、其余进「没开的岗位」', () => {
    const g = groupSkills([CARE, VOICE, QUOTE, BASICS])
    expect(g.mine.map((x) => x.id)).toEqual(['customer-care'])
    expect(g.mine[0]?.skills.map((s) => s.name)).toEqual(['customer-care', 'brand-voice'])
    expect(g.common?.skills.map((s) => s.name)).toEqual(['workspace-basics'])
    // 派工单的岗位顺序：社媒运营 → B2B → 公共关系
    expect(g.others.map((x) => x.id)).toEqual(['social-media', 'b2b', 'pr'])
  })

  it('跨岗位的标共用；没显示名退回英文 id', () => {
    expect(sharedAcross(VOICE)).toBe(3)
    expect(sharedAcross(CARE)).toBe(1)
    expect(skillLabel(CARE, 'zh')).toBe('客服回信')
    expect(skillLabel(QUOTE, 'zh')).toBe('quotation')
  })

  it('老服务进程没回 positions：全进「通用」', () => {
    const g = groupSkills([skill('x')])
    expect(g.common?.skills).toHaveLength(1)
    expect(g.mine).toEqual([])
  })

  it('搜名字 / 正文 / 职责名；只看有建议的；只看我在用的', () => {
    const all = [CARE, VOICE, QUOTE]
    expect(filterSkills(all, { query: '回信' }).map((s) => s.name)).toEqual(['customer-care'])
    expect(filterSkills(all, { query: 'quotation 正文' }).map((s) => s.name)).toEqual(['quotation'])
    expect(filterSkills(all, { query: '网站客服' }).map((s) => s.name)).toEqual(['customer-care'])
    expect(filterSkills(all, { onlyProposals: true }).map((s) => s.name)).toEqual(['customer-care'])
    expect(filterSkills(all, { onlyMine: true }).map((s) => s.name)).toEqual(['customer-care'])
  })

  it('第三栏按岗位 / 职责过滤同一套；老进程原样全给', () => {
    const all = [CARE, VOICE, QUOTE]
    expect(skillsForScope(all, { tier: 'position', scope_id: 'b2b' }).map((s) => s.name)).toEqual([
      'quotation',
    ])
    expect(skillsForScope(all, { tier: 'role', scope_id: 'social.x' }).map((s) => s.name)).toEqual([
      'brand-voice',
    ])
    expect(skillsForScope([skill('a'), skill('b')], { tier: 'role', scope_id: 'x' })).toHaveLength(
      2,
    )
  })
})

const card = (id: string, extra: Partial<KnowledgeCardRow> = {}): KnowledgeCardRow => ({
  id,
  layer: 'fact',
  subject: { type: 'knowledge', key: id },
  statement: `${id} 的口径`,
  status: 'active',
  updated_at: '2026-09-30T00:00:00.000Z',
  ...extra,
})

describe('知识按类型分组', () => {
  it('B2B 前缀 / 话术层 / 物流词 / 政策 / 产品 / 其它', () => {
    expect(knowledgeGroupOf(card('b2b:pricing_moq'))).toBe('b2b')
    expect(knowledgeGroupOf(card('tone.aftersales', { layer: 'phrasing' }))).toBe('brand_voice')
    expect(knowledgeGroupOf(card('shipping.cutoff'))).toBe('logistics')
    expect(knowledgeGroupOf(card('policy:shipping', { layer: 'policy' }))).toBe('policy')
    expect(knowledgeGroupOf(card('returns.window.de'))).toBe('policy')
    expect(knowledgeGroupOf(card('warranty.window'))).toBe('policy')
    expect(
      knowledgeGroupOf(
        card('product:Anker 737', { subject: { type: 'product', key: 'product:x' } }),
      ),
    ).toBe('product')
    expect(knowledgeGroupOf(card('case.1', { layer: 'historical_case' }))).toBe('other')
    expect(knowledgeGroupOf(card('something.else'))).toBe('other')
    // 「information」里有 rma 三个字母，不能被当成退换
    expect(knowledgeGroupOf(card('company.information'))).toBe('other')
  })

  it('政策分哪一份', () => {
    expect(policyKindOf(card('policy:refund'))).toBe('returns')
    expect(policyKindOf(card('policy:shipping'))).toBe('shipping')
    expect(policyKindOf(card('policy:privacy'))).toBe('privacy')
    expect(policyKindOf(card('policy:terms'))).toBe('terms')
    expect(policyKindOf(card('policy:warranty'))).toBe('warranty')
  })

  it('状态四档：冲突 > 已过期 > 待确认 > 已生效', () => {
    const now = new Date('2026-09-30T00:00:00.000Z')
    expect(knowledgeStatusOf(card('a'), now)).toBe('active')
    expect(knowledgeStatusOf(card('a', { status: 'proposed' }), now)).toBe('pending')
    expect(knowledgeStatusOf(card('a', { verification_state: 'stale' }), now)).toBe('expired')
    expect(knowledgeStatusOf(card('a', { valid: { until: '2026-09-01T00:00:00Z' } }), now)).toBe(
      'expired',
    )
    expect(
      knowledgeStatusOf(
        card('a', { status: 'proposed', conflicts: [{ with: 'b', note: '' }] }),
        now,
      ),
    ).toBe('conflict')
  })

  it('来源三档', () => {
    expect(
      knowledgeOriginOf(card('a', { provenance: [{ source: 'document', ref: 'knowledge/a.md' }] })),
    ).toBe('upload')
    expect(
      knowledgeOriginOf(card('a', { created_by: { kind: 'agent', id: 'brand-intake' } })),
    ).toBe('agent')
    expect(knowledgeOriginOf(card('a', { created_by: { kind: 'person', id: 'p1' } }))).toBe(
      'manual',
    )
  })

  it('按范围筛：选了某个品牌 = 它的 + 通用的；「通用」= 没限范围的', () => {
    const general = card('g')
    const a = card('a', { scope: [{ kind: 'brand', id: 'b1' }] })
    const b = card('b', { scope: [{ kind: 'brand', id: 'b2' }] })
    const all = [general, a, b]
    expect(scopeOptions(all)).toEqual([
      { kind: 'brand', id: 'b1' },
      { kind: 'brand', id: 'b2' },
    ])
    expect(filterKnowledge(all, { scope: 'brand:b1' }).map((c) => c.id)).toEqual(['g', 'a'])
    expect(filterKnowledge(all, { scope: SCOPE_GENERAL }).map((c) => c.id)).toEqual(['g'])
  })

  it('分组计数、空组不回；按状态筛与计数', () => {
    const all = [card('b2b:delivery'), card('b2b:pricing_moq', { status: 'proposed' }), card('x')]
    expect(groupKnowledge(all).map((g) => [g.id, g.cards.length])).toEqual([
      ['b2b', 2],
      ['other', 1],
    ])
    expect(filterKnowledge(all, { status: 'pending' }).map((c) => c.id)).toEqual([
      'b2b:pricing_moq',
    ])
    expect(countByStatus(all)).toEqual({ active: 2, pending: 1, expired: 0, conflict: 0 })
  })

  it('第三栏：岗位挑自己先看的几类，认不出的给全部', () => {
    expect(knowledgeGroupsForPosition('b2b')[0]).toBe('b2b')
    expect(knowledgeGroupsForPosition('nope')).toHaveLength(7)
  })
})
