import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderResult, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { AppProvider } from '@/lib/app-context'

export function renderWithProviders(ui: ReactNode, route = '/'): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AppProvider initialTheme="light" initialLang="zh" initialPosition="asg_1">
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}
