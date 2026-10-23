/**
 * WP438（WP434 设计 §3.4）：对话里的**小报表**——3 个数 + 1 张图，底下「固定到面板」「展开看」「改一改」。
 * 和整页、看板那一行是同一份规格的另一种画法；数都是服务端算好的。
 */
import type {
  BarsPayload,
  KpisPayload,
  RankPayload,
  ReportData,
  StackedPayload,
  TablePayload,
  TrendPayload,
} from '@agentsws/deck'
import { Check, Maximize2, Pin } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '@/lib/app-context'
import { BarsChart, DataTable, KpiCell, RankBars, StackedChart, TrendChart } from './blocks'
import { MissingBody } from './parts'

export function MiniReport({
  data,
  pinned,
  onPin,
  onExpand,
  onEdit,
  pinSlot,
}: {
  data: ReportData
  pinned?: boolean
  onPin?: () => void
  onExpand?: () => void
  onEdit?: () => void
  /** 「固定到哪」那个小框（挂在按钮上面）。 */
  pinSlot?: ReactNode
}): ReactNode {
  const { t } = useApp()
  const kpis = data.blocks.find((b) => b.kind === 'kpis')?.payload as KpisPayload | undefined
  const chart = data.blocks.find((b) => b.kind !== 'kpis')
  const sources = [...new Map(data.blocks.flatMap((b) => b.sources).map((s) => [s.id, s])).values()]
  const days = data.range === '7d' ? 7 : data.range === '90d' ? 90 : 30
  return (
    <section className="ws-card relative" data-testid="mini-report" data-id={data.id}>
      <header className="flex items-center gap-2.5 px-[18px] pt-3.5">
        <h3 className="text-[14px] font-semibold text-ws-ink">{data.title}</h3>
        <span className="inline-flex h-[22px] items-center rounded-full bg-ws-secondary px-2 text-xs text-ws-body">
          {chart?.title ?? t('report.range.days', { days })}
        </span>
        <span className="ml-auto inline-flex h-4 items-center rounded-[4px] bg-ws-info-bg px-[5px] text-ws-tiny font-semibold text-ws-info">
          AI
        </span>
      </header>
      <div className="px-[18px] pt-3 pb-4">
        {kpis === undefined ? null : (
          <div className="mb-3 grid grid-cols-3 gap-2.5">
            {kpis.items.slice(0, 3).map((m) => (
              <div key={m.key} className="rounded-lg bg-ws-surface">
                <KpiCell m={m} compact />
              </div>
            ))}
          </div>
        )}
        {chart === undefined ? null : chart.status !== 'ok' || chart.payload === undefined ? (
          <MissingBody
            status={chart.status === 'ok' ? 'empty' : chart.status}
            {...(chart.needs === undefined ? {} : { needs: chart.needs })}
            {...(chart.note === undefined ? {} : { note: chart.note })}
            {...(chart.title === undefined ? {} : { title: chart.title })}
          />
        ) : chart.kind === 'bars' ? (
          <BarsChart data={chart.payload as BarsPayload} height={220} />
        ) : chart.kind === 'stacked' ? (
          <StackedChart data={chart.payload as StackedPayload} height={220} />
        ) : chart.kind === 'trend' ? (
          <TrendChart data={chart.payload as TrendPayload} days={days} height={220} />
        ) : chart.kind === 'rank' ? (
          <RankBars data={chart.payload as RankPayload} />
        ) : (
          <DataTable data={chart.payload as TablePayload} />
        )}
      </div>
      <footer className="relative flex flex-wrap items-center gap-2 rounded-b-[16px] border-t border-ws-line bg-ws-surface px-[18px] py-3">
        {pinSlot}
        {onPin === undefined ? null : pinned === true ? (
          <span
            className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] bg-ws-tint px-3 text-[13px] font-medium text-ws-brand-ink"
            data-testid="mini-report-pinned"
          >
            <Check aria-hidden className="size-3.5" />
            {t('report.pinned.done')}
          </span>
        ) : (
          <button
            type="button"
            data-testid="mini-report-pin"
            className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] bg-ws-brand px-3 text-[13px] font-medium text-ws-brand-fg hover:brightness-95"
            onClick={onPin}
          >
            <Pin aria-hidden className="size-3.5" />
            {t('report.pin')}
          </button>
        )}
        {onExpand === undefined ? null : (
          <button
            type="button"
            data-testid="mini-report-expand"
            className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] bg-ws-secondary px-3 text-[13px] font-medium text-ws-ink hover:brightness-95"
            onClick={onExpand}
          >
            <Maximize2 aria-hidden className="size-3.5" />
            {t('report.expand')}
          </button>
        )}
        {onEdit === undefined ? null : (
          <button
            type="button"
            data-testid="mini-report-edit"
            className="inline-flex h-[30px] items-center rounded-[8px] px-3 text-[13px] text-ws-muted-fg hover:bg-ws-secondary hover:text-ws-ink"
            onClick={onEdit}
          >
            {t('report.edit')}
          </button>
        )}
        <span className="ml-auto text-xs text-ws-faint">
          {t('report.data_from', { names: sources.map((s) => s.label).join(' · ') })}
        </span>
      </footer>
    </section>
  )
}
