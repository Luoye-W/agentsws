import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from '@/App'
import { applyMotionPref } from '@/components/design/motion-pref'
import { AppProvider } from '@/lib/app-context'
import './index.css'

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
})

// WP195：「界面动效」那一项先挂到 <html data-ws-motion> 上，CSS 兜底层要看它
applyMotionPref()

const root = document.getElementById('root')
if (root === null) throw new Error('#root 不在页面里')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <AppProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AppProvider>
    </QueryClientProvider>
  </StrictMode>,
)
