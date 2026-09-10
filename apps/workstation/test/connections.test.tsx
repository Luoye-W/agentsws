/**
 * 连接页（WP20 §B）。
 *
 * 三组断言：
 * 1. **凭据零泄漏**：用户填进原生表单的值只出现在 `submitConnection` 的那一次调用里——
 *    不进 `console`、不进 localStorage、不进 `GET /v1/connections` 的渲染结果，
 *    提交后连 DOM 里都不留；
 * 2. **向导**：OAuth 类走 `openExternal` + 轮询，表单类走原生 `<form>`，
 *    密码字段一定是 `type=password` + `autocomplete=off`；
 * 3. **状态条与列表**：absent / unhardened / ready 三种；连上之后有它，断开之后没有。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionView, ConnectTestResult, ProviderView, RuntimeStatusView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const PASSWORD = 'app-specific-Zq7-never-leaks'
const T0 = '2026-09-09T09:00:00.000Z'

const MAIL_PROVIDER: ProviderView = {
  service: 'imap_smtp',
  label: '任意邮箱（IMAP / SMTP）',
  auth: 'custom_credential',
  fields: [
    { name: 'email', label: '邮箱地址', secret: false, required: true, kind: 'email' },
    { name: 'password', label: '密码 / 应用专用密码', secret: true, required: true },
    { name: 'imap_host', label: '收信服务器（IMAP）', secret: false, required: true },
    { name: 'imap_port', label: '收信端口', secret: false, required: false, default: '993' },
  ],
  available: true,
  data_sources: [],
  setup_guide: {
    summary: '开一个应用专用密码就能收发信。',
    steps: ['打开 IMAP', '生成应用专用密码', '填进来'],
    links: [
      { label: 'Gmail 应用专用密码', url: 'https://support.google.com/accounts/answer/185833' },
    ],
  },
}

const GA4_PROVIDER: ProviderView = {
  service: 'ga4',
  label: 'Google Analytics 4',
  auth: 'oauth2',
  fields: [],
  available: true,
  data_sources: ['ga4'],
  data_note: '连上之后面板会亮；数据下一版接。',
  setup_guide: { summary: '用你自己的 Google 应用授权一次。', steps: ['启用 API'], links: [] },
}

const SHOP_PROVIDER: ProviderView = {
  service: 'shopify_admin',
  label: 'Shopify 店铺',
  auth: 'api_key',
  // WP44：只剩 Dev Dashboard 应用这一条接法（客户端 ID + 密钥）
  fields: [
    { name: 'shop_domain', label: '店铺域名', secret: false, required: true },
    { name: 'client_id', label: '客户端 ID', secret: false, required: true },
    { name: 'client_secret', label: '客户端密钥', secret: true, required: true },
  ],
  available: false,
  unavailable_reason: '本机还没有装 OpenConnector runtime',
  data_sources: ['shop'],
  setup_guide: { summary: '在 Dev Dashboard 里建一个应用。', steps: ['建应用'], links: [] },
}

/** WP44：升级上来的那条老连接——OpenConnector 里有它，我们这边没有它的客户端凭据。 */
const LEGACY_SHOP_CONNECTION: ConnectionView = {
  id: 'conn_old_shop',
  service: 'shopify_admin',
  service_label: 'Shopify 店铺',
  alias: '主店',
  ownership: 'workspace',
  status: 'active',
  credential_store: 'openconnector',
  data_sources: ['shop'],
  legacy: {
    kind: 'shopify_access_token',
    hint: '这家店当初是把 shpat_ 开头的访问令牌直接粘进来接的。断开它，再用「Dev Dashboard 应用（客户端 ID + 密钥）」重接一次。',
  },
}

const MAIL_CONNECTION: ConnectionView = {
  id: 'conn_mail_1',
  service: 'imap_smtp',
  service_label: '任意邮箱（IMAP / SMTP）',
  alias: 'default',
  ownership: 'workspace',
  status: 'active',
  identity: { display_name: 'support@yourbrand.com' },
  credential_store: 'local_vault',
  data_sources: [],
  last_tested_at: T0,
  last_test: { ok: true, reason: 'ok', checked_at: T0 },
}

const READY: RuntimeStatusView = {
  state: 'ready',
  base_url: 'http://127.0.0.1:3000',
  reasons: [],
  checks: [],
  checked_at: T0,
  secrets_vault: { available: true },
}

const OK_TEST: ConnectTestResult = { ok: true, reason: 'ok', checked_at: T0 }

// ── 假 API 层（真调用会被这里截住，方便断言"值往哪走了"）──────────────

const state = {
  connections: [] as ConnectionView[],
  providers: [MAIL_PROVIDER, GA4_PROVIDER, SHOP_PROVIDER] as ProviderView[],
  runtime: READY as RuntimeStatusView,
  pollStatus: 'connected' as 'initiated' | 'connected' | 'failed' | 'expired',
}

const OWNER_POSITION = {
  position_id: 'asg_owner',
  role_id: 'common.owner',
  role_name: '工作区所有者',
  ranges: [] as { kind: string; id: string }[],
  ready: true,
  missing_connectors: [] as string[],
  tile_ids: [] as string[],
  range: 'yesterday' as const,
  show_tiles: false,
}

/** 可变：有一条就是所有者，清空就用来测「不是所有者」那条路。 */
const ownerPositions: (typeof OWNER_POSITION)[] = []

const submitted: { service: string; fields: Record<string, string> }[] = []
const opened: string[] = []
const removed: string[] = []
const tested: string[] = []

vi.mock('@/components/connections/bridge', () => ({
  openExternal: (url: string) => {
    opened.push(url)
  },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    // 连接页用「工作区所有者」那条 Assignment（05 authorize_connector 是 owner 专属）
    getPositions: async () => ({
      positions: ownerPositions,
      tile_library: [],
      max_tiles: 6,
    }),
    listConnections: async () => ({ connections: state.connections }),
    listProviders: async () => ({ providers: state.providers }),
    getConnectRuntime: async () => state.runtime,
    beginConnect: async (service: string) => {
      const provider = state.providers.find((p) => p.service === service)
      if (provider?.auth === 'oauth2') {
        return { request_id: 'creq_1', authorization_url: 'https://accounts.google.com/o/oauth2/x' }
      }
      return { request_id: 'creq_2', secure_form: { fields: provider?.fields ?? [] } }
    },
    pollConnectRequest: async () => ({ status: state.pollStatus }),
    submitConnection: async (service: string, input: { fields: Record<string, string> }) => {
      submitted.push({ service, fields: input.fields })
      state.connections = [MAIL_CONNECTION]
      return { connection: MAIL_CONNECTION, test: OK_TEST }
    },
    testConnection: async (id: string) => {
      tested.push(id)
      return OK_TEST
    },
    removeConnection: async (id: string) => {
      removed.push(id)
      state.connections = []
      return { removed: true }
    },
  }
})

const { ConnectionsPage } = await import('@/pages/connections')

beforeEach(() => {
  ownerPositions.splice(0, ownerPositions.length, OWNER_POSITION)
  state.connections = []
  state.providers = [MAIL_PROVIDER, GA4_PROVIDER, SHOP_PROVIDER]
  state.runtime = READY
  state.pollStatus = 'connected'
  submitted.length = 0
  opened.length = 0
  removed.length = 0
  tested.length = 0
})

describe('连接页：只有工作区所有者能管', () => {
  it('不持有所有者岗位时说清楚，而不是给一页 403', async () => {
    ownerPositions.length = 0
    renderWithProviders(<ConnectionsPage />, '/connections')
    expect(await screen.findByTestId('connections-not-owner')).toBeDefined()
    expect(screen.queryByTestId('provider-card')).toBeNull()
  })
})

describe('连接页：目录与状态条', () => {
  it('一开始空清单 + 三张可连接的卡', async () => {
    renderWithProviders(<ConnectionsPage />, '/connections')
    expect(await screen.findByTestId('connections-empty')).toBeDefined()
    expect(screen.getAllByTestId('provider-card')).toHaveLength(3)
    expect(screen.getByTestId('runtime-bar').getAttribute('data-state')).toBe('ready')
  })

  it('「要准备什么」是折叠的，展开后是 ≤ 5 步 + 外链', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConnectionsPage />, '/connections')
    const card = (await screen.findAllByTestId('provider-card'))[0]
    expect(card).toBeDefined()
    expect(within(card as HTMLElement).queryByTestId('setup-steps')).toBeNull()
    await user.click(within(card as HTMLElement).getByRole('button', { name: /要准备什么/ }))
    const steps = within(card as HTMLElement).getByTestId('setup-steps')
    expect(steps.querySelectorAll('li').length).toBeLessThanOrEqual(5)
    const link = within(card as HTMLElement).getByRole('link', { name: /应用专用密码/ })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('连不了的 provider 说清楚为什么，按钮是禁用的', async () => {
    renderWithProviders(<ConnectionsPage />, '/connections')
    await screen.findAllByTestId('provider-card')
    const shop = screen
      .getAllByTestId('provider-card')
      .find((c) => c.getAttribute('data-service') === 'shopify_admin')
    expect(shop).toBeDefined()
    expect(within(shop as HTMLElement).getByTestId('provider-unavailable').textContent).toContain(
      'OpenConnector',
    )
    expect(
      within(shop as HTMLElement)
        .getByRole('button', { name: '连接' })
        .hasAttribute('disabled'),
    ).toBe(true)
  })

  it('runtime 没加固：红条 + 原因列出来', async () => {
    state.runtime = {
      state: 'unhardened',
      base_url: 'http://127.0.0.1:3000',
      reasons: ['encryption_disabled', 'admin_auth_disabled'],
      checks: [{ name: 'encryption', ok: false, detail: '没开静态加密' }],
      checked_at: T0,
      secrets_vault: { available: false, reason: '没设 AGENTSWS_SECRETS_KEY' },
    }
    renderWithProviders(<ConnectionsPage />, '/connections')
    const bar = await screen.findByTestId('runtime-bar')
    expect(bar.getAttribute('data-state')).toBe('unhardened')
    expect(within(bar).getByTestId('runtime-reasons').textContent).toContain('encryption_disabled')
    expect(within(bar).getByTestId('vault-missing')).toBeDefined()
  })

  it('?service= 高亮那一张卡', async () => {
    renderWithProviders(<ConnectionsPage />, '/connections?service=ga4')
    await screen.findAllByTestId('provider-card')
    const highlighted = screen
      .getAllByTestId('provider-card')
      .filter((c) => c.getAttribute('data-highlighted') === 'true')
    expect(highlighted).toHaveLength(1)
    expect(highlighted[0]?.getAttribute('data-service')).toBe('ga4')
  })
})

describe('连接页：原生表单直填（凭据零泄漏）', () => {
  it('密码字段是 password 输入框、关掉自动填充；提交只走 submitConnection', async () => {
    const user = userEvent.setup()
    const logs: unknown[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(...args)
      }),
    )
    renderWithProviders(<ConnectionsPage />, '/connections')
    await screen.findAllByTestId('provider-card')
    const mail = screen
      .getAllByTestId('provider-card')
      .find((c) => c.getAttribute('data-service') === 'imap_smtp') as HTMLElement
    await user.click(within(mail).getByRole('button', { name: '连接' }))

    const form = await within(mail).findByTestId('secure-form')
    const password = within(form).getByLabelText(/密码/) as HTMLInputElement
    expect(password.type).toBe('password')
    expect(password.getAttribute('autocomplete')).toBe('off')
    expect(password.getAttribute('data-secret')).toBe('true')
    expect((form as HTMLFormElement).getAttribute('autocomplete')).toBe('off')
    // 非秘密字段可以有默认值，秘密字段永远没有
    expect((within(form).getByLabelText(/收信端口/) as HTMLInputElement).value).toBe('993')
    expect(password.value).toBe('')

    await user.type(within(form).getByLabelText(/邮箱地址/), 'support@yourbrand.com')
    await user.type(password, PASSWORD)
    await user.type(within(form).getByLabelText(/收信服务器/), 'imap.gmail.com')
    await user.click(within(form).getByRole('button', { name: '保存并测试' }))

    await waitFor(() => {
      expect(submitted).toHaveLength(1)
    })
    // 值确实到了那一条请求上
    expect(submitted[0]?.service).toBe('imap_smtp')
    expect(submitted[0]?.fields.password).toBe(PASSWORD)

    // ── 零泄漏 ────────────────────────────────────────────────────
    // 1. 没有任何一条 console 输出提到它
    expect(JSON.stringify(logs)).not.toContain(PASSWORD)
    for (const spy of spies) spy.mockRestore()
    // 2. localStorage 里没有
    expect(JSON.stringify(globalThis.localStorage)).not.toContain(PASSWORD)
    // 3. 提交完表单关掉了，整页 DOM 里没有它
    await waitFor(() => {
      expect(within(mail).queryByTestId('secure-form')).toBeNull()
    })
    expect(document.body.innerHTML).not.toContain(PASSWORD)
    // 4. 连上之后的清单里也没有
    const row = await screen.findByTestId('connection-row')
    expect(row.textContent ?? '').not.toContain(PASSWORD)
    expect(screen.getByTestId('connection-identity').textContent).toBe('support@yourbrand.com')
  })

  it('必填项空着不会发出请求（交给浏览器自己拦）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConnectionsPage />, '/connections')
    await screen.findAllByTestId('provider-card')
    const mail = screen
      .getAllByTestId('provider-card')
      .find((c) => c.getAttribute('data-service') === 'imap_smtp') as HTMLElement
    await user.click(within(mail).getByRole('button', { name: '连接' }))
    const form = await within(mail).findByTestId('secure-form')
    await user.click(within(form).getByRole('button', { name: '保存并测试' }))
    expect(submitted).toHaveLength(0)
  })

  it('取消就把表单收起来，什么都不发', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConnectionsPage />, '/connections')
    await screen.findAllByTestId('provider-card')
    const mail = screen
      .getAllByTestId('provider-card')
      .find((c) => c.getAttribute('data-service') === 'imap_smtp') as HTMLElement
    await user.click(within(mail).getByRole('button', { name: '连接' }))
    await within(mail).findByTestId('secure-form')
    await user.click(within(mail).getByRole('button', { name: '取消' }))
    expect(within(mail).queryByTestId('secure-form')).toBeNull()
    expect(submitted).toHaveLength(0)
  })
})

describe('连接页：OAuth 向导', () => {
  it('点「去授权」打开对方网站，并进入等待态', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConnectionsPage />, '/connections')
    await screen.findAllByTestId('provider-card')
    const ga4 = screen
      .getAllByTestId('provider-card')
      .find((c) => c.getAttribute('data-service') === 'ga4') as HTMLElement
    // OAuth 类不出表单
    expect(within(ga4).queryByTestId('secure-form')).toBeNull()
    await user.click(within(ga4).getByRole('button', { name: '去授权' }))
    await within(ga4).findByTestId('oauth-waiting')
    expect(opened).toEqual(['https://accounts.google.com/o/oauth2/x'])
  })

  it('GA4 / GSC 这类先说清楚「数据下一版接」', async () => {
    renderWithProviders(<ConnectionsPage />, '/connections')
    await screen.findAllByTestId('provider-card')
    const ga4 = screen
      .getAllByTestId('provider-card')
      .find((c) => c.getAttribute('data-service') === 'ga4') as HTMLElement
    expect(within(ga4).getByTestId('provider-note').textContent).toContain('下一版')
  })
})

describe('连接页：已连接的两个动作', () => {
  it('测试：打一次 test，结果显示成人话', async () => {
    const user = userEvent.setup()
    state.connections = [
      { ...MAIL_CONNECTION, last_test: { ok: false, reason: 'bad_credentials', checked_at: T0 } },
    ]
    renderWithProviders(<ConnectionsPage />, '/connections')
    const row = await screen.findByTestId('connection-row')
    // 报错是人话，不是 EAUTH
    expect(within(row).getByTestId('test-result').textContent).toContain('密码不对')
    await user.click(within(row).getByRole('button', { name: /测试/ }))
    await waitFor(() => {
      expect(tested).toEqual(['conn_mail_1'])
    })
  })

  it('断开：要确认；确认后清单空了', async () => {
    const user = userEvent.setup()
    state.connections = [MAIL_CONNECTION]
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    renderWithProviders(<ConnectionsPage />, '/connections')
    const row = await screen.findByTestId('connection-row')
    await user.click(within(row).getByRole('button', { name: '断开' }))
    expect(removed).toEqual([])

    confirm.mockReturnValue(true)
    await user.click(within(row).getByRole('button', { name: '断开' }))
    await waitFor(() => {
      expect(removed).toEqual(['conn_mail_1'])
    })
    await waitFor(() => {
      expect(screen.getByTestId('connections-empty')).toBeDefined()
    })
    confirm.mockRestore()
  })
})

describe('WP44 Shopify：只有一条接法 + 老连接提示', () => {
  it('卡上不再有"接法"单选，也没有 shpat_ 那条老路', async () => {
    renderWithProviders(<ConnectionsPage />)
    const card = await screen.findByTestId('provider-card-shopify_admin').catch(async () => {
      const cards = await screen.findAllByTestId('provider-card')
      const hit = cards.find((c) => c.getAttribute('data-service') === 'shopify_admin')
      if (hit === undefined) throw new Error('没有 Shopify 卡')
      return hit
    })
    expect(within(card).queryByTestId('auth-options')).toBeNull()
    expect(card.textContent ?? '').not.toContain('shpat')
  })

  it('老办法接的那条连接：黄条提示"断开后重接一次"', async () => {
    state.connections = [LEGACY_SHOP_CONNECTION]
    renderWithProviders(<ConnectionsPage />)
    const badge = await screen.findByTestId('connection-legacy')
    expect(badge.getAttribute('data-legacy-kind')).toBe('shopify_access_token')
    expect(badge.textContent ?? '').toContain('老办法接的')
    expect(badge.textContent ?? '').toContain('Dev Dashboard 应用')
  })

  it('正常接的连接不出这条黄条', async () => {
    state.connections = [MAIL_CONNECTION]
    renderWithProviders(<ConnectionsPage />)
    await screen.findByTestId('connection-row')
    expect(screen.queryByTestId('connection-legacy')).toBeNull()
  })
})

describe('WP44 状态条：代理 fake-IP 说人话', () => {
  it('fake_ip_detected → 黄条说清楚两条修法，并念出信任名单', async () => {
    state.runtime = {
      ...READY,
      egress: {
        fake_ip_detected: true,
        trusted_hosts: ['admin.shopify.com'],
        detail: 'api.deepseek.com 解析到了保留网段地址 198.18.0.7',
      },
    }
    renderWithProviders(<ConnectionsPage />)
    const bar = await screen.findByTestId('egress-fake-ip')
    const text = bar.textContent ?? ''
    expect(text).toContain('fake-IP')
    expect(text).toContain('公共 DNS')
    expect(text).toContain('admin.shopify.com')
    expect(text).toContain('198.18.0.7')
  })

  it('没检测到就不出这条黄条（别吓人）', async () => {
    state.runtime = { ...READY, egress: { fake_ip_detected: false, trusted_hosts: [] } }
    renderWithProviders(<ConnectionsPage />)
    await screen.findByTestId('runtime-bar')
    expect(screen.queryByTestId('egress-fake-ip')).toBeNull()
  })
})
