import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from '@/App'
import { applyMotionPref } from '@/components/design/motion-pref'
import { ErrorBoundary } from '@/components/error-boundary'
import { AppProvider } from '@/lib/app-context'
import { installGlobalErrorReporting } from '@/lib/client-errors'
import { DesktopDragStrip } from '@/lib/desktop-chrome'
import { applyOsAttr } from '@/lib/os-attr'
import { installPreloadReload } from '@/lib/preload-reload'
import './index.css'

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
})

// WP298：前端报错记进本机日志；升级后旧页面加载新分块失败 → 自动整页重载一次
installGlobalErrorReporting()
installPreloadReload()

// WP195：「界面动效」那一项先挂到 <html data-ws-motion> 上，CSS 兜底层要看它
applyMotionPref()

// WP461：<html data-os>——Windows 上换细滚动条（index.css）
applyOsAttr()

const root = document.getElementById('root')
if (root === null) throw new Error('#root 不在页面里')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <AppProvider>
        {/* WP298：最外层错误边界——外壳本身坏了时的最后一道（页面层在 AppShell 主区里） */}
        <ErrorBoundary scope="shell">
          <BrowserRouter>
            <App />
          </BrowserRouter>
          {/* WP424：桌面壳藏了标题栏时，登录 / 启动这几屏顶上那条拖动区 */}
          <DesktopDragStrip />
        </ErrorBoundary>
      </AppProvider>
    </QueryClientProvider>
  </StrictMode>,
)
