/**
 * WP502：红人详情跟进（界面这一半）。
 *
 * 1. 1760 B：头像 / 横幅 / 近期作品封面走本机同源地址（取字节换成 `blob:` 再画）；没缓存到的照旧一个字 / 色块；
 *    外站图片一张都不加载（不是同源那条路的地址根本不去取）。
 * 2. 1763 B：标签（加 / 删、不分大小写去重、不做乐观更新）与审核决定（通过 / 淘汰…理由可不填 / 重置为待审），
 *    详情与候选池卡片都显示；候选池能按审核决定、按标签筛。
 * 3. 1764 B：近期作品点了在浏览器里打开原作品；没记下链接的那几条点不开。
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRightPane } from '@/components/rail/right-pane'
import type { KolCreatorDetailData, KolCreatorRowData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const NOW = '2026-10-24T10:00:00.000Z'
const MEDIA = (n: number): string => `/v1/kol/media/${n.toString(16).padStart(32, '0')}`

const ROW: KolCreatorRowData = {
  creator_id: 'cre_1',
  display_name: 'Desk Fixture',
  channel: 'youtube',
  handle: '@deskfixture',
  url: 'https://www.youtube.com/@deskfixture',
  followers: 123_000,
  observed_at: NOW,
  score: 84,
  has_contact: false,
  avatar_media_url: MEDIA(1),
  tags: ['桌搭', '德国', '键盘', '复购'],
  review: { decision: 'approved', reason: '内容对路', decided_at: NOW },
}
const { avatar_media_url: _a, tags: _t, review: _r, ...BARE } = ROW
const ROW_2: KolCreatorRowData = {
  ...BARE,
  creator_id: 'cre_2',
  display_name: 'Lunch Fixture',
  handle: '@lunchfixture',
}

const DETAIL: KolCreatorDetailData = {
  creator: { id: 'cre_1', display_name: 'Desk Fixture', merged_from: [] },
  accounts: [
    {
      id: 'pa_yt',
      channel: 'youtube',
      handle: '@deskfixture',
      url: 'https://www.youtube.com/@deskfixture',
      followers: 123_000,
      observed_at: NOW,
    },
  ],
  contacts: [],
  collaborations: [],
  deliverables: [],
  tracked_links: [],
  profiles: {
    pa_yt: {
      saved_at: NOW,
      avatar_url: 'https://yt3.ggpht.com/avatar',
      banner_url: 'https://yt3.googleusercontent.com/banner',
      avatar_media_url: MEDIA(1),
      banner_media_url: MEDIA(2),
      recent_items: [
        {
          title: 'The ultimate desk setup guide',
          views: 39_000,
          thumbnail_url: 'https://i.ytimg.com/vi/dfVid000001/hqdefault.jpg',
          thumbnail_media_url: MEDIA(3),
          url: 'https://www.youtube.com/watch?v=dfVid000001',
        },
        // 没缓存到封面、没记下链接
        { title: 'Custom keyboards for beginners', views: 27_000 },
      ],
    },
  },
  tags: ['桌搭'],
}

const kolMediaObjectUrl = vi.fn(async (u: string) => `blob:test${u}`)
const setKolCreatorTags = vi.fn(async (_id: string, tags: string[]) => ({ ...DETAIL, tags }))
const reviewKolCreator = vi.fn(async () => DETAIL)
const getKolCreators = vi.fn(async (_f?: unknown) => ({
  rows: [ROW, ROW_2],
  tags: ['复购', '德国', '桌搭', '键盘'],
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    kolMediaObjectUrl: (u: string) => kolMediaObjectUrl(u),
    setKolCreatorTags: (id: string, tags: string[]) => setKolCreatorTags(id, tags),
    reviewKolCreator: (...a: unknown[]) => reviewKolCreator(...(a as [])),
    getKolCreators: (f?: unknown) => getKolCreators(f),
    getKolCreator: async () => DETAIL,
    getKolCollaborations: async () => ({ rows: [] }),
    getKolMergeSuggestions: async () => ({ rows: [] }),
    getKolOutreachDefaults: async () => ({
      brand_pitch: '',
      product: '',
      source: 'none' as const,
      mailbox_connected: true,
    }),
    getKolSandbox: async () => ({ active: false, creators: 0, collaborations: 0, message: '' }),
    getAutopilot: async () => [],
  }
})

const { CreatorInfoCard } = await import('@/components/kol/creator-info-card')
const { KolPanel } = await import('@/components/kol/kol-panel')

beforeEach(() => {
  for (const fn of [kolMediaObjectUrl, setKolCreatorTags, reviewKolCreator, getKolCreators])
    fn.mockClear()
})
afterEach(() => {
  resetRightPane()
})

const detail = (view: KolCreatorDetailData = DETAIL) =>
  renderWithProviders(<CreatorInfoCard view={view} assignment="asg_yt" channel="youtube" />)

describe('1760 B：图片走本机同源地址', () => {
  it('横幅、头像、封面画的都是 blob: 地址；没缓存到的封面是色块；缓存到了就不再给外站链接', async () => {
    const { container } = detail()
    await screen.findByTestId('kol-banner')
    await waitFor(() => {
      expect(screen.getByTestId('kol-avatar-img').getAttribute('src')).toBe(`blob:test${MEDIA(1)}`)
    })
    const covers = screen.getAllByTestId('kol-recent-cover')
    await waitFor(() => {
      expect(covers[0]?.getAttribute('data-cached')).toBe('yes')
    })
    expect(covers[1]?.getAttribute('data-cached')).toBe('no')
    const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')
    expect(srcs.filter((s) => s.startsWith('blob:'))).toHaveLength(3)
    // 外站地址一张都没有（平台标志是打包进来的本地图）
    expect(srcs.filter((s) => /^https?:/.test(s))).toEqual([])
    expect(kolMediaObjectUrl.mock.calls.map((c) => c[0]).sort()).toEqual(
      [MEDIA(1), MEDIA(2), MEDIA(3)].sort(),
    )
    expect(screen.queryByText('头像')).toBeNull()
    expect(screen.queryByTestId('kol-profile-images-hint')).toBeNull()
  })

  it('不是同源那条路的地址：一次都不去取，照旧一个字的头像、没有横幅', async () => {
    const outside: KolCreatorDetailData = {
      ...DETAIL,
      profiles: {
        pa_yt: {
          saved_at: NOW,
          avatar_url: 'https://yt3.ggpht.com/avatar',
          avatar_media_url: 'https://yt3.ggpht.com/avatar',
          banner_media_url: '/v1/kol/media/../../etc',
        },
      },
    }
    detail(outside)
    await screen.findByTestId('kol-creator-detail')
    expect(kolMediaObjectUrl).not.toHaveBeenCalled()
    expect(screen.queryByTestId('kol-banner')).toBeNull()
    expect(screen.getAllByTestId('ws-avatar')[0]?.textContent).toBe('D')
  })
})

describe('1764 B：近期作品点了外跳原作品', () => {
  it('有链接的是一条外链（新窗口，壳交给系统浏览器）；没链接的点不开', async () => {
    detail()
    const items = await screen.findAllByTestId('kol-recent-item')
    const open = items[0]?.querySelector('a[data-testid="kol-recent-open"]')
    expect(open?.getAttribute('href')).toBe('https://www.youtube.com/watch?v=dfVid000001')
    expect(open?.getAttribute('target')).toBe('_blank')
    expect(items[1]?.querySelector('a')).toBeNull()
  })
})

describe('1763 B：标签与审核决定（详情）', () => {
  it('位置照 KOLAgents：标签在合作历史那一格的位置，审核决定在合作进度之后、联系方式之前；头部有审核小标', async () => {
    detail({ ...DETAIL, review: { decision: 'rejected', reason: '受众不在欧洲', decided_at: NOW } })
    const tags = await screen.findByTestId('kol-tags-section')
    const review = screen.getByTestId('kol-review')
    const contacts = screen.getByTestId('kol-contacts')
    expect(tags.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(review.compareDocumentPosition(contacts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByTestId('kol-review-badge')[0]?.getAttribute('data-decision')).toBe(
      'rejected',
    )
    expect(screen.getByTestId('kol-review-reason').textContent).toContain('受众不在欧洲')
  })

  it('加标签（回车）、删标签、同名不分大小写不重复加', async () => {
    detail()
    const input = (await screen.findByTestId('kol-tag-input')) as HTMLInputElement
    fireEvent.change(input, { target: { value: ' 键盘 ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(setKolCreatorTags).toHaveBeenCalledWith('cre_1', ['桌搭', '键盘'])
    })
    setKolCreatorTags.mockClear()
    fireEvent.change(input, { target: { value: '桌搭' } })
    fireEvent.click(screen.getByTestId('kol-tag-add'))
    expect(setKolCreatorTags).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByTestId('kol-tag-remove')[0] as HTMLElement)
    await waitFor(() => {
      expect(setKolCreatorTags).toHaveBeenCalledWith('cre_1', [])
    })
  })

  it('通过一下就算；淘汰展开理由框、理由可不填；定过了才出「重置为待审」', async () => {
    const { unmount } = detail()
    expect(await screen.findByTestId('kol-review')).toBeDefined()
    expect(screen.queryByTestId('kol-review-reset')).toBeNull()
    fireEvent.click(screen.getByTestId('kol-review-approve'))
    await waitFor(() => {
      expect(reviewKolCreator).toHaveBeenCalledWith('cre_1', { decision: 'approved' }, 'asg_yt')
    })
    fireEvent.click(screen.getByTestId('kol-review-reject'))
    fireEvent.click(screen.getByTestId('kol-review-reject-confirm'))
    await waitFor(() => {
      expect(reviewKolCreator).toHaveBeenLastCalledWith('cre_1', { decision: 'rejected' }, 'asg_yt')
    })
    unmount()

    detail({ ...DETAIL, review: { decision: 'approved', decided_at: NOW } })
    fireEvent.click(await screen.findByTestId('kol-review-reject'))
    fireEvent.change(screen.getByTestId('kol-review-reason-input'), {
      target: { value: '  报价太高 ' },
    })
    fireEvent.click(screen.getByTestId('kol-review-reject-confirm'))
    await waitFor(() => {
      expect(reviewKolCreator).toHaveBeenLastCalledWith(
        'cre_1',
        { decision: 'rejected', reason: '报价太高' },
        'asg_yt',
      )
    })
    fireEvent.click(screen.getByTestId('kol-review-reset'))
    await waitFor(() => {
      expect(reviewKolCreator).toHaveBeenLastCalledWith('cre_1', { decision: 'pending' }, 'asg_yt')
    })
  })
})

describe('1763 B：候选池卡片与筛选', () => {
  it('卡片：缓存的头像、前 3 个标签 + 「+1」、已通过小标（待审的不画）', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    const cards = await screen.findAllByTestId('kol-creator-card')
    const first = cards[0] as HTMLElement
    await waitFor(() => {
      expect(first.querySelector('[data-testid="kol-avatar-img"]')).not.toBeNull()
    })
    expect(
      [...first.querySelectorAll('[data-testid="kol-card-tag"]')].map((n) => n.textContent),
    ).toEqual(['桌搭', '德国', '键盘'])
    expect(first.querySelector('[data-testid="kol-card-tags"]')?.textContent).toContain('+1')
    expect(
      first.querySelector('[data-testid="kol-review-badge"]')?.getAttribute('data-decision'),
    ).toBe('approved')
    const second = cards[1] as HTMLElement
    expect(second.querySelector('[data-testid="kol-review-badge"]')).toBeNull()
    expect(second.querySelector('[data-testid="kol-card-tags"]')).toBeNull()
    expect(second.querySelector('[data-testid="ws-avatar"]')?.textContent).toBe('L')
  })

  it('按审核决定筛、按标签筛：服务端那两格跟着带上', async () => {
    renderWithProviders(<KolPanel assignment="asg_yt" channel="youtube" />)
    await screen.findAllByTestId('kol-creator-card')
    const rejected = screen
      .getAllByTestId('kol-pool-review-filter')
      .find((b) => b.getAttribute('data-review') === 'rejected') as HTMLElement
    fireEvent.click(rejected)
    await waitFor(() => {
      expect(getKolCreators).toHaveBeenLastCalledWith(
        expect.objectContaining({ channel: 'youtube', review: 'rejected' }),
      )
    })
    fireEvent.change(screen.getByTestId('kol-pool-tag-filter'), { target: { value: '德国' } })
    await waitFor(() => {
      expect(getKolCreators).toHaveBeenLastCalledWith(
        expect.objectContaining({ review: 'rejected', tag: '德国' }),
      )
    })
    getKolCreators.mockResolvedValueOnce({ rows: [], tags: ['德国'] })
    fireEvent.click(
      screen
        .getAllByTestId('kol-pool-review-filter')
        .find((b) => b.getAttribute('data-review') === 'pending') as HTMLElement,
    )
    expect((await screen.findByTestId('kol-library-empty')).textContent).toBe('这个条件下没有人。')
  })
})
