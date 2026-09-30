/**
 * 技能页（WP29 交付 D）。
 *
 * 三组断言：
 * 1. 每个技能列出当前版本、基础层、三层 overlay；
 * 2. 每条改动标出来源——「人写的」还是「学到的」（06 §3.4 纪律）；
 * 3. 待审提案数与「昨天学到的」列表对得上；真正的决定不在这一页按
 *    （36 §2.1：动作矩阵只有五个，技能页不另造一套按钮）。
 *
 * WP209 之后版本、段落与三层改动**点开一张小卡才看**，所以前几条先点开再断言；
 * 分组 / 折叠 / 搜索 / 筛选的断言在文件末尾。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillProposalSummary, SkillSummary } from '@/lib/api'
import { SkillsPage } from '@/pages/skills'
import { renderWithProviders } from './helpers'

/** WP209：点开某个技能的小卡（段落与三层改动在里面）。 */
async function openTile(name: string): Promise<void> {
  const tile = (await screen.findAllByTestId('skill-tile')).find((el) => el.dataset.skill === name)
  if (tile === undefined) throw new Error(`没有 ${name} 这张卡`)
  await userEvent.setup().click(within(tile).getByTestId('skill-tile-toggle'))
}

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
    await openTile('customer-care')
    expect(screen.getByText(/当前版本 1\.4/)).toBeTruthy()
    expect(screen.getByText(/基础层/)).toBeTruthy()
    expect(screen.getAllByText('退货窗口计算').length).toBeGreaterThan(0)
    expect(screen.getAllByText('回信语气').length).toBeGreaterThan(0)
  })

  it('每条改动标出来源：学到的 / 人写的（06 §3.4）', async () => {
    const { container } = renderWithProviders(<SkillsPage />)
    await screen.findByText('customer-care')
    await openTile('customer-care')
    expect(container.querySelectorAll('[data-origin="learned"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-origin="authored"]').length).toBeGreaterThan(0)
    // 学来的那条要能追溯到是哪几条 lesson、哪一天改的
    expect(screen.getByText(/2026-09-08/)).toBeTruthy()
  })

  it('待审提案数与「昨天学到的」列表对得上；这一页不出现批准按钮', async () => {
    renderWithProviders(<SkillsPage />)
    await screen.findByText('customer-care')
    // WP209：小卡上的徽标
    expect(screen.getByTestId('skill-tile-proposals').textContent).toContain('1 条建议待看')
    expect(screen.getByText(PROPOSAL.title)).toBeTruthy()
    await openTile('customer-care')
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
    // WP209 少字：没有建议的小卡上不挂徽标
    expect(screen.queryByTestId('skill-tile-proposals')).toBeNull()
  })

  it('排除只影响本人：按一下发出 exclude，卡上标成已排除', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SkillsPage />)
    await screen.findByText('customer-care')
    await openTile('customer-care')
    await user.click(screen.getByRole('button', { name: '不用这个技能' }))
    await waitFor(() => {
      expect(state.excluded).toEqual([{ name: 'customer-care', excluded: true }])
    })
    expect((await screen.findAllByText('已排除')).length).toBeGreaterThan(0)
  })

  it('一个技能都没有时给一句人话', async () => {
    state.skills = []
    state.proposals = []
    renderWithProviders(<SkillsPage />)
    await screen.findByText(/还没有技能/)
  })
})

describe('WP209 技能页：按岗位分组、折叠、展开一张、搜索、筛选', () => {
  const pos = (id: string, zh: string, mine = false) => ({ id, name: { zh, en: id }, mine })
  const CARE: SkillSummary = {
    ...SKILL,
    display_name: { zh: '客服回信', en: 'Customer care' },
    summary: { zh: '读来信、判断能不能办、写回信', en: 'Read, judge, reply' },
    positions: [pos('customer-care', '客服', true)],
    roles: [
      { role_id: 'dtc.support', name: { zh: '网站客服', en: 'Web' }, position_ids: [], mine: true },
    ],
    in_use: true,
  }
  const VOICE: SkillSummary = {
    ...SKILL,
    name: 'brand-voice',
    display_name: { zh: '品牌话术', en: 'Brand voice' },
    overlays: [],
    pending_proposals: 0,
    positions: [pos('customer-care', '客服', true), pos('pr', '公共关系')],
    roles: [
      { role_id: 'pr.press', name: { zh: '媒体', en: 'Press' }, position_ids: [], mine: false },
    ],
    in_use: false,
  }
  const QUOTE: SkillSummary = {
    ...SKILL,
    name: 'quotation',
    display_name: { zh: '报价', en: 'Quotation' },
    sections: [{ id: 'q1', heading: '价格条款', origin: 'authored', body: 'FOB 与 DDP 的区别' }],
    overlays: [],
    pending_proposals: 0,
    positions: [pos('b2b', 'B2B')],
    roles: [],
    in_use: false,
  }
  const tilesIn = (group: string): string[] => {
    const el = screen
      .getAllByTestId('library-group')
      .find((g) => g.dataset.group === group) as HTMLElement
    return within(el)
      .queryAllByTestId('skill-tile')
      .map((t) => t.dataset.skill ?? '')
  }

  beforeEach(() => {
    state.skills = [CARE, VOICE, QUOTE]
  })

  it('中文名当标题；本人的岗位摊开在前；共用的标出来；没开的岗位收着', async () => {
    renderWithProviders(<SkillsPage />)
    await screen.findByText('客服回信')
    const groups = screen.getAllByTestId('library-group').map((g) => g.dataset.group)
    expect(groups[0]).toBe('customer-care')
    expect(tilesIn('customer-care')).toEqual(['customer-care', 'brand-voice'])
    expect(screen.getByTestId('skill-tile-shared')).toBeTruthy()
    const others = screen.getAllByTestId('library-group').find((g) => g.dataset.group === 'others')
    expect(others?.dataset.open).toBe('no')
    expect(screen.queryByText('报价')).toBeNull()
    // 段落与三层改动默认收着
    expect(screen.queryByTestId('skill-details')).toBeNull()
    expect(screen.getAllByTestId('skill-tile-role').map((r) => r.textContent)).toContain('网站客服')
  })

  it('点开「没开的岗位」能看到里面的岗位；点开一张才看段落', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SkillsPage />)
    await screen.findByText('客服回信')
    const others = screen
      .getAllByTestId('library-group')
      .find((g) => g.dataset.group === 'others') as HTMLElement
    await user.click(within(others).getByTestId('library-group-toggle'))
    const b2b = screen
      .getAllByTestId('library-group')
      .find((g) => g.dataset.group === 'b2b') as HTMLElement
    expect(b2b.dataset.open).toBe('no')
    await user.click(within(b2b).getByTestId('library-group-toggle'))
    await openTile('quotation')
    expect(screen.getByTestId('skill-details').dataset.skill).toBe('quotation')
  })

  it('搜正文也搜得到，结果所在的组自动摊开', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SkillsPage />)
    await screen.findByText('客服回信')
    await user.type(screen.getByTestId('skills-search'), 'DDP')
    expect(tilesIn('b2b')).toEqual(['quotation'])
    expect(screen.queryByText('客服回信')).toBeNull()
    await user.clear(screen.getByTestId('skills-search'))
    await user.type(screen.getByTestId('skills-search'), '找不到的词')
    expect(screen.getByTestId('skills-no-match')).toBeTruthy()
  })

  it('只看有建议的 / 只看我在用的', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SkillsPage />)
    await screen.findByText('客服回信')
    await user.click(screen.getByTestId('skills-filter-proposals'))
    expect(screen.getAllByTestId('skill-tile').map((t) => t.dataset.skill)).toEqual([
      'customer-care',
    ])
    await user.click(screen.getByTestId('skills-filter-proposals'))
    await user.click(screen.getByTestId('skills-filter-mine'))
    expect(screen.getAllByTestId('skill-tile').map((t) => t.dataset.skill)).toEqual([
      'customer-care',
    ])
  })
})
