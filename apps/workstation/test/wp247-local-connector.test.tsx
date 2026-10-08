/**
 * WP247：本机连接器按需下载在界面上的样子——
 * 顶上一行（没下载 / 下载中 / 启动中 / 出错 / 就绪）、点要连接器的卡先问「要先下载连接器，约 30 MB」、
 * 下好起来之后接着连、出错一句人话 + 重试；设置 · 诊断里的版本 / 重启 / 换回 / 删除下载。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalConnectorView, ProviderView, RuntimeStatusView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-07T09:00:00.000Z'

const SHOP: ProviderView = {
  service: 'shopify_admin',
  label: 'Shopify 店铺',
  auth: 'api_key',
  fields: [{ name: 'shop_domain', label: '店铺域名', secret: false, required: true }],
  available: true,
  requires_runtime: true,
  needs_download: true,
  data_sources: ['shop'],
  setup_guide: { summary: '在 Dev Dashboard 里建一个应用。', steps: [], links: [] },
}

const LOCAL: LocalConnectorView = {
  status: 'not_installed',
  version: '1.8.0',
  download_bytes: 26_800_000,
  update_available: false,
  desired: 'run',
}

const status = (local: Partial<LocalConnectorView>, over: Partial<RuntimeStatusView> = {}) =>
  ({
    state: 'absent',
    base_url: 'http://127.0.0.1:43170',
    reasons: ['runtime_unreachable'],
    checks: [],
    checked_at: T0,
    secrets_vault: { available: true },
    local: { ...LOCAL, ...local },
    ...over,
  }) satisfies RuntimeStatusView

const READY = status(
  { status: 'ready', installed: '1.8.0', previous: '1.7.0' },
  { state: 'ready', reasons: [] },
)

const state = { runtime: status({}) as RuntimeStatusView, providers: [SHOP] }
const actions: string[] = []
const begun: string[] = []

vi.mock('@/components/connections/bridge', () => ({ openExternal: () => undefined }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: [{ position_id: 'asg_owner', role_id: 'common.owner', role_name: '公司设置' }],
      tile_library: [],
      max_tiles: 6,
    }),
    listConnections: async () => ({ connections: [] }),
    listProviders: async () => ({ providers: state.providers }),
    getConnectRuntime: async () => state.runtime,
    getRedditBrowserReadStatus: async () => {
      throw new Error('501')
    },
    localConnectorAction: async (action: string) => {
      actions.push(action)
      if (action === 'install') state.runtime = status({ status: 'downloading' })
      return state.runtime
    },
    beginConnect: async (service: string) => {
      begun.push(service)
      return { request_id: 'creq_1', secure_form: { fields: SHOP.fields } }
    },
    listDeadLetters: async () => ({ dead_letters: [] }),
  }
})

const { ConnectionsPage } = await import('@/pages/connections')
const { DiagnosticsCard } = await import('@/components/settings/diagnostics-card')

beforeEach(() => {
  state.runtime = status({})
  state.providers = [SHOP]
  actions.length = 0
  begun.length = 0
})

describe('连接页顶上那一行', () => {
  it('没下载：一句话 + 「下载（约 30 MB）」，长说明在问号里', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConnectionsPage />)
    const line = await screen.findByTestId('local-connector')
    expect(line.dataset.status).toBe('not_installed')
    expect(line.textContent).toContain('连接器还没下载')
    // 老的「装 Docker」那一块不再出现
    expect(screen.queryByTestId('runtime-action')).toBeNull()
    expect(within(line).getByTestId('local-connector-download').textContent).toContain('约 30 MB')
    await user.click(within(line).getByTestId('local-connector-download'))
    expect(actions).toEqual(['install'])
  })

  it('下载中：百分比 + 进度条 + 取消', async () => {
    const user = userEvent.setup()
    state.runtime = status({
      status: 'downloading',
      job: { phase: 'downloading', version: '1.8.0', started_at: T0, fetched: 159, total: 318 },
    })
    renderWithProviders(<ConnectionsPage />)
    const line = await screen.findByTestId('local-connector')
    expect(line.textContent).toContain('正在下载连接器 50%')
    expect(within(line).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    await user.click(within(line).getByTestId('local-connector-cancel'))
    expect(actions).toEqual(['cancel'])
  })

  it('启动中：只一句；就绪：回到原来的「连接器就绪」', async () => {
    state.runtime = status({ status: 'starting', installed: '1.8.0' })
    const { unmount } = renderWithProviders(<ConnectionsPage />)
    expect((await screen.findByTestId('local-connector')).textContent).toContain('正在启动')
    unmount()
    state.runtime = READY
    renderWithProviders(<ConnectionsPage />)
    expect((await screen.findByTestId('runtime-bar')).textContent).toContain('连接器就绪')
    expect(screen.queryByTestId('local-connector')).toBeNull()
  })

  it('下载失败（网络）：一句人话 + 原始码进问号 + 重试 = 再下载', async () => {
    const user = userEvent.setup()
    state.runtime = status({
      status: 'error',
      job: {
        phase: 'failed',
        version: '1.8.0',
        started_at: T0,
        fetched: 3,
        total: 318,
        error: { code: 'network', detail: 'ENOTFOUND' },
      },
    })
    renderWithProviders(<ConnectionsPage />)
    const line = await screen.findByTestId('local-connector')
    expect(line.textContent).toContain('连不上下载源')
    expect(within(line).getByTestId('local-connector-detail')).toBeTruthy()
    await user.click(within(line).getByTestId('local-connector-retry'))
    expect(actions).toEqual(['install'])
  })

  it('装好了却起不来：重试 = 重启', async () => {
    const user = userEvent.setup()
    state.runtime = status({
      status: 'error',
      installed: '1.8.0',
      supervisor: { state: 'failed', port: 43170, attempts: 9, updated_at: T0, last_error: 'boom' },
    })
    renderWithProviders(<ConnectionsPage />)
    const line = await screen.findByTestId('local-connector')
    expect(line.textContent).toContain('连接器起不来')
    await user.click(within(line).getByTestId('local-connector-retry'))
    expect(actions).toEqual(['restart'])
  })
})

describe('点要连接器的卡', () => {
  it('没下载 → 先问一句；点「下载」开始下载；下好、起来之后接着连这一张', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConnectionsPage />)
    const card = (await screen.findAllByTestId('provider-card')).find(
      (c) => c.dataset.service === 'shopify_admin',
    )
    expect(card).toBeTruthy()
    // WP265：Shopify 卡的老接法收进了「高级」，先点开
    await user.click(within(card as HTMLElement).getByTestId('provider-advanced-toggle'))
    await user.click(within(card as HTMLElement).getByRole('button', { name: '连接' }))
    const dialog = await screen.findByTestId('connector-download-confirm')
    expect(dialog.textContent).toContain('要先下载连接器')
    expect(dialog.textContent).toContain('约 30 MB')
    expect(begun).toEqual([])
    await user.click(within(dialog).getByTestId('connector-download-ok'))
    expect(actions).toEqual(['install'])
    // 下好、起来了（轮询拿到 ready）→ 自动接着连 Shopify
    state.runtime = READY
    const { needs_download: _gone, ...ready } = SHOP
    state.providers = [ready]
    await waitFor(() => expect(begun).toEqual(['shopify_admin']), { timeout: 4000 })
  })

  it('点「先不了」：什么都不做', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConnectionsPage />)
    const card = (await screen.findAllByTestId('provider-card')).find(
      (c) => c.dataset.service === 'shopify_admin',
    )
    await user.click(within(card as HTMLElement).getByTestId('provider-advanced-toggle'))
    await user.click(within(card as HTMLElement).getByRole('button', { name: '连接' }))
    await user.click(await screen.findByRole('button', { name: '先不了' }))
    expect(actions).toEqual([])
    expect(begun).toEqual([])
  })
})

describe('设置 · 诊断：连接器', () => {
  it('版本、重启、换回上一版、删除下载（先确认）', async () => {
    const user = userEvent.setup()
    state.runtime = READY
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    renderWithProviders(<DiagnosticsCard assignment="asg_owner" />)
    const block = await screen.findByTestId('connector-diagnostics')
    expect(within(block).getByTestId('connector-diag-version').textContent).toBe('版本 1.8.0')
    await user.click(within(block).getByTestId('connector-diag-restart'))
    await user.click(within(block).getByTestId('connector-diag-rollback'))
    expect(within(block).getByTestId('connector-diag-rollback').textContent).toContain('1.7.0')
    await user.click(within(block).getByTestId('connector-diag-remove'))
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(actions).toEqual(['restart', 'rollback', 'remove']))
    confirm.mockRestore()
  })

  it('有新版本：多一个「更新到 x」；不归工作台管：整块不画', async () => {
    state.runtime = status(
      { status: 'ready', installed: '1.7.0', update_available: true },
      { state: 'ready', reasons: [] },
    )
    const { unmount } = renderWithProviders(<DiagnosticsCard assignment="asg_owner" />)
    expect((await screen.findByTestId('connector-diag-update')).textContent).toContain('1.8.0')
    unmount()
    state.runtime = { ...READY, local: undefined } as unknown as RuntimeStatusView
    renderWithProviders(<DiagnosticsCard assignment="asg_owner" />)
    await screen.findByTestId('settings-diagnostics')
    expect(screen.queryByTestId('connector-diagnostics')).toBeNull()
  })
})
