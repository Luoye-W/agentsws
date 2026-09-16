/**
 * WP68（48 §5.1 / §5.4）工作台那一侧：红人岗位面板上那几件**能动手的**事。
 *
 * 钉的是四条界面纪律，每一条都是"说真话"那一类：
 *
 * 1. 搜不到与**拿不到**分得开：服务端那一句人话原样出现，不画一张空表；
 * 2. 联系方式只出现脱敏形态，DOM 里搜不到一个真地址；
 * 3. 花钱之前先说数：公共库那一档的按钮上直接写着扣多少积分；
 * 4. campaign 清单里本人没有那条职责的整组**灰显 + 说得出为什么**（05 §4）。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KolCampaignData,
  KolCreatorDetailData,
  KolCreatorRowData,
  KolOutreachData,
  KolSearchData,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const LIBRARY: KolCreatorRowData[] = [
  {
    creator_id: 'cre_1',
    display_name: 'Gadget Jonas',
    channel: 'youtube',
    handle: 'gadgetjonas',
    url: 'https://www.youtube.com/@gadgetjonas',
    followers: 48_000,
    engagement_rate: 0.062,
    category: '数码',
    observed_at: '2026-09-15T00:00:00.000Z',
    score: 82,
    has_contact: true,
  },
  {
    creator_id: 'cre_2',
    display_name: 'Cable Kevin',
    channel: 'youtube',
    handle: 'cablekevin',
    url: 'https://www.youtube.com/@cablekevin',
    followers: 620_000,
    observed_at: '2026-09-15T00:00:00.000Z',
    score: 12,
    blocked: '62 万粉却几乎没人互动，这个数不可信',
    has_contact: false,
  },
]

const DETAIL: KolCreatorDetailData = {
  creator: { id: 'cre_1', display_name: 'Gadget Jonas', merged_from: [] },
  accounts: [
    {
      id: 'pa_1',
      channel: 'youtube',
      handle: 'gadgetjonas',
      url: 'https://www.youtube.com/@gadgetjonas',
      followers: 48_000,
      engagement_rate: 0.062,
      category: '数码',
      observed_at: '2026-09-15T00:00:00.000Z',
    },
  ],
  contacts: [
    {
      id: 'ctc_1',
      creator_id: 'cre_1',
      kind: 'email',
      source: 'import',
      masked: 'j***@example.com',
    },
  ],
  collaborations: [
    { id: 'col_1', creator_id: 'cre_1', channel: 'youtube', stage: 'contacted', currency: 'USD' },
  ],
  deliverables: [],
  tracked_links: [],
}

const BLOCKED_SEARCH: KolSearchData = {
  ok: false,
  source: 'channel',
  rows: [],
  reason: 'needs_approval',
  message: 'TikTok 的 Research API 是申请制：要在 TikTok for Developers 里提交用途说明。',
}

const PUBLIC_SEARCH: KolSearchData = {
  ok: true,
  source: 'public_library',
  rows: [
    {
      channel: 'youtube',
      handle: 'deskrosa',
      url: 'https://www.youtube.com/@deskrosa',
      display_name: 'deskrosa',
      followers: 31_000,
      has_contact: true,
      in_library: false,
    },
  ],
  reveal_price: {
    capability: 'data.kol.lookup',
    credits: 2,
    unit: 'call',
    note: '浏览是免费的；取回一个邮箱这一步扣 2 积分。',
  },
}

const BLOCKED_DRAFT: KolOutreachData = {
  staged: false,
  step: 'first',
  subject: '',
  body: '',
  forbidden_hits: ['我们付你'],
  missing_vars: [],
  message: '这封信里写了「我们付你」这类承诺。给钱要走"建一条合作"那条路。',
  quota: { cap: 30, sent_today: 0, remaining: 30, allowed: true },
}

const OK_DRAFT: KolOutreachData = {
  staged: true,
  approval_item_id: 'apr_1',
  auto_approved: false,
  step: 'first',
  subject: 'Nordvolt × Gadget Jonas：想聊聊合作',
  body: 'Gadget Jonas 你好，……',
  forbidden_hits: [],
  missing_vars: [],
  quota: { cap: 30, sent_today: 1, remaining: 29, allowed: true },
}

const PLAN: KolCampaignData = {
  campaign_id: 'cmp_1',
  ready: true,
  gaps: [],
  message: '',
  budget_per_creator: 500,
  approval_item_id: 'apr_campaign',
  by_channel: [
    {
      channel: 'youtube',
      role_id: 'kol.youtube',
      allowed: true,
      assignment_id: 'asg_yt',
      picks: [
        {
          creator_id: 'cre_1',
          display_name: 'Gadget Jonas',
          channel: 'youtube',
          handle: 'gadgetjonas',
          followers: 48_000,
          score: 82,
          why: ['互动率 6.2%，是同量级里的高分'],
          already: false,
        },
      ],
    },
    {
      channel: 'instagram',
      role_id: 'kol.instagram',
      allowed: false,
      reason: '你名下没有「kol.instagram」这条职责，所以这一组只能看不能建。',
      picks: [
        {
          creator_id: 'cre_3',
          display_name: 'Desk Rosa',
          channel: 'instagram',
          handle: 'deskrosa',
          score: 71,
          why: ['类目对得上'],
          already: false,
        },
      ],
    },
  ],
}

const getKolCreators = vi.fn(async () => ({ rows: LIBRARY }))
const getKolCreator = vi.fn(async () => DETAIL)
const searchKolCreators = vi.fn(async () => PUBLIC_SEARCH)
const getKolCollaborations = vi.fn(async () => ({ rows: DETAIL.collaborations }))
const advanceKolCollaboration = vi.fn(async () => DETAIL.collaborations[0] as never)
const draftKolOutreach = vi.fn(async () => OK_DRAFT)
const revealKolContact = vi.fn(async () => ({ ok: true, credits_spent: 2 }))
const planKolCampaign = vi.fn(async () => PLAN)
const acceptKolCampaign = vi.fn(async () => ({
  campaign_id: 'cmp_1',
  created: [],
  skipped: [],
}))
const addKolContact = vi.fn(async () => DETAIL.contacts[0] as never)
const addKolCreator = vi.fn(async () => DETAIL)
const importKolTable = vi.fn(async () => ({
  summary: '认出 2 个账号，重复 1 行已合并。',
  created_creators: 2,
  created_accounts: 2,
  updated_accounts: 0,
  created_contacts: 1,
  duplicates: [],
  rejected: [],
  unmapped: [],
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getKolCreators: (...a: unknown[]) => getKolCreators(...(a as [])),
    getKolCreator: (...a: unknown[]) => getKolCreator(...(a as [])),
    searchKolCreators: (...a: unknown[]) => searchKolCreators(...(a as [])),
    getKolCollaborations: (...a: unknown[]) => getKolCollaborations(...(a as [])),
    advanceKolCollaboration: (...a: unknown[]) => advanceKolCollaboration(...(a as [])),
    draftKolOutreach: (...a: unknown[]) => draftKolOutreach(...(a as [])),
    revealKolContact: (...a: unknown[]) => revealKolContact(...(a as [])),
    planKolCampaign: (...a: unknown[]) => planKolCampaign(...(a as [])),
    acceptKolCampaign: (...a: unknown[]) => acceptKolCampaign(...(a as [])),
    addKolContact: (...a: unknown[]) => addKolContact(...(a as [])),
    addKolCreator: (...a: unknown[]) => addKolCreator(...(a as [])),
    importKolTable: (...a: unknown[]) => importKolTable(...(a as [])),
  }
})

const { channelOfRole, KolPanel } = await import('@/components/kol/kol-panel')

describe('WP68 红人岗位面板', () => {
  beforeEach(() => {
    for (const fn of [
      getKolCreators,
      getKolCreator,
      searchKolCreators,
      getKolCollaborations,
      advanceKolCollaboration,
      draftKolOutreach,
      revealKolContact,
      planKolCampaign,
      acceptKolCampaign,
      addKolContact,
      addKolCreator,
      importKolTable,
    ])
      fn.mockClear()
    searchKolCreators.mockResolvedValue(PUBLIC_SEARCH)
    draftKolOutreach.mockResolvedValue(OK_DRAFT)
  })

  it('只有红人那五条职责认得出渠道，别的职责一概 undefined', () => {
    expect(channelOfRole('kol.youtube')).toBe('youtube')
    expect(channelOfRole('kol.x')).toBe('x')
    expect(channelOfRole('dtc.support')).toBeUndefined()
    expect(channelOfRole(undefined)).toBeUndefined()
    // 不认识的渠道名不猜一个（`kol.wechat` 现在不存在）
    expect(channelOfRole('kol.wechat')).toBeUndefined()
  })

  it('找人清单：刷粉那条的理由写在清单上，不悄悄拿掉', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    expect(await screen.findAllByTestId('kol-library-row')).toHaveLength(2)
    expect(screen.getByTestId('kol-blocked').textContent).toContain('不可信')
  })

  it('搜不到与拿不到分得开：要申请那一句原样出现，不画一张空表', async () => {
    searchKolCreators.mockResolvedValue(BLOCKED_SEARCH)
    renderWithProviders(<KolPanel assignment="asg_tt" channel="tiktok" />)
    await screen.findByTestId('kol-discovery')
    fireEvent.change(screen.getByTestId('kol-search-input'), { target: { value: 'cablekevin' } })
    fireEvent.click(screen.getByTestId('kol-search-go'))
    const blocked = await screen.findByTestId('kol-search-blocked')
    expect(blocked.textContent).toContain('申请制')
    expect(screen.queryByTestId('kol-search-results')).toBeNull()
  })

  it('公共库那一档：扣多少积分写在按钮上，点之前就看得见', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await screen.findByTestId('kol-discovery')
    fireEvent.change(screen.getByTestId('kol-search-input'), { target: { value: 'deskrosa' } })
    fireEvent.click(screen.getByTestId('kol-search-go'))
    const reveal = await screen.findByTestId('kol-reveal')
    expect(reveal.textContent).toContain('2')
    expect(screen.getByTestId('kol-search-results').textContent).toContain('浏览是免费的')
    fireEvent.click(reveal)
    await waitFor(() => {
      expect(revealKolContact).toHaveBeenCalledWith(
        { channel: 'youtube', handle: 'deskrosa' },
        'asg_yt',
      )
    })
  })

  it('点开详情：资料快照带"看到于"，联系方式只有脱敏形态', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const rows = await screen.findAllByTestId('kol-library-row')
    fireEvent.click(rows[0] as HTMLElement)
    expect(await screen.findByTestId('kol-creator-detail')).toBeDefined()
    expect(screen.getByTestId('kol-observed-at').textContent).toContain('2026-09-15')
    expect(screen.getByTestId('kol-contact').textContent).toContain('j***@example.com')
    // DOM 里没有一个真地址
    expect(document.body.textContent).not.toContain('jonas@example.com')
    // 合作历史看得见
    expect(screen.getByTestId('kol-history').textContent).toContain('已建联')
  })

  it('开发信草稿卡：写了承诺的那一封照实说被拦下，不假装进了队列', async () => {
    draftKolOutreach.mockResolvedValue(BLOCKED_DRAFT)
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const rows = await screen.findAllByTestId('kol-library-row')
    fireEvent.click(rows[0] as HTMLElement)
    await screen.findByTestId('kol-creator-detail')
    fireEvent.change(screen.getByTestId('kol-outreach-pitch'), {
      target: { value: '我们做桌面周边' },
    })
    fireEvent.change(screen.getByTestId('kol-outreach-product'), { target: { value: '充电器' } })
    fireEvent.click(screen.getByTestId('kol-outreach-go'))
    const blocked = await screen.findByTestId('kol-outreach-blocked')
    expect(blocked.textContent).toContain('我们付你')
  })

  it('合作分块：阶段推进按钮只给合法的下一步', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await screen.findByTestId('kol-collaborations')
    const buttons = await screen.findAllByTestId('kol-stage-next')
    // `contacted` 的下一步只有"有回音"与"谢绝了"
    expect(buttons.map((b) => b.getAttribute('data-next'))).toEqual(['replied', 'declined'])
    fireEvent.click(buttons[0] as HTMLElement)
    await waitFor(() => {
      expect(advanceKolCollaboration).toHaveBeenCalledWith('col_1', 'replied', 'asg_yt')
    })
  })

  it('campaign 清单：本人没有那条职责的整组灰显，并说得出为什么（05 §4）', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await screen.findByTestId('kol-campaign')
    fireEvent.change(screen.getByTestId('kol-campaign-goal'), { target: { value: '秋季桌面季' } })
    fireEvent.click(screen.getByTestId('kol-campaign-go'))
    await screen.findByTestId('kol-campaign-plan')
    const groups = screen.getAllByTestId('kol-campaign-group')
    expect(groups.map((g) => g.getAttribute('data-allowed'))).toEqual(['true', 'false'])
    // 灰着的那一组要说得出为什么——不是悄悄少几行
    expect(screen.getByTestId('kol-campaign-why').textContent).toContain('kol.instagram')
    fireEvent.click(screen.getByTestId('kol-campaign-accept'))
    await waitFor(() => {
      expect(acceptKolCampaign).toHaveBeenCalledWith('apr_campaign', 'asg_yt')
    })
  })

  it('导入按钮只挑 CSV / TSV，并把"为什么不收 xlsx"说在旁边', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const input = await screen.findByTestId('kol-import-file')
    const accept = input.getAttribute('accept') ?? ''
    expect(accept).toContain('.csv')
    // 挑得到却传不进去比挑不到更气人
    expect(accept).not.toContain('.xlsx')
    expect(screen.getByTestId('kol-tools').textContent).toContain('CSV / TSV')
  })
})
