/**
 * WP246（决策 87 / 88）：连接页「取数路线」——每个平台一行、每级一个状态图标、现在在用的那一级标「在用」；
 * 原因与怎么修进提示；「重新体检」；Reddit「登录读号」+ 常显的「别用版主号 / 品牌官方号」；第三方转文字开关。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadRoutesSection } from '@/components/connections/read-routes'
import type { ReadRoutesView } from '@/lib/api'
import { renderWithProviders } from './helpers'
import { CARD_TEXT_LIMIT, reportCard } from './less-text-guard'

const base = (): ReadRoutesView => ({
  doctor: {
    deep: false,
    checked_at: '2026-10-07T10:02:00.000Z',
    routes: [
      {
        platform: 'reddit',
        route_key: 'reddit.read',
        tool: 'read_reddit',
        levels: [
          {
            level: 'workshop',
            state: 'down',
            reason: '没关联 Agents 工坊账号。',
            fix: '到「设置 › 云端账号」关联（这一级按条扣积分）。',
            action: 'link_account',
          },
          {
            level: 'browser_readonly',
            state: 'down',
            reason: '还没登录读号。',
            fix: '点「登录读号」，用一个普通号在网页上登录（别用版主号 / 品牌官方号）。',
            action: 'login_read_account',
          },
        ],
      },
      {
        platform: 'youtube',
        route_key: 'youtube.transcript',
        tool: 'read_youtube_transcript',
        active: 'page_captions',
        levels: [
          {
            level: 'page_captions',
            state: 'ok',
            reason: '零配置：直接读视频页里的字幕轨，不经第三方。',
            last: { ok: false, at: '2026-10-07T09:00:00Z', message: '这个视频没有字幕轨' },
          },
          { level: 'workshop', state: 'pending', reason: '接口中台的 YouTube 字幕还没接。' },
        ],
      },
      {
        platform: 'web',
        route_key: 'web.read',
        tool: 'read_webpage',
        active: 'local_extract',
        levels: [
          {
            level: 'local_extract',
            state: 'ok',
            reason: '零配置：本机取网页、本机抽正文，不经第三方。',
          },
          {
            level: 'third_party_reader',
            state: 'off',
            reason: '默认关：开了网址会发给 Jina Reader。',
          },
        ],
      },
    ],
  },
  settings: { web_third_party_reader: false, reddit_browser_window: 'minimized' },
  reddit_account: { state: 'none' },
})

let current = base()
const api = vi.hoisted(() => ({
  getReadRoutes: vi.fn(),
  runReadRoutesDoctor: vi.fn(),
  setReadRoutesSettings: vi.fn(),
  openRedditReadAccountLogin: vi.fn(),
}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, ...api }
})

beforeEach(() => {
  current = base()
  api.getReadRoutes.mockImplementation(async () => current)
  api.runReadRoutesDoctor.mockImplementation(async () => ({
    ...current,
    doctor: { ...current.doctor, deep: true },
  }))
  api.setReadRoutesSettings.mockImplementation(
    async (patch: { web_third_party_reader?: boolean }) => {
      current = {
        ...current,
        settings: {
          ...current.settings,
          web_third_party_reader: patch.web_third_party_reader === true,
        },
      }
      return current
    },
  )
  api.openRedditReadAccountLogin.mockImplementation(async () => {
    current = { ...current, reddit_account: { state: 'logging_in' } }
    return current.reddit_account
  })
})

const hintOf = (testId: string): string =>
  screen
    .getByTestId(testId)
    .querySelector('[data-testid="status-icon"]')
    ?.getAttribute('data-hint') ?? ''

describe('连接页「取数路线」', () => {
  it('每个平台一行，每级一个图标；在用的那一级标「在用」；都不通的照实说', async () => {
    renderWithProviders(<ReadRoutesSection assignment="asg_owner" />)
    const reddit = await screen.findByTestId('read-route-reddit')
    expect(reddit.getAttribute('data-active')).toBe('')
    expect(within(reddit).getByText('都不通')).toBeTruthy()
    const levels = within(reddit).getAllByTestId('status-icon')
    expect(levels.map((l) => l.getAttribute('data-key'))).toEqual(['workshop', 'browser_readonly'])
    expect(levels.map((l) => l.getAttribute('data-state'))).toEqual(['fail', 'fail'])
    // 原因 + 怎么修进提示，不铺在卡上
    expect(hintOf('read-level-reddit-browser_readonly')).toContain('怎么修：点「登录读号」')
    const yt = screen.getByTestId('read-route-youtube')
    expect(within(yt).getByTestId('status-value').textContent).toBe('在用')
    expect(hintOf('read-level-youtube-page_captions')).toContain('上次没成：这个视频没有字幕轨')
    expect(hintOf('read-level-youtube-workshop')).toContain('还没接')
    expect(hintOf('read-level-web-third_party_reader')).toContain('关着')
  })

  it('Reddit：「登录读号」+ 常显的安全那句；点了按钮变「窗口开着」，提示在窗口里登录', async () => {
    renderWithProviders(<ReadRoutesSection assignment="asg_owner" />)
    const btn = await screen.findByTestId('read-account-login')
    expect(screen.getByText('用一个普通号登录，别用版主号 / 品牌官方号')).toBeTruthy()
    fireEvent.click(btn)
    await waitFor(() => expect(api.openRedditReadAccountLogin).toHaveBeenCalledWith('asg_owner'))
    await waitFor(() =>
      expect(screen.getByTestId('read-account-status').getAttribute('data-state')).toBe(
        'logging_in',
      ),
    )
    expect((screen.getByTestId('read-account-login') as HTMLButtonElement).disabled).toBe(true)
  })

  it('读号已登录 / 被拦（品牌登记的号）：一行状态', async () => {
    current = {
      ...base(),
      reddit_account: { state: 'logged_in', username: 'reader_bob' },
    }
    const r1 = renderWithProviders(<ReadRoutesSection />)
    expect((await screen.findByTestId('read-account-status')).textContent).toBe(
      '已登录：u/reader_bob',
    )
    r1.unmount()
    current = {
      ...base(),
      reddit_account: {
        state: 'refused',
        username: 'inmo_mod',
        message: 'u/inmo_mod 是品牌登记的号（官方号 / 版主号），读取不用它。',
      },
    }
    renderWithProviders(<ReadRoutesSection />)
    const st = await screen.findByTestId('read-account-status')
    expect(st.getAttribute('data-state')).toBe('refused')
    expect(st.textContent).toContain('品牌登记的号')
  })

  it('重新体检真去连；第三方转文字开关存设置（开了网址会经过对方，写在问号里）', async () => {
    renderWithProviders(<ReadRoutesSection assignment="asg_owner" />)
    fireEvent.click(await screen.findByTestId('read-routes-recheck'))
    await waitFor(() => expect(api.runReadRoutesDoctor).toHaveBeenCalledWith('asg_owner'))
    expect(screen.getByTestId('read-third-party-hint').getAttribute('data-hint')).toContain(
      'Jina Reader',
    )
    fireEvent.click(screen.getByTestId('read-third-party-switch'))
    await waitFor(() =>
      expect(api.setReadRoutesSettings).toHaveBeenCalledWith(
        { web_third_party_reader: true },
        'asg_owner',
      ),
    )
  })

  it('少字：整块常显的说明字不超过上限（状态与安全那句不算）', async () => {
    renderWithProviders(<ReadRoutesSection />)
    const section = await screen.findByTestId('read-routes')
    const r = reportCard(section)
    expect(r.weight, r.text).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
    expect(r.longSafety).toEqual([])
  })

  it('服务进程没装这一块：整块不画', async () => {
    api.getReadRoutes.mockImplementation(async () => {
      throw new Error('not_implemented')
    })
    const { container } = renderWithProviders(<ReadRoutesSection />)
    await waitFor(() => expect(api.getReadRoutes).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="read-routes"]')).toBeNull()
  })
})
