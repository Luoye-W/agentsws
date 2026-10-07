/**
 * WP216 / WP245：平台官方 CLI 卡（连接页 / 建站岗位页）。
 *
 * 1. 服务端回 `kit: null`（非 Shopify 品牌）或没有 `cli`（别的岗位页）→ 什么都不画；
 * 2. 没好：主状态一行 + 一个主按钮（「一键安装」/「登录 Shopify」），命令与输出收在「详情」；
 * 3. 安装画进度、失败一句人话 + 重试；登录把网址交给系统浏览器、可取消、结束后卡片变绿；
 * 4. 一个账号密码输入框都没有；「我登好了」按钮不在了。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformCliCard } from '@/components/connections/platform-cli-card'
import type { PlatformCliJob, PlatformCliState, PlatformKitView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const SPEC = {
  id: 'shopify-cli',
  label: 'Shopify CLI',
  bin: 'shopify',
  version_args: ['version'],
  npm: '@shopify/cli',
  license: 'MIT',
  min_node_major: 22,
  install: [{ method: 'npm' as const, command: 'npm install -g @shopify/cli@latest' }],
  login_command: 'shopify auth login',
  login_args: ['auth', 'login'],
  account_label: 'Shopify',
  tutorial: 'shopify-cli',
  positions: ['site'],
  roles: ['site.shopify-theme'],
  telemetry_off_env: { SHOPIFY_CLI_NO_ANALYTICS: '1' },
}

function kitWith(
  state: PlatformCliState,
  extra: Partial<NonNullable<NonNullable<PlatformKitView['kit']>['cli']>> = {},
): PlatformKitView {
  return {
    platform: 'shopify',
    kit: {
      skills: [{ name: 'shopify' }],
      cli: {
        spec: SPEC,
        probe: {
          installed: state !== 'missing',
          ...(state === 'missing' ? {} : { version: '4.8.4' }),
          node_version: state === 'node_old' ? '20.11.0' : '22.12.0',
          node_ok: state !== 'node_old',
          min_node_major: 22,
          checked_at: '2026-10-05T10:00:00.000Z',
        },
        ...(state === 'ready' ? { login_confirmed_at: '2026-10-05T10:00:00.000Z' } : {}),
        state,
        degraded_roles: state === 'ready' ? [] : ['site.shopify-theme'],
        can: { install: true, login: true },
        ...extra,
      },
    },
  }
}

const job = (
  j: Partial<PlatformCliJob> & Pick<PlatformCliJob, 'action' | 'phase'>,
): PlatformCliJob => ({
  started_at: '2026-10-07T10:00:00.000Z',
  command:
    j.action === 'install'
      ? 'npm install --prefix "/data/tools/shopify-cli" @shopify/cli@latest'
      : 'shopify auth login',
  log: [],
  ...j,
})

const api = {
  view: kitWith('missing') as PlatformKitView,
  views: [] as { position_id?: string }[],
  runs: [] as string[],
  cancels: 0,
  /** 点了按钮之后服务端回什么。 */
  next: undefined as PlatformKitView | undefined,
  owner: true,
  picks: [] as { input: { storefront_platform: string }; assignment?: string }[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPlatformKit: async (input: { position_id?: string }) => {
      api.views.push(input)
      return api.view
    },
    runPlatformCli: async (action: string) => {
      api.runs.push(action)
      if (api.next !== undefined) api.view = api.next
      return api.view
    },
    cancelPlatformCli: async () => {
      api.cancels += 1
      api.view = kitWith('needs_login', {
        job: job({ action: 'login', phase: 'cancelled' }),
      })
      return api.view
    },
    getPositions: async () => ({
      positions: api.owner
        ? [{ position_id: 'asg_owner', role_id: 'common.owner' }]
        : [{ position_id: 'asg_site', role_id: 'site.shopify-theme' }],
      instances: [],
    }),
    setPlatformKitPlatform: async (input: { storefront_platform: string }, assignment?: string) => {
      api.picks.push({ input, ...(assignment === undefined ? {} : { assignment }) })
      // 服务端那一侧：档案改了，之后再取就是 Shopify 那一套
      api.view = kitWith('needs_login')
      return api.view
    },
  }
})

const opened: string[] = []
vi.mock('@/components/connections/bridge', async () => {
  const actual = await vi.importActual<typeof import('@/components/connections/bridge')>(
    '@/components/connections/bridge',
  )
  return { ...actual, openExternal: (url: string) => opened.push(url) }
})

beforeEach(() => {
  api.view = kitWith('missing')
  api.views = []
  api.runs = []
  api.cancels = 0
  api.next = undefined
  opened.length = 0
  api.owner = true
  api.picks = []
})

const icon = (key: string) =>
  screen
    .getAllByTestId('status-icon')
    .find((el) => el.getAttribute('data-key') === key)
    ?.getAttribute('data-state')

describe('WP216 平台 CLI 卡', () => {
  it('非 Shopify 品牌（kit: null）：什么都不画', async () => {
    api.view = { platform: 'woocommerce', kit: null }
    renderWithProviders(<PlatformCliCard />)
    await waitFor(() => expect(api.views).toHaveLength(1))
    expect(screen.queryByTestId('platform-cli-card')).toBeNull()
  })

  it('别的岗位页（服务端没回 cli）：不画；岗位页按模板 id 问', async () => {
    api.view = { platform: 'shopify', kit: { skills: [{ name: 'shopify' }] } }
    renderWithProviders(<PlatformCliCard positionId="customer-care" />)
    await waitFor(() => expect(api.views).toEqual([{ position_id: 'customer-care' }]))
    expect(screen.queryByTestId('platform-cli-card')).toBeNull()
  })

  it('没装：一行 + 「一键安装」；降级说明进问号；命令收在「详情」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlatformCliCard positionId="site" />)
    const card = await screen.findByTestId('platform-cli-card')
    expect(card.getAttribute('data-state')).toBe('missing')
    expect(icon('installed')).toBe('fail')
    expect(icon('login')).toBe('unknown')
    // Node 不用用户操心：够的时候不出那一格
    expect(icon('node')).toBeUndefined()
    expect(screen.getByTestId('platform-cli-step').textContent).toContain('不用开终端')
    expect(card.querySelector('[data-hint*="店铺后台接口"]')).not.toBeNull()
    expect(screen.queryByTestId('platform-cli-degraded')).toBeNull()
    // 命令只在「详情」里（收着）
    const details = screen.getByTestId('platform-cli-details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(screen.getByTestId('platform-cli-install').textContent).toBe(
      'npm install -g @shopify/cli@latest',
    )
    expect(screen.getByTestId('tutorial-link').getAttribute('data-slug')).toBe('shopify-cli')
    api.next = kitWith('missing', {
      job: job({ action: 'install', phase: 'installing', fetched: 3, log: ['added 3 packages'] }),
    })
    await user.click(screen.getByTestId('platform-cli-install-run'))
    await waitFor(() => expect(api.runs).toEqual(['install']))
    const line = await screen.findByTestId('platform-cli-job')
    expect(line.getAttribute('data-phase')).toBe('installing')
    expect(line.textContent).toContain('正在安装')
    expect(line.textContent).toContain('已下载 3 个包')
    expect(screen.getByTestId('platform-cli-command').textContent).toContain('--prefix')
    expect(screen.getByTestId('platform-cli-log').textContent).toContain('added 3 packages')
    expect(screen.queryByTestId('platform-cli-install-run')).toBeNull()
    expect(screen.getByTestId('platform-cli-cancel')).toBeTruthy()
  })

  it('装失败（网络）：一句人话 + 原始码 + 「重试」', async () => {
    const user = userEvent.setup()
    api.view = kitWith('missing', {
      job: job({
        action: 'install',
        phase: 'failed',
        error: { code: 'network', detail: 'ENOTFOUND' },
        log: ['npm error code ENOTFOUND'],
      }),
    })
    renderWithProviders(<PlatformCliCard positionId="site" />)
    const err = await screen.findByTestId('platform-cli-error')
    expect(err.textContent).toContain('网络连不上')
    expect(err.textContent).toContain('ENOTFOUND')
    const retry = screen.getByTestId('platform-cli-install-run')
    expect(retry.textContent).toContain('重试')
    await user.click(retry)
    await waitFor(() => expect(api.runs).toEqual(['install']))
  })

  it('这台机器不能自动装：退回复制命令', async () => {
    api.view = kitWith('missing', { can: { install: false, login: true } })
    renderWithProviders(<PlatformCliCard positionId="site" />)
    await screen.findByTestId('platform-cli-card')
    expect(screen.getByTestId('platform-cli-step').textContent).toContain('终端')
    expect(screen.getByTestId('platform-cli-install-manual').textContent).toContain('npm install')
    expect(screen.queryByTestId('platform-cli-install-run')).toBeNull()
  })

  it('Node 不够：Node 那一格是红的，按钮还是「一键安装」（装一份工作台自己用的）', async () => {
    api.view = kitWith('node_old')
    renderWithProviders(<PlatformCliCard positionId="site" />)
    await screen.findByTestId('platform-cli-card')
    expect(icon('installed')).toBe('ok')
    expect(icon('node')).toBe('fail')
    expect(screen.getByTestId('platform-cli-install-run')).toBeTruthy()
  })

  it('没登录：「登录 Shopify」→ 网址交给系统浏览器（只开一次）→ 可取消；没有任何输入框', async () => {
    const user = userEvent.setup()
    api.view = kitWith('needs_login')
    renderWithProviders(<PlatformCliCard positionId="site" />)
    await screen.findByTestId('platform-cli-card')
    expect(screen.getByTestId('platform-cli-step').textContent).toContain('还差登录 Shopify')
    expect(screen.queryByTestId('platform-cli-login-done')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    const url =
      'https://accounts.shopify.com/activate-with-code?device_code%5Buser_code%5D=ABCD-EFGH'
    api.next = kitWith('needs_login', {
      job: job({
        action: 'login',
        phase: 'waiting_browser',
        login_url: url,
        user_code: 'ABCD-EFGH',
      }),
    })
    const btn = screen.getByTestId('platform-cli-login-run')
    expect(btn.textContent).toContain('登录 Shopify')
    await user.click(btn)
    await waitFor(() => expect(api.runs).toEqual(['login']))
    expect((await screen.findByTestId('platform-cli-step')).textContent).toContain(
      '浏览器里登录完回来就行',
    )
    await waitFor(() => expect(opened).toEqual([url]))
    expect(screen.getByTestId('platform-cli-code').textContent).toContain('ABCD-EFGH')
    // 「没弹出来？」再开一次
    await user.click(screen.getByTestId('platform-cli-reopen'))
    expect(opened).toEqual([url, url])
    await user.click(screen.getByTestId('platform-cli-cancel'))
    await waitFor(() => expect(api.cancels).toBe(1))
    expect(await screen.findByTestId('platform-cli-login-run')).toBeTruthy()
  })

  it('CLI 自己已经开了浏览器：不再开第二次；登完卡片变绿、只剩图标与「重新检查」', async () => {
    const user = userEvent.setup()
    api.view = kitWith('needs_login', {
      job: job({
        action: 'login',
        phase: 'waiting_browser',
        login_url: 'https://accounts.shopify.com/x',
        browser_opened: true,
      }),
    })
    renderWithProviders(<PlatformCliCard positionId="site" />)
    await screen.findByTestId('platform-cli-job')
    expect(opened).toEqual([])
    api.view = kitWith('ready', { job: job({ action: 'login', phase: 'done' }) })
    // 轮询拿到结束后的样子
    await waitFor(
      () =>
        expect(screen.getByTestId('platform-cli-card').getAttribute('data-state')).toBe('ready'),
      { timeout: 4000 },
    )
    expect(icon('login')).toBe('ok')
    expect(screen.queryByTestId('platform-cli-step')).toBeNull()
    expect(screen.queryByTestId('platform-cli-login-run')).toBeNull()
    await user.click(screen.getByTestId('platform-cli-recheck'))
    await waitFor(() => expect(api.runs).toEqual(['version']))
  })

  it('官方工具包那一格：开着没下载 = 「首次使用会下载官方工具包」', async () => {
    const base = kitWith('ready')
    api.view = {
      ...base,
      kit: {
        ...(base.kit as NonNullable<PlatformKitView['kit']>),
        mcp: {
          id: 'shopify-dev-mcp',
          label: 'Shopify Dev MCP',
          npm: '@shopify/dev-mcp',
          version: '1.15.0',
          license: 'ISC',
          egress: ['shopify.dev'],
          telemetry_off_env: {},
          enabled: true,
          downloaded: false,
          tools: [],
        },
      },
    }
    renderWithProviders(<PlatformCliCard positionId="site" />)
    await screen.findByTestId('platform-cli-card')
    expect(icon('toolkit')).toBe('unknown')
    const el = screen
      .getAllByTestId('status-icon')
      .find((e) => e.getAttribute('data-key') === 'toolkit')
    expect(el?.getAttribute('data-hint')).toContain('首次使用会下载官方工具包')
  })
})

describe('WP216（Fable 10-05）：没设建站平台——建站岗位页一行「先选一下你的建站平台」', () => {
  const choose: PlatformKitView = {
    kit: null,
    choose_platform: {
      choices: [
        { key: 'shopify', label: 'Shopify', supported: true },
        { key: 'none', label: '还没开始搭建', supported: true },
        { key: 'woocommerce', label: 'WooCommerce', supported: false },
      ],
    },
  }

  it('负责人：一行 + 下拉（灰显的选不了），选了用负责人那条分配发，之后出 CLI 卡', async () => {
    const user = userEvent.setup()
    api.view = choose
    renderWithProviders(<PlatformCliCard positionId="site" assignment="asg_site" />)
    expect((await screen.findByTestId('platform-choose')).textContent).toContain(
      '先选一下你的建站平台',
    )
    const select = (await screen.findByTestId('platform-choose-select')) as HTMLSelectElement
    expect([...select.options].find((o) => o.value === 'woocommerce')?.disabled).toBe(true)
    await user.selectOptions(select, 'shopify')
    await waitFor(() => expect(api.picks).toHaveLength(1))
    expect(api.picks[0]).toEqual({
      input: { storefront_platform: 'shopify', position_id: 'site' },
      assignment: 'asg_owner',
    })
    await screen.findByTestId('platform-cli-card')
  })

  it('不是负责人：只说一句，不给下拉', async () => {
    api.owner = false
    api.view = choose
    renderWithProviders(<PlatformCliCard positionId="site" />)
    await screen.findByTestId('platform-choose-ask-owner')
    expect(screen.queryByTestId('platform-choose-select')).toBeNull()
  })
})
