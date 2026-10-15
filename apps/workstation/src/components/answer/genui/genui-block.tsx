/**
 * WP336：一块 genui 的外壳——渲染层（`genui-view`，单独一块、懒加载）+ 出错兜底。
 *
 * 当场回答（answer-view）和所有 AI 回话的正文（safe-markdown 遇 ```dsh-ui）都用它；退路由调用方给
 * （当场回答退回表格 / 数字组件，正文退回几行 markdown），这一份不反过来依赖它们。
 */
import type { GenuiSpecLite } from '@agentsws/contracts'
import { Component, lazy, type ReactNode, Suspense } from 'react'
import { reportClientError } from '@/lib/client-errors'

const GenuiView = lazy(() => import('./genui-view'))

/** 渲染层抛错 → 换成退路（记一条本机日志），不让一整块空掉。 */
class GenuiBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    reportClientError('panel', error, { scope: 'answer:genui' })
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function GenuiBlockView({
  spec,
  fallback,
}: {
  spec: GenuiSpecLite
  fallback: ReactNode
}): ReactNode {
  return (
    <GenuiBoundary fallback={fallback}>
      <Suspense fallback={<div className="min-h-[120px]" />}>
        <GenuiView spec={spec} fallback={fallback} />
      </Suspense>
    </GenuiBoundary>
  )
}
