/**
 * WP372（决策 1019）：右侧面板里的「报表」——看一份（`ReportPanel`，按 `agentsws://report/<卡 id>` 开）
 * 与全部（`ReportsPanel`，卡底「显示更多」开：全部报表 + 这一层看数的看板）。
 * WP433：「工作」（进行中 / 卡住了…）与排期、流水线类看板挪去「计划」，数据看板先不挂（WP434 接）。
 *
 * 报表正文用原来那几个组件画（AI 发布的报告 `ReportBody`、经营一页纸 `WeeklyReviewBody`，其余标题 + 几个数），
 * 中间栏不再有报表区。面板可以临时加宽（面板头的「加宽」钮或拖左边，宽度记住）。
 */
import { lazy, type ReactNode, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import { isReport, ReportBody } from '@/components/deck/report-body'
import { isWeeklyReview, WeeklyReviewBody } from '@/components/deck/weekly-review-body'
import { GoButton } from '@/components/design'
import { MentionsTable } from '@/components/pr/mentions-table'
import { useRailState } from '@/components/rail/rail-state'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { CompetitorChangesTable } from '@/components/reports/competitor-watch'
import { ReportRow } from '@/components/reports/kit/report-row'
import {
  dutyMayHaveBoards,
  type ReportItem,
  reportAddress,
  reportIdOf,
  scopeMayHaveReportBoards,
  shortDate,
  useScopeReports,
} from '@/components/reports/report-data'
import { openRightPane } from '@/components/reports/right-pane'
import { useReportList } from '@/components/reports/use-report-list'
import { useApp } from '@/lib/app-context'
import { matterUrl } from '@/lib/work'

const ScopeReportBoards = lazy(async () => ({
  default: (await import('@/components/reports/scope-boards')).ScopeReportBoards,
}))

function ReportView({ item }: { item: ReportItem }): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const payload = item.card.detail.payload
  return (
    <article className="flex flex-col gap-2" data-testid="report-view" data-id={item.id}>
      <header className="flex items-baseline gap-2">
        <h3 className="min-w-0 flex-1 text-[15px] font-medium">{item.title}</h3>
        <span className="ws-num shrink-0 text-xs text-ws-muted-fg">{shortDate(item.at)}</span>
      </header>
      {isReport(payload) ? (
        <ReportBody payload={payload} />
      ) : isWeeklyReview(payload) ? (
        <WeeklyReviewBody payload={payload} />
      ) : (
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-ws-muted-fg">{item.card.summary}</p>
          <GoButton
            label={t('deck.go')}
            onClick={() => {
              navigate(matterUrl(item.card))
            }}
          />
        </div>
      )}
    </article>
  )
}

/** 看一份（报表卡上点一行开的）。 */
export function ReportPanel({ scope, address }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const { reports, ready } = useScopeReports(scope)
  const id = reportIdOf(address)
  const item = reports.find((r) => r.id === id)
  if (item === undefined)
    return ready ? (
      <p className="text-sm text-ws-muted-fg" data-testid="report-missing">
        {t('report.missing')}
      </p>
    ) : null
  return <ReportView item={item} />
}

/** WP433：名单挪到 `report-data.ts`（卡身体也要用，不该为它把这个面板拉进来）；这里照旧导出。 */
export { dutyMayHaveBoards, scopeMayHaveReportBoards }

/**
 * 全部（「显示更多」）：WP438 起上面是这一层固定的全部报表（一行一份，点了在第三栏拉出整页），
 * 再下面是不算报表、但原来挂在这张卡上的几样：AI 写的报告文档、竞品变化表、提及表、这一层的看板。
 */
export function ReportsPanel(props: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const { reports, ready } = useScopeReports(props.scope)
  const fixed = useReportList(props.scope)
  const scope = props.scope
  const hasBoards = scopeMayHaveReportBoards(scope)
  const where = fixed.where
  return (
    <div className="flex flex-col gap-5" data-testid="reports-panel">
      <section className="flex flex-col gap-1">
        <ul className="flex flex-col" data-testid="reports-all">
          {(fixed.list?.reports ?? []).map((r) => (
            <ReportRow
              key={r.id}
              report={r}
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
      </section>
      <section className="flex flex-col gap-1">
        {/* WP420（自查 U9）：下面有看板时不再说「还没有报表」 */}
        {reports.length === 0 && ready && !hasBoards && (fixed.list?.reports.length ?? 0) === 0 ? (
          <p className="text-[12px] text-ws-muted-fg" data-testid="reports-empty">
            {t('reports.empty')}
          </p>
        ) : reports.length === 0 ? null : (
          <>
            <h3 className="text-xs tracking-wider text-ws-muted-fg uppercase">
              {t('reports.docs')}
            </h3>
            <ul className="flex flex-col gap-px">
              {reports.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[13px] hover:bg-sidebar-accent/60"
                    data-testid="report-doc-row"
                    data-id={r.id}
                    onClick={() => {
                      rail.openAddress(reportAddress(r.id))
                    }}
                  >
                    <span className="min-w-0 truncate">{r.title}</span>
                    <span className="ws-num ml-auto shrink-0 text-xs text-ws-muted-fg">
                      {shortDate(r.at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {/* WP392：竞品变化表（整张；按竞品 / 种类筛） */}
      <CompetitorChangesTable scope={props.scope} />
      {/* WP419：担信息监控的这一层，拉回来的提及表（按组 / 情绪 / 来源筛；WP438 起从卡上挪到这一页） */}
      <MentionsTable scope={props.scope} />
      {/* WP433：只剩看数的那几块；「工作」（进行中 / 卡住了…）挪去「计划」，数据看板等 WP434 做成一份报表 */}
      {hasBoards ? (
        <section className="flex flex-col gap-2" data-testid="reports-boards">
          <h3 className="text-xs tracking-wider text-ws-muted-fg uppercase">
            {t('reports.boards')}
          </h3>
          <Suspense fallback={null}>
            <ScopeReportBoards {...props} />
          </Suspense>
        </section>
      ) : null}
    </div>
  )
}
