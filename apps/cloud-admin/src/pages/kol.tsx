/**
 * 公共红人库（WP116 §4 / 65）。
 *
 * 这一页只回答四个问题：
 *
 * 1. **库里有多少东西**（红人 / 联系方式 / 内容 / 观察），以及**是不是在长**
 *    （近 7 天、近 30 天新增）。一个孤零零的"723"说明不了任何事；
 * 2. **哪些平台**（按渠道的红人数与有联系方式的数）；
 * 3. **有人在用吗、赚不赚**（reveal 与上游调用的次数、积分、我方成本）——
 *    这一半来自**计量事件**，不是库里的行数。没接账本就说"看不了账"，
 *    不画一堆 0（与看板页同一条）；
 * 4. **某个人在不在库里，以及把他移除**（opt-out）。
 *
 * 移除是这一页唯一的破坏性动作，所以它要一句理由，并且**当场说清楚它不可撤销、
 * 以后搬家也搬不回来**——按之前就说，不是按完才说。
 */

import type { ColumnDef } from '@tanstack/react-table'
import { Database, Mail, Trash2, UserMinus, Video } from 'lucide-react'
import { useState } from 'react'
import {
  Button,
  inputClass,
  Kpi,
  Note,
  SectionTitle,
  StatusPill,
  WsCard,
} from '@/components/design'
import { PageHeader } from '@/components/layout'
import { ServerTable, useTableState } from '@/components/table'
import { api, qs } from '@/lib/api'
import { useApp, useQuery } from '@/lib/app'
import { cny, compact, credits, orDash, when } from '@/lib/format'
import { cn } from '@/lib/utils'

interface LibraryStats {
  creators: number
  contacts: number
  contents: number
  observations: number
  imported: number
  removed: number
  new_7d: number
  new_30d: number
  by_channel: { channel: string; creators: number; contacts: number }[]
  at: string
}

interface UsageRow {
  key: string
  calls: number
  credits: number
  cost_micros: number
}

interface CreatorRow {
  channel: string
  handle: string
  name?: string | null
  followers: number
  categories: string[]
  has_contact: boolean
  confidence: number
  observations: number
  imported_from?: string | null
  updated_at: string
}

/** 五个渠道（顺序与 `contracts` 的 `KOL_CHANNELS` 一致）。 */
const CHANNELS = ['youtube', 'instagram', 'tiktok', 'facebook', 'x']

export function KolPage(): React.ReactNode {
  const { t, lang, me } = useApp()
  const state = useTableState({ limit: 25 })
  const [removing, setRemoving] = useState<CreatorRow | undefined>(undefined)

  const stats = useQuery<{
    library: LibraryStats
    usage: { window: { from: string; to: string }; available: boolean; rows: UsageRow[] }
  }>('/v1/admin/kol')

  const filters = {
    q: state.get('q'),
    channel: state.get('channel'),
    has_contact: state.get('has_contact'),
    imported_only: state.get('imported_only'),
  }
  const list = useQuery<{ rows: CreatorRow[]; total: number }>(
    `/v1/admin/kol/creators${qs({ ...filters, limit: state.limit, offset: state.offset })}`,
  )

  const lib = stats.data?.library
  const usage = stats.data?.usage

  const columns: ColumnDef<CreatorRow, unknown>[] = [
    {
      id: 'channel',
      header: t('col.channel'),
      cell: ({ row }) => <StatusPill tone="neutral">{row.original.channel}</StatusPill>,
    },
    {
      id: 'handle',
      header: t('col.handle'),
      cell: ({ row }) => (
        <span className="block max-w-[220px] truncate" title={row.original.handle}>
          <span className="text-ws-ink">{orDash(row.original.name)}</span>
          <span className="ws-num block text-[11px] text-ws-muted-fg">@{row.original.handle}</span>
        </span>
      ),
    },
    {
      id: 'followers',
      header: t('col.followers'),
      cell: ({ row }) => <span className="ws-num">{compact(row.original.followers, lang)}</span>,
    },
    {
      id: 'categories',
      header: t('col.categories'),
      cell: ({ row }) => (
        <span className="block max-w-[180px] truncate text-ws-muted-fg">
          {row.original.categories.length === 0 ? '—' : row.original.categories.join('、')}
        </span>
      ),
    },
    {
      id: 'contact',
      header: t('col.has_contact'),
      cell: ({ row }) =>
        row.original.has_contact ? (
          <StatusPill tone="good">{t('kol.contact.yes')}</StatusPill>
        ) : (
          <span className="text-ws-muted-fg">—</span>
        ),
    },
    {
      id: 'source',
      header: t('col.source'),
      cell: ({ row }) => (
        <span className="text-ws-muted-fg text-[12px]">
          {row.original.imported_from === undefined || row.original.imported_from === null
            ? t('kol.source.own')
            : row.original.imported_from}
        </span>
      ),
    },
    {
      id: 'updated_at',
      header: t('col.updated_at'),
      cell: ({ row }) => <span className="ws-num">{when(row.original.updated_at)}</span>,
    },
    {
      id: 'remove',
      header: '',
      cell: ({ row }) =>
        me?.role === 'admin' ? (
          <Button
            variant="ghost"
            className="text-ws-bad"
            onClick={() => {
              setRemoving(row.original)
            }}
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t('action.kol_remove')}
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      <PageHeader title={t('nav.kol')} note={<Note tone="neutral">{t('kol.what')}</Note>} />

      {stats.error !== undefined && <Note tone="bad">{stats.error.message}</Note>}

      {lib !== undefined && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi
              label={t('kpi.kol_creators')}
              value={compact(lib.creators, lang)}
              delta={t('kpi.kol_new', { d7: lib.new_7d, d30: lib.new_30d })}
              icon={<Database className="size-3.5" />}
            />
            <Kpi
              label={t('kpi.kol_contacts')}
              value={compact(lib.contacts, lang)}
              /*
               * 这一格数的是**联系方式的条数**，不是"有邮箱的人数"（同一个人
               * 可能有两个邮箱）。所以下面那一句说的是覆盖率，不是把两个不同
               * 口径的数摆在一起——"14 条 / 其中搬来的 47 条"读起来像 47 > 14。
               */
              delta={t('kpi.kol_contact_rate', { p: pct(lib.contacts, lib.creators) })}
              tone="good"
              icon={<Mail className="size-3.5" />}
            />
            <Kpi
              label={t('kpi.kol_contents')}
              value={compact(lib.contents, lang)}
              delta={t('kpi.kol_observations', { n: lib.observations })}
              tone="info"
              icon={<Video className="size-3.5" />}
            />
            <Kpi
              label={t('kpi.kol_removed')}
              value={compact(lib.removed, lang)}
              delta={t('kpi.kol_removed_note')}
              tone="neutral"
              icon={<UserMinus className="size-3.5" />}
            />
          </div>

          <div className="mb-4 grid gap-3 lg:grid-cols-2">
            <WsCard className="p-4">
              <SectionTitle
                right={
                  <span className="text-[12px] text-ws-muted-fg">
                    {t('kpi.kol_imported', { n: compact(lib.imported, lang) })}
                  </span>
                }
              >
                {t('kol.by_channel')}
              </SectionTitle>
              {lib.by_channel.length === 0 ? (
                <p className="py-4 text-center text-sm text-ws-muted-fg">{t('kol.empty')}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {lib.by_channel.map((row) => (
                    <li key={row.channel} className="flex items-center gap-2 text-[13px]">
                      <span className="w-20 shrink-0 text-ws-muted-fg">{row.channel}</span>
                      <span className="ws-num w-16 shrink-0 text-right text-ws-ink">
                        {compact(row.creators, lang)}
                      </span>
                      <span className="ws-num w-24 shrink-0 text-right text-ws-muted-fg text-[12px]">
                        {t('kol.with_contact', { n: compact(row.contacts, lang) })}
                      </span>
                      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ws-surface">
                        <span
                          className="block h-full rounded-full bg-ws-brand"
                          style={{
                            width: `${String(pct(row.creators, lib.creators))}%`,
                          }}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </WsCard>

            <WsCard className="p-4">
              <SectionTitle>{t('kol.usage')}</SectionTitle>
              {usage?.available !== true ? (
                <Note tone="warn">{t('kol.usage.unavailable')}</Note>
              ) : usage.rows.length === 0 ? (
                <p className="py-4 text-center text-sm text-ws-muted-fg">{t('kol.usage.none')}</p>
              ) : (
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="text-ws-muted-fg text-[12px]">
                      <th className="py-1 text-left font-normal">{t('col.capability')}</th>
                      <th className="py-1 text-right font-normal">{t('kpi.calls')}</th>
                      <th className="py-1 text-right font-normal">{t('col.credits')}</th>
                      <th className="py-1 text-right font-normal">{t('col.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.rows.map((row) => (
                      <tr key={row.key} className="border-ws-line border-t">
                        <td className="py-1.5">{row.key}</td>
                        <td className="ws-num py-1.5 text-right">{compact(row.calls, lang)}</td>
                        <td className="ws-num py-1.5 text-right">{credits(row.credits)}</td>
                        <td
                          className={cn(
                            'ws-num py-1.5 text-right',
                            row.cost_micros > row.credits * 1_000_000 && 'text-ws-bad',
                          )}
                        >
                          {cny(row.cost_micros)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </WsCard>
          </div>
        </>
      )}

      <SectionTitle>{t('kol.search')}</SectionTitle>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className={cn(inputClass, 'w-64')}
          placeholder={t('kol.search.placeholder')}
          defaultValue={filters.q ?? ''}
          onKeyDown={(e) => {
            if (e.key === 'Enter') state.set({ q: e.currentTarget.value })
          }}
        />
        <select
          aria-label={t('col.channel')}
          className={cn(inputClass, 'w-36')}
          value={filters.channel ?? ''}
          onChange={(e) => {
            state.set({ channel: e.target.value === '' ? undefined : e.target.value })
          }}
        >
          <option value="">
            {t('col.channel')}：{t('filter.all')}
          </option>
          {CHANNELS.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
          <input
            type="checkbox"
            checked={filters.has_contact === 'true'}
            onChange={(e) => {
              state.set({ has_contact: e.target.checked ? 'true' : undefined })
            }}
          />
          {t('kol.filter.has_contact')}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
          <input
            type="checkbox"
            checked={filters.imported_only === 'true'}
            onChange={(e) => {
              state.set({ imported_only: e.target.checked ? 'true' : undefined })
            }}
          />
          {t('kol.filter.imported')}
        </label>
      </div>

      {list.error !== undefined && <Note tone="bad">{list.error.message}</Note>}

      <ServerTable
        columns={columns}
        rows={list.data?.rows}
        total={list.data?.total ?? 0}
        state={state}
        loading={list.loading}
        rowKey={(row) => `${row.channel}/${row.handle}`}
      />

      {removing !== undefined && (
        <RemoveDialog
          row={removing}
          onClose={() => {
            setRemoving(undefined)
          }}
          onDone={() => {
            setRemoving(undefined)
            list.reload()
            stats.reload()
          }}
        />
      )}
    </>
  )
}

const pct = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 100)

/**
 * 移除的确认框。
 *
 * **理由是必填的**（后端也拦着）：三个月后回头看"为什么这个人不在库里了"
 * 必须有答案。按之前就把"不可撤销、以后搬家也搬不回来"说清楚。
 */
function RemoveDialog({
  row,
  onClose,
  onDone,
}: {
  row: CreatorRow
  onClose: () => void
  onDone: () => void
}): React.ReactNode {
  const { t } = useApp()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <WsCard className="w-full max-w-md p-5">
        <h2 className="ws-display mb-2 text-[16px] text-ws-ink">
          {t('kol.remove.title', { who: `${row.channel}/@${row.handle}` })}
        </h2>
        <Note tone="bad">{t('kol.remove.warning')}</Note>
        <input
          className={cn(inputClass, 'mt-3 w-full')}
          placeholder={t('form.reason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value)
          }}
        />
        {error !== undefined && <p className="mt-2 text-[12px] text-ws-bad">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button
            variant="danger"
            disabled={busy || reason.trim().length < 2}
            onClick={() => {
              setBusy(true)
              setError(undefined)
              api
                .post(
                  `/v1/admin/kol/creators/${row.channel}/${encodeURIComponent(row.handle)}/remove`,
                  { reason: reason.trim() },
                )
                .then(onDone)
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err))
                  setBusy(false)
                })
            }}
          >
            {t('action.confirm')}
          </Button>
        </div>
      </WsCard>
    </div>
  )
}
