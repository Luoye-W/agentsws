/**
 * 连接目录与岗位连接清单的界面（WP83，54（将改号 55）§4 前两层）。
 *
 * 三组断言：
 * 1. **岗位卡**：并集 − 已连；`required` 没连时标"未就绪"；"还没做"不给按钮；
 *    一条不缺时整张卡不出现。
 * 2. **添加连接**：默认收起（不把整表铺在首页）、打开后按分类分组、搜索管用。
 * 3. **自定义 MCP**：原生 `<form>`，请求头的值只走 `saveMcpServer` 那一次调用——
 *    不进 `console`、不进 localStorage、提交后 DOM 里也不留（13 §4.3）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionDirectorySection } from '@/components/connections/directory'
import { PositionConnections } from '@/components/connections/position-connections'
import type { ConnectionDirectoryItem, McpServerRecord, PositionConnectionsView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-16T09:00:00.000Z'
/** 这个用例里唯一的"凭据"。零泄漏断言全盯着这一串。 */
const MCP_TOKEN = 'Bearer mcp-Zq7-never-leaks'

/**
 * 造一条目录项。默认那一份**不带** `service` / `connect_service`——"这一条还没有卡"
 * 是目录里的正经状态（`planned` 的多数是这种），而全仓开着 `exactOptionalPropertyTypes`，
 * 显式写 `service: undefined` 过不了检查。要卡的那几条自己填上。
 */
const entry = (over: Partial<ConnectionDirectoryItem>): ConnectionDirectoryItem => ({
  kind: 'email',
  name: { zh: '邮箱', en: 'Mailbox' },
  category: 'mailbox',
  auth: 'password',
  mode: 'openconnector_provider',
  fields: [],
  side_effect: 'write_external',
  status: 'available',
  state: 'not_connected',
  ...over,
})

const DIRECTORY: ConnectionDirectoryItem[] = [
  entry({ service: 'imap_smtp', connect_service: 'imap_smtp' }),
  entry({
    kind: 'shopify',
    name: { zh: 'Shopify 店铺', en: 'Shopify' },
    category: 'storefront',
    service: 'shopify_admin',
    connect_service: 'shopify_admin',
    state: 'connected',
  }),
  entry({
    kind: 'ga4',
    name: { zh: 'Google Analytics 4', en: 'Google Analytics 4' },
    category: 'analytics',
    side_effect: 'read_external',
    service: 'ga4',
    connect_service: 'ga4',
    state: 'error',
    state_detail: '要重新授权',
  }),
  entry({
    kind: 'wechat_clawbot',
    name: { zh: '个人微信（ClawBot）', en: 'Personal WeChat' },
    category: 'im',
    auth: 'qr',
    mode: 'channel_adapter',
    status: 'planned',
    docs_url: '/im-channels',
    note: { zh: '只做本人 ↔ 自己的代理。', en: 'You to your own agent only.' },
  }),
  entry({
    kind: 'mcp_server',
    name: { zh: '自定义 MCP 服务器', en: 'Custom MCP server' },
    category: 'custom',
    auth: 'none',
    mode: 'mcp_server',
  }),
]

const CHECKLIST: PositionConnectionsView = {
  position_id: 'customer-care',
  position_name: '客服',
  ready: false,
  missing_required: ['email'],
  items: [
    {
      kind: 'email',
      name: { zh: '邮箱', en: 'Mailbox' },
      required: true,
      connected: false,
      needed_by: ['网站售后客服', 'Amazon 客服'],
      status: 'available',
      connect_service: 'imap_smtp',
    },
    {
      kind: 'tracking',
      name: { zh: '物流追踪', en: 'Shipment tracking' },
      required: false,
      connected: false,
      needed_by: ['网站售后客服'],
      status: 'planned',
      note: { zh: '还没接：只读轨迹那一块先空着。', en: 'Not wired yet.' },
    },
  ],
}

const state = {
  directory: DIRECTORY,
  checklist: CHECKLIST as PositionConnectionsView | { items: [] },
  servers: [] as McpServerRecord[],
}
const saved: {
  name: string
  headers?: Record<string, string>
}[] = []
const probed: string[] = []
const removedServers: string[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getConnectionDirectory: async () => ({ entries: state.directory }),
    getPositionConnections: async () => state.checklist,
    listMcpServers: async () => ({ servers: state.servers }),
    saveMcpServer: async (input: {
      name: string
      transport: 'stdio' | 'streamable-http'
      command?: string
      headers?: Record<string, string>
    }) => {
      saved.push({
        name: input.name,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      })
      const row: McpServerRecord = {
        name: input.name,
        transport: input.transport,
        ...(input.command === undefined ? {} : { command: input.command }),
        header_names: Object.keys(input.headers ?? {}),
        probe: { ok: true, at: T0, tools: [{ name: 'echo' }] },
        created_at: T0,
        updated_at: T0,
      }
      state.servers = [row]
      return row
    },
    probeMcpServer: async (name: string) => {
      probed.push(name)
      return state.servers[0] as McpServerRecord
    },
    removeMcpServer: async (name: string) => {
      removedServers.push(name)
      state.servers = []
      return { removed: true }
    },
  }
})

beforeEach(() => {
  state.directory = DIRECTORY
  state.checklist = CHECKLIST
  state.servers = []
  saved.length = 0
  probed.length = 0
  removedServers.length = 0
})

describe('岗位页那张「连上这 N 个就能开工」的卡', () => {
  it('列出并集里还没连的，必需的标出来，未就绪也标出来', async () => {
    renderWithProviders(<PositionConnections id="customer-care" />)
    await screen.findByTestId('position-connections')
    expect(screen.getByText('连上这 2 个就能开工')).toBeTruthy()
    expect(screen.getByTestId('position-not-ready')).toBeTruthy()
    const items = screen.getAllByTestId('position-connection-item')
    expect(items.map((el) => el.getAttribute('data-kind'))).toEqual(['email', 'tracking'])
    // 说的是职责名字，不出 id（36 §2）
    expect(within(items[0] as HTMLElement).getByText(/网站售后客服/)).toBeTruthy()
    expect(screen.queryByText(/dtc\./)).toBeNull()
  })

  it('"还没做"的那一条不给按钮，只照实说一句（36 §3）', async () => {
    renderWithProviders(<PositionConnections id="customer-care" />)
    await screen.findByTestId('position-connections')
    const items = screen.getAllByTestId('position-connection-item')
    const tracking = items[1] as HTMLElement
    expect(within(tracking).queryByTestId('position-connection-go')).toBeNull()
    expect(within(tracking).getByTestId('position-connection-planned')).toBeTruthy()
    expect(within(tracking).getByTestId('position-connection-note').textContent).toContain('还没接')
    // 能连的那一条一键跳到那张安全表单上
    const email = items[0] as HTMLElement
    expect(within(email).getByTestId('position-connection-go').getAttribute('href')).toBe(
      '/connections?service=imap_smtp',
    )
  })

  it('一条不缺时整张卡不出现（不是出一张"都连好了"）', async () => {
    state.checklist = { ...CHECKLIST, ready: true, missing_required: [], items: [] }
    const { container } = renderWithProviders(<PositionConnections id="customer-care" />)
    await waitFor(() => {
      expect(screen.queryByTestId('position-connections')).toBeNull()
    })
    expect(container.textContent).toBe('')
  })
})

describe('连接页的「添加连接」', () => {
  it('默认收起来——不把整表铺在首屏', async () => {
    renderWithProviders(<ConnectionDirectorySection assignment="asg_owner" />)
    expect(screen.getByTestId('directory-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('directory-entry')).toBeNull()
  })

  it('打开之后按分类分组，每条带已连 / 未连 / 出错', async () => {
    renderWithProviders(<ConnectionDirectorySection assignment="asg_owner" />)
    await userEvent.click(screen.getByTestId('directory-toggle'))
    await screen.findByTestId('directory-search')
    const categories = screen
      .getAllByTestId('directory-category')
      .map((el) => el.getAttribute('data-category'))
    // 顺序照契约的分类表：店铺在邮箱前面
    expect(categories).toEqual(['storefront', 'mailbox', 'analytics', 'im', 'custom'])
    const byKind = (kind: string): HTMLElement =>
      screen
        .getAllByTestId('directory-entry')
        .find((el) => el.getAttribute('data-kind') === kind) as HTMLElement
    expect(byKind('shopify').getAttribute('data-state')).toBe('connected')
    expect(byKind('ga4').getAttribute('data-state')).toBe('error')
    expect(within(byKind('ga4')).getByTestId('directory-state-detail').textContent).toBe(
      '要重新授权',
    )
    // 已连的那一条按钮说"去管理"，没连的说"去连接"
    expect(within(byKind('shopify')).getByTestId('directory-go').textContent).toBe('去管理')
    expect(within(byKind('email')).getByTestId('directory-go').getAttribute('href')).toBe(
      '/connections?service=imap_smtp',
    )
  })

  it('还没做的标出来、指到那一页；不露原始 id（36）', async () => {
    renderWithProviders(<ConnectionDirectorySection assignment="asg_owner" />)
    await userEvent.click(screen.getByTestId('directory-toggle'))
    const wechat = (await screen.findAllByTestId('directory-entry')).find(
      (el) => el.getAttribute('data-kind') === 'wechat_clawbot',
    ) as HTMLElement
    expect(within(wechat).getByTestId('directory-planned')).toBeTruthy()
    expect(within(wechat).getByTestId('directory-route').getAttribute('href')).toBe('/im-channels')
    // 目录说的是"哪一类东西"，不出店铺域名 / 账号 id
    expect(document.body.textContent).not.toContain('myshopify.com')
  })

  it('搜索只留匹配的；一个都不剩时说一句', async () => {
    renderWithProviders(<ConnectionDirectorySection assignment="asg_owner" />)
    await userEvent.click(screen.getByTestId('directory-toggle'))
    const box = await screen.findByTestId('directory-search')
    await userEvent.type(box, 'shopify')
    await waitFor(() => {
      expect(screen.getAllByTestId('directory-entry')).toHaveLength(1)
    })
    await userEvent.clear(box)
    await userEvent.type(box, '没有这个东西')
    await waitFor(() => {
      expect(screen.getByTestId('directory-empty')).toBeTruthy()
    })
  })
})

describe('自定义 MCP 服务器（凭据零泄漏）', () => {
  const openForm = async (): Promise<void> => {
    renderWithProviders(<ConnectionDirectorySection assignment="asg_owner" />)
    await userEvent.click(screen.getByTestId('directory-toggle'))
    await screen.findByTestId('mcp-servers')
    await userEvent.click(screen.getByTestId('mcp-add'))
    await screen.findByTestId('mcp-form')
  }

  it('请求头的值只走 saveMcpServer 那一次调用，DOM / console / localStorage 都不留', async () => {
    const logs: string[] = []
    for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      })
    await openForm()
    await userEvent.type(screen.getByLabelText('名字'), 'my-tools')
    await userEvent.type(screen.getByLabelText('命令'), 'npx')
    await userEvent.type(screen.getByLabelText('参数'), '-y some-server')
    await userEvent.type(screen.getByLabelText('请求头'), `Authorization: ${MCP_TOKEN}`)
    await userEvent.click(screen.getByTestId('mcp-save'))

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0]?.headers).toEqual({ Authorization: MCP_TOKEN })
    // 提交完表单自己清空——DOM 里也不留
    await waitFor(() => {
      expect(document.body.innerHTML).not.toContain(MCP_TOKEN)
    })
    expect(logs.join('\n')).not.toContain(MCP_TOKEN)
    expect(JSON.stringify(globalThis.localStorage)).not.toContain(MCP_TOKEN)
    vi.restoreAllMocks()
  })

  it('登记过的列出来：只说存了哪几个头的名字，不说值', async () => {
    state.servers = [
      {
        name: 'my-tools',
        transport: 'stdio',
        command: 'npx',
        header_names: ['Authorization'],
        probe: { ok: true, at: T0, tools: [{ name: 'echo' }, { name: 'add' }] },
        created_at: T0,
        updated_at: T0,
      },
    ]
    renderWithProviders(<ConnectionDirectorySection assignment="asg_owner" />)
    await userEvent.click(screen.getByTestId('directory-toggle'))
    const row = await screen.findByTestId('mcp-row')
    expect(within(row).getByTestId('mcp-tools').textContent).toContain('2 个工具')
    expect(row.textContent).toContain('Authorization')
    expect(row.textContent).not.toContain(MCP_TOKEN)
  })

  it('连不上的照实说，不假装成功', async () => {
    state.servers = [
      {
        name: 'broken',
        transport: 'stdio',
        command: 'nope',
        header_names: [],
        probe: { ok: false, at: T0, tools: [], reason: 'probe_failed', detail: '连接超时' },
        created_at: T0,
        updated_at: T0,
      },
    ]
    renderWithProviders(<ConnectionDirectorySection assignment="asg_owner" />)
    await userEvent.click(screen.getByTestId('directory-toggle'))
    const row = await screen.findByTestId('mcp-row')
    expect(within(row).getByTestId('mcp-failed').textContent).toBe('连接超时')
    await userEvent.click(within(row).getByTestId('mcp-probe'))
    await waitFor(() => {
      expect(probed).toEqual(['broken'])
    })
  })

  it('删掉要先问一句（凭据也一起删）', async () => {
    state.servers = [
      {
        name: 'my-tools',
        transport: 'stdio',
        command: 'npx',
        header_names: [],
        created_at: T0,
        updated_at: T0,
      },
    ]
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    renderWithProviders(<ConnectionDirectorySection assignment="asg_owner" />)
    await userEvent.click(screen.getByTestId('directory-toggle'))
    const row = await screen.findByTestId('mcp-row')
    await userEvent.click(within(row).getByTestId('mcp-remove'))
    expect(removedServers).toEqual([])
    confirm.mockReturnValue(true)
    await userEvent.click(within(row).getByTestId('mcp-remove'))
    await waitFor(() => {
      expect(removedServers).toEqual(['my-tools'])
    })
    confirm.mockRestore()
  })

  it('streamable-http 换成地址那一格（命令那两格收起来）', async () => {
    await openForm()
    expect(screen.getByLabelText('命令')).toBeTruthy()
    await userEvent.click(screen.getByTestId('mcp-transport-streamable-http'))
    expect(screen.queryByLabelText('命令')).toBeNull()
    expect(screen.getByLabelText('地址')).toBeTruthy()
  })
})
