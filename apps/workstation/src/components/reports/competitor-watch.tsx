/**
 * WP392（docs/104 §3.5）：竞品监控在右侧面板里的三处——
 *
 * - **报表卡**：竞品变化表（按竞品 / 种类筛；价格变化旁边一条迷你走势线）。卡里列几条，「显示更多」里是整张表；
 * - **连接卡**：各监控源状态汇总成一句（「3 家 · 1 家没读到」），有没读到的亮红点、照实写是哪家；
 * - **计划卡**：下一次读的时刻（「竞品监控 · 明早 9:00」）。
 *
 * 只在这一层下面有「店铺管理」或「亚马逊店铺运营」时出（docs/104 C1 / C2），带那条职责的分配去取数。
 * 一句话由服务端拼好（`describeChange`，不提任何数据供应商名），这里不算任何数。
 */
import type { CompetitorChange, CompetitorChangeKind } from '@agentsws/contracts'
import { COMPETITOR_CHANGE_KINDS } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useMemo, useState } from 'react'
import { whenLabel } from '@/components/rail/card-status'
import type { RailScope } from '@/components/rail/rail-scope'
import { shortDate } from '@/components/reports/report-data'
import { Sparkline } from '@/components/stat-tile'
import { useApp } from '@/lib/app-context'
import {
  COMPETITOR_WATCH_ROLES,
  type CompetitorWatchView,
  competitorChangesKey,
  competitorWatchKey,
  getCompetitorChanges,
  getCompetitorWatch,
  runCompetitorWatch,
} from '@/lib/competitor-watch-api'
import { cn } from '@/lib/utils'

/** 这一层下面担竞品监控的那条分配（没有 = 这一层不出竞品监控）。 */
export function competitorAssignmentOf(scope: RailScope | undefined): string | undefined {
  return scope?.roles?.find((r) => COMPETITOR_WATCH_ROLES.includes(r.role_id))?.assignment
}

/** 竞品监控的状态（连接卡 / 计划卡 / 报表卡共用一个查询）。 */
export function useCompetitorWatch(scope: RailScope | undefined): {
  assignment?: string
  view?: CompetitorWatchView
} {
  const assignment = competitorAssignmentOf(scope)
  const q = useQuery({
    queryKey: competitorWatchKey(assignment ?? ''),
    queryFn: () => getCompetitorWatch(assignment as string),
    enabled: assignment !== undefined,
    retry: false,
    staleTime: 60_000,
  })
  return {
    ...(assignment === undefined ? {} : { assignment }),
    ...(q.data === undefined || q.data === null ? {} : { view: q.data }),
  }
}

/** 连接卡上那一句（「3 家 · 1 家没读到」）；没有源回 `undefined`。 */
export function competitorStatusText(
  view: CompetitorWatchView | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): { text: string; bad: boolean; who?: string } | undefined {
  if (view === undefined || view.summary.sources === 0) return undefined
  const s = view.summary
  const n = s.competitors
  if (s.failed > 0)
    return {
      text: t('cwatch.status.failed', { n, failed: s.failed_labels.length || s.failed }),
      bad: true,
      who: t('cwatch.failed_who', { who: s.failed_labels.join('、') }),
    }
  if (view.missing_adapters.length > 0 && s.ok === 0)
    return { text: t('cwatch.status.missing', { n }), bad: false }
  if (s.partial > 0)
    return { text: t('cwatch.status.partial', { n, partial: s.partial }), bad: false }
  if (s.ok === 0) return { text: t('cwatch.status.unchecked', { n }), bad: false }
  return { text: t('cwatch.status.ok', { n }), bad: false }
}

/** 连接卡里竞品监控那一行（坏了亮红点、照实说是哪家）。 */
export function CompetitorWatchConnectionRow({
  scope,
}: {
  scope: RailScope | undefined
}): ReactNode {
  const { t } = useApp()
  const { view } = useCompetitorWatch(scope)
  const status = competitorStatusText(view, t)
  if (status === undefined) return null
  return (
    <li
      className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-[13px]"
      data-testid="competitor-watch-row"
      data-bad={status.bad ? 'true' : undefined}
      title={status.who}
    >
      <i
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', status.bad ? 'bg-ws-bad' : 'bg-ws-good')}
      />
      <span className="min-w-0 truncate">{t('cwatch.name')}</span>
      <span
        className={cn(
          'ml-auto shrink-0 text-[11px] ws-num',
          status.bad ? 'text-ws-bad' : 'text-ws-muted-fg',
        )}
      >
        {status.text}
      </span>
    </li>
  )
}

/** 计划卡里竞品监控那一行（下次读的时刻）。 */
export function CompetitorWatchPlanRow({ scope }: { scope: RailScope | undefined }): ReactNode {
  const { t } = useApp()
  const { view } = useCompetitorWatch(scope)
  if (view?.next_read_at === undefined) return null
  return (
    <li
      className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-[13px]"
      data-testid="competitor-watch-plan"
    >
      <span className="min-w-0 truncate">{t('cwatch.plan')}</span>
      <span className="ml-auto shrink-0 text-[11px] text-ws-muted-fg ws-num">
        {whenLabel(view.next_read_at, t)}
      </span>
    </li>
  )
}

/** 同一商品的价格走势（这条变化以前的每一次改价 / 打折，按时间排）。 */
export function priceTrend(all: readonly CompetitorChange[], c: CompetitorChange): number[] {
  const priced = new Set<CompetitorChangeKind>(['price', 'discount_start', 'discount_end'])
  if (!priced.has(c.kind)) return []
  const same = all
    .filter(
      (x) =>
        priced.has(x.kind) &&
        x.category !== 'coupon' &&
        x.source_id === c.source_id &&
        x.product_key === c.product_key &&
        x.detected_at <= c.detected_at,
    )
    .sort((a, b) => a.detected_at.localeCompare(b.detected_at))
  const points: number[] = []
  for (const x of same) {
    if (points.length === 0 && typeof x.before === 'number') points.push(x.before)
    if (typeof x.after === 'number') points.push(x.after)
  }
  return points
}

const SELECT =
  'h-6 min-w-0 rounded-md border border-ws-border bg-transparent px-1 text-[12px] text-ws-body'

/**
 * 竞品变化表（按竞品 / 种类筛；价格变化带走势）。`limit` 给了就只列那么多（卡里）；不给 = 整张（「显示更多」）。
 */
export function CompetitorChangesTable({
  scope,
  limit,
}: {
  scope: RailScope | undefined
  limit?: number
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const { assignment, view } = useCompetitorWatch(scope)
  const [who, setWho] = useState('')
  const [kind, setKind] = useState('')
  const q = useQuery({
    queryKey: competitorChangesKey(assignment ?? ''),
    queryFn: () => getCompetitorChanges(assignment as string),
    enabled: assignment !== undefined && view !== undefined && view.summary.sources > 0,
    retry: false,
    staleTime: 60_000,
  })
  const run = useMutation({
    mutationFn: () => runCompetitorWatch(assignment as string),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['competitor-watch', assignment ?? ''] })
    },
  })
  const all = q.data ?? []
  const competitors = useMemo(
    () => [...new Map(all.map((c) => [c.competitor_id, c.competitor])).entries()],
    [all],
  )
  if (assignment === undefined || view === undefined || view.summary.sources === 0) return null
  const rows = all.filter(
    (c) => (who === '' || c.competitor_id === who) && (kind === '' || c.kind === kind),
  )
  const shown = limit === undefined ? rows : rows.slice(0, limit)
  return (
    <section className="flex flex-col gap-1.5" data-testid="competitor-changes">
      <header className="flex items-center gap-1.5">
        <h4 className="text-[11px] tracking-wider text-ws-muted-fg uppercase">
          {t('cwatch.title')}
        </h4>
        <button
          type="button"
          className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-ws-muted-fg hover:bg-sidebar-accent/60"
          data-testid="competitor-run"
          disabled={run.isPending}
          onClick={() => {
            run.mutate()
          }}
        >
          {run.isPending ? t('cwatch.running') : t('cwatch.run')}
        </button>
      </header>
      <div className="flex items-center gap-1.5">
        <select
          className={SELECT}
          aria-label={t('cwatch.col.competitor')}
          data-testid="competitor-filter"
          value={who}
          onChange={(e) => {
            setWho(e.target.value)
          }}
        >
          <option value="">{t('cwatch.all_competitors')}</option>
          {competitors.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          className={SELECT}
          aria-label={t('cwatch.col.change')}
          data-testid="competitor-kind-filter"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value)
          }}
        >
          <option value="">{t('cwatch.all_kinds')}</option>
          {COMPETITOR_CHANGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`cwatch.kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 ? (
        q.isPending ? null : (
          <p className="px-1.5 text-[12px] text-ws-muted-fg" data-testid="competitor-empty">
            {t('cwatch.empty')}
          </p>
        )
      ) : (
        <table className="w-full table-fixed text-[12px]" data-testid="competitor-table">
          <thead className="sr-only">
            <tr>
              <th>{t('cwatch.col.competitor')}</th>
              <th>{t('cwatch.col.change')}</th>
              <th>{t('cwatch.trend')}</th>
              <th>{t('cwatch.col.when')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const trend = priceTrend(all, c)
              const text = lang === 'en' ? c.text.en : c.text.zh
              return (
                <tr
                  key={c.id}
                  className="align-top"
                  data-testid="competitor-change-row"
                  data-kind={c.kind}
                >
                  <td className="w-[22%] truncate py-1 pr-1 text-ws-muted-fg">{c.competitor}</td>
                  <td className="py-1 pr-1 text-ws-body">
                    {c.url === undefined || c.url === '' ? (
                      text
                    ) : (
                      <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {text}
                      </a>
                    )}
                  </td>
                  <td className="w-12 py-1">
                    {trend.length >= 2 ? (
                      <span title={t('cwatch.trend')}>
                        <Sparkline
                          points={trend}
                          testId="competitor-trend"
                          className="h-4 w-12 text-ws-brand"
                        />
                      </span>
                    ) : null}
                  </td>
                  <td className="w-12 py-1 text-right text-[11px] text-ws-muted-fg ws-num">
                    {shortDate(c.detected_at)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
