/**
 * WP209：第三栏「设定」里的技能 / 知识标签用的是和技能页、知识库页**同一套**分组——
 * 技能按当前岗位 / 职责过滤，知识按岗位挑类。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KnowledgeGroupCounts } from '@/components/library/knowledge-groups'
import { SkillTagList } from '@/components/library/skill-groups'
import type { KnowledgeCardRow, SkillSummary } from '@/lib/api'
import { knowledgeGroupsForPosition, skillsForScope } from '@/lib/library'
import { renderWithProviders } from './helpers'

const skill = (name: string, zh: string, role: string, position: string): SkillSummary => ({
  name,
  tier: 'package',
  version: '1.0.0',
  excluded: false,
  sections: [],
  overlays: [],
  pending_proposals: name === 'quotation' ? 2 : 0,
  display_name: { zh, en: name },
  positions: [{ id: position, name: { zh: position, en: position }, mine: true }],
  roles: [{ role_id: role, name: { zh: role, en: role }, position_ids: [position], mine: true }],
})

const SKILLS = [
  skill('customer-care', '客服回信', 'dtc.support', 'customer-care'),
  skill('quotation', '报价', 'b2b.sales', 'b2b'),
]

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getSkills: async () => SKILLS }
})

const { SkillsPanel } = await import('@/components/rail/panels/skills-panel')

describe('WP209 第三栏用同一套分组', () => {
  it('技能面板：职责层只列这条职责在用的，名字用中文显示名', async () => {
    renderWithProviders(
      <SkillsPanel scope={{ tier: 'role', scope_id: 'b2b.sales', name: '业务员' }} />,
    )
    const rows = await screen.findAllByTestId('rail-skill')
    expect(rows.map((r) => r.dataset.skill)).toEqual(['quotation'])
    expect(rows[0]?.textContent).toContain('报价')
  })

  it('技能标签：按岗位过滤后一行一个名字，带待看建议数', () => {
    renderWithProviders(
      <SkillTagList skills={skillsForScope(SKILLS, { tier: 'position', scope_id: 'b2b' })} />,
    )
    const list = screen.getByTestId('skill-tag-list')
    expect(list.textContent).toBe('报价2')
  })

  it('知识计数：岗位挑自己常用的类，为 0 的不显示', () => {
    const cards: KnowledgeCardRow[] = [
      {
        id: 'b2b:delivery',
        layer: 'fact',
        subject: { type: 'b2b_fact', key: 'b2b:delivery' },
        statement: '交期 15 天',
        status: 'active',
        updated_at: '',
      },
      {
        id: 'tone',
        layer: 'phrasing',
        subject: { type: 'knowledge', key: 'tone.aftersales' },
        statement: '先确认订单号',
        status: 'active',
        updated_at: '',
      },
    ]
    renderWithProviders(
      <KnowledgeGroupCounts cards={cards} groups={knowledgeGroupsForPosition('b2b')} />,
    )
    const items = screen.getByTestId('knowledge-group-counts').querySelectorAll('li')
    // B2B 岗位不挑「品牌话术」，所以只剩 B2B 事实卡一类
    expect([...items].map((li) => li.dataset.group)).toEqual(['b2b'])
    expect(items[0]?.textContent).toBe('B2B 事实卡1')
  })
})
