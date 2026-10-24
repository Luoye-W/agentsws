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

// WP489：导入红人表（先预览再导）、用邮件更新阶段
const previewKolImport = vi.fn(async () => ({
  ok: true,
  job_id: 'kij_1',
  source: '红人表.xlsx',
  summary: '新增 2 人 · 合并 1 人 · 带合作 2 条（历史 1）',
  columns: [
    { header: '名称', field: 'display_name', samples: ['小桌'] },
    { header: '跟进情形', field: null, samples: ['已寄样'] },
  ],
  statuses: [{ source: '在等排期', stage: null, count: 2, by: 'none' }],
  counts: { rows: 3, create: 2, merge: 1, skip: 0, collabs: 2, historical: 1, unknown_status: 2 },
  rows: [
    {
      source_row: 2,
      name: '小桌',
      action: 'merge',
      merge_into: '小桌',
      historical: true,
      stage: 'closed',
    },
  ],
  currency: 'USD',
}))
const commitKolImport = vi.fn(async () => ({
  summary: '新增 2 人 · 合并 1 人 · 合作 2 条（1 条进「历史合作（导入）」）。',
  created_creators: 2,
  merged_creators: 1,
  created_collaborations: 2,
  updated_collaborations: 0,
  historical: 1,
  skipped: 0,
  campaign_id: 'cmp_legacy_import',
  campaign_name: '历史合作（导入）',
}))
const estimateKolMailStages = vi.fn(async () => ({
  months: 12,
  creators: 3,
  messages: 18,
  input_tokens: 9000,
  output_tokens: 600,
  model: true,
  mail_connected: true,
  summary: '近 12 个月：3 人、18 封，约 10k token',
}))
const runKolMailStages = vi.fn(async () => ({
  summary: '判了 3 人 · 更新 2 · 1 个和表格不一样，出了卡。',
  judged: 3,
  updated: 2,
  same: 0,
  conflicts: 1,
  by_model: 3,
  by_rule: 0,
  fallback: 0,
}))

// WP299（决策 386 / 387）：寄样与付款
const shipKolSample = vi.fn(async () => ({ staged: true, approval_item_id: 'ap_s' }))
const recordKolPayment = vi.fn(async () => ({ staged: true, approval_item_id: 'ap_p' }))
const getKolOutreachDefaults = vi.fn(async () => ({
  brand_pitch: 'We make desk chargers.',
  product: '',
  source: 'brand_profile' as const,
  mailbox_connected: false,
}))
const saveKolOutreachDefaults = vi.fn(async () => ({
  brand_pitch: 'We make desk chargers.',
  product: 'the 65W charger',
  source: 'saved' as const,
  mailbox_connected: false,
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
    previewKolImport: (...a: unknown[]) => previewKolImport(...(a as [])),
    commitKolImport: (...a: unknown[]) => commitKolImport(...(a as [])),
    estimateKolMailStages: (...a: unknown[]) => estimateKolMailStages(...(a as [])),
    runKolMailStages: (...a: unknown[]) => runKolMailStages(...(a as [])),
    getKolSandbox: (...a: unknown[]) => getKolSandbox(...(a as [])),
    startKolSandbox: (...a: unknown[]) => startKolSandbox(...(a as [])),
    shipKolSample: (...a: unknown[]) => shipKolSample(...(a as [])),
    recordKolPayment: (...a: unknown[]) => recordKolPayment(...(a as [])),
    getKolOutreachDefaults: (...a: unknown[]) => getKolOutreachDefaults(...(a as [])),
    saveKolOutreachDefaults: (...a: unknown[]) => saveKolOutreachDefaults(...(a as [])),
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

  it('WP201：插件收进来的 YouTube handle 自带 @，清单上只显示一个 @（不是 @@TheTechReviewer）', async () => {
    getKolCreators.mockResolvedValueOnce({
      rows: [{ ...(LIBRARY[0] as KolCreatorRowData), handle: '@TheTechReviewer' }],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const [row] = await screen.findAllByTestId('kol-library-row')
    expect(row?.textContent).toContain('@TheTechReviewer')
    expect(row?.textContent).not.toContain('@@')
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
    // WP295：外面搜不了，同一个关键词把自己的库筛一遍；一键回全部
    await waitFor(() => {
      expect(getKolCreators).toHaveBeenLastCalledWith(
        { channel: 'tiktok', q: 'cablekevin' },
        'asg_tt',
      )
    })
    fireEvent.click(await screen.findByTestId('kol-library-q-clear'))
    await waitFor(() => {
      expect(getKolCreators).toHaveBeenLastCalledWith({ channel: 'tiktok' }, 'asg_tt')
    })
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

  it('WP498（1752 C）：存入过红人池的账号，详情里看得到主页资料（数字一行、简介、前三条近期作品；图片只给链接）', async () => {
    getKolCreator.mockResolvedValueOnce({
      ...DETAIL,
      profiles: {
        pa_1: {
          saved_at: '2026-10-23T10:00:00.000Z',
          country: 'Germany',
          joined_date: 'Mar 3, 2021',
          total_views: 1_234_567,
          avg_views: 32_500,
          video_count: 231,
          bio: 'Desk setups and keyboard reviews.',
          avatar_url: 'https://yt3.example/avatar.png',
          banner_url: 'https://yt3.example/banner.png',
          recent_items: [
            {
              title: 'The ultimate desk setup guide',
              views_text: '39K views',
              published_text: '2 days ago',
            },
            { title: 'Custom keyboards for beginners', views: 27_000 },
            { title: 'My desk lighting plan' },
            { title: 'Budget vs flagship keyboard' },
          ],
        },
      },
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const rows = await screen.findAllByTestId('kol-library-row')
    fireEvent.click(rows[0] as HTMLElement)
    const block = await screen.findByTestId('kol-saved-profile')
    const facts = screen.getByTestId('kol-profile-facts').textContent ?? ''
    for (const part of ['Germany', '加入于 Mar 3, 2021', '总播放 1.2M', '平均播放 33k', '作品 231'])
      expect(facts).toContain(part)
    expect(block.textContent).toContain('存入于 2026-10-23')
    expect(screen.getByTestId('kol-profile-bio').textContent).toContain('Desk setups')
    const recent = screen.getByTestId('kol-profile-recent')
    expect(recent.querySelectorAll('li')).toHaveLength(3)
    expect(recent.textContent).toContain('39K views · 2 days ago')
    expect(recent.textContent).toContain('还有 1 条')
    // 外站图片不直接加载：头像 / 横幅只是链接
    expect(block.querySelector('img')).toBeNull()
    expect(screen.getByText('头像').getAttribute('href')).toBe('https://yt3.example/avatar.png')
    expect(screen.getByText('横幅').getAttribute('href')).toBe('https://yt3.example/banner.png')
  })

  it('没存入过红人池的账号：没有主页资料那一块', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const rows = await screen.findAllByTestId('kol-library-row')
    fireEvent.click(rows[0] as HTMLElement)
    await screen.findByTestId('kol-creator-detail')
    expect(screen.queryByTestId('kol-saved-profile')).toBeNull()
  })

  it('WP416：起草那两格从品牌档案预填；没连邮箱照实说并给「连邮箱」；改了的产品记成默认', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const rows = await screen.findAllByTestId('kol-library-row')
    fireEvent.click(rows[0] as HTMLElement)
    await screen.findByTestId('kol-creator-detail')
    await waitFor(() => {
      expect((screen.getByTestId('kol-outreach-pitch') as HTMLInputElement).value).toBe(
        'We make desk chargers.',
      )
    })
    expect(screen.getByTestId('kol-outreach-prefilled').textContent).toContain('品牌档案')
    expect(screen.getByTestId('kol-outreach-no-mailbox').textContent).toContain('发不出去')
    // 「只显示脱敏形态…」那句技术话不常驻
    expect(screen.queryByText(/只显示脱敏形态/)).toBeNull()
    fireEvent.change(screen.getByTestId('kol-outreach-product'), {
      target: { value: 'the 65W charger' },
    })
    fireEvent.click(screen.getByTestId('kol-outreach-go'))
    await waitFor(() => {
      expect(saveKolOutreachDefaults).toHaveBeenCalledWith(
        { brand_pitch: 'We make desk chargers.', product: 'the 65W charger' },
        'asg_yt',
      )
    })
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

  it('WP302：合作清单按急到缓分组、每行一个档色小标与迷你进度条；清单上没有推进按钮（推进在线程里）', async () => {
    const seg = (stage: string, state: 'done' | 'current' | 'pending', stalled = false) => ({
      stage,
      state,
      stalled,
    })
    getKolCollaborations.mockResolvedValue({
      rows: [
        {
          id: 'col_wait',
          creator_id: 'cre_1',
          channel: 'youtube',
          stage: 'contacted',
          currency: 'USD',
          status: { tier: 'waiting', label: '等回复 · 已 9 天（第 2 封）' },
          dwell_days: 9,
          stalled: true,
          segments: [
            seg('sourced', 'done'),
            seg('contacted', 'current', true),
            seg('replied', 'pending'),
          ],
        },
        {
          id: 'col_card',
          creator_id: 'cre_2',
          channel: 'youtube',
          stage: 'negotiating',
          currency: 'USD',
          budget: 300,
          status: { tier: 'action', label: '有一张卡等你批' },
          pending_cards: 1,
          segments: [seg('sourced', 'done'), seg('negotiating', 'current')],
        },
      ],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('threads')
    await screen.findByTestId('kol-collaborations')
    const groups = await screen.findAllByTestId('kol-collab-group')
    // 「要处理」在前；没人的组（进行中 / 其他）不出标题
    expect(groups.map((g) => g.getAttribute('data-group'))).toEqual(['action', 'waiting'])
    const rows = screen.getAllByTestId('kol-collab-row')
    expect(rows.map((r) => r.getAttribute('data-tier'))).toEqual(['action', 'waiting'])
    expect(rows[1]?.textContent).toContain('等回复 · 已 9 天')
    // 停满 7 天的那一段标黄
    const stalled = rows[1]?.querySelector(
      '[data-testid="kol-progress-segment"][data-state="stalled"]',
    )
    expect(stalled).not.toBeNull()
    // 有卡等批的那一行：小标是去卡片流的按钮，不是批的按钮
    expect(screen.getByTestId('kol-collab-cards').textContent).toContain('有一张卡等你批')
    expect(screen.queryByTestId('kol-stage-next')).toBeNull()
    // 推进在线程里
    fireEvent.click(screen.getAllByTestId('kol-collab-open')[1] as HTMLElement)
    const next = await screen.findAllByTestId('kol-thread-next')
    expect(next.map((b) => b.getAttribute('data-next'))).toEqual(['replied', 'declined'])
    expect(screen.getByTestId('kol-progress').getAttribute('data-layout')).toBe('stepper')
    fireEvent.click(next[0] as HTMLElement)
    await waitFor(() => {
      expect(advanceKolCollaboration).toHaveBeenCalledWith('col_wait', 'replied', 'asg_yt')
    })
  })

  it('WP302：「其他」一长串（演练一开二十几条「还没联系」）默认只露 3 条，点开才全出；筛过就全出', async () => {
    getKolCollaborations.mockResolvedValue({
      rows: Array.from({ length: 6 }, (_, i) => ({
        id: `col_idle_${i}`,
        creator_id: 'cre_1',
        channel: 'youtube',
        stage: 'sourced',
        currency: 'USD',
        status: { tier: 'idle', label: '还没联系' },
        segments: [],
      })),
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('threads')
    await screen.findByTestId('kol-collab-more')
    expect(screen.getAllByTestId('kol-collab-row')).toHaveLength(3)
    expect(screen.getByTestId('kol-collab-more').textContent).toContain('3')
    fireEvent.click(screen.getByTestId('kol-collab-more'))
    expect(screen.getAllByTestId('kol-collab-row')).toHaveLength(6)
    expect(screen.queryByTestId('kol-collab-more')).toBeNull()
  })

  it('WP302：候选池是达人卡——分数、判断色块、按阶段变的下一步；数不可信的先人工看', async () => {
    getKolCreators.mockResolvedValue({
      rows: [
        {
          ...(LIBRARY[0] as KolCreatorRowData),
          factors: [{ id: 'category', score: 35 }],
          engagement_judgement: { key: 'healthy', level: 'good', value: '6.2', median: '3.0' },
          collab: {
            id: 'col_1',
            stage: 'negotiating',
            with_sample: false,
            stalled: false,
            segments: [{ stage: 'negotiating', state: 'current', stalled: false }],
          },
        },
        LIBRARY[1] as KolCreatorRowData,
      ],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const cards = await screen.findAllByTestId('kol-creator-card')
    expect(cards.map((c) => c.getAttribute('data-next'))).toEqual(['negotiate', 'blocked'])
    const stat = (card: HTMLElement | undefined, id: string) =>
      card?.querySelector(`[data-testid="kol-card-stat"][data-stat="${id}"]`)
    expect(stat(cards[0], 'engagement')?.getAttribute('data-level')).toBe('good')
    expect(stat(cards[0], 'category')?.getAttribute('data-level')).toBe('bad')
    // 没有互动率的不画「未知」色块
    expect(stat(cards[1], 'engagement')?.getAttribute('data-level')).toBeNull()
    expect(cards[0]?.querySelector('[data-testid="kol-progress"]')).not.toBeNull()
    expect(cards[1]?.querySelector('[data-testid="kol-progress"]')).toBeNull()
    // 「去谈」落在合作线程里
    fireEvent.click(cards[0]?.querySelector('[data-testid="kol-card-next"]') as HTMLElement)
    expect(await screen.findByTestId('kol-collab-thread')).toBeDefined()
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

  it('WP489：导入收 Excel / CSV；先预览（列与状态可改）再导；导完能用邮件更新状态', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('campaign')
    const input = await screen.findByTestId('kol-import-file')
    const accept = input.getAttribute('accept') ?? ''
    expect(accept).toContain('.xlsx')
    expect(accept).toContain('.csv')
    expect(screen.getByTestId('kol-import-hint').getAttribute('data-hint')).toContain('Excel')
    const file = new File(['名称,跟进情形\n小桌,已寄样\n'], '红人表.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [file] } })
    await screen.findByTestId('kol-import-preview')
    expect(previewKolImport).toHaveBeenCalledWith(
      expect.objectContaining({ filename: '红人表.csv', content_base64: expect.any(String) }),
      'asg_yt',
    )
    expect(screen.getByTestId('kol-import-summary').textContent).toContain('新增 2 人')
    // 没认出的列指给「合作状态」，认不出的状态词指给「已谈成」
    const cols = screen.getAllByTestId('kol-import-col')
    fireEvent.change(cols[1] as HTMLSelectElement, { target: { value: 'status' } })
    fireEvent.change(screen.getByTestId('kol-import-status'), { target: { value: 'agreed' } })
    fireEvent.click(screen.getByTestId('kol-import-commit'))
    await waitFor(() => {
      expect(commitKolImport).toHaveBeenCalledWith(
        {
          job_id: 'kij_1',
          columns: ['display_name', 'status'],
          statuses: [{ source: '在等排期', stage: 'agreed' }],
          currency: 'USD',
        },
        'asg_yt',
      )
    })
    expect((await screen.findByTestId('kol-import-result')).textContent).toContain(
      '历史合作（导入）',
    )

    fireEvent.click(screen.getByTestId('kol-mailstage'))
    expect((await screen.findByTestId('kol-mailstage-estimate')).textContent).toContain('3 人')
    fireEvent.click(screen.getByTestId('kol-mailstage-run'))
    await waitFor(() => {
      expect(runKolMailStages).toHaveBeenCalledWith(12, 'asg_yt')
    })
    expect((await screen.findByTestId('kol-import-result')).textContent).toContain('出了卡')
  })

  it('WP489：贴在线表格链接；读不了照实说', async () => {
    previewKolImport.mockResolvedValueOnce({
      ok: false,
      message: '工坊的浏览器还没登录飞书——在浏览器里登录一下，再贴一次链接。',
      currency: 'USD',
    } as never)
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('campaign')
    fireEvent.change(await screen.findByTestId('kol-import-link'), {
      target: { value: 'https://acme.feishu.cn/sheets/shtX' },
    })
    fireEvent.click(screen.getByTestId('kol-import-link-go'))
    expect((await screen.findByTestId('kol-import-error')).textContent).toContain('登录')
    expect(previewKolImport).toHaveBeenCalledWith(
      { url: 'https://acme.feishu.cn/sheets/shtX' },
      'asg_yt',
    )
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
    // WP295：「已建联」的合作上只出议价；交付物与追踪链接等谈起来再出
    await screen.findByTestId('kol-thread-quote')
    expect(screen.queryByTestId('kol-thread-deliverables')).toBeNull()
    expect(screen.queryByTestId('kol-thread-links')).toBeNull()
    // WP299：寄样与付款都是谈成之后的事
    expect(screen.queryByTestId('kol-thread-sample')).toBeNull()
    expect(screen.queryByTestId('kol-thread-payment')).toBeNull()
  })

  it('WP295：「交付中」的合作出交付物与追踪链接，不再挂着议价', async () => {
    getKolCollaborations.mockResolvedValue({
      rows: [
        {
          ...(DETAIL.collaborations[0] as (typeof DETAIL.collaborations)[number]),
          stage: 'delivering',
        },
      ],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('threads')
    fireEvent.click(await screen.findByTestId('kol-collab-open'))
    await screen.findByTestId('kol-thread-deliverables')
    await screen.findByTestId('kol-thread-links')
    expect(screen.queryByTestId('kol-thread-quote')).toBeNull()
    getKolCollaborations.mockResolvedValue({ rows: DETAIL.collaborations })
  })

  it('WP299：「谈成」的合作出寄样与付款；寄样带成本、付款带金额，各出一张卡', async () => {
    getKolCollaborations.mockResolvedValue({
      rows: [
        {
          ...(DETAIL.collaborations[0] as (typeof DETAIL.collaborations)[number]),
          stage: 'agreed',
          budget: 400,
        },
      ],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('threads')
    fireEvent.click(await screen.findByTestId('kol-collab-open'))
    await screen.findByTestId('kol-thread-sample')
    expect(screen.getByTestId('kol-thread-paid').textContent).toContain('谈定 400 USD')
    fireEvent.change(screen.getByTestId('kol-thread-sample-address'), {
      target: { value: 'Jonas Weber, Hauptstr. 5, 10115 Berlin, DE' },
    })
    fireEvent.change(screen.getByTestId('kol-thread-sample-carrier'), { target: { value: 'DHL' } })
    fireEvent.change(screen.getByTestId('kol-thread-sample-cost'), { target: { value: '45' } })
    fireEvent.click(screen.getByTestId('kol-thread-sample-go'))
    await waitFor(() => {
      expect(shipKolSample).toHaveBeenCalledWith(
        'col_1',
        { address: 'Jonas Weber, Hauptstr. 5, 10115 Berlin, DE', carrier: 'DHL', cost: 45 },
        'asg_yt',
      )
    })
    fireEvent.change(screen.getByTestId('kol-thread-pay-amount'), { target: { value: '200' } })
    fireEvent.click(screen.getByTestId('kol-thread-pay-go'))
    await waitFor(() => {
      expect(recordKolPayment).toHaveBeenCalledWith('col_1', { amount: 200 }, 'asg_yt')
    })
    getKolCollaborations.mockResolvedValue({ rows: DETAIL.collaborations })
  })

  it('WP299：已寄样的合作只留一行（快递 · 寄到哪儿 · 成本），不再给表；「已建联」的不出寄样与付款', async () => {
    getKolCollaborations.mockResolvedValue({
      rows: [
        {
          ...(DETAIL.collaborations[0] as (typeof DETAIL.collaborations)[number]),
          stage: 'sample_sent',
          sample: {
            address_masked: 'J*** · 10115 Berlin, DE',
            carrier: 'DHL',
            tracking_no: 'JD0123',
            cost: 45,
            currency: 'USD',
            shipped_at: '2026-10-13T09:00:00.000Z',
          },
        },
      ],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await goto('threads')
    fireEvent.click(await screen.findByTestId('kol-collab-open'))
    expect((await screen.findByTestId('kol-thread-sample-line')).textContent).toBe(
      'DHL · JD0123 · 寄到 J*** · 10115 Berlin, DE · 成本 45 USD',
    )
    expect(screen.queryByTestId('kol-thread-sample-address')).toBeNull()
    getKolCollaborations.mockResolvedValue({ rows: DETAIL.collaborations })
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
        { id: 'link_account', label: '关联官方账号', note: '送 5 积分' },
        { id: 'byo', label: '接自己的数据接口', note: '不扣积分' },
      ],
    })
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const input = await screen.findByTestId('kol-search-input')
    fireEvent.change(input, { target: { value: 'charger' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const said = (await screen.findByTestId('kol-search-blocked')).textContent ?? ''
    expect(said.split('。').filter((x) => x.trim() !== '')).toHaveLength(2)
    // WP334：关联官方账号也在第三栏就地关联（不跳设置页）
    expect(screen.getByTestId('kol-search-entry-link_account').getAttribute('data-connect')).toBe(
      'workshop_account',
    )
    // WP324：接自己的数据接口在第三栏就地连这条渠道（不跳连接页）
    expect(screen.getByTestId('kol-search-entry-byo').getAttribute('data-connect')).toBe(
      'youtube_data',
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
