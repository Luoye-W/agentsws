/**
 * WP392（docs/104 §3.5）：竞品监控在右侧面板里的三处——
 *
 * - **报表卡**：竞品变化表（WP402 决策 1145：积木表格 + 通用筛选——竞品、种类、日期；价格变化带迷你走势线）。
 *   卡里列几条，「显示更多」里是整张表；
 * - **连接卡**：各监控源状态汇总成一句（「3 家 · 1 家没读到」），有没读到的亮红点、照实写是哪家；
 * - **计划卡**：下一次读的时刻（「竞品监控 · 明早 9:00」）。
 *
 * 只在这一层下面有「店铺管理」或「亚马逊店铺运营」时出（docs/104 C1 / C2），带那条职责的分配去取数。
 * 一句话由服务端拼好（`describeChange`，不提任何数据供应商名），这里不算任何数。
 */
import type { CompetitorChange, CompetitorChangeKind } from '@agentsws/contracts'
import type { TableResult } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useMemo } from 'react'
import { BlockTable } from '@/components/blocks/block-view'
import { whenLabel } from '@/components/rail/card-status'
import type { RailScope } from '@/components/rail/rail-scope'
import { useApp } from '@/lib/app-context'
import {
  COMPETITOR_WATCH_ROLES,
  type CompetitorChangeRow,
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
  // WP402：这一次换了路读的那几家（进问号，不多占一行字）
  const viaOf = (via: 'cloud' | 'extension'): string | undefined => {
    const who = [
      ...new Set(
        view.sources.filter((x) => x.paused !== true && x.last_via === via).map((x) => x.label),
      ),
    ]
    return who.length === 0 ? undefined : t(`cwatch.via.${via}`, { who: who.join('、') })
  }
  const routes = [viaOf('cloud'), viaOf('extension')].filter((x): x is string => x !== undefined)
  const withRoutes = (who: string | undefined): { who?: string } => {
    const all = [who, ...routes].filter((x): x is string => x !== undefined)
    return all.length === 0 ? {} : { who: all.join('；') }
  }
  if (s.failed > 0)
    return {
      text: t('cwatch.status.failed', { n, failed: s.failed_labels.length || s.failed }),
      bad: true,
      ...withRoutes(t('cwatch.failed_who', { who: s.failed_labels.join('、') })),
    }
  if (view.missing_adapters.length > 0 && s.ok === 0)
    return { text: t('cwatch.status.missing', { n }), bad: false }
  if (s.partial > 0)
    return {
      text: t('cwatch.status.partial', { n, partial: s.partial }),
      bad: false,
      ...withRoutes(undefined),
    }
  if (s.ok === 0) return { text: t('cwatch.status.unchecked', { n }), bad: false }
  return { text: t('cwatch.status.ok', { n }), bad: false, ...withRoutes(undefined) }
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
          'ml-auto shrink-0 text-xs ws-num',
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
      <span className="ml-auto shrink-0 text-xs text-ws-muted-fg ws-num">
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

/** WP402（决策 1145）：竞品变化表记筛法用的那个 id（卡里和「显示更多」那张整表同一份）。 */
export const COMPETITOR_TABLE_ID = 'competitor-watch.changes'

/** 变化表 → 积木表格那一份（竞品 / 种类能勾、说了什么能搜、时间能选起止；价格那几行带走势）。 */
export function competitorChangesPayload(
  all: readonly CompetitorChangeRow[],
  t: (key: string, vars?: Record<string, string | number>) => string,
  lang: 'zh' | 'en',
): TableResult {
  return {
    columns: [
      { key: 'competitor', label: t('cwatch.col.competitor'), filter: 'select' },
      // WP420（自查 B7 / U19）：「在哪」——Amazon 上的价还是官网的价，分得清
      { key: 'where', label: t('cwatch.col.where'), filter: 'select' },
      { key: 'change', label: t('cwatch.col.change'), filter: 'select' },
      { key: 'what', label: t('cwatch.col.what'), filter: 'search', link_key: 'url' },
      { key: 'trend', label: t('cwatch.col.trend'), format: 'sparkline' },
      { key: 'detected_at', label: t('cwatch.col.when'), filter: 'date' },
    ],
    rows: all.map((c) => ({
      id: c.id,
      competitor: c.competitor,
      where: t(c.source_kind === 'amazon_asin' ? 'cwatch.where.amazon' : 'cwatch.where.site'),
      change: t(`cwatch.kind.${c.kind}`),
      what: lang === 'en' ? c.text.en || c.text.zh : c.text.zh,
      trend: priceTrend(all, c).join(' '),
      detected_at: c.detected_at,
      ...(c.url === undefined || c.url === '' ? {} : { url: c.url }),
    })),
  }
}

/**
 * 竞品变化表（WP402 决策 1145：积木表格 + WP401 的筛选——竞品、种类、日期；说了什么能搜；价格变化带走势）。
 * `limit` 给了就只列那么多（卡里）；不给 = 整张（「显示更多」）。筛法记在本机，卡里和整表同一份。
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
  // WP420（自查 B7）：Amazon 运营那条职责只看 Amazon 上的变化（独立站的竞品变化归店铺管理）
  const amazonOnly = scope?.tier === 'role' && scope.scope_id === 'amz.store'
  const all = useMemo(
    () => (q.data ?? []).filter((c) => !amazonOnly || c.source_kind === 'amazon_asin'),
    [q.data, amazonOnly],
  )
  const payload = useMemo(() => competitorChangesPayload(all, t, lang), [all, t, lang])
  if (assignment === undefined || view === undefined || view.summary.sources === 0) return null
  return (
    <section className="flex flex-col gap-1.5" data-testid="competitor-changes">
      <header className="flex items-center gap-1.5">
        <h4 className="text-xs tracking-wider text-ws-muted-fg uppercase">{t('cwatch.title')}</h4>
        <button
          type="button"
          className="ml-auto rounded-md px-1.5 py-0.5 text-xs text-ws-muted-fg hover:bg-sidebar-accent/60"
          data-testid="competitor-run"
          disabled={run.isPending}
          onClick={() => {
            run.mutate()
          }}
        >
          {run.isPending ? t('cwatch.running') : t('cwatch.run')}
        </button>
      </header>
      {all.length === 0 && q.isPending ? null : (
        <BlockTable
          payload={payload}
          tableId={COMPETITOR_TABLE_ID}
          dense
          testId="competitor-table"
          empty={t('cwatch.empty')}
          {...(limit === undefined ? {} : { limit })}
        />
      )}
    </section>
  )
}
