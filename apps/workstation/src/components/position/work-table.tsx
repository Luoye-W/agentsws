/**
 * WP241「工作」的表格视图：标题一列固定，其余列在「列」里选（记在这个岗位的偏好里）。
 * 点「标题」表头按标题排；别的排序在工具栏「按截止 / 按更新」。
 */
import type { PositionWorkItem } from '@agentsws/contracts'
import { ArrowUpDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '@/lib/app-context'
import { type ColumnId, whenText } from '@/lib/position-work'
import {
  CardsBadge,
  DutyChip,
  GroupIcon,
  KindIcon,
  OverdueBadge,
  ProgressText,
} from './work-bits'
import { DueText, ItemTitle } from './work-list'

export function WorkTable({
  items,
  columns,
  now,
  onJump,
  onSortTitle,
}: {
  items: readonly PositionWorkItem[]
  columns: readonly ColumnId[]
  now: Date
  onJump(card_id: string): void
  onSortTitle(): void
}): ReactNode {
  const { t } = useApp()
  const cell = (item: PositionWorkItem, col: ColumnId): ReactNode => {
    switch (col) {
      case 'kind':
        return (
          <span className="inline-flex items-center gap-1.5 text-ws-muted-fg">
            <KindIcon kind={item.kind} />
            {t(`pos2.kind.${item.kind}`)}
          </span>
        )
      case 'duty':
        return <DutyChip item={item} />
      case 'status':
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <GroupIcon group={item.group} />
            {t(`pos2.group.${item.group}`)}
          </span>
        )
      case 'due':
        return <DueText item={item} now={now} />
      case 'source':
        return <span className="whitespace-nowrap">{t(`pos2.source.${item.source}`)}</span>
      case 'progress':
        return (
          <span
            className="line-clamp-1 text-ws-muted-fg"
            title={item.stuck_reason ?? item.progress}
          >
            <ProgressText item={item} fallback="—" />
          </span>
        )
      default:
        return (
          <span className="ws-num whitespace-nowrap text-ws-muted-fg">
            {whenText(item.updated_at, now, t)}
          </span>
        )
    }
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-testid="work-table">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-ws-surface text-left text-xs font-medium text-ws-muted-fg">
              <th className="px-3 py-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  data-testid="work-table-sort-title"
                  onClick={onSortTitle}
                >
                  {t('pos2.col.title')}
                  <ArrowUpDown className="size-3" aria-hidden />
                </button>
              </th>
              {columns.map((c) => (
                <th
                  key={c}
                  className="px-3 py-2 whitespace-nowrap"
                  data-testid="work-table-col"
                  data-col={c}
                >
                  {t(`pos2.col.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t" data-testid="work-table-row" data-id={item.id}>
                <td className="max-w-[18rem] px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <ItemTitle item={item} />
                    <OverdueBadge item={item} />
                    <CardsBadge item={item} onJump={onJump} />
                  </span>
                </td>
                {columns.map((c) => (
                  <td key={c} className="max-w-[14rem] px-3 py-2">
                    {cell(item, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t px-3 py-2 text-xs text-ws-muted-fg">
        {t('pos2.table.footer', { n: items.length })}
      </p>
    </div>
  )
}
