/**
 * WP372（决策 1019）：右侧面板里的「报表」——看一份（`ReportPanel`，按 `agentsws://report/<卡 id>` 开）
 * 与全部（`ReportsPanel`，卡底「显示更多」开：全部报表 + 这一层的看板）。
 *
 * 报表正文用原来那几个组件画（AI 发布的报告 `ReportBody`、经营一页纸 `WeeklyReviewBody`，其余标题 + 几个数），
 * 中间栏不再有报表区。面板可以临时加宽（面板头的「加宽」钮或拖左边，宽度记住）。
 */
import { lazy, type ReactNode, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import { isReport, ReportBody } from '@/components/deck/report-body'
import { isWeeklyReview, WeeklyReviewBody } from '@/components/deck/weekly-review-body'
import { GoButton } from '@/components/design'
import { useRailState } from '@/components/rail/rail-state'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { CompetitorChangesTable } from '@/components/reports/competitor-watch'
import {
  type ReportItem,
  reportAddress,
  reportIdOf,
  shortDate,
  useScopeReports,
} from '@/components/reports/report-data'
import { useApp } from '@/lib/app-context'
import { matterUrl } from '@/lib/work'

const ScopeBoards = lazy(async () => ({
  default: (await import('@/components/reports/scope-boards')).ScopeBoards,
}))

function ReportView({ item }: { item: ReportItem }): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const payload = item.card.detail.payload
  return (
    <article className="flex flex-col gap-2" data-testid="report-view" data-id={item.id}>
      <header className="flex items-baseline gap-2">
        <h3 className="min-w-0 flex-1 text-[15px] font-medium">{item.title}</h3>
        <span className="ws-num shrink-0 text-[11px] text-ws-muted-fg">{shortDate(item.at)}</span>
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

/**
 * WP420（自查 U9）：这条职责下面有没有看板（有就不说「还没有报表」）。和 `scope-boards.tsx` 的 `dutyHasBoards`
 * 同一份名单，但不 import 那个文件——它连着社媒日历、B2B、投放素材一大串，挂进报表面板会拖慢懒加载。
 */
export function dutyMayHaveBoards(role_id: string): boolean {
  return (
    role_id.startsWith('social.') ||
    role_id === 'b2b.outbound' ||
    role_id === 'b2b.sales' ||
    role_id === 'ads.google' ||
    role_id === 'ads.meta' ||
    role_id === 'dtc.content' ||
    role_id === 'amz.store'
  )
}

/** 全部（「显示更多」）：报表一行一份，点了看那一份；下面是这一层的看板。 */
export function ReportsPanel(props: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const { reports, ready } = useScopeReports(props.scope)
  const scope = props.scope
  const hasBoards =
    scope?.assignment !== undefined &&
    (scope.tier === 'position' || dutyMayHaveBoards(scope.scope_id))
  return (
    <div className="flex flex-col gap-5" data-testid="reports-panel">
      <section className="flex flex-col gap-1">
        {/* WP420（自查 U9）：下面有看板时不再说「还没有报表」 */}
        {reports.length === 0 && ready && !hasBoards ? (
          <p className="text-[12px] text-ws-muted-fg" data-testid="reports-empty">
            {t('reports.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {reports.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[13px] hover:bg-sidebar-accent/60"
                  data-testid="report-row"
                  data-id={r.id}
                  onClick={() => {
                    rail.openAddress(reportAddress(r.id))
                  }}
                >
                  <span className="min-w-0 truncate">{r.title}</span>
                  <span className="ws-num ml-auto shrink-0 text-[11px] text-ws-muted-fg">
                    {shortDate(r.at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* WP392：竞品变化表（整张；按竞品 / 种类筛） */}
      <CompetitorChangesTable scope={props.scope} />
      <section className="flex flex-col gap-2" data-testid="reports-boards">
        <h3 className="text-[11px] tracking-wider text-ws-muted-fg uppercase">
          {t('reports.boards')}
        </h3>
        <Suspense fallback={null}>
          <ScopeBoards {...props} />
        </Suspense>
      </section>
    </div>
  )
}
