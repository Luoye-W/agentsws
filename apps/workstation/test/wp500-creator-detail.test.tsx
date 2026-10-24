/**
 * WP500（决策 1758）：红人卡与红人详情照 KOLAgents 的红人信息卡移植。
 *
 * 钉的是：
 * 1. 详情从上往下的分区顺序与 KOLAgents 一致；工坊有数据的区块都画出来，没数据的那一节整节不画（不画空壳）；
 * 2. 两个以上账号时顶上那三格换成分平台表，合计写「未去重」，互动率各写各的；
 * 3. 疑似同一红人在最上面，点「合并」走合并建议那条接受，合完转到保留的那一个；
 * 4. 平常开在第三栏（WP481）；开不出第三栏就地画；自己已经在第三栏里时叠一层、← 回到候选池；
 * 5. 外站图片一张都不加载（头像是一个字、没有横幅、近期作品没有封面）。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InRightPaneContext } from '@/components/rail/in-right-pane'
import { bindRightPaneHost, resetRightPane } from '@/components/rail/right-pane'
import type { KolCreatorDetailData, KolCreatorRowData } from '@/lib/api'
import { AppProvider } from '@/lib/app-context'
import { renderWithProviders } from './helpers'

const NOW = '2026-10-23T10:00:00.000Z'

const ROW: KolCreatorRowData = {
  creator_id: 'cre_1',
  display_name: 'Desk Fixture',
  channel: 'youtube',
  handle: '@deskfixture',
  url: 'https://www.youtube.com/@deskfixture',
  followers: 123_000,
  engagement_rate: 0.031,
  category: '数码',
  observed_at: NOW,
  score: 84,
  has_contact: false,
}

const DETAIL: KolCreatorDetailData = {
  creator: { id: 'cre_1', display_name: 'Desk Fixture', merged_from: [] },
  accounts: [
    {
      id: 'pa_tt',
      channel: 'tiktok',
      handle: 'deskfixture',
      url: 'https://www.tiktok.com/@deskfixture',
      followers: 41_000,
      engagement_rate: 0.072,
      observed_at: '2026-10-20T00:00:00.000Z',
    },
    {
      id: 'pa_yt',
      channel: 'youtube',
      handle: '@deskfixture',
      url: 'https://www.youtube.com/@deskfixture',
      followers: 123_000,
      engagement_rate: 0.031,
      category: '数码',
      region: 'DE',
      observed_at: NOW,
    },
  ],
  contacts: [
    {
      id: 'ctc_1',
      creator_id: 'cre_1',
      kind: 'email',
      source: 'channel_about',
      masked: 'd***@deskfixture.com',
    },
  ],
  collaborations: [
    {
      id: 'col_1',
      creator_id: 'cre_1',
      channel: 'youtube',
      stage: 'negotiating',
      budget: 600,
      currency: 'USD',
      last_activity_at: '2026-10-21T00:00:00.000Z',
      stage_source: 'mail',
      stage_evidence: [
        {
          message_id: 'msg_1',
          at: '2026-10-21T00:00:00.000Z',
          direction: 'in',
          subject: 'Re: collab',
          quote: 'My rate for a dedicated video is $800.',
        },
      ],
    },
    {
      id: 'col_0',
      creator_id: 'cre_1',
      channel: 'youtube',
      stage: 'closed',
      budget: 400,
      currency: 'USD',
      agreed_at: '2026-06-02T00:00:00.000Z',
      payments: [
        { id: 'pay_1', amount: 400, currency: 'USD', paid_at: '2026-06-20T00:00:00.000Z' },
      ],
    },
  ],
  deliverables: [
    {
      id: 'dl_1',
      collaboration_id: 'col_0',
      kind: 'video',
      due_at: '2026-06-15T00:00:00.000Z',
      review: 'approved',
    },
  ],
  tracked_links: [
    {
      id: 'tl_1',
      collaboration_id: 'col_0',
      url: 'https://shop.example/?utm_source=deskfixture',
      affiliate_code: 'DESK10',
      clicks: 412,
      orders: 9,
      revenue: 540,
    },
  ],
  scores: {
    pa_yt: {
      total: 84,
      factors: [
        { id: 'followers', label: '粉丝', score: 88, why: '12.3 万粉，在目标区间里' },
        { id: 'engagement', label: '互动', score: 40, why: '互动率 3.1%，略低于同量级' },
      ],
    },
  },
  profiles: {
    pa_yt: {
      saved_at: NOW,
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
          views: 39_000,
          likes: 1_500,
          published_text: '2 days ago',
        },
        { title: 'Custom keyboards for beginners', views: 27_000, published_text: '9 days ago' },
      ],
    },
  },
  checks: {
    pa_yt: {
      health: { verdict: 'excellent', views_to_followers: 0.264, bought_audience_suspected: false },
      like_rate: { median: 0.038, items: 6, level: 'good' },
      valuation: {
        kind: 'estimated',
        currency: 'USD',
        low_cents: 39_000,
        mid_cents: 65_000,
        high_cents: 91_000,
        median_views: 32_500,
        items_used: 8,
        cap_applied: false,
      },
      regularity: { status: 'regular', avg_interval_days: 7 },
      follower_trend: { days: 20, delta: 3_000, percent: 2.5 },
    },
  },
  audit: { health: 78, findings: ['近 30 天发布正常'], at: NOW },
}

const getKolCreator = vi.fn(async () => DETAIL)
const getKolCreators = vi.fn(async () => ({ rows: [ROW] }))
const getKolCollaborations = vi.fn(async () => ({
  rows: [
    {
      ...DETAIL.collaborations[0],
      dwell_days: 2,
      stalled: false,
      status: { tier: 'action' as const, label: '他报了价，等你回' },
      segments: [
        { stage: 'sourced', state: 'done' as const, stalled: false },
        { stage: 'contacted', state: 'done' as const, stalled: false },
        { stage: 'replied', state: 'done' as const, stalled: false },
        { stage: 'negotiating', state: 'current' as const, stalled: false },
        { stage: 'agreed', state: 'pending' as const, stalled: false },
      ],
    },
  ],
}))
const getKolMergeSuggestions = vi.fn(async () => ({
  rows: [
    {
      id: 'kms_cre_0__cre_1',
      keep: { creator_id: 'cre_0', display_name: 'DeskFixture Clips' },
      merge: { creator_id: 'cre_1', display_name: 'Desk Fixture' },
      reasons: [{ id: 'shared_email', text: '两边留的是同一个邮箱' }],
      confidence: 0.95,
    },
  ],
}))
const decideKolMerge = vi.fn(async () => ({}))
const getKolOutreachDefaults = vi.fn(async () => ({
  brand_pitch: '',
  product: '',
  source: 'none' as const,
  mailbox_connected: true,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getKolCreator: (...a: unknown[]) => getKolCreator(...(a as [])),
    getKolCreators: (...a: unknown[]) => getKolCreators(...(a as [])),
    getKolCollaborations: (...a: unknown[]) => getKolCollaborations(...(a as [])),
    getKolMergeSuggestions: (...a: unknown[]) => getKolMergeSuggestions(...(a as [])),
    decideKolMerge: (...a: unknown[]) => decideKolMerge(...(a as [])),
    getKolOutreachDefaults: (...a: unknown[]) => getKolOutreachDefaults(...(a as [])),
    getKolSandbox: async () => ({ active: false, creators: 0, collaborations: 0, message: '' }),
    getAutopilot: async () => [],
  }
})

const { CreatorInfoCard } = await import('@/components/kol/creator-info-card')
const { KolPanel } = await import('@/components/kol/kol-panel')
const { CreatorPaneBody, resetCreatorPane, useCreatorPaneTarget } = await import(
  '@/components/kol/creator-pane'
)

beforeEach(() => {
  for (const fn of [getKolCreator, decideKolMerge, getKolMergeSuggestions]) fn.mockClear()
})
afterEach(() => {
  resetRightPane()
  resetCreatorPane()
})

describe('WP500 红人详情（移植自 KOLAgents 红人信息卡）', () => {
  it('分区顺序照 KOLAgents：疑似同人 → 头部 → 数字 → 结论 → 简介 → 合作历史 → 估值 → 质量 → 分项 → 进度 → 联系方式 → 开发信 → 链接 → 交付物 → 档案 → 近期作品', async () => {
    renderWithProviders(<CreatorInfoCard view={DETAIL} assignment="asg_yt" channel="youtube" />)
    await screen.findByTestId('kol-identity-banner')
    await screen.findByTestId('kol-progress-collab')
    const order = [
      'kol-identity-banner',
      'kol-detail-name',
      'kol-accounts',
      'kol-verdict',
      'kol-saved-profile',
      'kol-history',
      'kol-valuation',
      'kol-quality',
      'kol-score',
      'kol-progress-section',
      'kol-contacts',
      'kol-outreach',
      'kol-links',
      'kol-deliverables',
      'kol-archive',
      'kol-profile-recent',
    ].map((id) => screen.getByTestId(id))
    for (let i = 1; i < order.length; i++)
      expect(
        (order[i - 1] as Element).compareDocumentPosition(order[i] as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
  })

  it('两个账号：主平台（粉丝多的）领头，三格换成分平台表；合计标「未去重」，互动率各写各的', async () => {
    renderWithProviders(<CreatorInfoCard view={DETAIL} assignment="asg_yt" channel="youtube" />)
    const table = await screen.findByTestId('kol-platform-table')
    expect(table.textContent).toContain('未去重')
    expect(table.textContent).toContain('164k') // 123k + 41k
    const rows = screen.getAllByTestId('kol-platform-row')
    expect(rows[0]?.textContent).toContain('@deskfixture')
    expect(rows[0]?.textContent).toContain('主')
    expect(rows[0]?.textContent).toContain('3.1%')
    expect(rows[1]?.textContent).toContain('7.2%')
    // 头部：主平台的 handle、品类、国家（地区码 → 国名）
    expect(screen.getByTestId('kol-detail-handle').textContent).toContain('@deskfixture · 数码')
    expect(screen.getByTestId('kol-country').textContent).toContain('德国')
  })

  it('有数据的区块都画：结论、估值区间、账号质量四行 + 云端体检、分项条、进度与邮件依据、追踪链接、档案', async () => {
    renderWithProviders(<CreatorInfoCard view={DETAIL} assignment="asg_yt" channel="youtube" />)
    expect((await screen.findByTestId('kol-verdict')).textContent).toContain('互动：互动率 3.1%')
    expect(screen.getByTestId('kol-valuation-range').textContent).toBe('$390 – $910')
    const metrics = screen
      .getAllByTestId('kol-quality-row')
      .map((r) => r.getAttribute('data-metric'))
    expect(metrics).toEqual(['views_to_followers', 'like_rate', 'regularity', 'follower_trend'])
    expect(screen.getByTestId('kol-audit-detail').textContent).toContain('78')
    expect(screen.getAllByTestId('kol-score-bar')).toHaveLength(2)
    const progress = await screen.findByTestId('kol-progress-collab')
    await waitFor(() => {
      expect(progress.textContent).toContain('他报了价，等你回')
    })
    expect(screen.getByTestId('kol-stage-evidence').textContent).toContain(
      'My rate for a dedicated video',
    )
    expect(screen.getByTestId('kol-links').textContent).toContain('DESK10')
    expect(screen.getAllByTestId('kol-archive-card')).toHaveLength(1)
    expect(screen.getByTestId('kol-history').textContent).toContain('在谈 1 条')
  })

  it('没数据的那一节整节不画（不画空壳）；联系方式与开发信是动手的地方，空着也在', async () => {
    const bare: KolCreatorDetailData = {
      creator: DETAIL.creator,
      accounts: [DETAIL.accounts[1] as KolCreatorDetailData['accounts'][number]],
      contacts: [],
      collaborations: [],
      deliverables: [],
      tracked_links: [],
    }
    getKolMergeSuggestions.mockResolvedValueOnce({ rows: [] })
    renderWithProviders(<CreatorInfoCard view={bare} assignment="asg_yt" channel="youtube" />)
    await screen.findByTestId('kol-creator-detail')
    for (const id of [
      'kol-platform-table',
      'kol-verdict',
      'kol-saved-profile',
      'kol-history',
      'kol-valuation',
      'kol-quality',
      'kol-score',
      'kol-progress-section',
      'kol-links',
      'kol-deliverables',
      'kol-archive',
      'kol-profile-recent',
    ])
      expect(screen.queryByTestId(id)).toBeNull()
    expect(screen.getByTestId('kol-contacts')).toBeDefined()
    expect(screen.getByTestId('kol-outreach')).toBeDefined()
    await waitFor(() => {
      expect(screen.queryByTestId('kol-identity-banner')).toBeNull()
    })
  })

  it('外站图片一张都不加载：头像是一个字、近期作品没有封面；头像 / 横幅只是链接', async () => {
    const { container } = renderWithProviders(
      <CreatorInfoCard view={DETAIL} assignment="asg_yt" channel="youtube" />,
    )
    await screen.findByTestId('kol-profile-recent')
    const external = [...container.querySelectorAll('img')].filter((img) =>
      /^https?:/.test(img.getAttribute('src') ?? ''),
    )
    expect(external).toHaveLength(0)
    expect(screen.getByText('头像').getAttribute('href')).toBe('https://yt3.example/avatar.png')
  })

  it('疑似同一红人：点「合并」走合并建议那条接受，合完转到保留的那一个', async () => {
    const onRepoint = vi.fn()
    renderWithProviders(
      <CreatorInfoCard view={DETAIL} assignment="asg_yt" channel="youtube" onRepoint={onRepoint} />,
    )
    const banner = await screen.findByTestId('kol-identity-banner')
    expect(banner.textContent).toContain('DeskFixture Clips')
    expect(banner.textContent).toContain('同一个邮箱')
    fireEvent.click(screen.getByTestId('kol-identity-merge'))
    await waitFor(() => {
      expect(decideKolMerge).toHaveBeenCalledWith('kms_cre_0__cre_1', 'accept', 'asg_yt')
    })
    await waitFor(() => {
      expect(onRepoint).toHaveBeenCalledWith('cre_0')
    })
  })
})

describe('WP500 详情开在哪', () => {
  it('有外壳：点卡开在第三栏（kol-creator 那一格），候选池原样留着', async () => {
    const opened: unknown[] = []
    const unbind = bindRightPaneHost({
      open: (route) => {
        opened.push(route)
        return true
      },
      close: () => {},
    })
    let seen: string | undefined
    function Probe(): null {
      seen = useCreatorPaneTarget()?.id
      return null
    }
    renderWithProviders(
      <>
        <KolPanel assignment="asg_yt" channel="youtube" />
        <Probe />
      </>,
    )
    fireEvent.click((await screen.findAllByTestId('kol-library-row'))[0] as HTMLElement)
    expect(opened).toEqual([{ panel: 'kol-creator' }])
    await waitFor(() => {
      expect(seen).toBe('cre_1')
    })
    expect(screen.queryByTestId('kol-creator-detail')).toBeNull()
    expect(screen.getByTestId('kol-library')).toBeDefined()
    unbind()
  })

  it('第三栏那一格的身体：读的是刚点的那个人', async () => {
    const unbind = bindRightPaneHost({ open: () => true, close: () => {} })
    const { openCreatorPane } = await import('@/components/kol/creator-pane')
    renderWithProviders(<CreatorPaneBody />)
    expect(screen.getByTestId('kol-creator-pane-empty')).toBeDefined()
    openCreatorPane({ assignment: 'asg_yt', channel: 'youtube', id: 'cre_1' })
    expect(await screen.findByTestId('kol-creator-detail')).toBeDefined()
    expect(getKolCreator).toHaveBeenCalledWith('cre_1', 'asg_yt')
    unbind()
  })

  it('自己已经在第三栏里：详情叠在候选池上面，← 返回候选池', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={client}>
        <AppProvider initialTheme="light" initialLang="zh" initialPosition="asg_1">
          <MemoryRouter>
            <InRightPaneContext.Provider value={true}>
              <KolPanel assignment="asg_yt" channel="youtube" />
            </InRightPaneContext.Provider>
          </MemoryRouter>
        </AppProvider>
      </QueryClientProvider>,
    )
    fireEvent.click((await screen.findAllByTestId('kol-library-row'))[0] as HTMLElement)
    expect(await screen.findByTestId('kol-creator-detail')).toBeDefined()
    expect(screen.queryByTestId('kol-library')).toBeNull()
    fireEvent.click(screen.getByTestId('kol-detail-close'))
    expect(await screen.findByTestId('kol-library')).toBeDefined()
    expect(screen.queryByTestId('kol-creator-detail')).toBeNull()
  })

  it('红人卡：一个字的头像、平台标志 · handle、联系方式那一格、主页链接', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const card = (await screen.findAllByTestId('kol-creator-card'))[0] as HTMLElement
    expect(card.querySelector('[data-testid="ws-avatar"]')?.textContent).toBe('D')
    expect(card.querySelector('[data-testid="brand-icon"]')?.getAttribute('data-provider')).toBe(
      'youtube_data',
    )
    expect(card.querySelector('[data-testid="kol-card-email"]')?.getAttribute('data-has')).toBe(
      'no',
    )
    expect(card.querySelector('[data-testid="kol-card-profile"]')?.getAttribute('href')).toBe(
      'https://www.youtube.com/@deskfixture',
    )
  })
})
