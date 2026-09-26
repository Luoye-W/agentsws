/**
 * WP157：**界面减字守卫第二轮**——连接页、消息渠道、网站聊天窗（岗位页与职责面板在
 * `less-text-panels.test.tsx`）。量法、上限与 WP156 的 `less-text.test.tsx` 同一套
 * （`less-text-guard.ts`：每张卡可见说明 ≤ 60、没有 `<ol>` 步骤清单、参考外链 ≤ 1、
 * 安全承诺 / 风险提示压到一句 ≤ 40）。拆成单独的文件只因为假 API 层不一样
 * （设置页那份故意不给所有者岗位，连接页必须有）。
 *
 * provider 卡的夹具：服务端连接目录的 29 个 service，每张都塞一段 190 字的长介绍、
 * 一段「连上之后」、五步与两个外链（照 `catalog.ts` 里最长的那几张）——守的就是
 * "服务端给了，卡上也不铺"。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StandbyWizard } from '@/components/connections/standby-wizard'
import type { ConnectionDirectoryItem, ProviderView, RuntimeStatusView } from '@/lib/api'
import { HELP_BY_SERVICE } from '@/lib/help'
import { translate } from '@/lib/i18n'
import { ChatWindowPage } from '@/pages/chat-window'
import { ConnectionsPage } from '@/pages/connections'
import { ImChannelsPage } from '@/pages/im-channels'
import { renderWithProviders } from './helpers'
import { CARD_TEXT_LIMIT, type CardReport, reportCard } from './less-text-guard'

// ── 夹具 ────────────────────────────────────────────────────────────

const LONG_SUMMARY =
  '**三条规矩都是 Meta 的，不是我们的**：要过商业验证；主动发消息只能用审批过的模板（`template.name` 必填），且收件人必须先 opt-in；对方来过消息之后才有 24 小时窗口能自由回复。违反了封的是这个品牌的号——所以少模板名或没核过 opt-in 时我们当场 block，不是让你点一下就发。'
const LONG_NOTE =
  '没有它这条职责照样能用：找人靠导入你手上那张表与公共红人库，建联、合作、审核、归因一样不少。同一把 key 也供社媒运营的 YouTube 那条职责——连一次，两处都亮。'
const STEPS = [
  '打开 Google Cloud 控制台，新建（或选一个）项目',
  '在「API 和服务 → 库」里启用 YouTube Data API v3',
  '到「凭据」页点「创建凭据 → API 密钥」，复制那串密钥',
  '（建议）给这把密钥加限制：只允许 YouTube Data API v3',
  '把密钥填进下面的表单——只存在这台电脑上',
]
const DOCKER_REASON =
  '这张需要 Docker（可选）：它的账号凭据存在本机的连接器 runtime 里，那一份要用 Docker 起。不装也没关系——模型、邮箱、红人、社媒这些都不经它。'
const PLANNED_REASON =
  '还没接：连接目录、只读动作与表单已经就位，真调用还没做。在此之前邮件营销面板的自动流与效果两块照实说"还没连"，不出编出来的数字。'

/** 目录里登记着、还没做的那三张（服务端 `PLANNED_CONNECTORS`）。 */
const PLANNED_SERVICES = ['press_distribution', 'judgeme', 'loox']
const CATALOG_PLANNED = ['klaviyo', 'shopify_email', 'aftership', 'track17', 'x_ads', 'tiktok_ads']
const OAUTH = ['gmail', 'ga4', 'gsc', 'meta_ads']

const PROVIDERS: ProviderView[] = [...Object.keys(HELP_BY_SERVICE), ...PLANNED_SERVICES].map(
  (service, i): ProviderView => {
    const planned = PLANNED_SERVICES.includes(service)
    const catalogPlanned = CATALOG_PLANNED.includes(service)
    // 一半能连、四分之一要 Docker、其余是还没做的
    const reason = planned
      ? LONG_NOTE
      : catalogPlanned
        ? PLANNED_REASON
        : i % 4 === 3
          ? DOCKER_REASON
          : undefined
    return {
      service,
      label: service,
      auth: OAUTH.includes(service) ? 'oauth2' : 'api_key',
      fields: [],
      available: reason === undefined,
      ...(reason === undefined ? {} : { unavailable_reason: reason }),
      ...(planned ? { planned: true } : {}),
      data_sources: [],
      data_note: LONG_NOTE,
      setup_guide: planned
        ? { summary: LONG_NOTE, steps: [], links: [] }
        : {
            summary: LONG_SUMMARY,
            steps: STEPS,
            links: [
              { label: '控制台', url: 'https://console.example' },
              { label: '配额说明', url: 'https://docs.example/quota' },
            ],
          },
    }
  },
)

const RUNTIME: RuntimeStatusView = {
  state: 'absent',
  reasons: [],
  checks: [],
  checked_at: '2026-09-26T09:00:00.000Z',
  secrets_vault: { available: true },
  egress: {
    fake_ip_detected: true,
    trusted_hosts: ['admin.shopify.com'],
    detail: 'api.deepseek.com 解析到了保留网段地址 198.18.0.7',
  },
}

const DIRECTORY: ConnectionDirectoryItem[] = [
  ['press_distribution', 'pr', 'planned'],
  ['google_alerts', 'pr', 'available'],
  ['whatsapp_business', 'social', 'available'],
  ['mcp_server', 'custom', 'available'],
].map(
  ([kind, category, status]): ConnectionDirectoryItem => ({
    kind: kind as string,
    name: { zh: kind as string, en: kind as string },
    category: category as string,
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: [],
    side_effect: 'write_external',
    status: status as 'available' | 'planned',
    note: { zh: LONG_SUMMARY, en: LONG_SUMMARY },
    state: 'not_connected',
    ...(status === 'available' ? { connect_service: kind as string } : {}),
  }),
)

vi.mock('@/components/connections/bridge', () => ({ openExternal: () => undefined }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    // 连接页：所有者岗位
    getPositions: async () => ({
      positions: [
        {
          position_id: 'asg_owner',
          role_id: 'common.owner',
          role_name: '工作区所有者',
          ranges: [],
          ready: true,
          missing_connectors: [],
          tile_ids: [],
          range: 'yesterday',
          show_tiles: false,
        },
      ],
      tile_library: [],
      max_tiles: 6,
    }),
    getConnectRuntime: async () => RUNTIME,
    listProviders: async () => ({ providers: PROVIDERS }),
    listConnections: async () => ({
      connections: [
        {
          id: 'conn_mail_1',
          service: 'imap_smtp',
          service_label: '任意邮箱（IMAP / SMTP）',
          alias: 'default',
          ownership: 'workspace',
          status: 'active',
          identity: { display_name: 'support@nordvolt.example' },
          credential_store: 'local_vault',
          data_sources: [],
          last_tested_at: '2026-09-26T09:00:00.000Z',
          last_test: { ok: true, reason: 'ok', checked_at: '2026-09-26T09:00:00.000Z' },
        },
      ],
    }),
    listDeadLetters: async () => ({ dead_letters: [] }),
    getConnectionDirectory: async () => ({ entries: DIRECTORY }),
    listMcpServers: async () => ({
      servers: [
        {
          name: 'erp',
          transport: 'streamable-http',
          url: 'https://erp.example/mcp',
          created_at: '2026-09-20T09:00:00.000Z',
          updated_at: '2026-09-20T09:00:00.000Z',
          header_names: ['Authorization'],
          read_tools: [],
          probe: {
            ok: true,
            tools: [{ name: 'list_orders' }, { name: 'refund' }],
            at: '2026-09-26T09:00:00.000Z',
          },
        },
      ],
    }),
    getCapabilitySources: async () => ({ workspace_id: 'ws_1', capability_sources: {} }),
    getKolByoSources: async () => ({ rows: [] }),
    getSearchDataSettings: async () => ({
      choice: 'official',
      status: { configured: true, route: 'official' },
    }),
    listExtensionTokens: async () => ({
      tokens: [
        {
          id: 'ext_1',
          label: 'Chrome · 办公室',
          extension_id: 'abcdefghijklmnop',
          created_at: '2026-09-20T09:00:00.000Z',
          last_used_at: '2026-09-25T09:00:00.000Z',
        },
      ],
    }),
    createExtensionPairing: async () => ({ code: '482913', expires_at: '2099-01-01T00:00:00Z' }),
    getStorage: async () => ({
      tier: 'local',
      database: { kind: 'sqlite', display: '/data', bytes: 2_400_000 },
      blobs: {
        kind: 'local',
        display: '/data/blobs',
        bytes: 51_000_000,
        objects: 12,
        encrypted: true,
      },
      last_backup_at: '2026-09-09T22:00:00.000Z',
      env: [],
      compose_url: 'https://github.com/Luoye-W/agentsws/blob/main/docker-compose.yml',
    }),
    getStandby: async () => ({ linked: true, remote: false, seat_price: 30 }),
    getCloudCredits: async () => ({
      linked: true,
      month_credits: 12,
      fetched_at: '2026-09-26T09:00:00.000Z',
      balance: {
        org_id: 'org_1',
        purchased: 80,
        granted: 10,
        available: 90,
        reserved: 0,
        expiring: [],
        low_balance_threshold: 5,
        low_balance: false,
        at: '2026-09-26T09:00:00.000Z',
      },
    }),
    // 消息渠道
    getImStatus: async () => ({
      wechat: { bound: false, live: false, allowed: true },
      wecom: { configured: false, connected: false },
    }),
    // 聊天窗
    getChatWidgetSettings: async () => ({ allowed_origins: ['https://shop.example.com'] }),
    getChatRelaySettings: async () => ({
      endpoint: 'https://relay.example.com/relay/ws_x',
      has_pairing_token: true,
      has_message_key: false,
      configured: true,
    }),
    getChatRelayStatus: async () => ({ state: 'online', online: true }),
    listChatSessions: async () => [],
    getChatRelayHosted: async () => ({
      available: true,
      linked: true,
      subscription: { status: 'none' },
    }),
  }
})

// ── 量 ──────────────────────────────────────────────────────────────

const found: { name: string; report: CardReport }[] = []

function check(name: string, card: Element): void {
  const report = reportCard(card)
  found.push({ name, report })
  expect(
    report.weight,
    `「${name}」可见说明 ${report.weight} 字 > ${CARD_TEXT_LIMIT}：${report.text}`,
  ).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
  expect(report.ordered, `「${name}」里还有步骤清单 <ol>`).toBe(0)
  expect(
    report.externalLinks.length,
    `「${name}」外链 ${report.externalLinks.join(' ')}`,
  ).toBeLessThanOrEqual(1)
  expect(report.longSafety, `「${name}」安全承诺没压到一句`).toEqual([])
}

describe('连接页', () => {
  it('页头、状态条、已连接、目录（展开）、搜索数据、浏览器插件、数据后端：每一块都不超', async () => {
    renderWithProviders(<ConnectionsPage />, '/connections')
    const page = await screen.findByTestId('connections-page')
    check('连接 · 页头', page.querySelector('header') as Element)
    check('连接 · 状态条（没装 + fake-IP）', screen.getByTestId('runtime-bar'))
    check('连接 · 已连接一行', await screen.findByTestId('connection-row'))
    fireEvent.click(screen.getByTestId('directory-toggle'))
    const rows = await screen.findAllByTestId('directory-entry')
    for (const row of rows) check(`连接 · 目录 · ${row.getAttribute('data-kind') ?? ''}`, row)
    check('连接 · 自定义 MCP', await screen.findByTestId('mcp-servers'))
    check('连接 · 搜索数据', await screen.findByTestId('search-data'))
    const ext = screen.getByTestId('extension-section')
    await within(ext).findByTestId('extension-tokens')
    check('连接 · 浏览器插件', ext)
    fireEvent.click(screen.getByTestId('extension-generate'))
    await within(ext).findByTestId('extension-code')
    check('连接 · 浏览器插件（码在屏幕上）', ext)
    expect(within(ext).getByTestId('tutorial-link').getAttribute('data-slug')).toBe(
      'browser-extension',
    )
    check('连接 · 数据后端', await screen.findByTestId('data-backend'))
  })

  it('provider 卡：29 张每张都不超、不铺步骤与外链；认得的都有一句词条和「看教程」', async () => {
    renderWithProviders(<ConnectionsPage />, '/connections')
    const cards = await screen.findAllByTestId('provider-card')
    expect(cards).toHaveLength(PROVIDERS.length)
    for (const card of cards) {
      const service = card.getAttribute('data-service') ?? ''
      check(`连接 · 卡 · ${service}`, card)
      for (const step of STEPS) expect(card.textContent, service).not.toContain(step)
      expect(card.textContent, service).not.toContain('三条规矩都是 Meta 的')
      expect(translate('zh', `connections.line.${service}`), `${service} 没有一句话词条`).not.toBe(
        `connections.line.${service}`,
      )
      expect(translate('en', `connections.line.${service}`), `${service} 没有英文那一句`).not.toBe(
        translate('zh', `connections.line.${service}`),
      )
      const slug = HELP_BY_SERVICE[service]
      if (slug !== undefined)
        expect(card.querySelector('[data-testid="tutorial-link"]')?.getAttribute('data-slug')).toBe(
          slug,
        )
    }
  })
})

describe('连接页 · 值守向导（数据后端的托管档里）', () => {
  it('关联过账号、还没开：不超', async () => {
    const { container } = renderWithProviders(
      <StandbyWizard assignment="asg_owner" onGoToAccount={() => {}} />,
    )
    await waitFor(() => {
      expect(container.textContent).not.toBe('')
    })
    await screen.findByTestId('standby-step-open')
    check('值守向导', screen.getByTestId('storage-standby'))
  })
})

describe('消息渠道', () => {
  it('页头、微信卡、企业微信卡：不超；安全承诺各压一句；页头能开教程', async () => {
    const { container } = renderWithProviders(<ImChannelsPage />)
    await screen.findByText('微信（你自己的）')
    const cards = [...container.querySelectorAll('[data-slot="card"]')]
    expect(cards).toHaveLength(2)
    check('消息渠道 · 页头', container.querySelector('h1')?.parentElement as Element)
    check('消息渠道 · 微信', cards[0] as Element)
    check('消息渠道 · 企业微信', cards[1] as Element)
    expect(screen.getByTestId('tutorial-link').getAttribute('data-slug')).toBe('im-channels')
    // 从卡上拿下来的三条「它不做的事」都在安全承诺旁的问号里
    const hints = [...container.querySelectorAll('[data-slot="hint"]')]
      .map((h) => h.getAttribute('data-hint') ?? '')
      .join(' ')
    for (const key of ['im.wechat.not.colleagues', 'im.wechat.not.group', 'im.wechat.not.approve'])
      expect(hints).toContain(translate('zh', key))
  })
})

describe('网站聊天窗', () => {
  it('外观、转发方式、预览、对话：每张卡都不超；扣钱的提示看得见', async () => {
    const { container } = renderWithProviders(<ChatWindowPage />)
    await screen.findByTestId('chat-window-page')
    await screen.findByTestId('relay-hosted')
    const cards = [...container.querySelectorAll('[data-slot="card"]')]
    expect(cards.length).toBeGreaterThanOrEqual(3)
    for (const [i, card] of cards.entries()) check(`聊天窗 · 卡 ${String(i + 1)}`, card)
    expect(screen.getByTestId('relay-hosted').textContent).toContain('30 积分 / 月')
    expect(screen.getByTestId('relay-mode').textContent).toContain('每月 200 个对话')
    expect(screen.getByTestId('tutorial-link').getAttribute('data-slug')).toBe('chat-window')
  })
})

describe('量出来的数（给下一轮看的）', () => {
  it('打一张表到控制台（不断言）', () => {
    for (const { name, report } of found)
      console.info(`[less-text] ${String(report.weight).padStart(3)} 字  ${name}`)
    expect(true).toBe(true)
  })
})
