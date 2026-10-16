/**
 * WP361（决策 925 / 926 / 927，Luoye 10-16）：设置弹窗三处收尾。
 *
 * - 925：「进行中」看板挪到账号菜单「工作内容」组（② ③ 才有），⌘K 搜得到；弹窗团队组里不再有；
 *   老地址 `/org?tab=inprogress`、`/settings/inprogress` 不算设置了（主区跳到 `/in-progress`）。
 * - 926：账号菜单不再有「语言」；语言只在弹窗 → 个人 → 通用；深浅色、场景留在菜单。
 * - 927：开机自启是弹窗「这台电脑 → 桌面端」里的开关——读桥、写桥、托盘那边改了跟着变；网页端 / 旧壳不出。
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsTargetOf } from '@/components/settings-panel/route'
import type { OrganizationView } from '@/lib/api'
import { renderSettings, renderWithProviders } from './helpers'

const T0 = '2026-10-16T09:00:00.000Z'
const ORG: OrganizationView = {
  id: 'org_1',
  legal_name: '深圳诺伏特科技',
  domain: 'nordvolt.cn',
  discoverable: false,
  owner_id: 'per_wang',
  role: 'owner',
  brands: 1,
  members: 1,
  solo: true,
  mode: 'solo',
  created_at: T0,
}
const PEERS: OrganizationView = { ...ORG, solo: false, mode: 'peers', members: 2 }

const state = vi.hoisted(() => ({ orgs: [] as unknown[] }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => state.orgs,
    getCloudCredits: async () => ({ linked: false }),
    listInProgress: async () => ({ items: [], scope: 'workspace' }),
    getPositions: async () => ({
      positions: [
        {
          position_id: 'asg_owner',
          role_id: 'common.owner',
          role_name: '公司设置与授权',
          ranges: [],
          ready: true,
          missing_connectors: [],
          tile_ids: [],
          range: 'yesterday',
          show_tiles: true,
        },
      ],
      tile_library: [],
      max_tiles: 6,
    }),
    ensureSession: async () => ({
      person: { id: 'per_wang', email: 'wang@nordvolt.example', name: '王岚' },
      workspace: { id: 'ws_1', name: 'Nordvolt' },
      assignments: [],
    }),
  }
})

const { AccountBlock } = await import('@/components/account-block')
const { CommandPalette } = await import('@/components/command-palette')
const { InProgressPage } = await import('@/pages/in-progress')

function Loc(): React.ReactNode {
  const loc = useLocation()
  return <span data-testid="loc">{`${loc.pathname}${loc.search}`}</span>
}

function renderMenu(): void {
  renderWithProviders(
    <>
      <AccountBlock
        me={{
          person: { id: 'per_wang', email: 'wang@nordvolt.example', name: '王岚' },
          workspace: { id: 'ws_1', name: 'Nordvolt' },
          assignments: [],
        }}
      />
      <Routes>
        <Route path="*" element={<Loc />} />
      </Routes>
    </>,
  )
}

async function openWork(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId('account-toggle'))
  const menu = screen.getByTestId('account-menu')
  if (within(menu).getByTestId('account-group-work-toggle').getAttribute('aria-expanded') !== 'true')
    fireEvent.click(within(menu).getByTestId('account-group-work-toggle'))
  return menu
}

beforeEach(() => {
  state.orgs = [ORG]
  // 账号菜单两组的展开记在本机：每题一份干净的
  const box = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => {
      box.set(k, v)
    },
    removeItem: (k: string) => {
      box.delete(k)
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WP361 925：「进行中」在账号菜单「工作内容」里', () => {
  it('同事互联：工作内容里有「进行中」，和会议 / 知识库 / 技能并列；点了去 /in-progress', async () => {
    state.orgs = [PEERS]
    renderMenu()
    const menu = await openWork()
    const work = within(menu).getByTestId('account-group-work')
    const item = await within(work).findByTestId('nav-inprogress')
    expect(item.textContent).toBe('进行中')
    const ids = [...work.querySelectorAll('[data-testid^="nav-"]')].map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(ids).toEqual(['nav-meetings', 'nav-knowledge', 'nav-skills', 'nav-inprogress'])
    fireEvent.click(item)
    expect(screen.getByTestId('loc').textContent).toBe('/in-progress')
  })

  it('个人模式：工作内容里没有「进行中」', async () => {
    renderMenu()
    const menu = await openWork()
    await within(menu).findByTestId('nav-skills')
    // 等组织读到（读到之前本来也不出）
    await waitFor(() => {
      expect(within(menu).queryByTestId('nav-inprogress')).toBeNull()
    })
  })

  it('⌘K：同事互联里搜得到「进行中」那一页；个人模式没有', async () => {
    state.orgs = [PEERS]
    const palette = (
      <CommandPalette
        open
        onOpenChange={() => {}}
        positions={[]}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
      />
    )
    const { unmount } = renderWithProviders(palette)
    await waitFor(() => {
      const pages = screen.getAllByTestId('command-page').map((el) => el.dataset.to)
      expect(pages).toEqual(['/meetings', '/knowledge', '/skills', '/in-progress'])
    })
    unmount()
    state.orgs = [ORG]
    renderWithProviders(palette)
    await new Promise((r) => setTimeout(r, 0))
    const pages = screen.getAllByTestId('command-page').map((el) => el.dataset.to)
    expect(pages).not.toContain('/in-progress')
  })

  it('/in-progress 是一页：标题 + 一句话 + 原来那个看板', async () => {
    renderWithProviders(<InProgressPage />, '/in-progress')
    const page = await screen.findByTestId('inprogress-page')
    expect(within(page).getByRole('heading').textContent).toBe('进行中')
    expect(await within(page).findByText('大家手上正在做的事')).toBeTruthy()
  })

  it('弹窗团队组里不再有「进行中」；老地址不算设置了', async () => {
    state.orgs = [PEERS]
    renderSettings({ section: 'people' })
    expect(await screen.findByTestId('settings-group-team')).toBeTruthy()
    expect(screen.queryByTestId('settings-nav-inprogress')).toBeNull()
    const at = (url: string): ReturnType<typeof settingsTargetOf> => {
      const u = new URL(url, 'http://x')
      return settingsTargetOf({ pathname: u.pathname, search: u.search, hash: u.hash })
    }
    expect(at('/org?tab=inprogress')).toBeNull()
    expect(at('/settings/inprogress')).toBeNull()
    // 其余 /org 老地址照旧开弹窗
    expect(at('/org?tab=toolbox')).toEqual({ section: 'toolbox' })
    expect(at('/org')).toEqual({ section: 'positions' })
  })
})

describe('WP361 926：语言只在设置弹窗里', () => {
  it('账号菜单没有「语言」，深浅色与设置还在', async () => {
    renderMenu()
    fireEvent.click(screen.getByTestId('account-toggle'))
    const menu = screen.getByTestId('account-menu')
    expect(within(menu).queryByTestId('account-lang')).toBeNull()
    expect(within(menu).queryByText('语言')).toBeNull()
    expect(within(menu).getByTestId('account-theme')).toBeTruthy()
    expect(within(menu).getByTestId('nav-settings')).toBeTruthy()
  })

  it('设置弹窗 → 个人 → 通用里有语言（几选一）', async () => {
    renderSettings({ section: 'general' })
    const row = await screen.findByTestId('settings-lang')
    expect(within(row).getByText('中文')).toBeTruthy()
    expect(within(row).getByText('English')).toBeTruthy()
  })
})

type Listener = (on: boolean) => void
function fakeBridge(start: boolean) {
  let on = start
  const listeners = new Set<Listener>()
  const set = vi.fn(async (v: boolean) => {
    on = v
    return on
  })
  return {
    bridge: {
      platform: 'darwin',
      version: '0.9.0',
      launchAtLogin: {
        get: async () => on,
        set,
        onChange: (l: Listener) => {
          listeners.add(l)
          return () => {
            listeners.delete(l)
          }
        },
      },
    },
    set,
    /** 托盘那边点了一下。 */
    tray: () => {
      on = !on
      for (const l of listeners) l(on)
    },
    listeners,
  }
}

const w = globalThis as unknown as { agentsws?: unknown }

describe('WP361 927：开机自启开关（这台电脑 → 桌面端）', () => {
  afterEach(() => {
    delete w.agentsws
  })

  it('读桥上的值；点一下写回去；托盘那边改了开关跟着变', async () => {
    const f = fakeBridge(false)
    w.agentsws = f.bridge
    const { unmount } = renderSettings({ section: 'desktop' })
    const sw = await screen.findByTestId('settings-launch-at-login-switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    await waitFor(() => {
      expect(f.set).toHaveBeenCalledWith(true)
      expect(sw.getAttribute('aria-checked')).toBe('true')
    })
    act(() => {
      f.tray()
    })
    expect(screen.getByTestId('settings-launch-at-login-switch').getAttribute('aria-checked')).toBe(
      'false',
    )
    // 托盘那一行改了说法：开机自启不在「托盘菜单里」那句话里了
    expect(screen.getByText('暂停、导出诊断在托盘图标的菜单里')).toBeTruthy()
    unmount()
    expect(f.listeners.size).toBe(0)
  })

  it('搜「开机」能找到这个开关', async () => {
    w.agentsws = fakeBridge(true).bridge
    renderSettings({ section: 'general' })
    fireEvent.change(await screen.findByTestId('settings-search'), { target: { value: '开机' } })
    const hits = await screen.findAllByTestId('settings-search-hit')
    expect(hits[0]?.dataset.setting).toBe('launch-at-login')
  })

  it('旧壳（桥上没有这一项）：桌面端那一节在、没有这个开关', async () => {
    w.agentsws = { platform: 'darwin', version: '0.8.0' }
    renderSettings({ section: 'desktop' })
    expect(await screen.findByTestId('settings-app-update')).toBeTruthy()
    expect(screen.queryByTestId('settings-launch-at-login')).toBeNull()
  })

  it('网页端：没有「桌面端」这一节', async () => {
    renderSettings({ section: 'general' })
    await screen.findByTestId('settings-lang')
    expect(screen.queryByTestId('settings-nav-desktop')).toBeNull()
    expect(screen.queryByTestId('settings-launch-at-login')).toBeNull()
  })
})
