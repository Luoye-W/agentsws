/**
 * 技能页（WP29 交付 D）。
 *
 * 三组断言：
 * 1. 每个技能列出当前版本、基础层、三层 overlay；
 * 2. 每条改动标出来源——「人写的」还是「学到的」（06 §3.4 纪律）；
 * 3. 待审提案数与「昨天学到的」列表对得上；真正的决定不在这一页按
 *    （36 §2.1：动作矩阵只有五个，技能页不另造一套按钮）。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillProposalSummary, SkillSummary } from '@/lib/api'
import { SkillsPage } from '@/pages/skills'
import { renderWithProviders } from './helpers'

const SKILL: SkillSummary = {
  name: 'customer-care',
  tier: 'company',
  version: '1.4',
  excluded: false,
  sections: [
    { id: 'sec_1', heading: '退货窗口计算', origin: 'authored' },
    { id: 'sec_2', heading: '回信语气', origin: 'authored' },
  ],
  overlays: [
    {
      tier: 'personal',
      owner: 'per_wang',
      version: 2,
      base_version: '1.4',
      ops: [
        {
          op: 'append',
          section_id: 'sec_1',
          heading: '退货窗口计算',
          origin: 'learned',
          body: '退货窗口要从送达日算，不是下单日',
          learned_from: { lessons: ['les_1', 'les_2'], at: '2026-09-08T07:30:00.000Z' },
        },
        {
          op: 'append',
          section_id: 'sec_2',
          heading: '回信语气',
          origin: 'authored',
          body: '开头直接叫名字',
        },
      ],
    },
  ],
  pending_proposals: 1,
}

const PROPOSAL: SkillProposalSummary = {
  approval_item_id: 'apr_1',
  skill: 'customer-care',
  section_id: 'sec_1',
  heading: '退货窗口计算',
  title: '昨天学到的：给「退货窗口计算」加一条 先看窗口',
  summary: '2 次同类纠正攒出来的一条。采纳就写进你的个人层，不采纳以后不再提。',
  hits: 2,
  confidence: 0.75,
  options: [
    { id: 'append', label: '在「退货窗口计算」后面加一句' },
    { id: 'none', label: '都不要' },
  ],
  quotes: ['退货窗口要从送达日算，不是下单日'],
  diff: { before: '以送达日为起点。', after: '以送达日为起点。\n\n先看窗口', summary: '追加一条' },
}

const state = {
  skills: [SKILL] as SkillSummary[],
  proposals: [PROPOSAL] as SkillProposalSummary[],
  excluded: [] as { name: string; excluded: boolean }[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getSkills: async () => state.skills,
    getSkillProposals: async () => state.proposals,
    setSkillExcluded: async (name: string, excluded: boolean) => {
      state.excluded.push({ name, excluded })
      state.skills = state.skills.map((s) => (s.name === name ? { ...s, excluded } : s))
      return { name, excluded }
    },
  }
})

beforeEach(() => {
  state.skills = [SKILL]
  state.proposals = [PROPOSAL]
  state.excluded = []
})

describe('24 §1 技能页：当前版本 + 三层 overlay + 待审提案', () => {
  it('列出技能名、版本、基础层与两个段落', async () => {
    renderWithProviders(<SkillsPage />)
    await screen.findByText('customer-care')
    expect(screen.getByText(/当前版本 1\.4/)).toBeTruthy()
    expect(screen.getByText(/基础层/)).toBeTruthy()
    expect(screen.getAllByText('退货窗口计算').length).toBeGreaterThan(0)
    expect(screen.getAllByText('回信语气').length).toBeGreaterThan(0)
  })

  it('每条改动标出来源：学到的 / 人写的（06 §3.4）', async () => {
    const { container } = renderWithProviders(<SkillsPage />)
    await screen.findByText('customer-care')
    expect(container.querySelectorAll('[data-origin="learned"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-origin="authored"]').length).toBeGreaterThan(0)
    // 学来的那条要能追溯到是哪几条 lesson、哪一天改的
    expect(screen.getByText(/2026-09-08/)).toBeTruthy()
  })

  it('待审提案数与「昨天学到的」列表对得上；这一页不出现批准按钮', async () => {
    renderWithProviders(<SkillsPage />)
    await screen.findByText('customer-care')
    expect(screen.getByText('待审提案 1')).toBeTruthy()
    expect(screen.getByText(PROPOSAL.title)).toBeTruthy()
    expect(screen.getAllByText(/退货窗口要从送达日算/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '采纳' })).toBeNull()
    expect(screen.getByRole('button', { name: '去卡片上定' })).toBeTruthy()
  })

  it('没有待审建议时说人话，不是空白', async () => {
    state.proposals = []
    state.skills = [{ ...SKILL, pending_proposals: 0 }]
    renderWithProviders(<SkillsPage />)
    await screen.findByText('customer-care')
    expect(screen.getByText(/现在没有待审的建议/)).toBeTruthy()
    expect(screen.getByText('没有待你看的建议')).toBeTruthy()
  })

  it('排除只影响本人：按一下发出 exclude，卡上标成已排除', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SkillsPage />)
    await screen.findByText('customer-care')
    await user.click(screen.getByRole('button', { name: '不用这个技能' }))
    await waitFor(() => {
      expect(state.excluded).toEqual([{ name: 'customer-care', excluded: true }])
    })
    await screen.findByText('已排除')
  })

  it('一个技能都没有时给一句人话', async () => {
    state.skills = []
    state.proposals = []
    renderWithProviders(<SkillsPage />)
    await screen.findByText(/还没有技能/)
  })
})
