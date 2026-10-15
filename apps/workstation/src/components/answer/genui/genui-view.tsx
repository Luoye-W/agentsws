/**
 * WP336（决策 810–812）：当场回答里的 genui 块交给 dsh-genui 的 `/embed` 渲染层画。
 *
 * 这一份是**单独一块**（answer-view 里 `lazy` 引进来），没有 genui 回答的页面不下载它。
 * - 描述已经在契约里按白名单过滤过；这里再过一遍插件自己的 `processGenuiSpec`（补默认值、修小毛病），
 *   画不了就回 `fallback`（降级成表格 / 数字 / 字）。
 * - 不给 action 处理器、不包 `GenuiActionContext`：就算漏网一个按钮也是禁用的；交互状态不写本机存储。
 * - 有 `echart` 才去拉本机打包的图表引擎（echarts-asset.ts），拉完再画。
 */
import type { GenuiNodeLite, GenuiSpecLite } from '@agentsws/contracts'
import { GenuiBlock, isRenderableProcess, processGenuiSpec } from '@changfenhuang/dsh-genui/embed'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import './genui-view.css'

const hasEchart = (items: readonly GenuiNodeLite[]): boolean =>
  items.some(
    (n) => n.type === 'echart' || (Array.isArray(n.items) && hasEchart(n.items as GenuiNodeLite[])),
  )

let echarts: Promise<unknown> | undefined
const loadEcharts = (): Promise<unknown> => {
  echarts ??= import('./echarts-asset')
  return echarts
}

const keepNothing = (): void => {}

export default function GenuiView({
  spec,
  fallback,
}: {
  spec: GenuiSpecLite
  fallback: ReactNode
}): ReactNode {
  const processed = useMemo(() => processGenuiSpec(spec), [spec])
  const charts = useMemo(() => hasEchart(spec.items), [spec])
  const [ready, setReady] = useState<'yes' | 'no' | 'failed'>(charts ? 'no' : 'yes')
  useEffect(() => {
    if (!charts) return
    let live = true
    loadEcharts().then(
      () => live && setReady('yes'),
      () => live && setReady('failed'),
    )
    return () => {
      live = false
    }
  }, [charts])
  if (processed.spec === null || !isRenderableProcess(processed) || ready === 'failed')
    return fallback
  if (ready === 'no') return <div className="min-h-[120px]" data-testid="answer-genui-loading" />
  return (
    <div className="ws-genui" data-testid="answer-genui">
      <GenuiBlock spec={processed.spec} animateEntrance={false} onStateChange={keepNothing} />
    </div>
  )
}
