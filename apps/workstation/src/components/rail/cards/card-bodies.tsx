/**
 * WP372（决策 1004 / 1019）：右侧面板里**报表 / 产出 / 计划 / 连接 / 设定**五张卡展开后的样子。
 * （「对话」那张在 `components/conversations/conversations-panel.tsx`。）
 *
 * 规矩照决策 1004：展开后最多 `limit` 条（WP433 起 5 条），**要处理的排最上面**；完整列表在卡底「显示更多」
 * （外壳画；WP433：卡身体用 `onTotal` 报总数，多于 5 条才出）。
 * 这一个文件整体 `lazy()`：没有任何一张卡展开之前一个字节都不下载。
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { CheckCircle2, ChevronRight, Clock, Sparkles } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrandIcon } from '@/components/brand-icons'
import { MODEL_CHOICES_KEY } from '@/components/free-chat/model-picker'
import { KolSyncRows } from '@/components/kol/kol-sync-panel'
import { PrWatchSources } from '@/components/pr/pr-watch-sources'
import { useScopeMonitor } from '@/components/pr/use-scope-monitor'
import { connectionNeedsYou, useScopeConnections, whenLabel } from '@/components/rail/card-status'
import { ExtensionRows, useScopeExtension } from '@/components/rail/cards/extension-rows'
import { useRailState } from '@/components/rail/rail-state'
import {
  type RailCardBodyProps,
  type RailPanelBodyProps,
  useCardTotal,
} from '@/components/rail/registry'
import { isListedSchedule, SCHEDULES_KEY, scheduleInScope } from '@/components/rail/schedule-count'
import {
  CompetitorWatchConnectionRow,
  CompetitorWatchPlanRow,
  competitorAssignmentOf,
} from '@/components/reports/competitor-watch'
import { ReportRow } from '@/components/reports/kit/report-row'
import {
  reportAddress,
  scopeAssignments,
  scopeMayHaveReportBoards,
  shortDate,
  useScopeReports,
} from '@/components/reports/report-data'
import { openRightPane, useRightPane } from '@/components/reports/right-pane'
import { useReportList } from '@/components/reports/use-report-list'
import { settingsHref } from '@/components/settings-panel/route'
import { CONNECT_ADDRESS_PREFIX, useOpenConnect } from '@/components/setup/use-open-connect'
import { Hint } from '@/components/ui/hint'
import {
  getMySchedules,
  getPositionRecords,
  getPositionWork,
  type ScheduledTaskRow,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { getFreeChatModels } from '@/lib/free-chat'
import type { PrWatchView } from '@/lib/pr-watch-api'
import { cn } from '@/lib/utils'

/** WP456-T3（规范 §2.6 第 14 条）：看板卡里每行 32 高，「点或图标 + 名字 + 右边灰字」。 */
const ROW =
  'flex h-8 w-full min-w-0 items-center gap-2 rounded-[8px] px-2 text-left text-[13px] text-ws-body hover:bg-ws-hover'

/** 行首那个灰色小图标（和点同宽，名字对得齐）。 */
const ROW_ICON = 'size-3.5 shrink-0 text-ws-faint'

/** 行首的点（黄 = 等你看 / 卡住了；灰 = 没事）。 */
function RowDot({ tone }: { tone: 'warn' | 'idle' }): ReactNode {
  return (
    <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
      <i className={cn('size-1.5 rounded-full', tone === 'warn' ? 'bg-ws-warn' : 'bg-ws-faint')} />
    </span>
  )
}

function Empty({ text }: { text: string }): ReactNode {
  return (
    <p className="px-2 text-[12px] text-ws-muted-fg" data-testid="card-empty">
      {text}
    </p>
  )
}

function Meta({ children }: { children: ReactNode }): ReactNode {
  return <span className="ml-auto shrink-0 text-xs text-ws-faint ws-num">{children}</span>
}

/* ── 报表 ───────────────────────────────────────────────────────────── */

/**
 * WP438（WP434 设计 §3.2，决策 1334）：一行一份报表——名字（AI 做的挂「AI」标）+ 头条数 + 涨跌 + 小走势；
 * 点一行在第三栏拉出整页（决策 1335 改）。最多固定 5 份，超过的进「全部报表」（卡底「显示更多」）。
 * 卡底一行「跟 AI 说想看什么，做一份新的」，和卡头「+」是同一个入口。
 *
 * 不是报表的东西各回各处：AI 写的日报 / 周报正文归「产出」；竞品变化表、提及表进「全部报表」那一页。
 */
export function ReportsCard({ scope, limit, onTotal }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const { list, ready, where } = useReportList(scope)
  const pane = useRightPane()
  const rows = (list?.reports ?? []).slice(0, Math.min(limit, list?.limit ?? 5))
  /*
   * int/1024（WP433 × WP438）：「显示更多」多于 5 份才出；但竞品变化表、提及表、看数的看板只在「全部报表」那一页，
   * 这一层有它们时也算「还有更多」，不然就找不到了。
   */
  const monitored = useScopeMonitor(scope) !== undefined
  const extra =
    scopeMayHaveReportBoards(scope) || competitorAssignmentOf(scope) !== undefined || monitored
  useCardTotal(onTotal, (list?.reports.length ?? 0) + (extra ? limit + 1 : 0))
  const openId = pane.pane?.kind === 'report' ? pane.pane.id : undefined
  return (
    <div className="flex flex-col" data-testid="reports-card">
      {rows.length === 0 ? (
        ready ? (
          <Empty text={t('reports.empty')} />
        ) : null
      ) : (
        <ul className="-mx-0.5 flex flex-col">
          {rows.map((r) => (
            <ReportRow
              key={r.id}
              report={r}
              open={openId === r.id}
              fresh={pane.pinned === r.id}
              onOpen={() => {
                if (where === undefined) return
                openRightPane({
                  kind: 'report',
                  id: r.id,
                  position: where.position,
                  ...(where.duty === undefined ? {} : { duty: where.duty }),
                })
              }}
            />
          ))}
        </ul>
      )}
      {where === undefined ? null : (
        <button
          type="button"
          data-testid="reports-compose"
          className={cn(ROW, 'text-ws-muted-fg hover:text-ws-brand-ink')}
          onClick={() => {
            openRightPane({
              kind: 'report-compose',
              position: where.position,
              ...(where.duty === undefined ? {} : { duty: where.duty }),
            })
          }}
        >
          <Sparkles aria-hidden className={ROW_ICON} />
          {t('reports.compose')}
        </button>
      )}
    </div>
  )
}

/* ── 产出 ───────────────────────────────────────────────────────────── */

export function OutputsCard({ scope, limit, onTotal }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  // WP438（WP434 §3.1）：AI 写的日报 / 周报 / 经营一页纸是文档，归「产出」（不算报表）
  const docs = useScopeReports(scope)
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
  // WP433：卡身体报总数（WP438 起 AI 写的报告文档也在这张卡上）
  useCardTotal(onTotal, rows.length + docs.reports.length)
  if (rows.length === 0 && docs.reports.length === 0)
    return records.some((r) => r.isPending) || !docs.ready ? null : (
      <Empty text={t('outputs.empty')} />
    )
  const docRows = docs.reports.slice(0, limit)
  return (
    <ul className="flex flex-col gap-px" data-testid="outputs-card">
      {docRows.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className={ROW}
            data-testid="output-doc-row"
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
      {rows.slice(0, Math.max(0, limit - docRows.length)).map((row) => (
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

/**
 * WP456-T3（决策 1448）：「产出」合进清单卡以后，AI 写的日报 / 周报 / 一页纸在第三栏「产出 → 记录」那一格的最上面
 * （原来在卡上，卡不展开了就挪到这里），点一份在第三栏看全文。
 */
export function OutputDocs({ scope }: RailPanelBodyProps): ReactNode {
  const rail = useRailState()
  const docs = useScopeReports(scope)
  if (docs.reports.length === 0) return null
  return (
    <ul className="-mx-2 mb-3 flex flex-col gap-px" data-testid="outputs-docs">
      {docs.reports.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className={ROW}
            data-testid="output-doc-row"
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

/**
 * WP433：这条职责在「计划 → 显示更多」里有没有进度看板（社媒排期 / 群发、B2B、投放素材流水线）。
 * 和 `scope-boards.tsx` 的 `dutyHasWorkBoards` 同一份名单（不 import 那个大文件，卡身体要轻）。
 */
export function dutyMayHaveWorkBoards(role_id: string): boolean {
  return (
    role_id.startsWith('social.') ||
    role_id === 'b2b.outbound' ||
    role_id === 'b2b.sales' ||
    role_id === 'ads.google' ||
    role_id === 'ads.meta'
  )
}

/**
 * WP433（问题 8）：「计划」卡最上面一行「进度」——岗位层带上「进行中 N · 卡住了 M」（数与「工作」同一份），
 * 职责层是那条职责的排期 / 流水线；点了开「计划」的完整一格（原来这些摊在「报表」里）。
 */
function ProgressRow({ scope }: { scope: NonNullable<RailCardBodyProps['scope']> }): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const id = scope.tier === 'position' ? (scope.assignment ?? '') : ''
  const work = useQuery({
    queryKey: ['position-work', id],
    queryFn: () => getPositionWork(id),
    enabled: id !== '',
    retry: false,
  })
  const counts = work.data?.counts
  const stuck = counts?.stuck ?? 0
  const doing = counts?.doing ?? 0
  // 有在做 / 卡住的就说这两个数（为 0 的那一半不说）；都没有就说一共几件
  const meta =
    counts === undefined
      ? ''
      : doing + stuck > 0
        ? [
            doing > 0 ? t('plans.work.doing', { n: doing }) : '',
            stuck > 0 ? t('plans.work.stuck', { n: stuck }) : '',
          ]
            .filter((x) => x !== '')
            .join(' · ')
        : (work.data?.items.length ?? 0) > 0
          ? t('plans.work.items', { n: work.data?.items.length ?? 0 })
          : ''
  return (
    <li>
      <button
        type="button"
        className={ROW}
        data-testid="plan-row-progress"
        data-stuck={stuck > 0 ? 'true' : undefined}
        onClick={() => {
          rail.show('schedules')
        }}
      >
        <RowDot tone={stuck > 0 ? 'warn' : 'idle'} />
        <span className="min-w-0 truncate">{t('plans.progress')}</span>
        <Meta>{meta}</Meta>
      </button>
    </li>
  )
}

export function PlansCard({ scope, limit, onTotal }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const list = useQuery({ queryKey: SCHEDULES_KEY, queryFn: getMySchedules, retry: false })
  // WP386：信息监控下一次什么时候拉（系统自带的那条定时一小时一拍，人看的是「明早 9:00」）
  const monitorNext = useScopeMonitor(scope)?.view?.next_run_at
  const rows =
    scope === undefined
      ? []
      : (list.data ?? [])
          .filter((r) => isListedSchedule(r) && scheduleInScope(r, scope))
          .sort(byPlan)
  // WP392：竞品监控的下次读（不是一条定时任务，是按到点规则算出来的）
  const competitor = competitorAssignmentOf(scope) !== undefined
  const progress =
    scope?.assignment !== undefined &&
    (scope.tier === 'position' || dutyMayHaveWorkBoards(scope.scope_id))
  useCardTotal(
    onTotal,
    rows.length + (progress ? 1 : 0) + (competitor ? 1 : 0) + (monitorNext === undefined ? 0 : 1),
  )
  if (scope === undefined) return null
  if (rows.length === 0 && monitorNext === undefined && !competitor && !progress)
    return list.isPending ? null : <Empty text={t('plans.empty')} />
  return (
    <ul className="flex flex-col gap-px" data-testid="plans-card">
      {progress ? <ProgressRow scope={scope} /> : null}
      {competitor ? <CompetitorWatchPlanRow scope={scope} /> : null}
      {monitorNext === undefined ? null : (
        <li>
          <div className={ROW} data-testid="plan-row-monitor">
            <Clock aria-hidden className={ROW_ICON} />
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
              {waiting ? <RowDot tone="warn" /> : <Clock aria-hidden className={ROW_ICON} />}
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
  const { scope, limit, address, onTotal } = props
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
  useCardTotal(onTotal, sorted.length)
  // WP386：信息监控的监控源（一行汇总；拉不到的亮红点，点开就地看 / 贴）
  const monitor = useScopeMonitor(scope)
  // WP420：要插件的这一层，先列插件那几行（配对、后台在插件里连上没有）
  const extension = useScopeExtension(scope)
  /** WP509：这一层里本人持有的红人职责（有才出「同步到表格」那几行）。 */
  const kolAssignment = scope?.roles?.find((r) => r.role_id.startsWith('kol.'))?.assignment
  return (
    <div className="flex flex-col gap-1.5" data-testid="connections-card">
      {live ? (
        <div
          ref={here}
          className="rounded-lg ring-2 ring-ws-brand/40"
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
      {extension === undefined ? null : <ExtensionRows rows={extension} />}
      {/* WP509：红人同步到表格（红人营销这一层才有；一个同步一行，点开就地停 / 开 / 现在同步 / 删） */}
      {kolAssignment === undefined ? null : <KolSyncRows assignment={kolAssignment} />}
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
        extension !== undefined ||
        kolAssignment !== undefined ||
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
                ) : i.developer_setup === true ? (
                  // WP415（决策 1239）：要去开发者后台建应用的，不拿「去连接」诱导人去填
                  <span
                    className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-ws-muted-fg"
                    data-testid="connection-dev-setup"
                  >
                    {t('conncard.dev_setup')}
                    <Hint text={t('conncard.dev_setup.hint')} />
                  </span>
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

/**
 * WP456-T3（决策 1448）：「连接」合进看板的清单卡以后，点那一行在第三栏开的完整一格——就是原来卡里那几行
 * （不截 5 条）+ 连接卡就地连（地址带来的），最底下一行去设置里的「账号连接」看全部。
 */
export function ConnectionsPanel(props: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const noop = (): void => undefined
  return (
    <div className="flex flex-col gap-3" data-testid="connections-panel">
      <ConnectionsCard {...props} limit={Number.MAX_SAFE_INTEGER} onMore={noop} />
      <Link
        to={settingsHref('connections')}
        className="ws-link-muted self-start px-1.5 text-[12px]"
        data-testid="connections-panel-all"
      >
        {t('conncard.all')}
      </Link>
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

export function SettingsCard({ limit, tier, onTotal }: RailCardBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const models = useQuery({ queryKey: MODEL_CHOICES_KEY, queryFn: getFreeChatModels, retry: false })
  const model = models.data?.choices.find((c) => c.id === models.data?.default)?.label
  const rows: { id: string; label: string; value?: string; open: () => void; href?: string }[] = [
    {
      id: 'model',
      label: t('settings.row.model'),
      // WP456-T3（决策 1447）：没接时这一行不写「还没接 AI」（只在输入框那一颗说）
      value: model ?? '',
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
  useCardTotal(onTotal, rows.length)
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
