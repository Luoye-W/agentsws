/**
 * WP450（docs/109 §5.2 #9–11、17；决策 1765「资料在右、决策在中」）：
 *
 * - 第三栏「编辑日历」只在有 SEO 与 GEO / 内容与博客的岗位出；三格（日历 / 外链 / llms.txt）；
 * - 日历：按天、总页 / 分页、回头改、状态；「出一组主题」写明约多少积分；等批的那组只提一句（卡在中栏）；
 *   最近发布一键「改写成社媒稿」；
 * - 外链：开关、下次、一次多少积分、来源域名变化、要看的、竞品差距（已交公关）；用户看得到的字不提数据商；
 * - llms.txt：体检那一项、生成的那份、交建站、在 Shopify 上怎么放；
 * - 中栏「一组主题」卡：总页 + 分页、去掉一篇后批 = 带着改过的那组批。
 */
import type {
  BacklinkAuditView,
  LlmsTxtView,
  SeoCalendarView,
  SeoClusterPayload,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { railCard } from '@/components/rail/registry'
import { SeoPlanPanel } from '@/components/seo/seo-plan-panel'
import { hasSeoPlanRole } from '@/components/seo/seo-plan-status'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const api = vi.hoisted(() => ({
  plan: vi.fn(),
  repurpose: vi.fn(),
  runBl: vi.fn(),
  setBl: vi.fn(),
  genLlms: vi.fn(),
  decide: vi.fn(),
}))

const calendar: SeoCalendarView = {
  today: '2026-10-26',
  per_day: 2,
  entries: [
    {
      id: 'c1:pillar',
      cluster_id: 'c1',
      cluster_topic: 'usb c charger',
      post_id: 'pillar',
      role: 'pillar',
      keyword: 'usb c charger',
      title: 'Usb C Charger: The Complete Guide',
      kind: 'new',
      date: '2026-10-26',
      status: 'opened',
      matter_id: 'mat_1',
      links: [],
    },
    {
      id: 'c1:s1',
      cluster_id: 'c1',
      cluster_topic: 'usb c charger',
      post_id: 's1',
      role: 'spoke',
      keyword: 'gan charger',
      title: 'Gan Charger',
      kind: 'refresh',
      existing_page: 'https://shop.example/blogs/guide/gan-chargers-explained',
      date: '2026-10-27',
      status: 'scheduled',
      links: [],
    },
  ],
  refresh: [
    { page: 'https://shop.example/blogs/guide/old-post', query: 'old', reason: '点击在掉' },
  ],
  published: [
    {
      change_id: 'chg_1',
      title: 'How to choose a USB-C charger',
      published_at: '2026-10-20T09:00:00.000Z',
    },
  ],
  clusters: [{ id: 'c1', topic: 'usb c charger', total: 5, published: 0 }],
  plan: { available: true, serp_calls: 21, credits: 4.2 },
  pending: [{ approval_item_id: 'ap_c2', topic: 'magsafe power bank' }],
}

const backlinks: BacklinkAuditView = {
  settings: { enabled: true, every_days: 30 },
  next_due: '2026-11-25',
  estimate: { credits: 3.88, calls: 4 },
  available: true,
  last: {
    id: 'bl_1',
    at: '2026-10-25T08:00:00.000Z',
    status: 'ok',
    trigger: 'scheduled',
    ours: { target: 'shop.example', rank: 31, backlinks: 1840, referring_domains: 142, at: 'T' },
    previous: { at: '2026-09-25T08:00:00.000Z', referring_domains: 181 },
    change: { referring_domains: -39, pct: -21.5 },
    anchors: [{ anchor: 'usb c charger', kind: 'exact', count: 17, share: 0.567 }],
    suspicious: [{ domain: 'linkfarm-seo.example', why: '垃圾分 74（估算）' }],
    issues: [
      { rule: 'domains_drop', severity: 'high', text: '来源域名 181 → 142，少了 21.5%（估算）' },
    ],
    gap: [
      { domain: 'techradar-like.example', competitors: ['chargely.example', 'voltpeak.example'] },
    ],
    competitors: ['voltpeak.example', 'chargely.example'],
    notes: [],
    cost: { credits: 3.88, calls: 4 },
    handed_to_pr: { matter_id: 'mat_pr', at: 'T', sites: 1 },
  },
}

let llms: LlmsTxtView = {
  live: {
    state: 'stale',
    url: 'https://shop.example/llms.txt',
    reasons: ['店里现在有、文件里没写的 1 个（合集 / 政策页）'],
    checked_at: 'T',
  },
  placement: ['在 templates 里新建 llms.txt.liquid'],
}

vi.mock('@/lib/seo-plan-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/seo-plan-api')>('@/lib/seo-plan-api')
  return {
    ...actual,
    getSeoCalendar: async () => calendar,
    planSeoClusters: (...a: unknown[]) => api.plan(...a),
    repurposePost: (...a: unknown[]) => api.repurpose(...a),
    getBacklinkAudit: async () => backlinks,
    runBacklinkAudit: (...a: unknown[]) => api.runBl(...a),
    setBacklinkAudit: (...a: unknown[]) => api.setBl(...a),
    getLlmsTxt: async () => llms,
    generateLlmsTxt: (...a: unknown[]) => api.genLlms(...a),
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, decide: (...a: unknown[]) => api.decide(...a) }
})

const scope = {
  tier: 'position' as const,
  scope_id: 'web-ops',
  name: '网站运营',
  roles: [{ role_id: 'dtc.seo', assignment: 'asg_seo' }],
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset()
})

describe('WP450 第三栏「编辑日历」', () => {
  it('卡片列那张卡只在有 SEO 与 GEO / 内容与博客的岗位出', () => {
    ensureBuiltinPanels()
    expect(railCard('seo-plan')?.panel).toBe('seo-plan')
    expect(hasSeoPlanRole({ scope })).toBe(true)
    expect(
      hasSeoPlanRole({ scope: { ...scope, roles: [{ role_id: 'kol.youtube', assignment: 'a' }] } }),
    ).toBe(false)
  })

  it('日历：按天列、总页 / 分页、回头改、状态；出一组写明积分；等批的那组只提一句；最近发布一键起草社媒稿', async () => {
    api.plan.mockResolvedValue({
      approval_item_id: 'ap_c3',
      cost: { credits: 4.2, calls: 21 },
      notes: [],
    })
    api.repurpose.mockResolvedValue({
      source: { title: 'x' },
      drafts: [{}, {}, {}],
      matters: [{}, {}],
      skipped: [{ channel: 'reddit', reason: '没人担' }],
    })
    const user = userEvent.setup()
    renderWithProviders(<SeoPlanPanel scope={scope} tier="position" pathname="/" />)
    const days = await screen.findAllByTestId('seo-plan-day')
    expect(days.map((d) => d.getAttribute('data-date'))).toEqual(['2026-10-26', '2026-10-27'])
    expect(days[0]?.textContent).toContain('今天')
    expect(days[1]?.textContent).toContain('回头改')
    expect(
      screen.getAllByTestId('seo-plan-entry').map((e) => e.getAttribute('data-status')),
    ).toEqual(['opened', 'scheduled'])
    expect(screen.getByTestId('seo-plan-pending').textContent).toContain('magsafe power bank')
    const plan = screen.getByTestId('seo-plan-plan')
    expect(plan.textContent).toContain('约 4.2 积分')
    await user.click(plan)
    await waitFor(() => {
      expect(screen.getByTestId('seo-plan-note').textContent).toContain('去中栏批')
    })
    await user.click(screen.getByTestId('seo-plan-repurpose'))
    await waitFor(() => {
      expect(api.repurpose).toHaveBeenCalledWith({ change_id: 'chg_1' }, 'asg_seo')
    })
    await waitFor(() => {
      expect(screen.getByTestId('seo-plan-note').textContent).toContain('起草了 3 份，开了 2 件事')
    })
    expect(screen.getByTestId('seo-plan-note').textContent).toContain('Reddit 帖子')
  })

  it('外链：开关、下次、约多少积分、来源域名变化、要看的、竞品差距已交公关；不提数据商', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SeoPlanPanel scope={scope} tier="position" pathname="/" sub="backlinks" />)
    const panel = await screen.findByTestId('seo-plan-backlinks')
    expect(screen.getByTestId('seo-plan-bl-cost').textContent).toBe(
      '下次 2026-11-25 · 一次约 3.88 积分',
    )
    expect(screen.getByTestId('seo-plan-bl-stats').textContent).toContain('-39 (-21.5%)')
    expect(screen.getByTestId('seo-plan-bl-issue').getAttribute('data-rule')).toBe('domains_drop')
    expect(screen.getByTestId('seo-plan-bl-gap-row').textContent).toContain(
      'techradar-like.example',
    )
    expect(screen.getByTestId('seo-plan-bl-pr').getAttribute('href')).toBe('/matters/mat_pr')
    expect(panel.textContent).not.toMatch(/dataforseo|semrush|ahrefs|similarweb/i)
    await user.click(screen.getByTestId('seo-plan-bl-enabled'))
    await waitFor(() => {
      expect(api.setBl).toHaveBeenCalledWith({ enabled: false }, 'asg_seo')
    })
  })

  it('llms.txt：体检那一项、生成、交建站、怎么放', async () => {
    api.genLlms.mockImplementation(async (input: { handoff?: boolean }) => {
      llms = {
        ...llms,
        draft: { content: '# NordVolt Gear\n', generated_at: 'T', sections: [], source: 'sitemap' },
        ...(input.handoff === true ? { handed_to_site: { matter_id: 'mat_site', at: 'T' } } : {}),
      }
      return llms
    })
    const user = userEvent.setup()
    renderWithProviders(<SeoPlanPanel scope={scope} tier="position" pathname="/" sub="llms" />)
    const live = await screen.findByTestId('seo-plan-llms-live')
    expect(live.getAttribute('data-state')).toBe('stale')
    expect(live.textContent).toContain('过时了')
    await user.click(screen.getByTestId('seo-plan-llms-generate'))
    expect((await screen.findByTestId('seo-plan-llms-draft')).textContent).toContain(
      '# NordVolt Gear',
    )
    await user.click(screen.getByTestId('seo-plan-llms-handoff'))
    expect((await screen.findByTestId('seo-plan-llms-handed')).getAttribute('href')).toBe(
      '/matters/mat_site',
    )
    expect(screen.getByTestId('seo-plan-llms-how').textContent).toContain('llms.txt.liquid')
  })
})

describe('WP450 中栏「一组主题」卡', () => {
  const payload: SeoClusterPayload = {
    form: 'seo_cluster',
    per_day: 2,
    start: '2026-10-26',
    writer: 'content',
    cost: { credits: 4.2, calls: 21 },
    schedule: [
      { post_id: 'pillar', date: '2026-10-26' },
      { post_id: 's1', date: '2026-10-26' },
      { post_id: 's2', date: '2026-10-27' },
    ],
    cluster: {
      id: 'c1',
      topic: 'usb c charger',
      pillar: {
        id: 'pillar',
        role: 'pillar',
        keyword: 'usb c charger',
        title: 'T',
        kind: 'new',
        group: 0,
        also: ['best usb c charger'],
      },
      spokes: [
        {
          id: 's1',
          role: 'spoke',
          keyword: 'gan charger',
          title: 'T',
          kind: 'refresh',
          existing_page: 'https://shop.example/blogs/guide/gan',
          group: 0,
        },
        {
          id: 's2',
          role: 'spoke',
          keyword: 'usb c laptop charger 100w',
          title: 'T',
          kind: 'new',
          group: 1,
        },
      ],
      links: [
        { from: 's1', to: 'pillar', anchor: 'usb c charger', type: 'mandatory' },
        { from: 'pillar', to: 's1', anchor: 'gan charger', type: 'mandatory' },
        { from: 's2', to: 'pillar', anchor: 'usb c charger', type: 'mandatory' },
        { from: 'pillar', to: 's2', anchor: 'usb c laptop charger 100w', type: 'mandatory' },
      ],
      overlap: [{ a: 'usb c charger', b: 'gan charger', shared: 4 }],
    },
  }
  const card: DeckCard = draftCard({
    id: 'ap_c1',
    kind: 'seo_cluster',
    layout: 'change',
    role_id: 'dtc.seo',
    title: '一组主题：usb c charger（3 篇）',
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    detail: { ...draftCard().detail, payload },
  })

  it('总页 + 分页（哪天写、回头改哪页）、内链几条、交给谁写；去掉一篇后批 = 带着改过的那组批', async () => {
    api.decide.mockResolvedValue({})
    const user = userEvent.setup()
    renderWithProviders(
      <DeckCardView
        card={card}
        mode="zh_summary"
        onDecide={() => undefined}
        onOpen={() => undefined}
      />,
    )
    const body = await screen.findByTestId('seo-cluster-card')
    expect(screen.getByTestId('seo-cluster-summary').textContent).toBe(
      '分页 2 篇 · 内链 4 条 · 到日子交「内容与博客」写',
    )
    const posts = within(body).getAllByTestId('seo-cluster-post')
    expect(posts.map((p) => p.getAttribute('data-role'))).toEqual(['pillar', 'spoke', 'spoke'])
    expect(posts[0]?.textContent).toContain('也接住：best usb c charger')
    expect(posts[1]?.textContent).toContain('回头改：/blogs/guide/gan')
    expect(screen.queryByTestId('seo-cluster-approve-edited')).toBeNull()
    await user.click(within(posts[2] as HTMLElement).getByTestId('seo-cluster-toggle'))
    await user.click(screen.getByTestId('seo-cluster-approve-edited'))
    await waitFor(() => {
      expect(api.decide).toHaveBeenCalledTimes(1)
    })
    const call = api.decide.mock.calls[0] as unknown[]
    const edited = (call[1] as { edited_payload: SeoClusterPayload }).edited_payload
    expect(edited.cluster.spokes.map((s) => s.id)).toEqual(['s1'])
    expect(edited.cluster.links.every((l) => l.from !== 's2' && l.to !== 's2')).toBe(true)
    expect(edited.schedule.map((s) => s.post_id)).toEqual(['pillar', 's1'])
  })
})
