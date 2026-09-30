import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, type RenderResult, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
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
