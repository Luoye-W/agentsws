/**
 * WP356（决策 923，Luoye 10-16「学 Claude」）：设置是盖在当前页上的大弹窗。
 *
 * - 老地址一个不废：`/settings?tab=…`、`#company`、`#diagnostics`、插件三条深链、`/connections?service=…`、
 *   `/im-channels#site-chat`、`/org?tab=…` 都映射到弹窗里的一节一项；
 * - ⌘, 打开；Esc 关；背后那一页不卸、关了回到原地址；
 * - 搜索按标题和说明全文搜，点命中跳到那一项并亮一下；
 * - 个人模式不出「团队」组；同事互联 / 公司出；
 * - ⌘K 搜得到每一项。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsTargetOf } from '@/components/settings-panel/route'
import type { OrganizationView } from '@/lib/api'
import { renderWithProviders } from './helpers'

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

const state = vi.hoisted(() => ({
  orgs: [] as unknown[],
  owner: true,
  mounts: 0,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => state.orgs,
    getPositions: async () => ({
      positions: state.owner
        ? [
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
          ]
        : [],
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

const { SettingsDialog } = await import('@/components/settings-panel/settings-dialog')
const { useSettingsRoute } = await import('@/components/settings-panel/use-settings-route')
const { CommandPalette } = await import('@/components/command-palette')

/** 背后那一页：记挂载次数（关弹窗回来不能重挂）。 */
function Background(): React.ReactNode {
  useEffect(() => {
    state.mounts += 1
  }, [])
  return <div data-testid="bg">背后那一页</div>
}

/** 与 App.tsx 同一种接法：主区按 background 路由，弹窗盖在上面。 */
function Harness(): React.ReactNode {
  const s = useSettingsRoute()
  const loc = useLocation()
  return (
    <>
      <Routes location={s.background}>
        <Route path="*" element={<Background />} />
      </Routes>
      <SettingsDialog target={s.target} onNavigate={s.go} onClose={s.close} />
      <span data-testid="loc">{`${loc.pathname}${loc.search}${loc.hash}`}</span>
    </>
  )
}

const loc = (): string => screen.getByTestId('loc').textContent ?? ''
const pane = (): HTMLElement => screen.getByTestId('settings-pane')

beforeEach(() => {
  state.orgs = [ORG]
  state.owner = true
  state.mounts = 0
})

describe('WP356 老地址 → 弹窗里的一节一项', () => {
  const at = (url: string): ReturnType<typeof settingsTargetOf> => {
    const u = new URL(url, 'http://x')
    return settingsTargetOf({ pathname: u.pathname, search: u.search, hash: u.hash })
  }
  it('设置页的 tab / 锚点 / 插件三条深链', () => {
    expect(at('/settings')).toEqual({ section: 'general' })
    expect(at('/settings?tab=account')).toEqual({ section: 'account' })
    expect(at('/settings?tab=credits')).toEqual({ section: 'account', item: 'credits' })
    expect(at('/settings?tab=models')).toEqual({ section: 'models' })
    expect(at('/settings?tab=plugins')).toEqual({ section: 'plugins' })
    expect(at('/settings#company')).toEqual({ section: 'profile', item: 'brand-profile' })
    expect(at('/settings#diagnostics')).toEqual({ section: 'diagnostics', item: 'diagnostics' })
    for (const tab of ['credits', 'billing', 'apikeys'])
      expect(at(`/settings/${tab}`)).toEqual({ section: 'account', item: 'credits' })
    expect(at('/settings/runs#archive')).toEqual({ section: 'runs', item: 'archive' })
    expect(at('/settings/nope')).toEqual({ section: 'general' })
  })
  it('连接 / 消息渠道 / 岗位与品牌', () => {
    expect(at('/connections')).toEqual({ section: 'connections' })
    expect(at('/connections?service=shopify_admin')).toEqual({ section: 'connections' })
    expect(at('/connections#data-backend')).toEqual({ section: 'privacy', item: 'data-backend' })
    expect(at('/im-channels')).toEqual({ section: 'channels' })
    expect(at('/im-channels#site-chat')).toEqual({ section: 'channels', item: 'site-chat' })
    expect(at('/org')).toEqual({ section: 'positions' })
    expect(at('/org?tab=brands')).toEqual({ section: 'brands' })
    expect(at('/org?tab=toolbox&q=x')).toEqual({ section: 'toolbox' })
    expect(at('/org?tab=positions&new=kol')).toEqual({ section: 'positions' })
    expect(at('/org?tab=members')).toEqual({ section: 'people' })
    expect(at('/org?tab=join')).toEqual({ section: 'merge' })
  })
  it('别的地址不是设置', () => {
    for (const p of ['/', '/assistant', '/positions/a', '/brand-design', '/settingsx'])
      expect(at(p)).toBeNull()
  })
})

describe('WP356 弹窗开关与回原位', () => {
  it('⌘, 打开在「通用」；背后那一页不卸；Esc 关了回到原地址', async () => {
    renderWithProviders(<Harness />, '/todos?view=week')
    expect(screen.queryByTestId('settings-dialog')).toBeNull()
    fireEvent.keyDown(document, { key: ',', metaKey: true })
    const dialog = await screen.findByTestId('settings-dialog')
    expect(loc()).toBe('/settings')
    expect(pane().dataset.section).toBe('general')
    expect(within(dialog).getByTestId('settings-theme')).toBeTruthy()
    expect(screen.getByTestId('bg')).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId('settings-dialog')).toBeNull()
    })
    expect(loc()).toBe('/todos?view=week')
    expect(state.mounts).toBe(1)
  })

  it('左边点一节：换地址（替换），右边换成那一节', async () => {
    renderWithProviders(<Harness />, '/settings')
    fireEvent.click(await screen.findByTestId('settings-nav-memory'))
    await waitFor(() => {
      expect(pane().dataset.section).toBe('memory')
    })
    expect(loc()).toBe('/settings/memory')
  })

  it('插件深链 /settings/credits 落在「账号与积分」', async () => {
    renderWithProviders(<Harness />, '/settings/credits')
    await screen.findByTestId('settings-dialog')
    expect(pane().dataset.section).toBe('account')
    expect(pane().querySelector('[data-setting="credits"]')).not.toBeNull()
  })

  it('老地址 /im-channels#site-chat、/org?tab=brands 打开对应那一节', async () => {
    const { unmount } = renderWithProviders(<Harness />, '/org?tab=brands')
    await screen.findByTestId('settings-dialog')
    expect(pane().dataset.section).toBe('brands')
    unmount()
    renderWithProviders(<Harness />, '/im-channels')
    await screen.findByTestId('settings-dialog')
    expect(pane().dataset.section).toBe('channels')
  })
})

describe('WP356 搜索', () => {
  it('按标题和说明全文搜，点命中跳到那一项并亮一下', async () => {
    renderWithProviders(<Harness />, '/settings')
    const input = await screen.findByTestId('settings-search')
    fireEvent.change(input, { target: { value: '归档' } })
    const hits = await screen.findAllByTestId('settings-search-hit')
    expect(hits.map((h) => h.dataset.setting)).toContain('archive')
    fireEvent.click(hits.find((h) => h.dataset.setting === 'archive') as HTMLElement)
    await waitFor(() => {
      expect(loc()).toBe('/settings/runs#archive')
    })
    const item = pane().querySelector('[data-setting="archive"]') as HTMLElement
    expect(item.className).toContain('ring-2')
    // 搜索框清空、左边回到分组导航
    expect(screen.getByTestId('settings-nav')).toBeTruthy()
  })

  it('说明里的词也搜得到；搜不到说一句', async () => {
    renderWithProviders(<Harness />, '/settings')
    const input = await screen.findByTestId('settings-search')
    fireEvent.change(input, { target: { value: '卡住' } })
    const hits = await screen.findAllByTestId('settings-search-hit')
    expect(hits[0]?.dataset.setting).toBe('run-limits')
    fireEvent.change(input, { target: { value: 'zzzz 不存在' } })
    expect(await screen.findByText('没搜到。换个说法试试')).toBeTruthy()
  })
})

describe('WP356 按模式出组', () => {
  it('个人模式不出「团队」组；同事互联出', async () => {
    const { unmount } = renderWithProviders(<Harness />, '/settings')
    await screen.findByTestId('settings-dialog')
    await screen.findByTestId('settings-group-device')
    expect(screen.queryByTestId('settings-group-team')).toBeNull()
    unmount()
    state.orgs = [{ ...ORG, solo: false, mode: 'peers', members: 2 }]
    renderWithProviders(<Harness />, '/settings')
    expect(await screen.findByTestId('settings-group-team')).toBeTruthy()
    expect(screen.getByTestId('settings-nav-people').textContent).toBe('同事')
    // 公司模式才有的那几节（邀请与加入 / 店铺组 / 并进来）同事互联里不出
    expect(screen.queryByTestId('settings-nav-invite')).toBeNull()
  })

  it('不是所有者：模型 / 这台电脑那几节不出；去不了的那一节落在「通用」', async () => {
    state.owner = false
    renderWithProviders(<Harness />, '/settings/models')
    await screen.findByTestId('settings-dialog')
    await waitFor(() => {
      expect(pane().dataset.section).toBe('general')
    })
    expect(screen.queryByTestId('settings-nav-models')).toBeNull()
    expect(screen.queryByTestId('settings-group-device')).toBeNull()
  })

  it('品牌那一组标着当前品牌', async () => {
    renderWithProviders(<Harness />, '/settings')
    await waitFor(() => {
      expect(screen.getByTestId('settings-group-brand').textContent).toContain('品牌 · Nordvolt')
    })
  })
})

describe('WP356 ⌘K 搜设置项', () => {
  it('打字就列出命中的设置项，选了去那一项的地址', async () => {
    renderWithProviders(
      <CommandPalette
        open
        onOpenChange={() => {}}
        positions={[]}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/./), { target: { value: '自动记忆' } })
    await waitFor(() => {
      const tos = screen.getAllByTestId('command-setting').map((el) => el.dataset.to)
      expect(tos).toContain('/settings/memory#auto-memory')
    })
  })
})

describe('WP456-T6：设置弹窗的样子走共用件', () => {
  it('左栏分组名是共用的分组名（12/600 灰字）、每行 30 高；页头标题 16、说明 13；节里的小标题是节标题', async () => {
    renderWithProviders(<Harness />, '/settings/channels')
    const nav = await screen.findByTestId('settings-nav')
    const labels = nav.querySelectorAll('.ws-group-label')
    expect(labels.length).toBeGreaterThanOrEqual(3)
    const row = within(nav).getByTestId('settings-nav-general')
    expect(row.className).toContain('h-[30px]')
    expect(row.className).toContain('text-ws-ui')
    const head = pane().querySelector('header[data-slot="page-header"]') as HTMLElement
    expect(head.querySelector('h2')?.className).toContain('text-ws-title')
    // 不再有 12.5 这种半档
    expect(pane().innerHTML).not.toContain('text-[12.5px]')
    // 「消息渠道」那几项自己没标题，上面画的是共用的节标题
    await waitFor(() => {
      expect(pane().querySelectorAll('.ws-sec-title').length).toBeGreaterThan(0)
    })
  })
})
