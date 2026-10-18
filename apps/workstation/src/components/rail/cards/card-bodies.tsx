/**
 * WP372（决策 1004 / 1019）：右侧面板里**报表 / 产出 / 计划 / 连接 / 设定**五张卡展开后的样子。
 * （「对话」那张在 `components/conversations/conversations-panel.tsx`。）
 *
 * 规矩照决策 1004：展开后最多 4 条（`limit`），**要处理的排最上面**；完整列表在卡底「显示更多」（外壳画）。
 * 这一个文件整体 `lazy()`：没有任何一张卡展开之前一个字节都不下载。
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { CheckCircle2, ChevronRight } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrandIcon } from '@/components/brand-icons'
import { MODEL_CHOICES_KEY } from '@/components/free-chat/model-picker'
import { MentionsTable } from '@/components/pr/mentions-table'
import { PrWatchSources } from '@/components/pr/pr-watch-sources'
import { useScopeMonitor } from '@/components/pr/use-scope-monitor'
import { connectionNeedsYou, useScopeConnections, whenLabel } from '@/components/rail/card-status'
import { useRailState } from '@/components/rail/rail-state'
import type { RailCardBodyProps } from '@/components/rail/registry'
import { isListedSchedule, SCHEDULES_KEY, scheduleInScope } from '@/components/rail/schedule-count'
import {
  CompetitorChangesTable,
  CompetitorWatchConnectionRow,
  CompetitorWatchPlanRow,
  competitorAssignmentOf,
} from '@/components/reports/competitor-watch'
import {
  reportAddress,
  scopeAssignments,
  shortDate,
  useScopeReports,
} from '@/components/reports/report-data'
import { settingsHref } from '@/components/settings-panel/route'
import { CONNECT_ADDRESS_PREFIX, useOpenConnect } from '@/components/setup/use-open-connect'
import { getMySchedules, getPositionRecords, type ScheduledTaskRow } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { getFreeChatModels } from '@/lib/free-chat'
import type { PrWatchView } from '@/lib/pr-watch-api'
import { cn } from '@/lib/utils'

const ROW =
  'flex w-full min-w-0 items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[13px] text-ws-body hover:bg-sidebar-accent/60'

function Empty({ text }: { text: string }): ReactNode {
  return (
    <p className="px-1.5 text-[12px] text-ws-muted-fg" data-testid="card-empty">
      {text}
    </p>
  )
}

function Meta({ children }: { children: ReactNode }): ReactNode {
  return <span className="ml-auto shrink-0 text-[11px] text-ws-muted-fg ws-num">{children}</span>
}

/* ── 报表 ───────────────────────────────────────────────────────────── */

export function ReportsCard({ scope, limit }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const { reports, ready } = useScopeReports(scope)
  // WP392：担竞品监控的这一层，卡里再放竞品变化表（按竞品 / 种类筛；价格带走势）
  const competitor =
    competitorAssignmentOf(scope) === undefined ? null : (
      <CompetitorChangesTable scope={scope} limit={limit} />
    )
  // WP419（自查 P5）：担信息监控的这一层，卡里放拉回来的提及表（按组 / 情绪 / 来源筛）
  const mentions = <MentionsTable scope={scope} {...(limit === undefined ? {} : { limit })} />
  const monitored = useScopeMonitor(scope) !== undefined
  if (reports.length === 0)
    return (
      <div className="flex flex-col gap-2">
        {ready && !monitored ? <Empty text={t('reports.empty')} /> : null}
        {competitor}
        {mentions}
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-px" data-testid="reports-card">
        {reports.slice(0, limit).map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={ROW}
              data-testid="report-row"
              data-id={r.id}
              onClick={() => {
                rail.openAddress(reportAddress(r.id))
              }}
            >
              <span className="min-w-0 truncate">{r.title}</span>
              <Meta>{shortDate(r.at)}</Meta>
            </button>
          </li>
        ))}
      </ul>
      {competitor}
      {mentions}
    </div>
  )
}

/* ── 产出 ───────────────────────────────────────────────────────────── */

export function OutputsCard({ scope, limit }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const records = useQueries({
    queries: scopeAssignments(scope).map((a) => ({
      queryKey: ['records', a],
      queryFn: () => getPositionRecords(a),
      retry: false,
    })),
  })
  const seen = new Set<string>()
  const rows = records
    .flatMap((r) => r.data?.payload?.rows ?? [])
    .filter((row) => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
    .sort((a, b) => b.at.localeCompare(a.at))
  if (rows.length === 0)
    return records.some((r) => r.isPending) ? null : <Empty text={t('outputs.empty')} />
  return (
    <ul className="flex flex-col gap-px" data-testid="outputs-card">
      {rows.slice(0, limit).map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className={ROW}
            data-testid="output-row"
            title={row.summary}
            onClick={() => {
              rail.show('records')
            }}
          >
            <span className="min-w-0 truncate">{row.title}</span>
            <Meta>{shortDate(row.at)}</Meta>
          </button>
        </li>
      ))}
    </ul>
  )
}

/* ── 计划 ───────────────────────────────────────────────────────────── */

/** 等你点头的排最上，其余按下一次的时间。 */
function byPlan(a: ScheduledTaskRow, b: ScheduledTaskRow): number {
  const wa = a.params?.awaiting_approval === true ? 0 : 1
  const wb = b.params?.awaiting_approval === true ? 0 : 1
  if (wa !== wb) return wa - wb
  return (a.next_fire_at ?? '~').localeCompare(b.next_fire_at ?? '~')
}

export function PlansCard({ scope, limit }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const list = useQuery({ queryKey: SCHEDULES_KEY, queryFn: getMySchedules, retry: false })
  // WP386：信息监控下一次什么时候拉（系统自带的那条定时一小时一拍，人看的是「明早 9:00」）
  const monitorNext = useScopeMonitor(scope)?.view?.next_run_at
  if (scope === undefined) return null
  const rows = (list.data ?? [])
    .filter((r) => isListedSchedule(r) && scheduleInScope(r, scope))
    .sort(byPlan)
  // WP392：竞品监控的下次读（不是一条定时任务，是按到点规则算出来的）
  const competitor = competitorAssignmentOf(scope) !== undefined
  if (rows.length === 0 && monitorNext === undefined && !competitor)
    return list.isPending ? null : <Empty text={t('plans.empty')} />
  return (
    <ul className="flex flex-col gap-px" data-testid="plans-card">
      {competitor ? <CompetitorWatchPlanRow scope={scope} /> : null}
      {monitorNext === undefined ? null : (
        <li>
          <div className={ROW} data-testid="plan-row-monitor">
            <span className="min-w-0 truncate">{t('prwatch.plan.row')}</span>
            <Meta>{whenLabel(monitorNext, t)}</Meta>
          </div>
        </li>
      )}
      {rows.slice(0, limit).map((r) => {
        const waiting = r.params?.awaiting_approval === true
        return (
          <li key={r.id}>
            <button
              type="button"
              className={ROW}
              data-testid="plan-row"
              data-waiting={waiting ? 'true' : undefined}
              onClick={() => {
                rail.show('schedules')
              }}
            >
              {waiting ? (
                <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-ws-warn" />
              ) : null}
              <span className="min-w-0 truncate">{r.title ?? t('rail.panel.schedules')}</span>
              <Meta>
                {r.state === 'paused'
                  ? t('plans.paused')
                  : r.next_fire_at === undefined
                    ? ''
                    : whenLabel(r.next_fire_at, t)}
              </Meta>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/* ── 连接 ───────────────────────────────────────────────────────────── */

const ConnectBody = lazy(async () => {
  const m = await import('@/components/rail/panels/connect-panel')
  return { default: m.ConnectPanel }
})

export function ConnectionsCard(props: RailCardBodyProps): ReactNode {
  const { scope, limit, address } = props
  const { t, lang } = useApp()
  const openConnect = useOpenConnect()
  const { items, ready } = useScopeConnections(scope)
  const live = address?.startsWith(CONNECT_ADDRESS_PREFIX) === true
  const here = useRef<HTMLDivElement | null>(null)
  // 决策 690 + 1004：连接卡弹出来时这一块在最上面，滚到它
  useEffect(() => {
    // 同一张连接卡再点一次（地址不变）也再滚一次
    if (live && address !== '')
      here.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [live, address])
  const sorted = [...items].sort(
    (a, b) => Number(connectionNeedsYou(b)) - Number(connectionNeedsYou(a)),
  )
  // WP386：信息监控的监控源（一行汇总；拉不到的亮红点，点开就地看 / 贴）
  const monitor = useScopeMonitor(scope)
  return (
    <div className="flex flex-col gap-1.5" data-testid="connections-card">
      {live ? (
        <div
          ref={here}
          className="rounded-[10px] ring-2 ring-ws-brand/40"
          data-testid="connections-live"
        >
          <Suspense fallback={null}>
            <ConnectBody {...props} />
          </Suspense>
        </div>
      ) : null}
      {monitor === undefined ? null : (
        <MonitorRow assignment={monitor.assignment} view={monitor.view} />
      )}
      {/* WP392：竞品监控各监控源的状态（坏了亮红点、照实说是哪家） */}
      {competitorAssignmentOf(scope) === undefined ? null : (
        <ul className="flex flex-col gap-px">
          <CompetitorWatchConnectionRow scope={scope} />
        </ul>
      )}
      {sorted.length === 0 ? (
        live ||
        !ready ||
        monitor !== undefined ||
        competitorAssignmentOf(scope) !== undefined ? null : (
          <Empty text={t('conncard.empty')} />
        )
      ) : (
        <ul className="flex flex-col gap-px">
          {sorted.slice(0, limit).map((i) => {
            const todo = connectionNeedsYou(i)
            return (
              <li
                key={i.kind}
                className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-[13px]"
                data-testid="connection-row"
                data-kind={i.kind}
                data-todo={todo ? 'true' : undefined}
              >
                <BrandIcon provider={i.connect_service ?? i.kind} />
                <span className="min-w-0 truncate">{lang === 'en' ? i.name.en : i.name.zh}</span>
                {i.connected ? (
                  <CheckCircle2
                    className="ml-auto size-3.5 shrink-0 text-ws-good"
                    aria-label={t('conncard.connected')}
                  />
                ) : i.connect_service === undefined ? null : (
                  <button
                    type="button"
                    data-testid="connection-go"
                    className={cn(
                      'ml-auto shrink-0 rounded-md px-2 py-0.5 text-[12px] font-medium',
                      todo ? 'bg-ws-bad-bg text-ws-bad' : 'bg-ws-surface text-ws-body',
                    )}
                    onClick={() => {
                      openConnect(i.connect_service)
                    }}
                  >
                    {t('conncard.connect')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** WP386：连接卡上信息监控那一行（「Google Alerts · 17 条 · 1 条拉不到」）；点开就地看每一条、贴 RSS。 */
function MonitorRow({
  assignment,
  view,
}: {
  assignment: string
  view?: PrWatchView | undefined
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const bad = (view?.failed ?? 0) > 0
  return (
    <div
      className="flex flex-col gap-1"
      data-testid="connection-row-monitor"
      data-todo={bad ? 'true' : undefined}
    >
      <button
        type="button"
        className={ROW}
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        <BrandIcon provider="google_alerts" />
        <span className="min-w-0 truncate">{t('prwatch.conn.name')}</span>
        {bad ? <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-ws-bad" /> : null}
        <Meta>{view?.summary ?? ''}</Meta>
      </button>
      {open ? (
        <div className="px-1.5 pb-1">
          <PrWatchSources assignment={assignment} compact />
        </div>
      ) : null}
    </div>
  )
}

/* ── 设定 ───────────────────────────────────────────────────────────── */

export function SettingsCard({ limit, tier }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const models = useQuery({ queryKey: MODEL_CHOICES_KEY, queryFn: getFreeChatModels, retry: false })
  const model = models.data?.choices.find((c) => c.id === models.data?.default)?.label
  const rows: { id: string; label: string; value?: string; open: () => void; href?: string }[] = [
    {
      id: 'model',
      label: t('settings.row.model'),
      value: model ?? (models.isPending ? '' : t('settings.model.none')),
      open: () => undefined,
      href: settingsHref('models'),
    },
    // WP406：岗位层多一行「岗位更新」（官方更新的三档设置、挑着看、退回）
    ...(
      [
        'memory',
        'knowledge',
        'skills',
        'role',
        'caps',
        ...(tier === 'position' ? (['updates'] as const) : []),
      ] as const
    ).map((id) => ({
      id,
      label: t(`rail.panel.${id}`),
      open: () => {
        rail.show(id)
      },
    })),
  ]
  return (
    <ul className="flex flex-col gap-px" data-testid="settings-card">
      {rows.slice(0, limit).map((r) => (
        <li key={r.id}>
          {r.href === undefined ? (
            <button
              type="button"
              className={ROW}
              data-testid="settings-row"
              data-row={r.id}
              onClick={r.open}
            >
              <span className="min-w-0 truncate">{r.label}</span>
              <ChevronRight aria-hidden className="ml-auto size-3.5 text-ws-muted-fg" />
            </button>
          ) : (
            <Link to={r.href} className={ROW} data-testid="settings-row" data-row={r.id}>
              <span className="shrink-0">{r.label}</span>
              <Meta>{r.value}</Meta>
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
}
