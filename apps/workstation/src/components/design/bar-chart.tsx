/**
 * 双色柱（画布岗位页"本周销售"）：本周 vs 上周同时，柱顶圆角。
 *
 * 36 §1 定的图表方案是 shadcn chart，也就是 recharts + 一层 token 化的壳；这里就是
 * 那层壳，颜色只走 `--ws-*`，所以深浅色自动跟着切。工作台只有这一处上图表库——
 * 火花线、进度环都不用它。
 */
import {
  Bar,
  CartesianGrid,
  BarChart as RechartsBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export interface BarPoint {
  label: string
  current: number
  previous: number
}

export function DualBarChart({
  data,
  height = 190,
  currentName,
  previousName,
  formatValue,
}: {
  data: BarPoint[]
  height?: number
  currentName: string
  previousName: string
  formatValue?: (v: number) => string
}): React.ReactNode {
  return (
    <div data-testid="ws-bar-chart" data-points={data.length} style={{ height }}>
      {/* jsdom 里 ResponsiveContainer 量不到宽度，测试只断言容器与图例，不断言 svg */}
      <ResponsiveContainer width="100%" height="100%">
        <RechartsBarChart data={data} barGap={2} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--ws-line)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--ws-muted-fg)', fontSize: 12 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={52}
            tick={{ fill: 'var(--ws-muted-fg)', fontSize: 11.5 }}
            {...(formatValue === undefined ? {} : { tickFormatter: formatValue })}
          />
          <Tooltip
            cursor={{ fill: 'var(--ws-surface)' }}
            contentStyle={{
              borderRadius: 12,
              border: 'none',
              background: 'var(--ws-card)',
              color: 'var(--ws-ink)',
              boxShadow: 'var(--ws-shadow)',
              fontSize: 12,
            }}
            {...(formatValue === undefined ? {} : { formatter: (v: number) => formatValue(v) })}
          />
          <Bar dataKey="current" name={currentName} fill="var(--ws-brand)" radius={[6, 6, 0, 0]} />
          <Bar
            dataKey="previous"
            name={previousName}
            fill="var(--ws-brand-soft)"
            radius={[6, 6, 0, 0]}
          />
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** 画布上那条图例：两个小色块 + 名字。图表本体不带图例，位置在标题行右边。 */
export function DualBarLegend({
  currentName,
  previousName,
}: {
  currentName: string
  previousName: string
}): React.ReactNode {
  return (
    <span className="flex items-center gap-3 text-xs text-ws-body" data-testid="ws-bar-legend">
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="inline-block size-2.5 rounded-[3px] bg-ws-brand" />
        {currentName}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="inline-block size-2.5 rounded-[3px] bg-ws-brand-soft" />
        {previousName}
      </span>
    </span>
  )
}
