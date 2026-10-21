/**
 * WP432（Luoye 10-20 反馈 9）：工坊这一侧——
 *
 * 1. 卡上点「发送」= 批准：社媒岗位页顶上一行「N 条已批，等你在浏览器插件里发」（同一张卡只算一条）；
 * 2. 浏览器里的插件不是新版 / 这几分钟没看到它：就地出「插件要重新加载一下」+ 怎么点（复制 chrome://extensions）；
 *    插件报了新版就自己消失；
 * 3. 连接卡上：已配上、但浏览器里那个报的是旧版（还没重新加载过）——照实说一句怎么点。
 */
import type { RedditWriteView } from '@agentsws/contracts'
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionInstall } from '@/components/connections/extension-install'
import { EXT_FRESH_MS, reloadNeed } from '@/components/connections/extension-reload'
import { RedditWriteNotice } from '@/components/social/reddit-write-notice'
import type { ExtensionInstallView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const recent = (): string => new Date(Date.now() - 60_000).toISOString()
const longAgo = (): string => new Date(Date.now() - 2 * EXT_FRESH_MS).toISOString()

const state = {
  rows: [] as RedditWriteView[],
  view: undefined as ExtensionInstallView | undefined,
  /** WP445：服务端数的「插件里 N 条等你发」（不给 = 老服务，前端自己数批过的）。 */
  inPlugin: undefined as number | undefined,
}

vi.mock('@/lib/reddit-write-api', () => ({
  REDDIT_WRITES_KEY: ['reddit-writes'],
  listRedditWrites: async () => ({
    rows: state.rows,
    ...(state.inPlugin === undefined ? {} : { in_plugin: state.inPlugin }),
  }),
  refillRedditWrite: async () => ({}),
  dismissRedditWrite: async () => ({}),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getExtensionInstall: async () => {
      if (state.view === undefined) throw new Error('not_implemented')
      return state.view
    },
    openExtensionInstall: async () => ({ opened: true, address: 'chrome://extensions' }),
  }
})

const row = (over: Partial<RedditWriteView> = {}): RedditWriteView => ({
  approval_item_id: 'ap_1',
  job_id: 'rdw_1',
  kind: 'reply',
  subreddit: 'ivraxr',
  state: 'awaiting',
  queued_at: recent(),
  ...over,
})

const view = (over: Partial<ExtensionInstallView> = {}): ExtensionInstallView => ({
  folder: '/x/chrome-extension',
  folder_version: '0.2.1-beta.5',
  running: [],
  can_open: true,
  ...over,
})

const run = (version: string, at = recent()) => ({
  token_id: 't1',
  extension_id: 'mlbfinfiigagllemohnopbhfdghagijg',
  version,
  at,
})

const duties = [{ role_id: 'social.reddit', assignment_id: 'asg_reddit' }]

beforeEach(() => {
  state.rows = []
  state.view = undefined
  state.inPlugin = undefined
})

describe('WP432 要不要提示重新加载', () => {
  const now = Date.now()
  it('报了工坊那一版：不提示；报的是旧版：stale；这几分钟谁都没报：unseen；不是桌面版：不提示', () => {
    expect(reloadNeed(view({ running: [run('0.2.1-beta.5')] }), now)).toBeUndefined()
    expect(reloadNeed(view({ running: [run('0.2.1-beta.3')] }), now)).toEqual({
      kind: 'stale',
      running: '0.2.1-beta.3',
      folder: '0.2.1-beta.5',
    })
    expect(
      reloadNeed(view({ unpaired: { version: '0.2.1-beta.3', at: recent() } }), now)?.kind,
    ).toBe('stale')
    expect(reloadNeed(view({ running: [run('0.2.1-beta.5', longAgo())] }), now)?.kind).toBe(
      'unseen',
    )
    const { folder_version: _f, ...noFolder } = view()
    expect(reloadNeed(noFolder, now)).toBeUndefined()
  })
})

describe('WP432 社媒岗位页：等你在插件里发', () => {
  it('批了的两张卡（其中一张再填过）→「插件里 2 条等你发」（WP445）；插件是旧版 → 就地提示怎么重新加载', async () => {
    state.rows = [
      row(),
      row({ job_id: 'rdw_0', state: 'failed', approval_item_id: 'ap_1' }),
      row({ approval_item_id: 'ap_2', job_id: 'rdw_2' }),
      row({ approval_item_id: 'ap_3', job_id: 'rdw_3', state: 'sent' }),
    ]
    state.view = view({ running: [run('0.2.1-beta.3')] })
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    const line = await screen.findByTestId('reddit-write-awaiting')
    expect(line.textContent).toContain('插件里 2 条等你发')
    const prompt = await screen.findByTestId('extension-reload')
    expect(prompt.getAttribute('data-kind')).toBe('stale')
    expect(prompt.textContent).toContain('插件要重新加载一下')
    expect(prompt.textContent).toContain('0.2.1-beta.3')
    expect(prompt.textContent).toContain('chrome://extensions')
  })

  it('插件这几分钟没来过、又有等你发的 → 也提示；插件报了新版 → 自己消失', async () => {
    state.rows = [row()]
    state.view = view()
    const first = renderWithProviders(<RedditWriteNotice duties={duties} />)
    expect((await screen.findByTestId('extension-reload')).getAttribute('data-kind')).toBe('unseen')
    first.unmount()
    state.view = view({ running: [run('0.2.1-beta.5')] })
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    await screen.findByTestId('reddit-write-awaiting')
    await waitFor(() => expect(screen.queryByTestId('extension-reload')).toBeNull())
  })

  it('WP445：数字按服务端的「插件里 N 条等你发」（还没审的卡也算）；不是卡，点了提示去浏览器插件里发', async () => {
    state.rows = []
    state.inPlugin = 3
    state.view = view({ running: [run('0.2.1-beta.5')] })
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    const line = await screen.findByTestId('reddit-write-awaiting')
    expect(line.textContent).toContain('插件里 3 条等你发')
    expect(screen.queryByTestId('deck-reddit-write')).toBeNull()
    expect(screen.queryByTestId('reddit-write-awaiting-tip')).toBeNull()
    ;(await screen.findByTestId('reddit-write-awaiting-go')).click()
    expect((await screen.findByTestId('reddit-write-awaiting-tip')).textContent).toContain(
      'Agents 工坊助手',
    )
  })

  it('没有等你发的：不出这一行，也不出重新加载提示', async () => {
    state.rows = [row({ state: 'sent' })]
    state.view = view()
    const { container } = renderWithProviders(<RedditWriteNotice duties={duties} />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})

describe('WP432 连接卡', () => {
  it('已配上、浏览器里那个报的是旧版（没卡在换不成）→ 照实说怎么重新加载', async () => {
    state.view = view({ running: [run('0.2.1-beta.3')] })
    renderWithProviders(<ExtensionInstall paired />)
    const p = await screen.findByTestId('extension-install-stale')
    expect(p.textContent).toContain('0.2.1-beta.3')
    expect(p.textContent).toContain('重新加载')
  })
})
