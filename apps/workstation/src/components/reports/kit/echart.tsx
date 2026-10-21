/**
 * WP438：一张 ECharts 图（报表里的大趋势、堆叠柱、每天几根柱 + 一条线）。
 *
 * - 颜色全从 CSS token 读（`--ws-chart-*`，浅 / 深两套），换主题自己重画；
 * - 引擎懒加载（`echarts-core.ts`），测试环境（jsdom 没有 canvas）只画一个占位框，不加载引擎；
 * - 每张图都有悬停提示（tooltip 用卡片底色 + 阴影，和设计稿一样）。
 */
import { type ReactNode, useEffect, useRef, useState } from 'react'

export interface ChartColors {
  series: [string, string, string, string]
  single: string
  grid: string
  axis: string
  card: string
  ink: string
  muted: string
  body: string
  faint: string
  info: string
  line: string
  secondary: string
}

const VAR = (name: string, fallback: string): string => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v === '' ? fallback : v
  } catch {
    return fallback
  }
}

export function readChartColors(): ChartColors {
  return {
    series: [
      VAR('--ws-chart-1', '#008a6c'),
      VAR('--ws-chart-2', '#2a78d6'),
      VAR('--ws-chart-3', '#eb6834'),
      VAR('--ws-chart-4', '#6250d6'),
    ],
    single: VAR('--ws-chart-single', '#007b67'),
    grid: VAR('--ws-chart-grid', '#eef1ed'),
    axis: VAR('--ws-chart-axis', '#8d958f'),
    card: VAR('--ws-card', '#ffffff'),
    ink: VAR('--ws-ink', '#263331'),
    muted: VAR('--ws-muted-fg', '#6b746f'),
    body: VAR('--ws-body', '#4b5550'),
    faint: VAR('--ws-faint', '#9aa29d'),
    info: VAR('--ws-info', '#2f63c8'),
    line: VAR('--ws-line', '#ecefea'),
    secondary: VAR('--ws-secondary', '#edf0eb'),
  }
}

/** 主题一换（`html.dark`）就重读一次颜色。 */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(() => readChartColors())
  useEffect(() => {
    const root = document.documentElement
    const obs = new MutationObserver(() => {
      setColors(readChartColors())
    })
    obs.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    return () => {
      obs.disconnect()
    }
  }, [])
  return colors
}

/** jsdom（单测）里没有 canvas：只画占位框，不加载引擎。 */
const canDraw = (): boolean => {
  try {
    return typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)
  } catch {
    return false
  }
}

/** 图表里那张悬停卡（卡片底色 + 阴影、没有描边）。 */
export function tooltipBase(c: ChartColors): Record<string, unknown> {
  return {
    trigger: 'axis',
    backgroundColor: c.card,
    borderWidth: 0,
    padding: [8, 10],
    extraCssText:
      'border-radius:10px;box-shadow:0 16px 34px rgba(20,40,30,.14),0 2px 6px rgba(20,40,30,.06);',
    textStyle: { color: c.body, fontSize: 12 },
    axisPointer: { type: 'line', lineStyle: { color: c.axis, type: 'dashed', width: 1 } },
  }
}

export function EChart({
  option,
  height,
  testId,
  label,
}: {
  option: (c: ChartColors) => Record<string, unknown>
  height: number
  testId?: string
  /** 读屏用的一句（图说的是什么）。 */
  label: string
}): ReactNode {
  const box = useRef<HTMLDivElement | null>(null)
  const colors = useChartColors()
  const make = useRef(option)
  make.current = option
  const [chart, setChart] = useState<{ setOption(o: unknown, n?: boolean): void } | null>(null)

  useEffect(() => {
    if (!canDraw()) return
    let disposed = false
    let instance: { dispose(): void; resize(): void } | undefined
    let ro: ResizeObserver | undefined
    void import('./echarts-core').then(({ echarts }) => {
      if (disposed || box.current === null) return
      const inst = echarts.init(box.current, undefined, { renderer: 'canvas' })
      instance = inst
      setChart(inst as never)
      ro = new ResizeObserver(() => {
        inst.resize()
      })
      ro.observe(box.current)
    })
    return () => {
      disposed = true
      ro?.disconnect()
      instance?.dispose()
    }
  }, [])

  useEffect(() => {
    chart?.setOption(
      {
        animationDuration: 400,
        textStyle: { fontFamily: 'Outfit, "PingFang SC", "Noto Sans SC", system-ui, sans-serif' },
        ...make.current(colors),
      },
      true,
    )
    // option 每次渲染都是新函数：照 colors / chart 变化重画就够了（`make.current` 拿的是最新那一份）
  }, [chart, colors])

  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      data-testid={testId}
      className="w-full"
      style={{ height }}
    />
  )
}
