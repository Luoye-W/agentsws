import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, type RenderResult, render, screen, within } from '@testing-library/react'
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
 * WP372 / WP375：右侧面板开到某一格。归卡的面板（设定 / 产出 / 计划 / 对话 / 报表）= 「⋮」打开面板、
 * 展开那张卡、点卡底「显示更多」；不归卡的工具（浏览器 / 变更审阅 / 教程）= 右上角那个图标。
 */
export async function openRailPanel(id: string): Promise<void> {
  const card = RAIL_PANEL_CARD[id]
  if (card === undefined) {
    // WP375：不归卡的工具（浏览器 / 变更审阅）是右上角的图标；WP412：不常用的（教程…）在「⋮」菜单里
    const icon = screen.queryByTestId(`rail-icon-${id}`)
    if (icon !== null) {
      fireEvent.click(icon)
      return
    }
    if (screen.queryByTestId('rail-menu') === null)
      fireEvent.click(screen.getByTestId('rail-overflow'))
    fireEvent.click(await screen.findByTestId(`rail-menu-${id}`))
    return
  }
  // WP456-T3（决策 1448）：产出 / 连接 / 设定 / 工坊服务合进了清单卡——点那一行就在第三栏开完整一格
  if (LIST_CARDS.has(card)) {
    fireEvent.click(await screen.findByTestId(`rail-list-row-${card}`))
    return
  }
  await openRailCard(card)
  // WP433：「显示更多」只在多于 5 条时出；条数少的卡从卡里那一行进（产出 → 记录、计划 → 定时任务、设定 → 那一格）
  const more = await screen
    .findByTestId(`rail-card-more-${card}`, {}, { timeout: 1500 })
    .catch(() => null)
  if (more !== null) {
    fireEvent.click(more)
    return
  }
  const row = CARD_ROW[card]
  if (row === undefined) throw new Error(`「${card}」卡不到 5 条，没有「显示更多」`)
  const box = screen.getByTestId(`rail-card-${card}`)
  fireEvent.click((await within(box).findAllByTestId(row))[0] as HTMLElement)
}

/** WP456-T3：合进清单卡的那几张（没有展开，点那一行开第三栏）。 */
export const LIST_CARDS: ReadonlySet<string> = new Set([
  'outputs',
  'connections',
  'settings',
  'workshop-services',
])

/** WP433：条数少、没有「显示更多」时，从卡里哪一行进完整那一格。 */
const CARD_ROW: Record<string, string> = {
  outputs: 'output-row',
  plans: 'plan-row-progress',
  settings: 'settings-row',
}

/**
 * WP375（决策 1035）：右上角不再有卡片图标，卡没展开就点它的标题行展开。
 * WP412（决策 1035 更正）：面板由右上角专门的开关（`rail-toggle`）开；岗位 / 职责 / 事项页默认就开着。
 * WP433：开关去掉了，卡片列属于中栏、一直在；「显示更多」开在它右边的第三栏里（右上角 × 收起）。
 */
export async function openRailCard(card: string): Promise<HTMLElement> {
  // WP433：卡片列属于中栏、一直在（第三栏开着也不挡它）
  const box = await screen.findByTestId(`rail-card-${card}`)
  // WP456-T3：清单卡里那几行没有展开 / 收起
  if (LIST_CARDS.has(card)) return box
  if (box.getAttribute('data-open') !== 'true')
    fireEvent.click(screen.getByTestId(`rail-card-toggle-${card}`))
  return box
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
