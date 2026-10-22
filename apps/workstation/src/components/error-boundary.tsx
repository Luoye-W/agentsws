/**
 * WP298：错误边界——某一页（某一块）渲染时抛错，不再让整个工作台一片空白。
 *
 * 三层（Luoye 10-13 Windows 真机「消息渠道」一片空白）：
 * - **页面层**（`AppShell` 的主区）：只换掉主区，左栏与顶栏照常可用；换页（路径变了）自动复原；
 * - **面板层**（右栏面板、懒加载的分块）：只换掉那一块；
 * - **最外层**（`main.tsx`）：外壳本身也坏了时的最后一道，整页一句话 + 两个按钮。
 *
 * 兜底页：一句人话 + 「重新加载」「回首页」 + 一行可展开的技术信息（错误名 + 第一行，洗过、不含用户数据）。
 * 接住的同时记一条日志（`lib/client-errors.ts` → 本机服务）。
 */
import { AlertCircle } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useOptionalApp } from '@/lib/app-context'
import { reportClientError, technicalLine } from '@/lib/client-errors'
import { translate } from '@/lib/i18n'

export type BoundaryScope = 'page' | 'panel' | 'shell'

interface Props {
  scope: BoundaryScope
  /** 变了就复原（页面层传路径：换一页就是新的开始）。 */
  resetKey?: string
  /** 记日志时的细分（`panel:<id>`）。 */
  label?: string
  children: ReactNode
}

interface State {
  error: unknown
  failed: boolean
  key: string | undefined
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined, failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.key) return null
    return { key: props.resetKey, error: undefined, failed: false }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const component = info.componentStack ?? undefined
    reportClientError(this.props.scope === 'panel' ? 'panel' : 'boundary', error, {
      scope: this.props.label ?? this.props.scope,
      ...(error instanceof Error && typeof error.stack === 'string'
        ? { stack: error.stack }
        : component === undefined
          ? {}
          : { stack: component }),
    })
  }

  reset = (): void => {
    this.setState({ error: undefined, failed: false })
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    if (this.props.scope === 'page')
      return <PageCrash error={this.state.error} onReset={this.reset} />
    return <Crash scope={this.props.scope} error={this.state.error} />
  }
}

function useT(): (key: string) => string {
  const app = useOptionalApp()
  return app === null ? (key) => translate('zh', key) : (key) => app.t(key)
}

function reloadPage(): void {
  globalThis.location.reload()
}

/** 页面层：在路由里面，「回首页」走路由（左栏不重挂）。 */
function PageCrash({ error, onReset }: { error: unknown; onReset: () => void }): ReactNode {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return (
    <CrashCard
      scope="page"
      error={error}
      onHome={() => {
        // 换了路径边界自己会复原（`resetKey`）；本来就在首页时才手动复原再试一次
        if (pathname === '/') onReset()
        else navigate('/')
      }}
    />
  )
}

function Crash({ scope, error }: { scope: 'panel' | 'shell'; error: unknown }): ReactNode {
  const card = (
    <CrashCard
      scope={scope}
      error={error}
      {...(scope === 'shell'
        ? {
            onHome: () => {
              globalThis.location.assign('/')
            },
          }
        : {})}
    />
  )
  if (scope === 'panel') return card
  return <div className="flex min-h-screen items-start justify-center bg-ws-paper p-8">{card}</div>
}

function CrashCard({
  scope,
  error,
  onHome,
}: {
  scope: BoundaryScope
  error: unknown
  onHome?: () => void
}): ReactNode {
  const t = useT()
  return (
    <div
      role="alert"
      data-testid={`crash-${scope}`}
      className="flex max-w-xl flex-col gap-3 rounded-lg border border-ws-line bg-ws-card p-4 text-sm"
    >
      <p className="flex items-start gap-2 font-medium">
        <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>{t(scope === 'panel' ? 'crash.panel' : 'crash.title')}</span>
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" data-testid="crash-reload" onClick={reloadPage}>
          {t('crash.reload')}
        </Button>
        {onHome === undefined ? null : (
          <Button size="sm" variant="ghost" data-testid="crash-home" onClick={onHome}>
            {t('crash.home')}
          </Button>
        )}
      </div>
      <details className="text-xs text-ws-muted-fg">
        <summary className="cursor-pointer select-none">{t('crash.details')}</summary>
        <code data-testid="crash-detail" className="mt-1 block break-all">
          {technicalLine(error)}
        </code>
      </details>
    </div>
  )
}
