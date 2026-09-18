/**
 * 审计（65 §2）：**只读**分页。
 *
 * 这一页没有任何按钮——审计表只增不改，界面上也就没有什么可"做"的。
 * 一条动作通常有两行（`intent` 与 `done`）：先写打算做什么，再补做成没有。
 */

import type { ColumnDef } from '@tanstack/react-table'
import { inputClass, StatusPill, type Tone } from '@/components/design'
import { PageHeader } from '@/components/layout'
import { ServerTable, useTableState } from '@/components/table'
import { qs } from '@/lib/api'
import { useApp, useQuery } from '@/lib/app'
import { when } from '@/lib/format'
import type { Key } from '@/lib/i18n'

interface AuditRow {
  id: number
  at: string
  action: string
  actor_account_id: string
  actor_role: string
  target_kind: string
  target_id: string
  outcome: 'intent' | 'done' | 'failed'
  details: Record<string, unknown>
  ip: string
}

const TONE: Record<AuditRow['outcome'], Tone> = {
  intent: 'neutral',
  done: 'good',
  failed: 'bad',
}

export function AuditPage(): React.ReactNode {
  const { t } = useApp()
  const state = useTableState({ limit: 50 })
  const list = useQuery<{ rows: AuditRow[]; total: number }>(
    `/v1/admin/audit${qs({
      action: state.get('action'),
      target_id: state.get('target_id'),
      limit: state.limit,
      offset: state.offset,
    })}`,
  )

  const columns: ColumnDef<AuditRow, unknown>[] = [
    {
      id: 'at',
      header: t('col.at'),
      cell: ({ row }) => <span className="ws-num">{when(row.original.at)}</span>,
    },
    { id: 'action', header: t('col.action'), cell: ({ row }) => row.original.action },
    {
      id: 'outcome',
      header: t('col.outcome'),
      cell: ({ row }) => (
        <StatusPill tone={TONE[row.original.outcome]}>
          {t(`audit.${row.original.outcome}` as Key)}
        </StatusPill>
      ),
    },
    {
      id: 'actor',
      header: t('col.actor'),
      cell: ({ row }) => (
        <span className="block max-w-[180px] truncate" title={row.original.actor_account_id}>
          {row.original.actor_account_id} · {row.original.actor_role}
        </span>
      ),
    },
    {
      id: 'target',
      header: t('col.target'),
      cell: ({ row }) => (
        <span className="block max-w-[200px] truncate" title={row.original.target_id}>
          {row.original.target_kind} · {row.original.target_id}
        </span>
      ),
    },
    {
      id: 'details',
      header: t('col.details'),
      cell: ({ row }) => (
        <span
          className="block max-w-[320px] truncate text-ws-muted-fg"
          title={JSON.stringify(row.original.details)}
        >
          {JSON.stringify(row.original.details)}
        </span>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        title={t('nav.audit')}
        right={
          <div className="flex gap-2">
            <input
              className={`${inputClass} w-44`}
              placeholder={t('col.action')}
              defaultValue={state.get('action') ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') state.set({ action: e.currentTarget.value })
              }}
            />
            <input
              className={`${inputClass} w-52`}
              placeholder={t('col.target')}
              defaultValue={state.get('target_id') ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') state.set({ target_id: e.currentTarget.value })
              }}
            />
          </div>
        }
      />
      <ServerTable
        columns={columns}
        rows={list.data?.rows}
        total={list.data?.total ?? 0}
        state={state}
        loading={list.loading}
        rowKey={(row) => String(row.id)}
      />
    </>
  )
}
