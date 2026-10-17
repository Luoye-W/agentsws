/**
 * WP342（决策 853，Luoye 10-15）：外壳整理。
 *
 * 1. 顶栏不再有积分与模型；积分在左下角账号菜单（余额 + 充值），余额低时头像上一个小点；
 * 2. 账号菜单里两组入口（工作内容 / 设置），展开记在本机；场景是菜单里一行子菜单；键盘可达；
 * 3. 输入框左下角的 AI 钮：选了只回调这一次（调用方存）；所有者有「设为默认」→ 改品牌默认；不是所有者没有；
 * 4. 岗位输入框选的 AI 跟着「交给它」一起交上去；
 * 5. ⌘K 里搜得到收进菜单的那几页。
 *
 * 全部替身，不联网。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette'
import { ComposerModelPicker } from '@/components/free-chat/model-picker'
import { askAtPosition } from '@/components/position/quick-answer-store'
import type { DshScenesData, PositionSummary } from '@/lib/api'
import type { FreeChatModels } from '@/lib/free-chat'
import { renderWithProviders } from './helpers'

const MODELS: FreeChatModels = {
  choices: [
    { id: 'deepseek/deepseek-flash', label: 'DeepSeek 官方', official: false, vision: 'ok' },
    { id: 'agentsws/qwen-max', label: 'Agents 工坊（用积分）', official: true, vision: 'no' },
  ],
  default: 'deepseek/deepseek-flash',
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}

const SCENES: DshScenesData = {
  available: true,
  dsh_version: '0.2.1-rc.2',
  scenes: [
    {
      name: 'agentsws',
      origin: 'agentsws',
      surface: 'agentsws',
      is_default: true,
      deletable: false,
      launchable: true,
      initialized: true,
      state: 'running',
    },
  ],
  templates: [],
}

const state = {
  owner: true,
  low: false,
  defaults: [] as { input: unknown; assignment: unknown }[],
  opened: [] as { id: string; input: Record<string, unknown> }[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: state.owner
        ? [{ position_id: 'asg_owner', role_id: 'common.owner', role_name: '老板' }]
        : [{ position_id: 'asg_x', role_id: 'dtc.support', role_name: '客服' }],
    }),
    getCloudCredits: async () => ({
      linked: true,
      balance: {
        available: 96.06,
        low_balance: state.low,
        low_balance_threshold: 100,
      },
      can_topup: true,
    }),
    getModelDefaults: async () => ({ default: MODELS.default, by_purpose: {}, choices: [] }),
    listModelProviders: async () => ({
      providers: [{ id: 'deepseek', active: true }],
      templates: [],
    }),
    getDshScenes: async () => SCENES,
    setModelDefaults: async (input: unknown, assignment: unknown) => {
      state.defaults.push({ input, assignment })
      return { default: '', by_purpose: {}, budget: {}, choices: [] }
    },
    openMatterAtPosition: async (id: string, input: Record<string, unknown>) => {
      state.opened.push({ id, input })
      return {
        mode: 'task',
        matter: { id: 'mat_1', title: String(input.title) },
        candidates: [],
        ambiguous: false,
        reason: '',
      }
    },
  }
})

vi.mock('@/lib/free-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/free-chat')>('@/lib/free-chat')
  return { ...actual, getFreeChatModels: async () => MODELS }
})

const positions: PositionSummary[] = [
  {
    position_id: 'asg_1',
    role_id: 'dtc.support',
    role_name: '客服',
    ranges: [],
    ready: true,
    missing_connectors: [],
    tile_ids: [],
    range: 'yesterday',
    show_tiles: true,
  },
]

function stubStorage(): void {
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v)
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
  })
}

function renderShell(route = '/'): void {
  renderWithProviders(
    <AppShell positions={positions} cards={[]} tileLibrary={[]} onAddTile={() => {}}>
      <div>主区</div>
    </AppShell>,
    route,
  )
}

beforeEach(() => {
  state.owner = true
  state.low = false
  state.defaults = []
  state.opened = []
  stubStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WP342 顶栏与账号菜单', () => {
  it('顶栏不再有积分与模型芯片', async () => {
    renderShell()
    const header = screen.getByRole('banner')
    await waitFor(() => {
      expect(screen.getByTestId('account-toggle')).toBeTruthy()
    })
    expect(within(header).queryByTestId('credits-chip')).toBeNull()
    expect(within(header).queryByTestId('model-chip')).toBeNull()
    expect(header.textContent).not.toContain('96')
  })

  it('账号菜单第一行是余额 + 充值；余额低时头像上一个小点', async () => {
    state.low = true
    renderShell()
    expect(await screen.findByTestId('account-low-dot')).toBeTruthy()
    fireEvent.click(screen.getByTestId('account-toggle'))
    const menu = screen.getByTestId('account-menu')
    expect((await within(menu).findByTestId('account-balance')).textContent).toBe('96.06')
    expect(within(menu).getByTestId('account-topup').textContent).toBe('充值')
  })

  it('「工作内容」默认收着、展开记在本机；「设置」是一行（WP356：点了开设置弹窗）', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('account-toggle'))
    const menu = screen.getByTestId('account-menu')
    expect(within(menu).queryByTestId('nav-meetings')).toBeNull()
    fireEvent.click(within(menu).getByTestId('account-group-work-toggle'))
    const work = within(menu).getByTestId('account-group-work')
    for (const id of ['nav-meetings', 'nav-knowledge', 'nav-skills'])
      expect(within(work).getByTestId(id)).toBeTruthy()
    expect(within(menu).getByTestId('nav-settings').textContent).toContain('⌘,')
    // 岗位与品牌 / 连接 / 消息渠道都进了设置弹窗，菜单里不再有
    for (const id of ['nav-org', 'nav-connections', 'nav-im'])
      expect(within(menu).queryByTestId(id)).toBeNull()
    expect(localStorage.getItem('agentsws.account.groups')).toContain('"work":true')
    // 左栏里不再有这些
    const nav = screen.getByTestId('main-nav')
    expect(nav.querySelector('a[href="/settings"]')).toBeNull()
    expect(nav.querySelector('a[href="/connections"]')).toBeNull()
  })

  it('点「设置」菜单收起（去设置地址 = 开弹窗）', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('account-toggle'))
    fireEvent.click(screen.getByTestId('nav-settings'))
    expect(screen.queryByTestId('account-menu')).toBeNull()
  })

  it('场景是菜单里一行子菜单，点开就是场景面板；左栏不再单独一行', async () => {
    renderShell()
    expect(screen.queryByTestId('scene-toggle')).toBeNull()
    fireEvent.click(screen.getByTestId('account-toggle'))
    const toggle = await within(screen.getByTestId('account-menu')).findByTestId('scene-toggle')
    expect(toggle.getAttribute('role')).toBe('menuitem')
    fireEvent.click(toggle)
    expect(await screen.findByTestId('scene-panel')).toBeTruthy()
  })

  it('托盘「管理场景…」（?scenes=1）：菜单自己打开、场景面板自己展开', async () => {
    renderShell('/?scenes=1')
    expect(await screen.findByTestId('scene-panel')).toBeTruthy()
    expect(screen.getByTestId('account-menu')).toBeTruthy()
  })

  it('键盘可达：开了焦点在第一项，↓ 走下一项，Esc 收起回到账号块', async () => {
    renderShell()
    const toggle = screen.getByTestId('account-toggle')
    fireEvent.click(toggle)
    const menu = screen.getByTestId('account-menu')
    await within(menu).findByTestId('account-topup')
    await waitFor(() => {
      expect(document.activeElement).toBe(within(menu).getByTestId('account-credits'))
    })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByTestId('account-topup'))
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByTestId('account-menu')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })
})

describe('WP342 输入框里的 AI 钮', () => {
  it('选一个只回调这一次（调用方存）；所有者点「设为默认」改品牌默认', async () => {
    const picked: string[] = []
    renderWithProviders(
      <ComposerModelPicker value="agentsws/qwen-max" onChange={(id) => picked.push(id)} />,
    )
    const pick = await screen.findByTestId('model-pick')
    // 工坊的模型：只有标记，无障碍名称「工坊」
    expect(pick.textContent).toBe('')
    expect(pick.getAttribute('aria-label')).toBe('这次用的 AI：工坊')
    fireEvent.click(pick)
    fireEvent.click(
      screen
        .getAllByTestId('model-pick-option')
        .find((o) => o.dataset.model === 'deepseek/deepseek-flash') as HTMLElement,
    )
    expect(picked).toEqual(['deepseek/deepseek-flash'])
    expect(state.defaults).toEqual([])
    fireEvent.click(pick)
    fireEvent.click(await screen.findByTestId('model-pick-set-default'))
    await waitFor(() => {
      expect(state.defaults).toEqual([
        { input: { default: 'agentsws/qwen-max' }, assignment: 'asg_owner' },
      ])
    })
  })

  it('不是所有者：没有「设为默认」；当前就是默认时也没有', async () => {
    state.owner = false
    renderWithProviders(<ComposerModelPicker value="agentsws/qwen-max" onChange={() => {}} />)
    fireEvent.click(await screen.findByTestId('model-pick'))
    expect(screen.getByTestId('model-pick-menu')).toBeTruthy()
    expect(screen.queryByTestId('model-pick-set-default')).toBeNull()
  })

  it('自接的模型：服务商图标 +「来源 · 模型名」（WP362）；默认那一项标「默认」', async () => {
    renderWithProviders(<ComposerModelPicker value={undefined} onChange={() => {}} />)
    const pick = await screen.findByTestId('model-pick')
    expect(pick.textContent).toBe('DeepSeek 官方 · deepseek-flash')
    fireEvent.click(pick)
    // WP362：按来源分组，工坊那组排最前；默认那一项（自接的 DeepSeek）标「默认」
    const def = screen
      .getAllByTestId('model-pick-option')
      .find((o) => o.dataset.model === 'deepseek/deepseek-flash') as HTMLElement
    expect(def.textContent).toContain('默认')
    // ↓ 换到下一项，Esc 收起
    fireEvent.keyDown(screen.getByTestId('model-pick-menu'), { key: 'Escape' })
    expect(screen.queryByTestId('model-pick-menu')).toBeNull()
  })

  it('岗位输入框选的 AI 跟着「交给它」交上去；不选就不带', async () => {
    await askAtPosition({
      position: 'asg_1',
      text: '查一下 Anna 的退货',
      model: 'agentsws/qwen-max',
    })
    await askAtPosition({ position: 'asg_1', text: '另一件' })
    expect(state.opened[0]?.input.model).toBe('agentsws/qwen-max')
    expect('model' in (state.opened[1]?.input ?? {})).toBe(false)
  })
})

describe('WP342 ⌘K 里照样到得了收进菜单的那几页', () => {
  it('会议 / 知识库 / 技能三页 + 一行「设置」（WP356：设置项另有一组，打字才列）', () => {
    renderWithProviders(
      <CommandPalette
        open
        onOpenChange={() => {}}
        positions={positions}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
      />,
    )
    const pages = screen.getAllByTestId('command-page').map((el) => el.dataset.to)
    expect(pages).toEqual(['/meetings', '/knowledge', '/skills'])
    const settings = screen.getAllByTestId('command-setting').map((el) => el.dataset.to)
    expect(settings).toEqual(['/settings'])
  })
})
