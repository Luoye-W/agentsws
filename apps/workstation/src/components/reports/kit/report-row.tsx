/**
 * WP438（WP434 设计 §3.2）：看板「报表」卡的一行——名字（AI 做的挂「AI」标）+ 头条数 + 涨跌 + 小走势。
 * 缺数据源时不出假的 0，改成「差 GA4」这种短提示，点了就地连接。
 */
import type { ReportSummary } from '@agentsws/deck'
import { Plug } from 'lucide-react'
import type { ReactNode } from 'react'
import { connectServiceFor } from '@/components/connections/links'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { deltaOf, fmtValue } from './format'
import { AiTag, Delta, Sparkline } from './parts'

export function ReportRow({
  report,
  open,
  fresh,
  onOpen,
}: {
  report: ReportSummary
  /** 第三栏里正开着这一份。 */
  open?: boolean
  /** 刚固定的（亮一下）。 */
  fresh?: boolean
  onOpen: () => void
}): ReactNode {
  const { t } = useApp()
  const openConnect = useOpenConnect()
  const m = report.headline
  const d = deltaOf(m)
  return (
    <li className="list-none">
      <div
        className={cn(
          'group/row relative grid grid-cols-[1fr_auto] items-center gap-x-2.5 rounded-[10px] px-2 py-[9px] hover:bg-ws-surface',
          open === true && 'bg-ws-tint',
          fresh === true && 'bg-ws-card shadow-[var(--ws-glow)]',
        )}
        data-testid="report-row"
        data-id={report.id}
        data-origin={report.origin}
        data-status={m.status}
      >
        <button
          type="button"
          className="col-start-1 flex min-w-0 items-center gap-1.5 text-left text-[13px] font-medium text-ws-ink after:absolute after:inset-0"
          onClick={onOpen}
        >
          <span className="truncate">{report.title}</span>
          {report.origin === 'ai' ? <AiTag /> : null}
        </button>
        <div className="col-start-1 mt-0.5 flex min-w-0 items-baseline gap-1.5 text-xs text-ws-muted-fg">
          {m.status === 'ok' ? (
            <>
              <span className="truncate">{report.headline_label}</span>
              <span className="ws-display text-[15px] text-ws-ink" data-slot="data">
                {fmtValue(m.value, m.format, m.currency ?? 'USD')}
              </span>
              {d === undefined ? null : <Delta {...d} />}
            </>
          ) : m.status === 'not_connected' ? (
            <button
              type="button"
              data-testid="report-row-connect"
              className="relative z-10 inline-flex items-center gap-1 text-ws-warn hover:underline"
              onClick={() => {
                openConnect(connectServiceFor(m.need?.source ?? m.source))
              }}
            >
              <Plug aria-hidden className="size-3" />
              {t('report.row.need', { name: m.need?.label ?? '' })}
            </button>
          ) : (
            <span className="truncate" data-slot="status">
              {m.note ?? t('report.kpi.empty')}
            </span>
          )}
        </div>
        <div className="col-start-2 row-span-2 row-start-1">
          {report.spark === undefined || m.status !== 'ok' ? (
            <span className="inline-block w-[84px]" />
          ) : (
            <Sparkline data={report.spark} width={84} height={30} />
          )}
        </div>
      </div>
    </li>
  )
}
