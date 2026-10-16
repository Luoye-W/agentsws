/**
 * WP345（决策 871）：连接卡「浏览器插件」里装插件那一块。
 *
 * 1. 还没配上：一句 + 两个按钮 + 三步小字；点「打开插件文件夹」本机打开、路径进剪贴板；
 * 2. 配上了、跟得上：整块不出（卡自己收起靠的是有没有还能用的配对，撤掉的不算）；
 * 3. 没跟上新版：文件夹没换成 / 浏览器里那个重载了还是旧版——照实说一句；
 * 4. 不是桌面版 / 老本机服务：整块不出；已配上的那一行带插件版本。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserExtensionSection } from '@/components/connections/browser-extension'
import { ExtensionInstall } from '@/components/connections/extension-install'
import { type ConnectContext, useNeedConnected } from '@/components/setup/connect-widgets'
import type { ExtensionInstallView, ExtensionTokenView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const FOLDER = '/Users/a/Library/Application Support/@agentsws/desktop/chrome-extension'

const state = {
  view: undefined as ExtensionInstallView | undefined,
  opened: [] as string[],
  openResult: { opened: true } as { opened: boolean; message?: string; address?: string },
  tokens: [] as ExtensionTokenView[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getExtensionInstall: async () => {
      if (state.view === undefined) throw new Error('not_implemented')
      return state.view
    },
    openExtensionInstall: async (target: string) => {
      state.opened.push(target)
      return state.openResult
    },
    listExtensionTokens: async () => ({ tokens: state.tokens }),
  }
})

const view = (over: Partial<ExtensionInstallView> = {}): ExtensionInstallView => ({
  folder: FOLDER,
  folder_version: '0.2.0-beta.8',
  bundled_version: '0.2.0-beta.8',
  sync: { status: 'updated', at: '2026-10-15T08:00:00.000Z' },
  running: [],
  can_open: true,
  ...over,
})

const token = (id: string, revoked = false): ExtensionTokenView => ({
  id,
  label: '浏览器插件',
  extension_id: 'mlbfinfiigagllemohnopbhfdghagijg',
  scopes: ['kol.observe'],
  created_at: '2026-10-15T08:00:00.000Z',
  expires_at: '2026-11-14T08:00:00.000Z',
  ...(revoked ? { revoked_at: '2026-10-15T08:30:00.000Z' } : {}),
})

const writeText = vi.fn(async () => {})

beforeEach(() => {
  state.view = view()
  state.opened = []
  state.openResult = { opened: true }
  state.tokens = []
  writeText.mockClear()
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('还没配上：第一次装', () => {
  it('一句 + 两个按钮 + 三步小字；打开文件夹顺手复制路径', async () => {
    renderWithProviders(<ExtensionInstall assignment="asg_owner" paired={false} />)
    await screen.findByTestId('extension-install')
    expect(
      screen.getByText('插件随工坊带着：在 Chrome 里装一次，以后跟着工坊自己更新。'),
    ).toBeTruthy()
    expect(screen.getByTestId('extension-install-steps').textContent).toContain(
      '加载已解压的扩展程序',
    )
    fireEvent.click(screen.getByTestId('extension-install-folder'))
    await waitFor(() => expect(state.opened).toEqual(['folder']))
    expect(writeText).toHaveBeenCalledWith(FOLDER)
    expect((await screen.findByTestId('extension-install-note')).textContent).toBe('路径已复制')
    state.openResult = { opened: true, address: 'chrome://extensions' }
    fireEvent.click(screen.getByTestId('extension-install-chrome'))
    await waitFor(() => expect(state.opened).toEqual(['folder', 'chrome']))
    await waitFor(() =>
      expect(screen.getByTestId('extension-install-note').textContent).toBe(
        'chrome://extensions 已复制：在要装插件的那个 Chrome 窗口（有好几个 Chrome 用户的，就在那个用户的窗口）地址栏粘贴、回车',
      ),
    )
    expect(writeText).toHaveBeenLastCalledWith('chrome://extensions')
  })

  it('没打开（没找到 Chrome）：照实说那一句', async () => {
    state.openResult = { opened: false, message: '没找到 Chrome。' }
    renderWithProviders(<ExtensionInstall paired={false} />)
    fireEvent.click(await screen.findByTestId('extension-install-chrome'))
    expect((await screen.findByTestId('extension-install-note')).textContent).toBe(
      '没找到 Chrome。',
    )
  })

  it('不是桌面版 / 老本机服务：整块不出', async () => {
    const { folder: _f, ...rest } = view()
    state.view = { ...rest, can_open: false }
    const a = renderWithProviders(<ExtensionInstall paired={false} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('extension-install')).toBeNull()
    a.unmount()
    state.view = undefined
    renderWithProviders(<ExtensionInstall paired={false} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('extension-install')).toBeNull()
  })
})

describe('配上了', () => {
  it('跟得上：不出', async () => {
    state.view = view({
      running: [
        {
          token_id: 't1',
          extension_id: 'x',
          version: '0.2.0-beta.8',
          at: '2026-10-15T09:00:00.000Z',
        },
      ],
    })
    renderWithProviders(<ExtensionInstall paired />)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('extension-install')).toBeNull()
  })

  it('文件夹没换成：说原因，不出装的那几步', async () => {
    state.view = view({
      folder_version: '0.2.0-beta.7',
      sync: { status: 'failed', at: '2026-10-15T08:00:00.000Z', error: 'EBUSY' },
    })
    renderWithProviders(<ExtensionInstall paired />)
    const line = await screen.findByTestId('extension-install-failed')
    expect(line.textContent).toContain('0.2.0-beta.8')
    expect(line.textContent).toContain('EBUSY')
    expect(screen.queryByTestId('extension-install-folder')).toBeNull()
  })

  it('浏览器里那个重载了还是旧版：说一句 + 按钮与三步（删掉重装）', async () => {
    state.view = view({
      running: [
        {
          token_id: 't1',
          extension_id: 'x',
          version: '0.2.0-beta.7',
          at: '2026-10-15T09:00:00.000Z',
          stuck_on: '0.2.0-beta.8',
        },
      ],
    })
    renderWithProviders(<ExtensionInstall paired />)
    const line = await screen.findByTestId('extension-install-stuck')
    expect(line.textContent).toContain('还是 0.2.0-beta.7')
    expect(screen.getByTestId('extension-install-folder')).toBeTruthy()
  })
})

describe('连接页那一节', () => {
  it('没配上：出装的那一块；已配上那一行带插件版本', async () => {
    const first = renderWithProviders(<BrowserExtensionSection assignment="asg_owner" />)
    await screen.findByTestId('extension-install')
    first.unmount()
    state.tokens = [token('t1')]
    state.view = view({
      running: [
        {
          token_id: 't1',
          extension_id: 'x',
          version: '0.2.0-beta.8',
          at: '2026-10-15T09:00:00.000Z',
        },
      ],
    })
    renderWithProviders(<BrowserExtensionSection assignment="asg_owner" />)
    await screen.findByTestId('extension-tokens')
    await waitFor(() =>
      expect(screen.getByTestId('extension-tokens').textContent).toContain('插件 0.2.0-beta.8'),
    )
    expect(screen.queryByTestId('extension-install')).toBeNull()
  })
})

describe('连接卡收起', () => {
  function Probe(props: { ctx: ConnectContext }): React.ReactNode {
    const v = useNeedConnected({ service: 'extension' } as never, props.ctx)
    return <span data-testid="connected">{String(v)}</span>
  }
  const ctx: ConnectContext = {
    owner: 'asg_owner',
    providers: [],
    isConnected: () => false,
    refresh: () => {},
  }

  it('只有撤掉的配对不算连上；有一把还能用的才算', async () => {
    state.tokens = [token('t1', true)]
    const a = renderWithProviders(<Probe ctx={ctx} />)
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('false'))
    a.unmount()
    state.tokens = [token('t1', true), token('t2')]
    renderWithProviders(<Probe ctx={ctx} />)
    await waitFor(() => expect(screen.getByTestId('connected').textContent).toBe('true'))
  })
})
