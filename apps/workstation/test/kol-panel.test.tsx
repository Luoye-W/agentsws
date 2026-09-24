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
  KolCampaignAcceptData,
  KolCampaignData,
  KolCreatorDetailData,
  KolCreatorRowData,
  KolOutreachData,
  KolSearchData,
} from '@/lib/api'
import { ApiClientError } from '@/lib/api'
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
const acceptKolCampaign = vi.fn(
  async (): Promise<KolCampaignAcceptData> => ({
    campaign_id: 'cmp_1',
    created: [],
    skipped: [],
  }),
)
const addKolContact = vi.fn(async () => DETAIL.contacts[0] as never)
const addKolCreator = vi.fn(async () => DETAIL)
const getKolSandbox = vi.fn(async () => ({
  on: false,
  now: '2026-09-15T09:00:00.000Z',
  creators: 0,
  collaborations: 0,
  sent: 0,
  replies: 0,
  pending: 0,
  banner: '演练中 · 不会发出任何真邮件',
}))
const startKolSandbox = vi.fn(async () => ({
  on: true,
  now: '2026-09-15T09:00:00.000Z',
  creators: 24,
  collaborations: 24,
  sent: 0,
  replies: 0,
  pending: 0,
  banner: '演练中 · 不会发出任何真邮件',
}))
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
    getKolSandbox: (...a: unknown[]) => getKolSandbox(...(a as [])),
    startKolSandbox: (...a: unknown[]) => startKolSandbox(...(a as [])),
  }
})

const { channelOfRole, KolPanel } = await import('@/components/kol/kol-panel')

/**
 * WP117（66 断点 #10）：面板切成了三个子视图，所以测试要先走到对的那一个。
 *
 * 用的是界面上那排按钮本身（不是直接改 URL）——这样"切视图这件事在界面上
 * 点得到"也顺带被钉住了。
 */
async function goto(view: 'pool' | 'campaign' | 'threads'): Promise<void> {
  const tabs = await screen.findAllByTestId('kol-subview')
  const hit = tabs.find((b) => b.getAttribute('data-view') === view)
  if (hit === undefined) throw new Error(`子视图里没有 ${view}`)
  fireEvent.click(hit)
}

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
      getKolSandbox,
      startKolSandbox,
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
    await goto('threads')
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
    await goto('campaign')
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
    await goto('campaign')
    const input = await screen.findByTestId('kol-import-file')
    const accept = input.getAttribute('accept') ?? ''
    expect(accept).toContain('.csv')
    // 挑得到却传不进去比挑不到更气人
    expect(accept).not.toContain('.xlsx')
    expect(screen.getByTestId('kol-tools').textContent).toContain('CSV / TSV')
  })
})

/**
 * WP117（66 断点 #3 / #5 / #6 / #7 / #10）：界面不许再吞错、不许再没回执。
 *
 * 这一组盯的是"点了之后人知不知道发生了什么"——断点表里那四条都是
 * 同一个病：只报成功，不报失败，也不报回执。
 */
describe('WP117 红人界面：说真话与三个子视图', () => {
  beforeEach(() => {
    for (const fn of [
      getKolCreators,
      getKolCreator,
      searchKolCreators,
      getKolCollaborations,
      draftKolOutreach,
      addKolContact,
      acceptKolCampaign,
      planKolCampaign,
      getKolSandbox,
      startKolSandbox,
    ]) {
      fn.mockClear()
    }
    getKolCreators.mockResolvedValue({ rows: LIBRARY })
    getKolCreator.mockResolvedValue(DETAIL)
    getKolCollaborations.mockResolvedValue({ rows: DETAIL.collaborations })
    planKolCampaign.mockResolvedValue(PLAN)
    draftKolOutreach.mockResolvedValue(OK_DRAFT)
    addKolContact.mockResolvedValue(DETAIL.contacts[0] as never)
    getKolSandbox.mockResolvedValue({
      on: false,
      now: '2026-09-15T09:00:00.000Z',
      creators: 0,
      collaborations: 0,
      sent: 0,
      replies: 0,
      pending: 0,
      banner: '演练中 · 不会发出任何真邮件',
    })
  })

  it('三个子视图都点得到，默认停在候选池', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const tabs = await screen.findAllByTestId('kol-subview')
    expect(tabs.map((b) => b.getAttribute('data-view'))).toEqual(['pool', 'campaign', 'threads'])
    expect(tabs[0]?.getAttribute('aria-pressed')).toBe('true')
    await screen.findByTestId('kol-discovery')
  })

  it('断点 #3：搜索框按回车就搜，不用非得去点「搜」', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const input = await screen.findByTestId('kol-search-input')
    fireEvent.change(input, { target: { value: '桌面周边' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(searchKolCreators).toHaveBeenCalled()
    })
  })

  it('断点 #6：加联系方式失败 → 照实说那句话，邮箱**留在框里**等人改', async () => {
    addKolContact.mockRejectedValue(
      new ApiClientError(400, {
        code: 'invalid_input',
        message: '这台机器的加密库没开：联系方式没地方存，先在设置里开一把钥匙。',
      }),
    )
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const rows = await screen.findAllByTestId('kol-library-row')
    fireEvent.click(rows[0] as HTMLElement)
    await screen.findByTestId('kol-creator-detail')
    const box = screen.getByTestId('kol-contact-input')
    fireEvent.change(box, { target: { value: 'jonas@example.com' } })
    fireEvent.click(screen.getByTestId('kol-contact-save'))
    const alert = await screen.findByTestId('kol-detail-error')
    expect(alert.textContent).toContain('加密库没开')
    expect(alert.getAttribute('role')).toBe('alert')
    // 失败不清空：清了人就得重打一遍，还以为自己刚才打错了
    expect((box as HTMLInputElement).value).toBe('jonas@example.com')
  })

  it('断点 #7：起草成功要有回执，说清"批了才发"', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const rows = await screen.findAllByTestId('kol-library-row')
    fireEvent.click(rows[0] as HTMLElement)
    await screen.findByTestId('kol-creator-detail')
    fireEvent.change(screen.getByTestId('kol-outreach-pitch'), { target: { value: '做桌面周边' } })
    fireEvent.change(screen.getByTestId('kol-outreach-product'), { target: { value: '充电器' } })
    fireEvent.click(screen.getByTestId('kol-outreach-go'))
    const receipt = await screen.findByTestId('kol-detail-receipt')
    expect(receipt.textContent).toContain('等你批')
  })

  it('断点 #5：接受清单之后有回执，说清建了几条、去哪儿看', async () => {
    acceptKolCampaign.mockResolvedValue({
      campaign_id: 'cmp_1',
      created: [{ channel: 'youtube', creator_id: 'cre_1', collaboration_id: 'col_9' }],
      skipped: [],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('campaign')
    fireEvent.change(screen.getByTestId('kol-campaign-goal'), { target: { value: '秋季桌面季' } })
    fireEvent.click(screen.getByTestId('kol-campaign-go'))
    await screen.findByTestId('kol-campaign-plan')
    fireEvent.click(screen.getByTestId('kol-campaign-accept'))
    const receipt = await screen.findByTestId('kol-campaign-receipt')
    expect(receipt.textContent).toContain('建了 1 条合作')
    expect(receipt.textContent).toContain('合作线程')
  })

  it('断点 #5：接受清单失败 → 说"一条都没建"，不静默吞掉', async () => {
    acceptKolCampaign.mockRejectedValue(
      new ApiClientError(409, { code: 'conflict', message: '这张卡已经被别人接过了。' }),
    )
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('campaign')
    fireEvent.change(screen.getByTestId('kol-campaign-goal'), { target: { value: '秋季桌面季' } })
    fireEvent.click(screen.getByTestId('kol-campaign-go'))
    await screen.findByTestId('kol-campaign-plan')
    fireEvent.click(screen.getByTestId('kol-campaign-accept'))
    const alert = await screen.findByTestId('kol-campaign-error')
    expect(alert.textContent).toContain('已经被别人接过了')
  })

  it('取不回来 ≠ 库里没人：红人库的查询失败时说实话，不显示"先导一张表进来"', async () => {
    getKolCreators.mockRejectedValue(
      new ApiClientError(429, { code: 'budget_exhausted', message: '请求过于频繁' }),
    )
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const alert = await screen.findByTestId('kol-library-error')
    expect(alert.textContent).toContain('请求过于频繁')
    expect(screen.queryByTestId('kol-library-empty')).toBeNull()
  })

  it('断点 #10 / #11：合作能点开成一条线程，交付物与追踪链接在里面', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('threads')
    const open = await screen.findByTestId('kol-collab-open')
    fireEvent.click(open)
    const thread = await screen.findByTestId('kol-collab-thread')
    expect(thread.getAttribute('data-collab')).toBe('col_1')
    await screen.findByTestId('kol-thread-deliverables')
    await screen.findByTestId('kol-thread-links')
  })
})

describe('WP117 交付 4：演练开关与状态带', () => {
  beforeEach(() => {
    getKolSandbox.mockClear()
    startKolSandbox.mockClear()
    getKolCreators.mockResolvedValue({ rows: LIBRARY })
    getKolCollaborations.mockResolvedValue({ rows: DETAIL.collaborations })
  })

  it('没开演练：不出状态带（常驻一条"没在演练"等于教人忽略它）', async () => {
    getKolSandbox.mockResolvedValue({
      on: false,
      now: '2026-09-15T09:00:00.000Z',
      creators: 0,
      collaborations: 0,
      sent: 0,
      replies: 0,
      pending: 0,
      banner: '演练中 · 不会发出任何真邮件',
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const bar = await screen.findByTestId('kol-sandbox-bar')
    await waitFor(() => {
      expect(bar.getAttribute('data-on')).toBe('false')
    })
    expect(screen.queryByTestId('kol-sandbox-banner')).toBeNull()
  })

  it('开着演练：顶上那条带子写的是**服务端给的**那句话，不是界面自己拼的', async () => {
    getKolSandbox.mockResolvedValue({
      on: true,
      now: '2026-09-18T09:00:00.000Z',
      creators: 24,
      collaborations: 24,
      sent: 5,
      replies: 2,
      pending: 1,
      banner: '演练中 · 不会发出任何真邮件',
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const banner = await screen.findByTestId('kol-sandbox-banner')
    expect(banner.textContent).toContain('不会发出任何真邮件')
    expect(screen.getByTestId('kol-sandbox-counts').textContent).toContain('合成红人 24')
    // 快进按钮在，三档
    expect(
      screen.getAllByTestId('kol-sandbox-jump').map((b) => b.getAttribute('data-days')),
    ).toEqual(['3', '7', '30'])
  })

  it('关演练 = 清空数据，所以要先确认一次，不是点一下就没了', async () => {
    getKolSandbox.mockResolvedValue({
      on: true,
      now: '2026-09-18T09:00:00.000Z',
      creators: 24,
      collaborations: 24,
      sent: 0,
      replies: 0,
      pending: 0,
      banner: '演练中 · 不会发出任何真邮件',
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    // 先等状态回来：还在取的时候开关是禁用的，点了什么都不会发生
    await screen.findByTestId('kol-sandbox-banner')
    fireEvent.click(screen.getByTestId('kol-sandbox-toggle'))
    const confirm = await screen.findByTestId('kol-sandbox-confirm')
    expect(confirm.textContent).toContain('真数据不碰')
    expect(screen.getByTestId('kol-sandbox-clear')).toBeTruthy()
  })
})

describe('WP131 插件「回作战室看这批」', () => {
  beforeEach(() => {
    getKolCreators.mockClear()
  })

  it('?batch= 进来：只按这一批取、标题说清是「插件这一批」；「看全部」回到整个库', async () => {
    renderWithProviders(
      <KolPanel assignment="asg_yt" channel="youtube" />,
      '/influencer/creators?batch=bt_abc123x',
    )
    expect(await screen.findByTestId('kol-library-batch')).toBeTruthy()
    expect(screen.getByTestId('kol-library-batch').textContent).toContain('插件这一批')
    expect(getKolCreators).toHaveBeenCalledWith(
      { channel: 'youtube', batch: 'bt_abc123x' },
      'asg_yt',
    )
    fireEvent.click(screen.getByText('看全部'))
    await waitFor(() => {
      expect(screen.queryByTestId('kol-library-batch')).toBeNull()
    })
    expect(getKolCreators).toHaveBeenLastCalledWith({ channel: 'youtube' }, 'asg_yt')
  })

  it('自动评分跑过体检的人，清单上多一格「体检 N」', async () => {
    getKolCreators.mockResolvedValueOnce({
      rows: [{ ...LIBRARY[0], audit_health: 76, audited_at: '2026-09-23T10:00:00.000Z' }],
    } as never)
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    expect((await screen.findByTestId('kol-audit')).textContent).toBe('体检 76')
  })
})

describe('WP142 候选池与活动：不够数说原因，给两个动作', () => {
  beforeEach(() => {
    for (const fn of [searchKolCreators, planKolCampaign, acceptKolCampaign, getKolSandbox])
      fn.mockClear()
    getKolCreators.mockResolvedValue({ rows: LIBRARY })
    getKolSandbox.mockResolvedValue({
      on: false,
      now: '2026-09-15T09:00:00.000Z',
      creators: 0,
      collaborations: 0,
      sent: 0,
      replies: 0,
      pending: 0,
      banner: '演练中 · 不会发出任何真邮件',
    })
  })

  it('候选池没接数据源：两句话 + 两个按钮（关联官方账号 → 账号与积分；接自己的数据接口 → 这条渠道的连接卡）', async () => {
    searchKolCreators.mockResolvedValue({
      ok: false,
      source: 'channel',
      rows: [],
      reason: 'no_data_source',
      message:
        '现在搜不了YouTube上的红人：还没接任何数据来源。关联 Agents 工坊账号（按次扣积分）或者接你自己的数据接口（不扣积分），任选其一就能搜。',
      entry_points: [
        { id: 'link_account', label: '关联官方账号', note: '送 10 积分' },
        { id: 'byo', label: '接自己的数据接口', note: '不扣积分' },
      ],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const input = await screen.findByTestId('kol-search-input')
    fireEvent.change(input, { target: { value: 'charger' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const said = (await screen.findByTestId('kol-search-blocked')).textContent ?? ''
    expect(said.split('。').filter((x) => x.trim() !== '')).toHaveLength(2)
    expect(screen.getByTestId('kol-search-entry-link_account').getAttribute('href')).toBe(
      '/settings/credits',
    )
    expect(screen.getByTestId('kol-search-entry-byo').getAttribute('href')).toBe(
      '/connections?service=youtube_data',
    )
  })

  const ALREADY_PLAN: KolCampaignData = {
    ...PLAN,
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
            score: 90,
            why: ['正好在想要的区间里。'],
            already: true,
          },
          {
            creator_id: 'cre_2',
            display_name: 'Desk Rosa',
            channel: 'youtube',
            handle: 'deskrosa',
            followers: 31_000,
            score: 90,
            why: ['正好在想要的区间里。'],
            already: true,
          },
        ],
      },
    ],
  }

  async function planIt(): Promise<void> {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('campaign')
    fireEvent.change(screen.getByTestId('kol-campaign-goal'), { target: { value: '65W 充电器' } })
    fireEvent.change(screen.getByTestId('kol-campaign-headcount'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('kol-campaign-go'))
    await screen.findByTestId('kol-campaign-plan')
  }

  it('清单不够数：想要 5 个只有 2 个（其中 2 个已在合作里），给「导入一张表」「关联官方数据接口」', async () => {
    planKolCampaign.mockResolvedValue(ALREADY_PLAN)
    await planIt()
    const short = screen.getByTestId('kol-campaign-short')
    expect(short.textContent).toContain('想要 5 个，库里合适的只有 2 个')
    expect(short.textContent).toContain('其中 2 个已经在合作里了')
    expect(screen.getByTestId('kol-campaign-short-link').getAttribute('href')).toBe(
      '/settings/credits',
    )
    expect(screen.getByTestId('kol-campaign-short-import')).toBeTruthy()
    // 清单上当场标出来：谁已经在合作里
    expect(
      screen.getAllByTestId('kol-campaign-pick').map((li) => li.getAttribute('data-already')),
    ).toEqual(['true', 'true'])
    expect(screen.getAllByTestId('kol-campaign-pick')[0]?.textContent).toContain('已在合作里')
  })

  it('接受后一条都没新建（都已在合作里）：说清为什么，并给「去合作线程看他们」「找更多人」', async () => {
    planKolCampaign.mockResolvedValue(ALREADY_PLAN)
    acceptKolCampaign.mockResolvedValue({
      campaign_id: 'cmp_1',
      created: [],
      skipped: [
        {
          channel: 'youtube',
          creator_id: 'cre_1',
          reason: '这条渠道上已经有一条合作了，不重复建。',
        },
        {
          channel: 'youtube',
          creator_id: 'cre_2',
          reason: '这条渠道上已经有一条合作了，不重复建。',
        },
      ],
    })
    await planIt()
    fireEvent.click(screen.getByTestId('kol-campaign-accept'))
    const receipt = await screen.findByTestId('kol-campaign-receipt')
    expect(receipt.textContent).toContain('这 2 位都已经在合作里了，所以没有新建')
    fireEvent.click(screen.getByTestId('kol-campaign-go-threads'))
    await waitFor(() => {
      const tabs = screen.getAllByTestId('kol-subview')
      expect(
        tabs.find((b) => b.getAttribute('data-view') === 'threads')?.getAttribute('aria-pressed'),
      ).toBe('true')
    })
  })
})
