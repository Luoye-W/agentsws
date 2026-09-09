/**
 * 29 §2 的前端那一半：**按 component 名查注册表渲染，未知 → UnknownBlock**。
 *
 * payload 已经在服务端过了 payload_schema，这里只管画。
 */
import type {
  BlockData,
  BlockDef,
  RecordRow,
  ScalarResult,
  SeriesResult,
  TableResult,
} from '@agentsws/deck'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useMemo } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getBlockData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate, formatValue } from '@/lib/format'

/** 前端的组件注册表：名字对不上就不渲染（29 原则 ①）。 */
const RENDERERS = ['stat_tile', 'table', 'chart_line', 'timeline', 'kv', 'markdown'] as const
type Renderer = (typeof RENDERERS)[number]

const isKnown = (name: string): name is Renderer => (RENDERERS as readonly string[]).includes(name)

function ScalarBlock({ payload }: { payload: ScalarResult }): React.ReactNode {
  const { lang } = useApp()
  return (
    <div className="text-2xl font-semibold tabular-nums">
      {formatValue(
        payload.value,
        payload.currency === undefined ? 'count' : 'money',
        lang,
        payload.currency,
      )}
    </div>
  )
}

/** 行的稳定 key：把每一列的值拼起来（服务端给的表没有 id 列）。 */
function rowKey(row: Record<string, string | number>, columns: TableResult['columns']): string {
  return columns.map((c) => String(row[c.key] ?? '')).join('|')
}

function TableBlock({ payload }: { payload: TableResult }): React.ReactNode {
  const { lang } = useApp()
  if (payload.rows.length === 0) return <p className="text-sm text-muted-foreground">—</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="block-table">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            {payload.columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`py-1.5 pr-3 ${c.align === 'right' ? 'text-right' : ''}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {payload.rows.map((row) => (
            <tr key={rowKey(row, payload.columns)} className="border-b last:border-0">
              {payload.columns.map((c) => {
                const value = row[c.key]
                const text =
                  c.key === 'created_at' && typeof value === 'string'
                    ? formatDate(value, lang)
                    : typeof value === 'number'
                      ? formatValue(value, 'money', lang, String(row.currency ?? 'USD'))
                      : String(value ?? '')
                return (
                  <td
                    key={c.key}
                    className={`py-1.5 pr-3 ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}
                  >
                    {text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * recharts 把颜色写成 SVG 的**表现属性**，而表现属性里的 `var(--x)` 浏览器不解析——
 * 写进去等于没写（线会消失）。所以在这里按当前主题把 token 读成真颜色再传。
 */
function useChartColors(theme: string): { grid: string; axis: string; series: string[] } {
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme 不进闭包，只当「重读 CSS 变量」的信号——深浅色是两套 token
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
      series: [1, 2, 3, 4, 5].map((i) => read(`--chart-${i}`, '#888')),
    }
  }, [theme])
}

function ChartLineBlock({ payload }: { payload: SeriesResult }): React.ReactNode {
  const { theme } = useApp()
  const colors = useChartColors(theme)
  const rows = payload.x.map((x, i) => {
    const row: Record<string, string | number> = { x }
    for (const s of payload.series) row[s.key] = s.points[i] ?? 0
    return row
  })
  return (
    <div className="h-56 w-full" data-testid="block-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
          <XAxis dataKey="x" tick={{ fontSize: 11, fill: colors.axis }} stroke={colors.grid} />
          <YAxis tick={{ fontSize: 11, fill: colors.axis }} stroke={colors.grid} />
          <ReTooltip
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          {payload.series.map((s, i) => (
            <Line
              key={s.key}
              // 按天分桶的数据不做平滑：曲线插值会画出根本不存在的中间值
              type="linear"
              dataKey={s.key}
              name={s.label}
              stroke={colors.series[i % 5]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function TimelineBlock({ payload }: { payload: { rows: RecordRow[] } }): React.ReactNode {
  const { t, lang } = useApp()
  if (payload.rows.length === 0) return <p className="text-sm text-muted-foreground">—</p>
  return (
    <ol className="flex flex-col gap-3" data-testid="block-timeline">
      {payload.rows.map((row) => (
        <li key={row.id} className="border-l pl-3">
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
            <time dateTime={row.at}>{formatDate(row.at, lang)}</time>
            <span>{t(`kind.${row.kind}`)}</span>
            <span className="font-mono">{row.state}</span>
          </div>
          <div className="text-sm">{row.title}</div>
        </li>
      ))}
    </ol>
  )
}

export function BlockBody({ data }: { data: BlockData }): React.ReactNode {
  const { t } = useApp()
  if (!isKnown(data.block.component)) {
    return <p className="text-sm text-muted-foreground">{t('block.unknown')}</p>
  }
  if (data.status !== 'ok' || data.payload === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('view.not_connected', { source: data.block.source })}
      </p>
    )
  }
  switch (data.block.component) {
    case 'stat_tile':
      return <ScalarBlock payload={data.payload as ScalarResult} />
    case 'table':
      return <TableBlock payload={data.payload as TableResult} />
    case 'chart_line':
      return <ChartLineBlock payload={data.payload as SeriesResult} />
    default:
      return <TimelineBlock payload={data.payload as { rows: RecordRow[] }} />
  }
}

/** 一个积木 = 一次 `GET /v1/blocks/{id}/data`。 */
export function BlockCard({
  block,
  range,
  assignment,
}: {
  block: BlockDef
  range: 'yesterday' | 'last_7d'
  assignment: string
}): React.ReactNode {
  const { t } = useApp()
  const query = useQuery({
    queryKey: ['block', block.id, range, assignment],
    queryFn: () => getBlockData(block.id, range, assignment),
  })
  return (
    <Card data-testid="block" data-block-id={block.id} data-block-component={block.component}>
      <CardHeader>
        <CardTitle className="text-sm">{block.title}</CardTitle>
        {block.report_url === undefined ? null : (
          <a
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
            href={block.report_url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('view.report')}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </CardHeader>
      <CardContent>
        {query.isPending ? <Skeleton className="h-24 w-full" /> : null}
        {query.data === undefined ? null : <BlockBody data={query.data} />}
      </CardContent>
    </Card>
  )
}
