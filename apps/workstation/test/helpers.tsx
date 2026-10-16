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
  fireEvent.click(screen.getByTestId('rail-icon-settings'))
  fireEvent.click(await screen.findByTestId(`settings-tab-${tab}`))
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
