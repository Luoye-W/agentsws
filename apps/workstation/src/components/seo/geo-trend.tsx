/**
 * WP335：看板的**趋势**（docs/96 §4.2「趋势」+ 决策 337「多折线 2–4 条同单位」）——提及率按 AI 分几条。
 *
 * 出现：≥ 3 周有数（点不够不画）。没拿到回答的那一周是断开的（不连成一条假线、不当 0）。
 * 配色固定（绿蓝橙紫，读 `--chart-*`），可悬停看数；没有双纵轴。
 */
import type { GeoMetricsView } from '@agentsws/contracts'
import { type ReactNode, useMemo } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useApp } from '@/lib/app-context'

/** 至少几周有数才画（docs/96：点不够不出）。 */
export const TREND_MIN_WEEKS = 3

/** recharts 的颜色写进 SVG 表现属性，`var(--x)` 不解析——按当前主题读成真颜色（同 block-view）。 */
function useColors(theme: string): { grid: string; axis: string; series: string[] } {
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme 只当「重读 CSS 变量」的信号
  return useMemo(() => {
    const read = (name: string, fallback: string): string => {
      const root = globalThis.document?.documentElement
      if (root === undefined) return fallback
      const value = getComputedStyle(root).getPropertyValue(name).trim()
      return value === '' ? fallback : value
    }
    return {
      grid: read('--border', '#e5e5e5'),
      axis: read('--muted-foreground', '#737373'),
      // 决策 337：固定绿蓝橙紫（`--chart-2` 是品牌浅色，线上看不清，跳过）；紫色没有令牌，取一个两种底色都看得清的
      series: [
        read('--chart-1', '#16a34a'),
        read('--chart-3', '#2563eb'),
        read('--chart-4', '#d97706'),
        '#8b5cf6',
      ],
    }
  }, [theme])
}

export function GeoTrend({ view }: { view: GeoMetricsView }): ReactNode {
  const { t, theme } = useApp()
  const colors = useColors(theme)
  const all = view.trends.find((l) => l.kind === 'all')?.points ?? []
  const lines = view.trends.filter((l) => l.kind === 'platform').slice(0, 4)
  const weeks = all.filter((p) => p.mention_rate !== undefined).map((p) => p.week)
  if (weeks.length < TREND_MIN_WEEKS || lines.length === 0) return null
  const rows = weeks.map((week) => {
    const row: Record<string, string | number | null> = { x: week.slice(5) }
    for (const l of lines) {
      const v = l.points.find((p) => p.week === week)?.mention_rate
      row[l.key] = v === undefined ? null : Math.round(v * 100)
    }
    return row
  })
  return (
    <div className="flex flex-col gap-2" data-testid="geo-trend" data-lines={lines.length}>
      <h4 className="text-sm font-medium">{t('geo.trend')}</h4>
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
            <XAxis dataKey="x" tick={{ fontSize: 11, fill: colors.axis }} stroke={colors.grid} />
            <YAxis
              domain={[0, 100]}
              unit="%"
              tick={{ fontSize: 11, fill: colors.axis }}
              stroke={colors.grid}
            />
            <Tooltip
              formatter={(v) => `${String(v)}%`}
              contentStyle={{
                background: 'var(--popover)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {lines.map((l, i) => (
              <Line
                key={l.key}
                type="linear"
                dataKey={l.key}
                name={t(`geo.platform.${l.key}`)}
                stroke={colors.series[i % 4]}
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
