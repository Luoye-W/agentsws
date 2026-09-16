import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderResult, render } from '@testing-library/react'
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
