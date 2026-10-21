/**
 * int/1024（WP437 × WP438）：第三栏里报表那两格的**身体**——挂在 WP437 的统一宿主上（`builtin-panels.tsx` 注册）。
 *
 * - `report`：按地址 `agentsws://report/<id>` 开。这一次是 `openRightPane({ kind: 'report', id })` 开的（看板「报表」卡、
 *   首页关键数字、对话里的小报表）→ 画 WP438 的整份报表；从「产出」点 AI 写的报告文档（卡 id）→ 照旧画那份文档。
 * - `report-compose`：跟 AI 说想看什么 → 做一份。
 */
import type { ReactNode } from 'react'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { ReportCompose } from '@/components/reports/report-compose'
import { reportIdOf, useScopeReports } from '@/components/reports/report-data'
import { ReportView } from '@/components/reports/report-view'
import { ReportPanel } from '@/components/reports/reports-panel'
import { useRightPane } from '@/components/reports/right-pane'

export function ReportPaneBody(props: RailPanelBodyProps): ReactNode {
  const { pane } = useRightPane()
  const id = reportIdOf(props.address)
  const spec = pane?.kind === 'report' && pane.id === id
  const docs = useScopeReports(props.scope, !spec)
  if (id === undefined) return null
  if (spec && pane?.kind === 'report')
    return (
      <ReportView
        id={pane.id}
        {...(pane.position === undefined ? {} : { position: pane.position })}
        {...(pane.duty === undefined ? {} : { duty: pane.duty })}
      />
    )
  // AI 写的报告文档（「产出」卡上点的，地址里是卡 id）
  if (!docs.ready || docs.reports.some((r) => r.id === id)) return <ReportPanel {...props} />
  return <ReportView id={id} />
}

export function ReportComposeBody(_props: RailPanelBodyProps): ReactNode {
  const { pane } = useRightPane()
  const p = pane?.kind === 'report-compose' ? pane : undefined
  return (
    <ReportCompose
      {...(p?.position === undefined ? {} : { position: p.position })}
      {...(p?.duty === undefined ? {} : { duty: p.duty })}
      {...(p?.prompt === undefined ? {} : { prompt: p.prompt })}
    />
  )
}
