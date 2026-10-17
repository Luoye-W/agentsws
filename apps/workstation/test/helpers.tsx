import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, type RenderResult, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { SettingsTarget } from '@/components/settings-panel/route'
import { SettingsDialog } from '@/components/settings-panel/settings-dialog'
import { AppProvider } from '@/lib/app-context'

export function renderWithProviders(
  ui: ReactNode,
  route = '/',
  /** WP71：当前分配（左栏"当前岗位默认展开"与第三栏的范围都按它算）。 */
  position = 'asg_1',
): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AppProvider initialTheme="light" initialLang="zh" initialPosition={position}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

/**
 * WP208：角色 / 记忆 / 知识 / 技能 / 额度合进了第三栏的「设定」——点图标开「设定」，再点那一个标签。
 * （标签就是旧 id：`role` / `memory` / `knowledge` / `skills` / `caps`。）
 */
export async function openSettingsTab(tab: string): Promise<void> {
  await openRailPanel('settings')
  fireEvent.click(await screen.findByTestId(`settings-tab-${tab}`))
}

/**
 * WP372：右侧面板开到某一格。归卡的面板（设定 / 产出 / 计划 / 对话 / 报表）= 点右上角那张卡的图标、
 * 再点卡底「显示更多」；不归卡的工具（浏览器 / 变更审阅 / 教程）= 点「⋮」再点菜单里那一项。
 */
export async function openRailPanel(id: string): Promise<void> {
  const card = RAIL_PANEL_CARD[id]
  if (card === undefined) {
    fireEvent.click(screen.getByTestId('rail-overflow'))
    fireEvent.click(await screen.findByTestId(`rail-menu-${id}`))
    return
  }
  fireEvent.click(screen.getByTestId(`rail-icon-${card}`))
  fireEvent.click(await screen.findByTestId(`rail-card-more-${card}`))
}

const RAIL_PANEL_CARD: Record<string, string> = {
  settings: 'settings',
  outputs: 'outputs',
  records: 'outputs',
  schedules: 'plans',
  conversations: 'conversations',
  reports: 'reports',
}

/** WP356：设置弹窗开在某一节（原来测 `SettingsPage` 的题改测这里）。 */
export function renderSettings(
  target: SettingsTarget,
  route = '/settings',
  position = 'asg_1',
): RenderResult {
  return renderWithProviders(
    <SettingsDialog target={target} onNavigate={() => {}} onClose={() => {}} />,
    route,
    position,
  )
}
