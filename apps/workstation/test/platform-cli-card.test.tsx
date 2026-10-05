/**
 * WP216：平台官方 CLI 卡（连接页 / 建站岗位页）。
 *
 * 1. 服务端回 `kit: null`（非 Shopify 品牌）或没有 `cli`（别的岗位页）→ 什么都不画；
 * 2. 四档：没装给安装命令、Node 不够给门槛、没登录给登录命令与「我登好了」、好了只剩一排图标；
 * 3. 状态用图标（36 §7 第四档），没好时照实说降级；
 * 4. 「我登好了」只发 `confirmed: true`，一个凭据都不经手。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformCliCard } from '@/components/connections/platform-cli-card'
import type { PlatformCliState, PlatformKitView } from '@/lib/api'
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
  tutorial: 'shopify-cli',
  positions: ['site'],
  roles: ['site.shopify-theme'],
  telemetry_off_env: { SHOPIFY_CLI_NO_ANALYTICS: '1' },
}

function kitWith(state: PlatformCliState): PlatformKitView {
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
      },
    },
  }
}

const api = {
  view: kitWith('missing') as PlatformKitView,
  views: [] as { position_id?: string }[],
  logins: [] as boolean[],
  checks: 0,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPlatformKit: async (input: { position_id?: string }) => {
      api.views.push(input)
      return api.view
    },
    checkPlatformCli: async () => {
      api.checks += 1
      return api.view
    },
    confirmPlatformCliLogin: async (confirmed: boolean) => {
      api.logins.push(confirmed)
      return kitWith(confirmed ? 'ready' : 'needs_login')
    },
  }
})

beforeEach(() => {
  api.view = kitWith('missing')
  api.views = []
  api.logins = []
  api.checks = 0
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

  it('没装：三格图标、降级说明、安装命令、「再查一次」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlatformCliCard positionId="site" />)
    const card = await screen.findByTestId('platform-cli-card')
    expect(card.getAttribute('data-state')).toBe('missing')
    expect(icon('installed')).toBe('fail')
    expect(icon('login')).toBe('unknown')
    expect(screen.getByTestId('platform-cli-degraded').textContent).toContain('店铺后台接口')
    expect(screen.getByTestId('platform-cli-install').textContent).toBe(
      'npm install -g @shopify/cli@latest',
    )
    expect(screen.getByTestId('tutorial-link').getAttribute('data-slug')).toBe('shopify-cli')
    await user.click(screen.getByTestId('platform-cli-recheck'))
    await waitFor(() => expect(api.checks).toBe(1))
  })

  it('Node 不够：说门槛，Node 那一格是红的', async () => {
    api.view = kitWith('node_old')
    renderWithProviders(<PlatformCliCard positionId="site" />)
    await screen.findByTestId('platform-cli-card')
    expect(icon('installed')).toBe('ok')
    expect(icon('node')).toBe('fail')
    expect(screen.getByTestId('platform-cli-step').textContent).toContain('22')
  })

  it('没登录：给登录命令；点「我登好了」只发一个 true，之后卡上只剩图标', async () => {
    const user = userEvent.setup()
    api.view = kitWith('needs_login')
    renderWithProviders(<PlatformCliCard positionId="site" />)
    await screen.findByTestId('platform-cli-card')
    expect(screen.getByTestId('platform-cli-login').textContent).toBe('shopify auth login')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    await user.click(screen.getByTestId('platform-cli-login-done'))
    await waitFor(() =>
      expect(screen.getByTestId('platform-cli-card').getAttribute('data-state')).toBe('ready'),
    )
    expect(api.logins).toEqual([true])
    expect(icon('login')).toBe('ok')
    expect(screen.queryByTestId('platform-cli-step')).toBeNull()
    expect(screen.queryByTestId('platform-cli-degraded')).toBeNull()
  })
})
