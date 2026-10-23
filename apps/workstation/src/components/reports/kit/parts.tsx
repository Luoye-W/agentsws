/**
 * WP438：报表积木里的小件——火花线、涨跌、块外壳、来源那一行、缺连接占位、结论卡。
 * 对话里的小报表、看板那一行、第三栏的整页都用这一套（决策 847：组件化、对话和面板同一套组件）。
 */
import type { ReportBlockData, ReportConclusion, ReportNeed, ReportSourceRef } from '@agentsws/deck'
import {
  BarChart3,
  Database,
  Globe,
  LineChart,
  MessagesSquare,
  Plug,
  Search,
  Sparkles,
  Store,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { connectServiceFor } from '@/components/connections/links'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { boldParts, type DeltaTone } from './format'

/** 小走势（内联 SVG，不上图表库）：一条线 + 很淡的面积 + 末端一个点。 */
export function Sparkline({
  data,
  width = 72,
  height = 26,
  color = 'var(--ws-chart-single)',
  area = true,
  testId,
}: {
  data: readonly number[]
  width?: number
  height?: number
  color?: string
  area?: boolean
  testId?: string
}): ReactNode {
  if (data.length < 2) return <span style={{ width, height }} className="inline-block shrink-0" />
  const max = Math.max(...data)
  const min = Math.min(...data)
  const sx = (i: number): number => 1 + (i / (data.length - 1)) * (width - 4)
  const sy = (v: number): number => height - 3 - ((v - min) / (max - min || 1)) * (height - 6)
  const d = data
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`)
    .join('')
  const last = data[data.length - 1] ?? 0
  return (
    <svg
      aria-hidden
      data-testid={testId}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
    >
      {area ? (
        <path
          d={`${d}L${sx(data.length - 1)},${height}L${sx(0)},${height}Z`}
          fill={color}
          opacity={0.12}
        />
      ) : null}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={sx(data.length - 1)} cy={sy(last)} r={2.4} fill={color} />
    </svg>
  )
}

/** 涨跌那一小截（绿 = 好事，红 = 坏事；越小越好的指标由调用方传 `good`）。 */
export function Delta({
  text,
  tone,
  good,
  className,
}: {
  text: string
  tone: DeltaTone
  good: boolean
  className?: string
}): ReactNode {
  return (
    <span
      data-slot="data"
      data-tone={tone}
      className={cn(
        'ws-display inline-flex items-center text-[12px] font-semibold',
        tone === 'flat' ? 'text-ws-muted-fg' : good ? 'text-ws-good' : 'text-ws-bad',
        className,
      )}
    >
      {text}
    </span>
  )
}

const SOURCE_ICON: Record<string, typeof Store> = {
  shop: Store,
  ga4: LineChart,
  gsc: Search,
  approvals: Database,
  pr: MessagesSquare,
  google_alerts: Globe,
  social: Users,
  kol: Users,
  ads: BarChart3,
  ads_meta: BarChart3,
  ads_google: BarChart3,
}

/** 块底那一行灰字：数据来自哪（店铺后台 · GA4）。 */
export function SourceLine({ sources }: { sources: readonly ReportSourceRef[] }): ReactNode {
  if (sources.length === 0) return null
  return (
    <p
      className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ws-faint"
      data-testid="report-source"
    >
      {sources.map((s, i) => {
        const Icon = SOURCE_ICON[s.id] ?? Database
        return (
          <span key={s.id} className="inline-flex items-center gap-1">
            {i > 0 ? <span aria-hidden>·</span> : null}
            <Icon aria-hidden className="size-3" />
            {s.label}
          </span>
        )
      })}
    </p>
  )
}

/** 一块的外壳：标题 + 一行说明 + 内容 + 来源（块里不堆按钮）。 */
export function BlockShell({
  block,
  right,
  children,
  className,
}: {
  block: Pick<ReportBlockData, 'id' | 'kind' | 'title' | 'subtitle' | 'sources' | 'status'>
  right?: ReactNode
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <section
      className={cn('ws-card relative flex min-w-0 flex-col px-5 py-[18px]', className)}
      data-testid="report-block"
      data-block={block.id}
      data-kind={block.kind}
      data-status={block.status}
    >
      {block.title === undefined && right === undefined ? null : (
        <header className="mb-3 flex items-start gap-2.5">
          <div className="min-w-0">
            {block.title === undefined ? null : (
              <h3 className="text-[14px] font-semibold text-ws-ink">{block.title}</h3>
            )}
            {block.subtitle === undefined ? null : (
              <p className="mt-0.5 text-[12px] text-ws-muted-fg">{block.subtitle}</p>
            )}
          </div>
          {right === undefined ? null : (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div>
          )}
        </header>
      )}
      <div className="min-w-0 flex-1">{children}</div>
      <SourceLine sources={block.sources} />
    </section>
  )
}

/** 中英之间留空格：以英文 / 数字结尾的名字后面接中文时补一个空格（「GA4 还没连」）。 */
export const spaced = (s: string): string => (/[A-Za-z0-9]$/.test(s) ? `${s} ` : s)

/** 一段很淡的灰色占位图（缺数据源那一块的背景）。 */
function GhostChart(): ReactNode {
  const pts = [18, 26, 22, 34, 30, 42, 38, 47, 44, 52]
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${i * 36},${70 - v}`).join('')
  return (
    <svg aria-hidden viewBox="0 0 324 80" className="h-[150px] w-full opacity-25 grayscale">
      {[16, 36, 56, 76].map((y) => (
        <line key={y} x1={0} x2={324} y1={y} y2={y} stroke="var(--ws-chart-grid)" />
      ))}
      <path d={d} fill="none" stroke="var(--ws-chart-axis)" strokeWidth={2} />
    </svg>
  )
}

/**
 * 缺数据源的那一块：原位放淡灰占位图，中间一句话 + 就地连接（决策 690）。只占这一块，不满屏都是「去连接」。
 * `empty`（连上了但上游没给那一格）只说为什么、不给按钮。
 */
export function MissingBody({
  status,
  needs,
  note,
  title,
}: {
  status: 'not_connected' | 'empty'
  needs?: readonly ReportNeed[]
  note?: string
  title?: string
}): ReactNode {
  const { t } = useApp()
  const openConnect = useOpenConnect()
  const list = needs ?? []
  const text =
    status === 'not_connected'
      ? t('report.missing.connect', {
          what: spaced(list.map((n) => n.label).join(' / ')),
          block: title ?? t('report.missing.block'),
        })
      : (note ?? t('report.missing.empty'))
  return (
    <div className="relative min-h-[170px]" data-testid="report-missing" data-status={status}>
      <GhostChart />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center">
        <div className="pointer-events-none absolute top-1/2 left-1/2 h-[120px] w-[min(340px,100%)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-ws-card shadow-[0_0_40px_30px_var(--ws-card)]" />
        {status === 'not_connected' ? (
          <Plug aria-hidden className="relative size-4 text-ws-muted-fg" />
        ) : null}
        <p className="relative max-w-[300px] text-[13px] text-ws-body" data-slot="status">
          {text}
        </p>
        {status === 'not_connected' && list.length > 0 ? (
          <div className="relative flex flex-wrap justify-center gap-2">
            {list.map((n, i) => (
              <button
                key={n.source}
                type="button"
                data-testid="report-connect"
                data-source={n.source}
                className={cn(
                  'inline-flex h-[26px] items-center rounded-md px-2.5 text-[12px] font-medium',
                  i === 0
                    ? 'bg-ws-brand text-ws-brand-fg hover:brightness-95'
                    : 'bg-ws-secondary text-ws-ink hover:brightness-95',
                )}
                onClick={() => {
                  openConnect(connectServiceFor(n.source))
                }}
              >
                {t('report.connect.one', { name: n.label })}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 结论卡：三句（最后一句「要留意」）+ 一个动作钮（点了变成一张卡）。 */
export function ConclusionCard({
  conclusion,
  onAction,
  busy,
}: {
  conclusion: ReportConclusion
  onAction?: (prompt: string) => void
  busy?: boolean
}): ReactNode {
  const { t } = useApp()
  return (
    <section
      className="ws-card grid grid-cols-[26px_1fr] items-start gap-3 px-[18px] py-4 sm:grid-cols-[26px_1fr_auto]"
      data-testid="report-conclusion"
      data-by={conclusion.by}
    >
      <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-ws-tint text-ws-brand-ink">
        <Sparkles aria-hidden className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="mb-1.5 text-[12px] text-ws-muted-fg">
          {conclusion.by === 'ai' ? t('report.conclusion.ai') : t('report.conclusion.rules')}
        </p>
        <ul className="flex flex-col gap-1.5 text-[13px] text-ws-body" data-slot="data">
          {conclusion.lines.map((line) => (
            <li key={line}>
              {boldParts(line).map((p, i) =>
                p.bold ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同一句里的几段，顺序就是身份
                  <b key={i} className="font-semibold text-ws-ink">
                    {p.text}
                  </b>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                  <span key={i}>{p.text}</span>
                ),
              )}
            </li>
          ))}
        </ul>
      </div>
      {conclusion.action === undefined || onAction === undefined ? null : (
        <button
          type="button"
          disabled={busy === true}
          data-testid="report-action"
          className="col-start-2 inline-flex h-[26px] items-center gap-1.5 self-start justify-self-start rounded-md bg-ws-secondary px-2.5 text-[12px] font-medium text-ws-ink hover:brightness-95 disabled:opacity-60 sm:col-start-3"
          onClick={() => {
            if (conclusion.action !== undefined) onAction(conclusion.action.prompt)
          }}
        >
          <Sparkles aria-hidden className="size-3" />
          {conclusion.action.label}
        </button>
      )}
    </section>
  )
}

/** 名字后面那个小「AI」标签（AI 做的报表）。 */
export function AiTag(): ReactNode {
  return (
    <span
      data-testid="report-ai-tag"
      data-slot="badge"
      className="inline-flex h-4 shrink-0 items-center rounded-[4px] bg-ws-info-bg px-[5px] text-ws-tiny font-semibold text-ws-info"
    >
      AI
    </span>
  )
}
