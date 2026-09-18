/**
 * 总览（65 §4）。
 *
 * 排版顺序就是"先看什么"的顺序：**亏本告警在最上面**（0 行时整张卡不渲染——
 * 一张永远显示"一切正常"的卡，人三天之后就不看了），然后 KPI，然后趋势，
 * 最后三张分组表与成本 Top 10。
 */

import {
  Activity,
  AlertTriangle,
  Banknote,
  Building2,
  Coins,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Empty, Kpi, Note, SectionTitle, Spinner, StatusPill, WsCard } from '@/components/design'
import { PageHeader } from '@/components/layout'
import { useApp, useQuery } from '@/lib/app'
import { cny, compact, credits } from '@/lib/format'
import type { Key } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface Breakdown {
  key: string
  calls: number
  quantity: number
  credits: number
  cost_micros: number
  input_tokens: number
  output_tokens: number
  margin_micros: number
}

interface Overview {
  window_days: number
  kpis: { key: string; value: number; delta_7d?: number; delta_30d?: number }[]
  trend: { day: string; credits: number; cost_micros: number; calls: number }[]
  by_capability: Breakdown[]
  by_provider: Breakdown[]
  by_model: Breakdown[]
  top_orgs: (Breakdown & { org_name: string | null })[]
  loss: { rows: number; loss_micros: number; worst_micros: number }
  charge_health: { status: string; rows: number }[]
  cost_table: { as_of: string; needs_review: boolean }
}

const KPI_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  accounts: Users,
  active_orgs_7d: Building2,
  revenue_credits_30d: Coins,
  cost_micros_30d: Banknote,
  margin_micros_30d: TrendingUp,
  calls: Activity,
}

/** 每个 KPI 怎么显示：是积分、是钱、还是一个纯计数。 */
const KPI_KIND: Record<string, 'count' | 'credits' | 'micros'> = {
  accounts: 'count',
  active_orgs_7d: 'count',
  revenue_credits_30d: 'credits',
  cost_micros_30d: 'micros',
  margin_micros_30d: 'micros',
  input_tokens: 'count',
  output_tokens: 'count',
  calls: 'count',
  outstanding_credits: 'credits',
  outstanding_granted: 'credits',
  outstanding_purchased: 'credits',
}

const CHARGE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  charged: 'good',
  skipped: 'neutral',
  admin_exempt: 'neutral',
  insufficient_credits: 'warn',
  error: 'bad',
}

export function OverviewPage(): React.ReactNode {
  const { t, lang } = useApp()
  const [params, setParams] = useSearchParams()
  const days = Number(params.get('window') ?? 30)
  const windowDays = [7, 30, 90].includes(days) ? days : 30
  const { data, loading } = useQuery<Overview>(`/v1/admin/overview?window=${String(windowDays)}`)

  return (
    <>
      <PageHeader
        title={t('nav.overview')}
        right={
          <div className="flex gap-1 rounded-lg bg-ws-surface p-0.5">
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(params)
                  next.set('window', String(n))
                  setParams(next, { replace: true })
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs',
                  windowDays === n ? 'bg-ws-card text-ws-ink shadow-ws' : 'text-ws-muted-fg',
                )}
              >
                {t(`window.${n}` as Key)}
              </button>
            ))}
          </div>
        }
        note={
          data?.cost_table.needs_review === true ? (
            <Note tone="warn">{t('overview.cost_review', { as_of: data.cost_table.as_of })}</Note>
          ) : undefined
        }
      />

      {loading && data === undefined && <Spinner label={t('loading')} />}
      {data !== undefined && (
        <div className="flex flex-col gap-5">
          {/*
           * 亏本告警：**0 行就整张卡不渲染**。这是 KOLAgents 那条——一张永远绿着的
           * 卡等于没有卡，而真出事那天它会淹没在一排"正常"里。
           */}
          {data.loss.rows > 0 && (
            <WsCard className="flex items-start gap-3 border-0 bg-ws-bad-bg p-4 text-ws-bad">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="ws-display text-[15px]">{t('overview.loss.title')}</p>
                <p className="mt-1 text-[13px]">
                  {t('overview.loss.body', {
                    rows: data.loss.rows,
                    loss: cny(data.loss.loss_micros),
                    worst: cny(data.loss.worst_micros),
                  })}
                </p>
              </div>
            </WsCard>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {data.kpis.map((kpi) => {
              const kind = KPI_KIND[kpi.key] ?? 'count'
              const Icon = KPI_ICONS[kpi.key]
              const value =
                kind === 'micros'
                  ? cny(kpi.value)
                  : kind === 'credits'
                    ? credits(kpi.value)
                    : compact(kpi.value, lang)
              const delta =
                kpi.delta_7d === undefined && kpi.delta_30d === undefined
                  ? undefined
                  : `+${String(kpi.delta_7d ?? 0)}/7d · +${String(kpi.delta_30d ?? 0)}/30d`
              return (
                <Kpi
                  key={kpi.key}
                  label={t(`kpi.${kpi.key}` as Key)}
                  value={value}
                  tone={kpi.key === 'margin_micros_30d' && kpi.value < 0 ? 'bad' : 'brand'}
                  {...(delta === undefined ? {} : { delta })}
                  {...(Icon === undefined ? {} : { icon: <Icon className="size-3.5" /> })}
                />
              )
            })}
          </div>

          <WsCard className="p-4">
            <SectionTitle
              right={
                <div className="flex items-center gap-3 text-xs text-ws-muted-fg">
                  <LegendDot className="bg-ws-brand" label={t('overview.trend.credits')} />
                  <LegendDot className="bg-ws-info" label={t('overview.trend.cost')} />
                </div>
              }
            >
              {t('overview.trend')}
            </SectionTitle>
            <div className="h-[220px]">
              {data.trend.length === 0 ? (
                <Empty label={t('empty')} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={data.trend.map((p) => ({
                      day: p.day.slice(5),
                      credits: p.credits,
                      cost: p.cost_micros / 1_000_000,
                    }))}
                    margin={{ top: 4, right: 8, bottom: 0, left: -18 }}
                  >
                    <defs>
                      <linearGradient id="grad-credits" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--ws-brand)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--ws-brand)" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="grad-cost" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--ws-info)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="var(--ws-info)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--ws-line)" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 11, fill: 'var(--ws-muted-fg)' }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={16}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'var(--ws-muted-fg)' }}
                      tickLine={false}
                      axisLine={false}
                      width={52}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--ws-card)',
                        border: '1px solid var(--ws-line)',
                        borderRadius: 12,
                        fontSize: 12,
                        color: 'var(--ws-ink)',
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="credits"
                      name={t('overview.trend.credits')}
                      stroke="var(--ws-brand)"
                      strokeWidth={2}
                      fill="url(#grad-credits)"
                    />
                    <Area
                      type="monotone"
                      dataKey="cost"
                      name={t('overview.trend.cost')}
                      stroke="var(--ws-info)"
                      strokeWidth={2}
                      fill="url(#grad-cost)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </WsCard>

          <div className="grid gap-4 xl:grid-cols-3">
            <BreakdownTable title={t('overview.by_capability')} rows={data.by_capability} />
            <BreakdownTable title={t('overview.by_provider')} rows={data.by_provider} />
            <BreakdownTable title={t('overview.by_model')} rows={data.by_model} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
            <BreakdownTable
              title={t('overview.top_orgs')}
              rows={data.top_orgs.map((r) => ({ ...r, key: r.org_name ?? r.key }))}
            />
            <WsCard className="p-4">
              <SectionTitle>{t('overview.charge_health')}</SectionTitle>
              <ul className="flex flex-col gap-2">
                {data.charge_health.length === 0 && <Empty label={t('empty')} />}
                {data.charge_health.map((row) => (
                  <li key={row.status} className="flex items-center justify-between gap-2">
                    <StatusPill tone={CHARGE_TONE[row.status] ?? 'neutral'}>
                      {row.status}
                    </StatusPill>
                    <span className="ws-num text-[13px] text-ws-body">
                      {row.rows.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </WsCard>
          </div>
        </div>
      )}
    </>
  )
}

function LegendDot({ className, label }: { className: string; label: string }): React.ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={cn('size-2 rounded-full', className)} aria-hidden />
      {label}
    </span>
  )
}

/**
 * 按能力 / 供应商 / 模型那三张表。
 *
 * **收与支成对标红**（KOLAgents 那条）：毛利为负时整行的两列一起变红，
 * 而不是只把毛利那一格标红——一格红了看不出是收少了还是支多了。
 */
function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }): React.ReactNode {
  const { t, lang } = useApp()
  return (
    <WsCard className="overflow-hidden">
      <div className="px-4 pt-4">
        <SectionTitle>{title}</SectionTitle>
      </div>
      <div className="max-h-[320px] overflow-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="ws-th">{t('col.key')}</th>
              <th className="ws-th text-right">{t('col.calls')}</th>
              <th className="ws-th text-right">{t('col.credits')}</th>
              <th className="ws-th text-right">{t('col.cost')}</th>
              <th className="ws-th text-right">{t('col.margin')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const loss = row.margin_micros < 0
              return (
                <tr key={row.key} className="ws-tr">
                  <td className="ws-td max-w-[180px] truncate" title={row.key}>
                    {row.key}
                  </td>
                  <td className="ws-td ws-num text-right">{compact(row.calls, lang)}</td>
                  <td className={cn('ws-td ws-num text-right', loss && 'text-ws-bad')}>
                    {credits(row.credits)}
                  </td>
                  <td className={cn('ws-td ws-num text-right', loss && 'text-ws-bad')}>
                    {cny(row.cost_micros)}
                  </td>
                  <td
                    className={cn(
                      'ws-td ws-num text-right font-semibold',
                      loss ? 'text-ws-bad' : 'text-ws-ink',
                    )}
                  >
                    {cny(row.margin_micros)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <Empty label={t('empty')} />}
      </div>
    </WsCard>
  )
}
