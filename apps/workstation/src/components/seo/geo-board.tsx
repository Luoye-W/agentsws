/**
 * WP335（docs/99 §5.4 / §5.6，O3）：「内容与搜索」职责页最上面的 **AI 回答监测看板**。
 *
 * 按 docs/96 组件化：数字 ×4（提及率、引用率、平均名次、声量份额，各带小折线）→ 趋势（提及率按 AI）→
 * 表格（Prompt × AI 方格、关注词排名、被引用最多的站）→ 对比（我们 vs 竞品）。每一块都有出现条件：
 * 没数据不出（不出 0）、点不够不画趋势、没竞品不画对比、0 行不画表。
 *
 * **数不经模型手**：所有数都是服务端规则算好的（`GET /v1/seo/watch/metrics`），这里只画。
 * 页面零说明：怎么读方格进问号；设置不在这里（「关注设置」在第三栏「设定」里）；
 * 点方格的一格 → 第三栏「一条回答」（不离开这一页）。
 */
import type { GeoMetricsView, GeoWeekPoint } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Search, SlidersHorizontal } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { SparkLine, StatTile } from '@/components/design'
import { useRailState } from '@/components/rail/rail-state'
import { Button } from '@/components/ui/button'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'
import { getGeoMetrics, getGeoWatch, runGeoWatch } from '@/lib/geo-watch-api'
import { pct } from './geo-bits'
import { GeoGrid } from './geo-grid'
import { GeoQuality } from './geo-quality'
import { GeoCompare, GeoRankTable, GeoSites } from './geo-tables'
import { GeoTrend } from './geo-trend'

/** 某个数在每一周上的值（没有的周跳过）——画小折线用。 */
const series = (points: readonly GeoWeekPoint[], key: keyof GeoWeekPoint): number[] =>
  points.map((p) => p[key]).filter((v): v is number => typeof v === 'number')

function Tiles({ view }: { view: GeoMetricsView }): ReactNode {
  const { t } = useApp()
  const all = view.trends.find((l) => l.kind === 'all')?.points ?? []
  const now = all.find((p) => p.week === view.week)
  const change = now?.change_pp
  const tiles: { id: string; label: string; value: string; spark: number[]; delta?: number }[] = [
    {
      id: 'mention',
      label: t('geo.tile.mention'),
      value: pct(now?.mention_rate),
      spark: series(all, 'mention_rate'),
      ...(change === undefined ? {} : { delta: change }),
    },
    {
      id: 'citation',
      label: t('geo.tile.citation'),
      value: pct(now?.citation_rate),
      spark: series(all, 'citation_rate'),
    },
    {
      id: 'rank',
      label: t('geo.tile.rank'),
      value:
        now?.avg_rank === undefined
          ? '—'
          : t('geo.tile.rank.value', { n: String(Math.round(now.avg_rank * 10) / 10) }),
      spark: series(all, 'avg_rank'),
    },
    { id: 'sov', label: t('geo.tile.sov'), value: pct(now?.sov), spark: series(all, 'sov') },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="geo-tiles">
      {tiles.map((tile) => (
        <div key={tile.id} data-testid={`geo-tile-${tile.id}`} data-slot="data">
          <StatTile
            value={tile.value}
            label={tile.label}
            {...(tile.delta === undefined || tile.delta === 0
              ? {}
              : {
                  delta: t('geo.tile.change', { v: String(Math.abs(Math.round(tile.delta))) }),
                  direction: tile.delta > 0 ? ('up' as const) : ('down' as const),
                })}
            {...(tile.spark.length < 2 ? {} : { spark: <SparkLine points={tile.spark} /> })}
          />
        </div>
      ))}
    </div>
  )
}

/** 「现在跑一轮」：有 Claude（单格 ≥ 1 积分）时先说这一轮多少积分，确认了才跑（一轮合并确认一次）。 */
function RunNow({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [ask, setAsk] = useState<number | undefined>(undefined)
  const [done, setDone] = useState<string | undefined>(undefined)
  const run = useMutation({
    mutationFn: (confirm: boolean) => runGeoWatch(confirm ? { confirm: true } : {}, assignment),
    onSuccess: (out) => {
      if (out.needs_confirm === true && !out.started) {
        setAsk(out.estimate.credits ?? 0)
        return
      }
      setAsk(undefined)
      setDone(
        out.pending_tasks > 0
          ? t('geo.run.pending', { n: String(out.pending_tasks) })
          : (out.notes[0] ?? t('geo.run.started')),
      )
      void client.invalidateQueries({ queryKey: ['geo-metrics'] })
      void client.invalidateQueries({ queryKey: ['geo-watch'] })
    },
  })
  if (ask !== undefined)
    return (
      <span className="flex items-center gap-1.5" data-testid="geo-run-confirm">
        <span className="text-xs text-ws-muted-fg" data-slot="status">
          {t('geo.run.confirm', { c: String(ask) })}
        </span>
        <Button size="xs" disabled={run.isPending} onClick={() => run.mutate(true)}>
          {t('geo.run.go')}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setAsk(undefined)}>
          {t('geo.run.cancel')}
        </Button>
      </span>
    )
  return (
    <span className="flex items-center gap-1.5">
      {done === undefined ? null : (
        <span className="text-xs text-ws-muted-fg" data-slot="status" data-testid="geo-run-done">
          {done}
        </span>
      )}
      <Button
        size="xs"
        variant="ghost"
        data-testid="geo-run"
        disabled={run.isPending}
        onClick={() => run.mutate(false)}
      >
        <Play className="size-3" aria-hidden />
        {t('geo.run')}
      </Button>
    </span>
  )
}

export function GeoBoard({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const metrics = useQuery({
    queryKey: ['geo-metrics', assignment],
    queryFn: () => getGeoMetrics(assignment),
  })
  const watch = useQuery({
    queryKey: ['geo-watch', assignment],
    queryFn: () => getGeoWatch(assignment),
  })
  const view = metrics.data
  const notConnected = watch.data?.search_data === 'not_configured'
  return (
    <section className="flex flex-col gap-4" data-testid="geo-board">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="ws-display text-base">{t('geo.title')}</h3>
        <Hint text={t('geo.title.hint')} />
        {view?.week === undefined ? null : (
          <span className="text-xs text-ws-muted-fg" data-slot="status">
            {t('geo.week', { week: view.week.slice(5) })}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {notConnected ? null : <RunNow assignment={assignment} />}
          <Button
            size="xs"
            variant="ghost"
            data-testid="geo-open-settings"
            onClick={() => rail.show('geo-watch')}
          >
            <SlidersHorizontal className="size-3" aria-hidden />
            {t('geo.settings')}
          </Button>
        </span>
      </div>
      {metrics.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : view === undefined || view.grid === undefined ? (
        notConnected ? (
          <EmptyLine
            icon={<Search className="size-4" aria-hidden />}
            text={t('geo.no_data_source')}
            action={{ label: t('geo.connect'), to: '/connections' }}
            testId="geo-empty"
          />
        ) : (
          <EmptyLine
            icon={<Search className="size-4" aria-hidden />}
            text={t('geo.empty')}
            testId="geo-empty"
          />
        )
      ) : (
        <>
          <Tiles view={view} />
          <GeoTrend view={view} />
          <GeoGrid grid={view.grid} assignment={assignment} />
          <GeoRankTable rank={view.rank} />
          <div className="grid gap-4 lg:grid-cols-2">
            <GeoSites view={view} />
            <GeoCompare brands={view.brands} />
          </div>
          <GeoQuality view={view} assignment={assignment} />
        </>
      )}
    </section>
  )
}
