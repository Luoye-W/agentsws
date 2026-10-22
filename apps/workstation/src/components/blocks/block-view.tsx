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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ExecutionPill } from '@/components/deck/execution-note'
import { DualBarChart, DualBarLegend, WsCard } from '@/components/design'
import { ColumnFilter, FilteredLine, useTableFilters } from '@/components/design/table-filter'
import { Sparkline } from '@/components/stat-tile'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { getBlockData, rerunBlock } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate, formatValue } from '@/lib/format'
import { approvalStateLabel, cellText } from '@/lib/humanize'
import type { Lang } from '@/lib/i18n'
import { activeFilterCount, applyFilters, filterColumns } from '@/lib/table-filter'

/** 前端的组件注册表：名字对不上就不渲染（29 原则 ①）。 */
const RENDERERS = [
  'stat_tile',
  'table',
  'chart_line',
  'timeline',
  'kv',
  'markdown',
  // WP302（决策 406）
  'funnel',
  'conversion',
] as const
type Renderer = (typeof RENDERERS)[number]

const isKnown = (name: string): name is Renderer => (RENDERERS as readonly string[]).includes(name)

function ScalarBlock({ payload }: { payload: ScalarResult }): React.ReactNode {
  const { lang } = useApp()
  return (
    <div className="ws-display text-[28px] leading-none">
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

/**
 * WP224：`flag` 列——格子里非空就画一个小三角，那句话进 tooltip（盈亏线那一格的提示图标）。
 * 同 `Hint`：文案也写进 `aria-label`，读屏与测试不靠 tooltip 打开。
 */
function FlagCell({ text }: { text: string }): React.ReactNode {
  if (text === '') return null
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={text}
            data-testid="table-flag"
            data-hint={text}
            className="inline-flex text-ws-warn"
          >
            <AlertTriangle aria-hidden className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** WP224：表下面那一行小字（「没填毛利率 · 去填」）。 */
function TableFooter({ footer }: { footer: NonNullable<TableResult['footer']> }): React.ReactNode {
  return (
    <p className="px-4 pt-2 text-xs text-ws-muted-fg" data-testid="table-footer">
      {footer.text}
      {footer.href === undefined ? null : (
        <>
          {' · '}
          <Link className="font-medium text-ws-brand hover:underline" to={footer.href}>
            {footer.link_label ?? footer.href}
          </Link>
        </>
      )}
    </p>
  )
}

/** 一格怎么念（表格里画的、筛选弹层里选项显示的、搜的都是这几个字）。 */
function cellDisplay(
  c: TableResult['columns'][number],
  value: string | number | undefined,
  row: Record<string, string | number>,
  lang: Lang,
): string {
  if (c.format === 'flag') return String(value ?? '')
  // WP402：走势那一格画成小折线，不念字（也不进筛选）
  if (c.format === 'sparkline') return ''
  return c.key === 'created_at' && typeof value === 'string'
    ? formatDate(value, lang)
    : typeof value === 'number'
      ? // WP63：列自己说它是什么（不说就按金额——老积木的行为一个字不变）。
        // 件数 / 评分不是钱，渲染成 `US$2.00` 是把真话说成了假话。
        formatValue(value, c.format ?? 'money', lang, String(row.currency ?? 'USD'))
      : // WP141：渠道 / 形态 / ISO 时间这几种字串说人话（lib/humanize）
        cellText(c.key, String(value ?? ''), lang)
}

/** WP402：`sparkline` 那一格（一串数，空格隔开）→ 小折线；不到两个点不画。 */
function SparkCell({ text }: { text: string }): React.ReactNode {
  const points = text
    .split(/\s+/u)
    .map(Number)
    .filter((n) => Number.isFinite(n))
  if (points.length < 2) return null
  // WP420（自查 U20）：走势线用中性色——品牌色在深色里是绿，降价被读成「好」
  return <Sparkline points={points} testId="table-sparkline" className="h-4 w-12 text-ws-body" />
}

/**
 * WP401（决策 1090）：列声明里写了 `filter` 的列，表头多一个小漏斗（点开才有选项）；筛法按积木 id 记在本机。
 * 没写的列、没给 `tableId` 的地方一个字不变。
 *
 * WP402（决策 1145）：导出给别的面板用（竞品变化表）。`dense` = 右栏那种窄地方（格子小一号、不往两边伸）。
 */
export function BlockTable(props: {
  payload: TableResult
  tableId?: string | undefined
  dense?: boolean
  testId?: string
  /** 筛完之后最多列几行（卡里只放几条；不给 = 全列）。 */
  limit?: number
  /** 一行都没有时那一句（不给 = 「—」）。 */
  empty?: string
}): React.ReactNode {
  return <TableBlock {...props} />
}

function TableBlock({
  payload,
  tableId,
  dense = false,
  testId = 'block-table',
  limit,
  empty,
}: {
  payload: TableResult
  tableId?: string | undefined
  dense?: boolean
  testId?: string
  limit?: number | undefined
  empty?: string | undefined
}): React.ReactNode {
  const { lang } = useApp()
  const { state, setColumn, clear } = useTableFilters(tableId)
  const display = useCallback(
    (key: string, raw: string): string => {
      const c = payload.columns.find((x) => x.key === key)
      return c === undefined ? raw : cellDisplay(c, raw, {}, lang)
    },
    [payload.columns, lang],
  )
  const cols = useMemo(
    () => filterColumns(payload.columns, payload.rows, (r, k) => r[k], 'declared', display),
    [payload.columns, payload.rows, display],
  )
  const byKey = useMemo(() => new Map(cols.map((c) => [c.key, c])), [cols])
  const rows = useMemo(
    () => applyFilters(payload.rows, cols, state, (r, k) => r[k], display),
    [payload.rows, cols, state, display],
  )
  const filtering = activeFilterCount(cols, state) > 0
  const shown = limit === undefined ? rows : rows.slice(0, limit)
  if (payload.rows.length === 0)
    return (
      <>
        <p className="text-sm text-ws-muted-fg" data-testid={`${testId}-empty`}>
          {empty ?? '—'}
        </p>
        {payload.footer === undefined ? null : <TableFooter footer={payload.footer} />}
      </>
    )
  return (
    <div>
      <div className={dense ? 'overflow-x-auto' : '-mx-4 overflow-x-auto'}>
        <table className={dense ? 'w-full text-[12px]' : 'w-full text-[13px]'} data-testid={testId}>
          <thead>
            {/* WP96 画布：表头是浅灰底、**没有下边框**，靠底色分区 */}
            <tr className="bg-ws-surface text-left text-xs font-medium text-ws-muted-fg">
              {payload.columns.map((c) => {
                const col = byKey.get(c.key)
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={`${dense ? 'px-1.5 py-1.5' : 'px-4 py-3'} first:rounded-l-lg last:rounded-r-lg ${c.align === 'right' ? 'text-right' : ''}`}
                  >
                    {col === undefined ? (
                      c.label
                    ) : (
                      <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                        {c.label}
                        <ColumnFilter
                          col={col}
                          value={state[c.key]}
                          onChange={(v) => setColumn(c.key, v)}
                          display={display}
                        />
                      </span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr
                key={rowKey(row, payload.columns)}
                className="border-b border-ws-line last:border-0"
              >
                {payload.columns.map((c) => {
                  const value = row[c.key]
                  if (c.format === 'flag')
                    return (
                      <td key={c.key} className={dense ? 'px-1 py-1.5' : 'px-2 py-3.5'}>
                        <FlagCell text={String(value ?? '')} />
                      </td>
                    )
                  if (c.format === 'sparkline')
                    return (
                      <td key={c.key} className={dense ? 'px-1.5 py-1.5' : 'px-4 py-3.5'}>
                        <SparkCell text={String(value ?? '')} />
                      </td>
                    )
                  const text = cellDisplay(c, value, row, lang)
                  const href = c.link_key === undefined ? undefined : row[c.link_key]
                  return (
                    <td
                      key={c.key}
                      className={`${dense ? 'px-1.5 py-1.5' : 'px-4 py-3.5'} ${c.align === 'right' ? 'ws-num text-right' : ''}`}
                    >
                      {typeof href === 'string' && /^https?:\/\//u.test(href) ? (
                        <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
                          {text}
                        </a>
                      ) : (
                        text
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {payload.footer === undefined ? null : <TableFooter footer={payload.footer} />}
      </div>
      {/* 在表格那层横向滚动外面：表往右滚了也看得见「n / m 行 · 清空」 */}
      {filtering ? (
        <FilteredLine shown={rows.length} total={payload.rows.length} onClear={clear} />
      ) : null}
    </div>
  )
}

/**
 * WP302（决策 406）：漏斗——每一级一根条，长度按第一级比，右边是人数与「比上一级」的转化率。
 *
 * 移植自 KOLAgents（Luoye 的产品，非模板代码）：`src/components/dashboard/v2/funnel-card.tsx`
 * @ 88d74b2c 的画法（h-2 底条 + 主色条、有人至少画 4%）。口径「处于或已越过那一级」在服务端
 * （`kol.reach_funnel`），于是每一级只会比上一级少，转化率读得通。
 */
function FunnelBlock({ payload }: { payload: TableResult }): React.ReactNode {
  const { lang } = useApp()
  const [labelCol, countCol] = payload.columns
  if (payload.rows.length === 0 || labelCol === undefined || countCol === undefined)
    return <p className="text-sm text-ws-muted-fg">—</p>
  const counts = payload.rows.map((r) => Number(r[countCol.key] ?? 0))
  const max = Math.max(1, counts[0] ?? 0)
  return (
    <ol className="grid gap-2" data-testid="block-funnel">
      {payload.rows.map((row, i) => {
        const count = counts[i] ?? 0
        const prev = i > 0 ? counts[i - 1] : undefined
        const rate = prev !== undefined && prev > 0 ? Math.round((count / prev) * 100) : undefined
        return (
          <li key={String(row[labelCol.key])} className="grid gap-1" data-testid="funnel-step">
            <span className="flex items-baseline justify-between text-sm">
              <span>{String(row[labelCol.key] ?? '')}</span>
              <span className="ws-num text-xs text-ws-muted-fg">
                {formatValue(count, 'count', lang, 'USD')}
                {rate === undefined ? '' : ` · ${rate}%`}
              </span>
            </span>
            <span className="block h-2 rounded-full bg-muted">
              <span
                className="block h-2 rounded-full bg-primary"
                style={{
                  width: `${Math.max(count > 0 ? 4 : 0, Math.round((count / max) * 100))}%`,
                }}
              />
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * WP302（决策 406）：归因三态卡——没连店铺（算不出来，给去处）/ 等第一单 / 有数（一排数）。
 *
 * 三态照 KOLAgents（Luoye 的产品，非模板代码）`src/components/dashboard/v2/conversion-card.tsx`
 * @ 88d74b2c；那边有数时还有趋势图与按红人 / 活动 / 商品的分表，第一期只搬一排数——按红人的
 * 明细在「带货最好的红人」那一块，这里不再说一遍（docs/96 P5）。
 */
function ConversionBlock({ payload }: { payload: TableResult }): React.ReactNode {
  const { lang } = useApp()
  const state = payload.state ?? (payload.rows.length === 0 ? 'waiting' : 'ready')
  const metrics = payload.metrics ?? []
  return (
    <div className="flex flex-col gap-2" data-testid="block-conversion" data-state={state}>
      {state === 'ready' && metrics.length > 0 ? (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2">
          {metrics.map((m) => (
            <div
              key={m.label}
              className="flex flex-col gap-0.5 rounded-lg bg-ws-surface px-3 py-2"
              data-testid="conversion-metric"
            >
              <dt className="text-xs text-ws-muted-fg">{m.label}</dt>
              <dd className="ws-num text-base font-semibold">
                {formatValue(m.value, m.format ?? 'count', lang, m.currency ?? 'USD')}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {state === 'ready' && payload.rows.length > 0 ? <TableBlock payload={payload} /> : null}
      {state !== 'ready' && payload.footer !== undefined ? (
        <p
          className="rounded-lg border border-dashed border-ws-line px-3 py-3 text-sm text-ws-muted-fg"
          data-testid="conversion-empty"
        >
          {payload.footer.text}
          {payload.footer.href === undefined ? null : (
            <>
              {' · '}
              <Link className="font-medium text-ws-brand hover:underline" to={payload.footer.href}>
                {payload.footer.link_label ?? payload.footer.href}
              </Link>
            </>
          )}
        </p>
      ) : null}
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

/**
 * 走势块。
 *
 * WP96：**两条序列就画画布那种双色柱**（"本周 vs 上周同时"），一条或三条以上
 * 还是折线。这是按数据形状挑图形，不是按块的名字挑：两条序列就是在做对比，
 * 柱子比两条叠在一起的折线读得快；日度多序列叠柱只会糊成一片。
 */
function ChartLineBlock({ payload }: { payload: SeriesResult }): React.ReactNode {
  const { theme, lang } = useApp()
  const colors = useChartColors(theme)
  if (payload.series.length === 2) {
    const [current, previous] = payload.series
    const points = payload.x.map((x, i) => ({
      label: x,
      current: current?.points[i] ?? 0,
      previous: previous?.points[i] ?? 0,
    }))
    return (
      <div data-testid="block-chart" data-chart="dual_bar">
        <div className="mb-2 flex justify-end">
          <DualBarLegend currentName={current?.label ?? ''} previousName={previous?.label ?? ''} />
        </div>
        <DualBarChart
          data={points}
          currentName={current?.label ?? ''}
          previousName={previous?.label ?? ''}
          formatValue={(v) => formatValue(v, 'count', lang)}
        />
      </div>
    )
  }
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
  if (payload.rows.length === 0) return <p className="text-sm text-ws-muted-fg">—</p>
  return (
    <ol className="flex flex-col gap-3" data-testid="block-timeline">
      {payload.rows.map((row) => (
        <li key={row.id} className="border-l pl-3">
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-ws-muted-fg">
            <time dateTime={row.at}>{formatDate(row.at, lang)}</time>
            <span>{t(`kind.${row.kind}`)}</span>
            {/* WP415：执行过的照实说办没办成 */}
            {row.execution === undefined ? (
              <span>{approvalStateLabel(row.state, lang)}</span>
            ) : (
              <ExecutionPill view={row.execution} />
            )}
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
    return <p className="text-sm text-ws-muted-fg">{t('block.unknown')}</p>
  }
  if (data.status !== 'ok' || data.payload === undefined) {
    return (
      <p className="text-sm text-ws-muted-fg">
        {t('view.not_connected', { source: data.block.source })}
      </p>
    )
  }
  switch (data.block.component) {
    case 'stat_tile':
      return <ScalarBlock payload={data.payload as ScalarResult} />
    case 'table':
      return <TableBlock payload={data.payload as TableResult} tableId={data.block.id} />
    case 'chart_line':
      return <ChartLineBlock payload={data.payload as SeriesResult} />
    case 'funnel':
      return <FunnelBlock payload={data.payload as TableResult} />
    case 'conversion':
      return <ConversionBlock payload={data.payload as TableResult} />
    default:
      return <TimelineBlock payload={data.payload as { rows: RecordRow[] }} />
  }
}

/**
 * WP418（审计 A8）：上线检查单只有 `POST /v1/site/checklist/run` 这个口，块定义里没写 `rerun`——
 * 在这里给这一块补一个「现在检查」，别的块不受影响。块定义里自己写了 `rerun` 的以块定义为准。
 */
const LOCAL_RERUN: Readonly<Record<string, NonNullable<BlockDef['rerun']>>> = {
  'site.checklist': { path: '/v1/site/checklist/run', label: '现在检查' },
}

export const rerunOf = (block: BlockDef): BlockDef['rerun'] => block.rerun ?? LOCAL_RERUN[block.id]

/**
 * WP381：块头一个小钮（「现在体检」）——点了 `POST` 块上写的地址，跑完把这个岗位的块都刷新。
 * 只有图标，字进 tooltip（界面少字）。
 */
function RerunButton({
  rerun,
  assignment,
}: {
  rerun: NonNullable<BlockDef['rerun']>
  assignment: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const run = useMutation({
    mutationFn: () => rerunBlock(rerun.path, assignment),
    onSettled: () => client.invalidateQueries({ queryKey: ['block'] }),
  })
  /* 检查单那一块说「现在检查」，其余（体检）照旧说「现在体检」。 */
  const checklist = rerun.path === '/v1/site/checklist/run'
  const label = run.isPending
    ? t(checklist ? 'block.rerun.checklist.running' : 'block.rerun.running')
    : run.isError
      ? t(checklist ? 'block.rerun.checklist.failed' : 'block.rerun.failed')
      : t(checklist ? 'block.rerun.checklist' : 'block.rerun')
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-muted hover:text-ws-fg disabled:opacity-60"
            aria-label={label}
            data-testid="block-rerun"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            <RefreshCw className={`size-3.5 ${run.isPending ? 'animate-spin' : ''}`} aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
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
  const rerun = rerunOf(block)
  const query = useQuery({
    queryKey: ['block', block.id, range, assignment],
    queryFn: () => getBlockData(block.id, range, assignment),
  })
  /*
   * WP302（docs/96 P3）：`hide_when_empty` 的积木（交稿排期、带货最好的红人）没有一行就整块不出——
   * 没有要催的稿是好事，不占一块地方说「没有」。取数的时候也不先画骨架（免得闪一下又消失）。
   */
  if (block.hide_when_empty === true) {
    const payload = query.data?.payload as { rows?: unknown[] } | undefined
    if (query.isPending || query.data?.status !== 'ok' || (payload?.rows ?? []).length === 0)
      return null
  }
  return (
    <WsCard
      data-testid="block"
      data-block-id={block.id}
      data-block-component={block.component}
      className="flex flex-col gap-3.5 p-[18px]"
    >
      <div className="flex items-start gap-2">
        <h3 className="ws-display flex-1 text-[14px]">{block.title}</h3>
        {rerun === undefined ? null : <RerunButton rerun={rerun} assignment={assignment} />}
        {block.report_url === undefined ? null : (
          <a
            className="inline-flex items-center gap-1 text-xs text-ws-muted-fg hover:underline"
            href={block.report_url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('view.report')}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>
      {query.isPending ? <Skeleton className="h-24 w-full" /> : null}
      {query.data === undefined ? null : <BlockBody data={query.data} />}
    </WsCard>
  )
}
