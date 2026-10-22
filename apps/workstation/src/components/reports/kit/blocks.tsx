/**
 * WP438：报表积木（WP434 设计 §4 清单）——KPI 条、带对比与事件标记的趋势图、排行条、漏斗、堆叠柱、
 * 每天几根柱 + 一条线、带小走势的表格、占比条、几个数的小格子。
 *
 * 每块只有「标题 + 一行说明 + 内容 + 一行灰字来源」；缺数据源的块原位占位（{@link MissingBody}）。
 * 图表用 ECharts（与 genui 共用），配色只读 `--ws-chart-*`：一条线用品牌色，多条用校验过的四色；
 * 不用两根纵轴；每张图都有悬停提示。
 */
import type {
  BarsPayload,
  FunnelPayload,
  KpisPayload,
  RankPayload,
  ReportBlockData,
  ReportMetricValue,
  SharePayload,
  StackedPayload,
  TablePayload,
  TilesPayload,
  TrendPayload,
} from '@agentsws/deck'
import { Package } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { type ChartColors, EChart, tooltipBase } from './echart'
import { deltaOf, fmtValue, pctText, shortDay } from './format'
import { BlockShell, Delta, MissingBody, Sparkline } from './parts'

const fmtAxis = (format: string, currency?: string) => (v: number) =>
  format === 'currency'
    ? fmtValue(v, 'currency', currency ?? 'USD')
    : format === 'percent'
      ? `${v}%`
      : fmtValue(v, 'count')

function grid(): Record<string, unknown> {
  return { left: 6, right: 12, top: 26, bottom: 4, containLabel: true }
}

function axisStyle(c: ChartColors): Record<string, unknown> {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: c.axis, fontSize: 11 },
    splitLine: { lineStyle: { color: c.grid } },
  }
}

function tipRow(color: string, name: string, value: string, dashed = false): string {
  const swatch = dashed
    ? `<i style="display:inline-block;width:10px;border-top:2px dashed ${color};margin-right:6px;vertical-align:middle"></i>`
    : `<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></i>`
  return `<div style="display:flex;justify-content:space-between;gap:14px;align-items:center"><span>${swatch}${name}</span><b style="font-family:Outfit,system-ui">${value}</b></div>`
}

// ── KPI 条 ────────────────────────────────────────────────────────────

/** 一格：名字 / 大数 / 一行小字（和前一段比）。 */
export function KpiCell({
  m,
  days,
  compact,
}: {
  m: ReportMetricValue
  days?: number
  compact?: boolean
}): ReactNode {
  const { t } = useApp()
  const d = deltaOf(m)
  const cur = m.currency ?? 'USD'
  return (
    <div
      className={cn('min-w-0', compact === true ? 'px-3 py-2.5' : 'px-4 py-3.5')}
      data-testid="report-kpi"
      data-key={m.key}
      data-status={m.status}
    >
      <p className="truncate text-[12px] text-ws-muted-fg">{m.label}</p>
      {m.status === 'ok' ? (
        <>
          <p
            className={cn(
              'ws-display mt-1 mb-0.5 leading-tight text-ws-ink',
              compact === true ? 'text-[19px]' : 'text-[22px]',
            )}
            data-slot="data"
          >
            {fmtValue(m.value, m.format, cur, {
              full: m.format === 'currency' && compact !== true,
            })}
          </p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-ws-faint">
            {d === undefined ? null : <Delta {...d} />}
            {m.previous !== undefined && days !== undefined ? (
              <span data-slot="data">
                {t('report.kpi.prev', { days, value: fmtValue(m.previous, m.format, cur) })}
              </span>
            ) : m.note !== undefined ? (
              <span>{m.note}</span>
            ) : null}
          </p>
        </>
      ) : (
        <>
          <p className="ws-display mt-1 mb-0.5 text-[22px] leading-tight text-ws-faint">—</p>
          <p className="truncate text-xs text-ws-warn" data-slot="status">
            {m.status === 'not_connected'
              ? t('report.kpi.need', { name: m.need?.label ?? '' })
              : (m.note ?? t('report.kpi.empty'))}
          </p>
        </>
      )}
    </div>
  )
}

export function KpiStrip({ data, days }: { data: KpisPayload; days: number }): ReactNode {
  const n = data.items.length
  return (
    <section
      className={cn(
        'ws-card grid overflow-hidden',
        n >= 6
          ? 'grid-cols-2 @lg:grid-cols-3 @3xl:grid-cols-6'
          : n === 5
            ? 'grid-cols-2 @lg:grid-cols-3 @3xl:grid-cols-5'
            : n === 4
              ? 'grid-cols-2 @2xl:grid-cols-4'
              : 'grid-cols-3',
      )}
      data-testid="report-kpis"
    >
      {data.items.map((m, i) => (
        <div key={m.key} className={cn(i > 0 && 'border-l border-ws-line')}>
          <KpiCell m={m} days={days} />
        </div>
      ))}
    </section>
  )
}

// ── 大趋势图 ──────────────────────────────────────────────────────────

export function TrendChart({
  data,
  days,
  height = 240,
}: {
  data: TrendPayload
  days: number
  height?: number
}): ReactNode {
  const { t } = useApp()
  const fmt = fmtAxis(data.format, data.currency)
  const full = (v: number): string =>
    fmtValue(v, data.format, data.currency ?? 'USD', { full: true })
  const cur = t('report.trend.current', { days })
  const prev = t('report.trend.previous', { days })
  return (
    <EChart
      height={height}
      testId="report-trend-chart"
      label={t('report.trend.label', { name: data.label })}
      option={(c) => ({
        grid: { ...grid(), top: data.events.length > 0 ? 30 : 14 },
        tooltip: {
          ...tooltipBase(c),
          formatter: (ps: { dataIndex: number }[]) => {
            const i = ps[0]?.dataIndex ?? 0
            const ev = data.events.find((e) => e.date === data.x[i])
            return `<div style="color:${c.muted};font-size:11.5px;margin-bottom:4px">${shortDay(data.x[i] ?? '')}</div>${tipRow(c.single, cur, full(data.current[i] ?? 0))}${tipRow(c.axis, prev, full(data.previous[i] ?? 0), true)}${ev === undefined ? '' : `<div style="margin-top:4px;color:${c.info}">● ${ev.label}</div>`}`
          },
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: data.x.map(shortDay),
          ...axisStyle(c),
          splitLine: { show: false },
          axisLabel: {
            color: c.axis,
            fontSize: 11,
            interval: Math.max(0, Math.floor(data.x.length / 6) - 1),
          },
        },
        yAxis: {
          type: 'value',
          ...axisStyle(c),
          axisLabel: { color: c.axis, fontSize: 11, formatter: fmt },
          splitNumber: 4,
        },
        series: [
          {
            name: prev,
            type: 'line',
            data: data.previous,
            symbol: 'none',
            smooth: 0.25,
            lineStyle: { color: c.axis, width: 1.5, type: 'dashed' },
            z: 1,
          },
          {
            name: cur,
            type: 'line',
            data: data.current,
            symbol: 'circle',
            symbolSize: 6,
            showSymbol: false,
            smooth: 0.25,
            lineStyle: { color: c.single, width: 2 },
            itemStyle: { color: c.single },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: `${c.single}33` },
                  { offset: 1, color: `${c.single}00` },
                ],
              },
            },
            markLine:
              data.events.length === 0
                ? undefined
                : {
                    symbol: ['none', 'circle'],
                    symbolSize: 7,
                    silent: true,
                    lineStyle: { color: c.axis, type: 'dashed', width: 1, opacity: 0.7 },
                    itemStyle: { color: c.info },
                    label: {
                      position: 'end',
                      formatter: (p: { name: string }) => p.name,
                      color: c.body,
                      fontSize: 11,
                      distance: 6,
                    },
                    data: data.events.map((e) => ({ name: e.label, xAxis: shortDay(e.date) })),
                  },
            z: 2,
          },
        ],
      })}
    />
  )
}

function TrendLegend({ days }: { days: number }): ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-wrap gap-3.5 text-[12px] text-ws-muted-fg">
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="h-0.5 w-3.5 rounded-[1px] bg-ws-chart-single" />
        {t('report.trend.current', { days })}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i aria-hidden className="w-3.5 border-t-2 border-dashed border-[var(--ws-chart-axis)]" />
        {t('report.trend.previous', { days })}
      </span>
    </div>
  )
}

// ── 排行条 / 漏斗 / 占比 / 小格子（HTML，不上图表库） ────────────────────

export function RankBars({ data }: { data: RankPayload }): ReactNode {
  return (
    <ul className="flex flex-col gap-[11px]" data-testid="report-rank">
      {data.rows.map((r) => (
        <li key={r.label}>
          <div className="mb-[5px] flex justify-between gap-2 text-[13px]">
            <span className="flex min-w-0 items-center gap-1.5 text-ws-ink">
              <span className="truncate">{r.label}</span>
              {r.tag === undefined ? null : (
                <span className="inline-flex h-4 items-center rounded-[4px] bg-ws-tint px-1 text-xs font-semibold text-ws-brand-ink">
                  {r.tag}
                </span>
              )}
            </span>
            <span className="ws-display shrink-0 font-normal text-ws-muted-fg" data-slot="data">
              <b className="font-semibold text-ws-ink">
                {fmtValue(r.value, data.format, data.currency ?? 'USD', { full: true })}
              </b>
              {r.note === undefined ? null : ` · ${r.note}`}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ws-secondary">
            <div
              className="h-full rounded-full bg-ws-chart-single"
              style={{ width: `${Math.max(2, Math.round(r.share * 100))}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function FunnelBars({ data }: { data: FunnelPayload }): ReactNode {
  const max = Math.max(...data.steps.map((s) => s.value), 1)
  const worst = data.steps
    .filter((s) => s.rate !== undefined)
    .sort((a, b) => (a.rate ?? 0) - (b.rate ?? 0))[0]
  return (
    <ol className="flex flex-col gap-2" data-testid="report-funnel">
      {data.steps.map((s) => (
        <li
          key={s.label}
          className="grid grid-cols-[64px_1fr_58px_52px] items-center gap-2.5 text-[13px]"
        >
          <span className="truncate text-ws-ink">{s.label}</span>
          <span className="h-[22px] overflow-hidden rounded-[6px] bg-ws-secondary">
            <span
              className="block h-full min-w-1 rounded-[6px] bg-ws-chart-single"
              style={{ width: `${(s.value / max) * 100}%` }}
            />
          </span>
          <span className="ws-display text-right font-semibold" data-slot="data">
            {fmtValue(s.value, 'count', 'USD', { full: true })}
          </span>
          <span
            className={cn(
              'ws-display text-right',
              s === worst ? 'font-semibold text-ws-bad' : 'text-ws-muted-fg',
            )}
            data-slot="data"
          >
            {s.rate === undefined ? '' : `${s.rate}%`}
          </span>
        </li>
      ))}
    </ol>
  )
}

const SHARE_TONE: Record<string, string> = {
  good: 'bg-ws-good text-ws-brand-fg dark:text-ws-paper',
  neutral: 'bg-[var(--ws-chart-axis)] text-white dark:text-ws-paper',
  bad: 'bg-ws-bad text-white dark:text-ws-paper',
}

export function ShareBar({ data }: { data: SharePayload }): ReactNode {
  const parts = data.parts.filter((p) => p.value > 0)
  return (
    <div data-testid="report-share">
      <div className="flex h-7 gap-0.5 overflow-hidden rounded-[8px]">
        {parts.map((p) => {
          const pct = Math.round((p.value / Math.max(1, data.total)) * 100)
          return (
            <div
              key={p.key}
              title={`${p.label} ${pct}%`}
              className={cn(
                'ws-display grid min-w-6 place-items-center overflow-hidden text-xs font-semibold whitespace-nowrap',
                SHARE_TONE[p.tone],
              )}
              style={{ flexGrow: p.value, flexBasis: 0 }}
            >
              {pct >= 12 ? `${p.label} ${pct}%` : pct >= 6 ? `${pct}%` : ''}
            </div>
          )
        })}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]" data-slot="data">
        {data.parts.map((p) => (
          <li key={p.key} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-ws-body">
              <i aria-hidden className={cn('size-2 rounded-[2px]', SHARE_TONE[p.tone])} />
              {p.label}
            </span>
            <b className="ws-display font-semibold text-ws-ink">{p.value}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TilesGrid({ data }: { data: TilesPayload }): ReactNode {
  return (
    <div className="grid grid-cols-2 gap-2.5" data-testid="report-tiles">
      {data.items.map((it) => (
        <div key={it.label} className="rounded-lg bg-ws-surface px-3 py-2.5">
          <p className="text-xs text-ws-muted-fg">{it.label}</p>
          <p
            className={cn(
              'ws-display text-[19px]',
              it.tone === 'warn' ? 'text-ws-warn' : 'text-ws-ink',
            )}
            data-slot="data"
          >
            {fmtValue(it.value, it.format)}
          </p>
        </div>
      ))}
    </div>
  )
}

// ── 表格（带小走势、涨跌列） ──────────────────────────────────────────

export function DataTable({ data }: { data: TablePayload }): ReactNode {
  const cur = data.currency ?? 'USD'
  const first = data.columns[0]?.key
  const productish = first === 'product'
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full border-collapse text-[13px]" data-testid="report-table">
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th
                key={c.key}
                className={cn(
                  'border-b border-ws-line pb-2 text-xs font-medium whitespace-nowrap text-ws-muted-fg',
                  c.align === 'right' ? 'pl-2.5 text-right' : 'text-left',
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 服务端排好序的表，第几行就是身份
            <tr key={i} className="border-b border-ws-line last:border-b-0">
              {data.columns.map((c) => {
                const v = row[c.key]
                const right = c.align === 'right'
                let body: ReactNode
                if (c.format === 'spark')
                  body = Array.isArray(v) ? (
                    <span className="inline-flex justify-end">
                      <Sparkline data={v} width={48} height={20} area={false} />
                    </span>
                  ) : null
                else if (c.format === 'delta') {
                  const p = pctText(typeof v === 'number' ? v : null)
                  body = (
                    <span
                      className={cn(
                        'ws-display font-semibold',
                        p.good === undefined
                          ? 'text-ws-muted-fg'
                          : p.good
                            ? 'text-ws-good'
                            : 'text-ws-bad',
                      )}
                    >
                      {p.text}
                    </span>
                  )
                } else if (typeof v === 'number')
                  body = (
                    <span className="ws-display">
                      {fmtValue(v, c.format === 'text' ? 'count' : (c.format ?? 'count'), cur, {
                        full: true,
                      })}
                    </span>
                  )
                else if (c.key === first && productish)
                  body = (
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-ws-secondary text-ws-muted-fg">
                        <Package aria-hidden className="size-3.5" />
                      </span>
                      <span className="truncate">{String(v ?? '')}</span>
                    </span>
                  )
                else if (c.key === first && typeof row.sub === 'string')
                  body = (
                    <span className="block min-w-0">
                      <span className="block truncate">{String(v ?? '')}</span>
                      <span className="block text-xs text-ws-muted-fg">{row.sub}</span>
                    </span>
                  )
                else body = v === null || v === undefined ? '—' : String(v)
                return (
                  <td
                    key={c.key}
                    className={cn(
                      'py-[9px] text-ws-ink',
                      right ? 'pl-2.5 text-right whitespace-nowrap' : 'max-w-[220px]',
                    )}
                    data-slot="data"
                  >
                    {body}
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

// ── 堆叠柱 / 每天几根柱 + 一条线（ECharts） ─────────────────────────────

export function StackedChart({
  data,
  height = 210,
}: {
  data: StackedPayload
  height?: number
}): ReactNode {
  const { t } = useApp()
  return (
    <EChart
      height={height}
      testId="report-stacked-chart"
      label={t('report.stacked.label', { names: data.series.map((s) => s.label).join(' / ') })}
      option={(c) => ({
        grid: { ...grid(), top: 10 },
        tooltip: {
          ...tooltipBase(c),
          axisPointer: { type: 'shadow', shadowStyle: { color: `${c.axis}14` } },
        },
        xAxis: { type: 'category', data: data.x, ...axisStyle(c), splitLine: { show: false } },
        yAxis: { type: 'value', ...axisStyle(c), splitNumber: 4 },
        series: data.series.map((s, i) => ({
          name: s.label,
          type: 'bar',
          stack: 'all',
          data: s.points,
          barMaxWidth: 34,
          itemStyle: {
            color: c.series[i % 4],
            borderRadius: i === data.series.length - 1 ? [4, 4, 0, 0] : 0,
          },
        })),
      })}
    />
  )
}

export function BarsChart({
  data,
  height = 230,
}: {
  data: BarsPayload
  height?: number
}): ReactNode {
  const { t } = useApp()
  const fmt = fmtAxis(data.format)
  return (
    <EChart
      height={height}
      testId="report-bars-chart"
      label={t('report.bars.label', { name: data.bars.label })}
      option={(c) => ({
        grid: { ...grid(), top: 10 },
        tooltip: {
          ...tooltipBase(c),
          axisPointer: { type: 'shadow', shadowStyle: { color: `${c.axis}14` } },
        },
        xAxis: {
          type: 'category',
          data: data.x,
          ...axisStyle(c),
          splitLine: { show: false },
          axisLabel: {
            color: c.axis,
            fontSize: 11,
            interval: data.x.length > 14 ? Math.floor(data.x.length / 7) : 0,
          },
        },
        yAxis: {
          type: 'value',
          ...axisStyle(c),
          axisLabel: { color: c.axis, fontSize: 11, formatter: fmt },
          splitNumber: 4,
        },
        series: [
          {
            name: data.bars.label,
            type: 'bar',
            data: data.bars.points.map((v, i) => ({
              value: v,
              itemStyle: {
                color:
                  data.bars.tones === undefined
                    ? data.line === undefined
                      ? c.single === '#76fb91'
                        ? c.series[0]
                        : c.single
                      : c.series[1]
                    : data.bars.tones[i] === 'a'
                      ? c.series[0]
                      : c.series[1],
                borderRadius: [3, 3, 0, 0],
              },
            })),
            barMaxWidth: data.x.length > 14 ? 12 : 36,
          },
          ...(data.line === undefined
            ? []
            : [
                {
                  name: data.line.label,
                  type: 'line',
                  data: data.line.points,
                  symbol: 'circle',
                  symbolSize: 5,
                  lineStyle: { color: c.series[2], width: 1.8 },
                  itemStyle: { color: c.series[2], borderColor: c.card, borderWidth: 1 },
                  z: 3,
                },
              ]),
        ],
      })}
    />
  )
}

function BarsLegend({ data }: { data: BarsPayload }): ReactNode {
  const items: { label: string; color: string; line?: boolean }[] =
    data.legend !== undefined
      ? [
          { label: data.legend.a, color: 'var(--ws-chart-1)' },
          ...(data.legend.b === undefined
            ? []
            : [{ label: data.legend.b, color: 'var(--ws-chart-2)' }]),
        ]
      : data.line === undefined
        ? []
        : [
            { label: data.bars.label, color: 'var(--ws-chart-2)' },
            { label: data.line.label, color: 'var(--ws-chart-3)', line: true },
          ]
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-3.5 text-[12px] text-ws-muted-fg">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <i
            aria-hidden
            className={cn(
              'inline-block',
              it.line === true ? 'h-0.5 w-3.5 rounded-[1px]' : 'size-2.5 rounded-[3px]',
            )}
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  )
}

function StackedLegend({ data }: { data: StackedPayload }): ReactNode {
  return (
    <div className="flex flex-wrap gap-3.5 text-[12px] text-ws-muted-fg">
      {data.series.map((s, i) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <i
            aria-hidden
            className="size-2.5 rounded-[3px]"
            style={{ background: `var(--ws-chart-${(i % 4) + 1})` }}
          />
          {s.label}
        </span>
      ))}
    </div>
  )
}

// ── 一块（按种类画） ──────────────────────────────────────────────────

export function ReportBlock({ block, days }: { block: ReportBlockData; days: number }): ReactNode {
  if (block.kind === 'kpis') {
    const p = block.payload as KpisPayload | undefined
    return p === undefined ? null : <KpiStrip data={p} days={days} />
  }
  if (block.status !== 'ok' || block.payload === undefined)
    return (
      <BlockShell block={block}>
        <MissingBody
          status={block.status === 'ok' ? 'empty' : block.status}
          {...(block.needs === undefined ? {} : { needs: block.needs })}
          {...(block.note === undefined ? {} : { note: block.note })}
          {...(block.title === undefined ? {} : { title: block.title })}
        />
      </BlockShell>
    )
  switch (block.kind) {
    case 'trend':
      return (
        <BlockShell block={block} right={<TrendLegend days={days} />}>
          <TrendChart data={block.payload as TrendPayload} days={days} />
        </BlockShell>
      )
    case 'rank':
      return (
        <BlockShell block={block}>
          <RankBars data={block.payload as RankPayload} />
        </BlockShell>
      )
    case 'funnel':
      return (
        <BlockShell block={block}>
          <FunnelBars data={block.payload as FunnelPayload} />
        </BlockShell>
      )
    case 'stacked':
      return (
        <BlockShell block={block} right={<StackedLegend data={block.payload as StackedPayload} />}>
          <StackedChart data={block.payload as StackedPayload} />
        </BlockShell>
      )
    case 'bars':
      return (
        <BlockShell block={block} right={<BarsLegend data={block.payload as BarsPayload} />}>
          <BarsChart data={block.payload as BarsPayload} />
        </BlockShell>
      )
    case 'share':
      return (
        <BlockShell block={block}>
          <ShareBar data={block.payload as SharePayload} />
        </BlockShell>
      )
    case 'tiles':
      return (
        <BlockShell block={block}>
          <TilesGrid data={block.payload as TilesPayload} />
        </BlockShell>
      )
    default:
      return (
        <BlockShell block={block}>
          <DataTable data={block.payload as TablePayload} />
        </BlockShell>
      )
  }
}
