/**
 * 用量台账（65 §4）：事件本身，一行一次调用。
 *
 * **收与支成对标红**（KOLAgents 那条）：亏本的行两列一起变红，而不是只标毛利
 * 那一格——一格红了看不出是收少了还是支多了。顶上那张亏本卡与总览的是同一个口径。
 */

import type { ColumnDef } from '@tanstack/react-table'
import { AlertTriangle, Download } from 'lucide-react'
import { Button, inputClass, Note, StatusPill, type Tone, WsCard } from '@/components/design'
import { PageHeader } from '@/components/layout'
import { ServerTable, useTableState } from '@/components/table'
import { qs } from '@/lib/api'
import { useApp, useQuery } from '@/lib/app'
import { cny, credits, orDash, when } from '@/lib/format'
import { cn } from '@/lib/utils'

interface UsageRow {
  id: number
  at: string
  org_id: string
  org_name: string | null
  workspace_id: string
  capability: string
  provider: string | null
  model: string | null
  unit: string
  quantity: number
  input_tokens: number | null
  output_tokens: number | null
  credits: number
  cost_micros: number | null
  charge_status: string | null
  request_id: string
}

const CHARGE_TONE: Record<string, Tone> = {
  charged: 'good',
  skipped: 'neutral',
  admin_exempt: 'info',
  insufficient_credits: 'warn',
  error: 'bad',
}

export function UsagePage(): React.ReactNode {
  const state = useTableState({ limit: 50 })
  const { t } = useApp()

  const filters = {
    org_id: state.get('org_id'),
    capability: state.get('capability'),
    provider: state.get('provider'),
    model: state.get('model'),
    charge_status: state.get('charge_status'),
    loss_only: state.get('loss_only'),
    from: state.get('from'),
    to: state.get('to'),
  }
  const list = useQuery<{
    rows: UsageRow[]
    total: number
    loss: { rows: number; loss_micros: number; worst_micros: number }
  }>(`/v1/admin/usage${qs({ ...filters, limit: state.limit, offset: state.offset })}`)
  const options = useQuery<{ capabilities: string[]; providers: string[]; models: string[] }>(
    '/v1/admin/usage/filters',
  )

  const columns: ColumnDef<UsageRow, unknown>[] = [
    {
      id: 'at',
      header: t('col.at'),
      cell: ({ row }) => <span className="ws-num">{when(row.original.at)}</span>,
    },
    {
      id: 'org',
      header: t('col.org'),
      cell: ({ row }) => (
        <span className="block max-w-[180px] truncate" title={row.original.org_id}>
          {orDash(row.original.org_name ?? row.original.org_id)}
        </span>
      ),
    },
    { id: 'capability', header: t('col.capability'), cell: ({ row }) => row.original.capability },
    {
      id: 'provider',
      header: t('col.provider'),
      cell: ({ row }) => orDash(row.original.provider),
    },
    {
      id: 'model',
      header: t('col.model'),
      cell: ({ row }) => (
        <span className="block max-w-[160px] truncate" title={row.original.model ?? ''}>
          {orDash(row.original.model)}
        </span>
      ),
    },
    {
      id: 'tokens',
      header: t('col.tokens'),
      cell: ({ row }) => (
        <span className="ws-num">
          {row.original.input_tokens === null && row.original.output_tokens === null
            ? '—'
            : `${String(row.original.input_tokens ?? 0)} / ${String(row.original.output_tokens ?? 0)}`}
        </span>
      ),
    },
    {
      id: 'credits',
      header: t('col.credits'),
      cell: ({ row }) => (
        <span className={cn('ws-num', isLoss(row.original) && 'text-ws-bad')}>
          {credits(row.original.credits)}
        </span>
      ),
    },
    {
      id: 'cost',
      header: t('col.cost'),
      cell: ({ row }) => (
        <span className={cn('ws-num', isLoss(row.original) && 'text-ws-bad')}>
          {row.original.cost_micros === null ? '—' : cny(row.original.cost_micros)}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('col.status'),
      cell: ({ row }) => {
        const status = row.original.charge_status ?? 'charged'
        return <StatusPill tone={CHARGE_TONE[status] ?? 'neutral'}>{status}</StatusPill>
      },
    },
  ]

  return (
    <>
      <PageHeader
        title={t('nav.usage')}
        right={
          <a
            href={`/v1/admin/usage/export.csv${qs(filters)}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ws-surface px-3 text-[13px] text-ws-ink hover:bg-ws-tint"
          >
            <Download className="size-3.5" aria-hidden />
            {t('action.export')}
          </a>
        }
      />

      {list.data !== undefined && list.data.loss.rows > 0 && (
        <WsCard className="mb-4 flex items-start gap-3 bg-ws-bad-bg p-4 text-ws-bad">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="ws-display text-[15px]">{t('overview.loss.title')}</p>
            <p className="mt-1 text-[13px]">
              {t('overview.loss.body', {
                rows: list.data.loss.rows,
                loss: cny(list.data.loss.loss_micros),
                worst: cny(list.data.loss.worst_micros),
              })}
            </p>
          </div>
          <Button
            className="ml-auto"
            onClick={() => {
              state.set({ loss_only: 'true' })
            }}
          >
            {t('filter.loss')}
          </Button>
        </WsCard>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className={cn(inputClass, 'w-52')}
          placeholder="org_id"
          defaultValue={filters.org_id ?? ''}
          onKeyDown={(e) => {
            if (e.key === 'Enter') state.set({ org_id: e.currentTarget.value })
          }}
        />
        <Select
          value={filters.capability}
          options={options.data?.capabilities ?? []}
          label={t('col.capability')}
          onChange={(v) => {
            state.set({ capability: v })
          }}
        />
        <Select
          value={filters.provider}
          options={options.data?.providers ?? []}
          label={t('col.provider')}
          onChange={(v) => {
            state.set({ provider: v })
          }}
        />
        <Select
          value={filters.model}
          options={options.data?.models ?? []}
          label={t('col.model')}
          onChange={(v) => {
            state.set({ model: v })
          }}
        />
        <Select
          value={filters.charge_status}
          options={['charged', 'skipped', 'admin_exempt', 'insufficient_credits', 'error']}
          label={t('col.status')}
          onChange={(v) => {
            state.set({ charge_status: v })
          }}
        />
        <label className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
          <input
            type="checkbox"
            checked={filters.loss_only === 'true'}
            onChange={(e) => {
              state.set({ loss_only: e.target.checked ? 'true' : undefined })
            }}
          />
          {t('filter.loss')}
        </label>
      </div>

      {list.error !== undefined && <Note tone="bad">{list.error.message}</Note>}

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

const isLoss = (row: UsageRow): boolean =>
  row.cost_micros !== null && row.cost_micros > row.credits * 1_000_000

function Select({
  value,
  options,
  label,
  onChange,
}: {
  value: string | undefined
  options: string[]
  label: string
  onChange: (next: string | undefined) => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <select
      aria-label={label}
      className={cn(inputClass, 'w-40')}
      value={value ?? ''}
      onChange={(e) => {
        onChange(e.target.value === '' ? undefined : e.target.value)
      }}
    >
      <option value="">
        {label}：{t('filter.all')}
      </option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  )
}
