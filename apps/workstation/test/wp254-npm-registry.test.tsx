/**
 * WP254（决策 100 / 123）：「换国内源再试」与设置 · 诊断里的「下载源」。
 *
 * 1. CLI 卡装失败且是网络类、这次用的不是国内源 → 多一个「换国内源再试」：点了先把下载源改成国内源，再装；
 *    已经是国内源 / 不是网络类失败 → 不出；
 * 2. 连接器那一行同理（先改源，再下载）；
 * 3. 诊断里显示这台电脑的下载源，能改回官方源。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalConnectorLine } from '@/components/connections/local-connector'
import { PlatformCliCard } from '@/components/connections/platform-cli-card'
import { NpmRegistryDiagnostics } from '@/components/settings/npm-registry-diagnostics'
import type {
  LocalConnectorJobView,
  PlatformCliJob,
  PlatformKitView,
  RuntimeStatusView,
} from '@/lib/api'
import type { NpmRegistryView } from '@/lib/npm-registry-api'
import { offerMirrorRetry } from '@/lib/npm-registry-api'
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
  telemetry_off_env: {},
}

const failedInstall = (over: Partial<PlatformCliJob> = {}): PlatformKitView => ({
  platform: 'shopify',
  kit: {
    skills: [{ name: 'shopify' }],
    cli: {
      spec: SPEC,
      probe: {
        installed: false,
        node_version: '22.12.0',
        node_ok: true,
        min_node_major: 22,
        checked_at: '2026-10-07T10:00:00.000Z',
      },
      state: 'missing',
      degraded_roles: ['site.shopify-theme'],
      can: { install: true, login: true },
      job: {
        action: 'install',
        phase: 'failed',
        started_at: '2026-10-07T10:00:00.000Z',
        command: 'npm install --prefix "/data/tools/shopify-cli" @shopify/cli@latest',
        log: [],
        error: { code: 'network', detail: 'ENOTFOUND' },
        registry: 'official',
        ...over,
      },
    },
  },
})

const calls: string[] = []
const state = {
  kit: failedInstall(),
  registry: {
    source: 'official',
    urls: { official: 'https://registry.npmjs.org', npmmirror: 'https://registry.npmmirror.com' },
    env_override: false,
  } as NpmRegistryView,
}

vi.mock('@/components/connections/bridge', () => ({ openExternal: () => undefined }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPlatformKit: async () => state.kit,
    runPlatformCli: async (action: string) => {
      calls.push(`run:${action}`)
      return state.kit
    },
    localConnectorAction: async (action: string) => {
      calls.push(`local:${action}`)
      return connectorFailed()
    },
  }
})

vi.mock('@/lib/npm-registry-api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/npm-registry-api')>('@/lib/npm-registry-api')
  return {
    ...actual,
    getNpmRegistry: async () => state.registry,
    setNpmRegistry: async (source: 'official' | 'npmmirror') => {
      calls.push(`registry:${source}`)
      state.registry = { ...state.registry, source }
      return state.registry
    },
  }
})

function connectorFailed(job: Partial<LocalConnectorJobView> = {}): RuntimeStatusView {
  return {
    state: 'absent',
    reasons: ['runtime_unreachable'],
    checks: [],
    checked_at: '2026-10-07T10:00:00.000Z',
    secrets_vault: { available: true },
    local: {
      status: 'error',
      version: '1.8.0',
      download_bytes: 26_800_000,
      update_available: false,
      desired: 'run',
      job: {
        phase: 'failed',
        version: '1.8.0',
        started_at: '2026-10-07T10:00:00.000Z',
        fetched: 0,
        total: 318,
        error: { code: 'network', detail: 'ENOTFOUND' },
        registry: 'official',
        ...job,
      },
    },
  }
}

beforeEach(() => {
  calls.length = 0
  state.kit = failedInstall()
  state.registry = { ...state.registry, source: 'official' }
})

describe('什么时候给「换国内源再试」', () => {
  it('只在网络类失败、而且这次用的不是国内源时', () => {
    expect(offerMirrorRetry({ phase: 'failed', error: { code: 'network' } })).toBe(true)
    expect(
      offerMirrorRetry({ phase: 'failed', error: { code: 'timeout' }, registry: 'official' }),
    ).toBe(true)
    expect(
      offerMirrorRetry({ phase: 'failed', error: { code: 'network' }, registry: 'npmmirror' }),
    ).toBe(false)
    expect(offerMirrorRetry({ phase: 'failed', error: { code: 'integrity' } })).toBe(false)
    expect(offerMirrorRetry({ phase: 'done' })).toBe(false)
    expect(offerMirrorRetry(undefined)).toBe(false)
  })
})

describe('CLI 卡', () => {
  it('网络失败：「重试」旁边多一个「换国内源再试」，点了先改源再装', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PlatformCliCard />)
    const btn = await screen.findByTestId('platform-cli-retry-mirror')
    expect(btn.textContent).toBe('换国内源再试')
    expect(screen.getByTestId('platform-cli-install-run').textContent).toContain('重试')
    await user.click(btn)
    await waitFor(() => expect(calls).toEqual(['registry:npmmirror', 'run:install']))
  })

  it('已经是国内源还失败 / 不是网络问题：不出这个按钮', async () => {
    state.kit = failedInstall({ registry: 'npmmirror' })
    const { unmount } = renderWithProviders(<PlatformCliCard />)
    await screen.findByTestId('platform-cli-error')
    expect(screen.queryByTestId('platform-cli-retry-mirror')).toBeNull()
    unmount()
    state.kit = failedInstall({ error: { code: 'disk_full' } })
    renderWithProviders(<PlatformCliCard />)
    await screen.findByTestId('platform-cli-error')
    expect(screen.queryByTestId('platform-cli-retry-mirror')).toBeNull()
  })
})

describe('连接器那一行', () => {
  it('下载失败（网络）：「重试」旁边多一个「换国内源再试」，点了先改源再下', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LocalConnectorLine status={connectorFailed()} />)
    expect(screen.getByTestId('local-connector-retry')).toBeTruthy()
    await user.click(screen.getByTestId('local-connector-retry-mirror'))
    await waitFor(() => expect(calls).toEqual(['registry:npmmirror', 'local:install']))
  })

  it('国内源下也失败：不再出', () => {
    renderWithProviders(<LocalConnectorLine status={connectorFailed({ registry: 'npmmirror' })} />)
    expect(screen.queryByTestId('local-connector-retry-mirror')).toBeNull()
  })
})

describe('设置 · 诊断「下载源」', () => {
  it('国内源时显示出来、能改回官方源；官方源时能改用国内源', async () => {
    const user = userEvent.setup()
    state.registry = { ...state.registry, source: 'npmmirror' }
    renderWithProviders(<NpmRegistryDiagnostics />)
    const label = await screen.findByTestId('npm-registry-source')
    expect(label.textContent).toBe('国内源（npmmirror）')
    await user.click(screen.getByTestId('npm-registry-use-official'))
    await waitFor(() => expect(calls).toEqual(['registry:official']))
    await waitFor(() =>
      expect(screen.getByTestId('npm-registry-source').getAttribute('data-source')).toBe(
        'official',
      ),
    )
    expect(screen.getByTestId('npm-registry-use-npmmirror')).toBeTruthy()
  })
})
