/**
 * 组织（65 §4）：表 + 抽屉（成员、关联令牌、钱包 lots、近 30 天用量、停用 / 恢复）。
 *
 * 关联令牌那一栏**只显示前缀与动作集**——令牌明文我们自己也没有（库里只有哈希），
 * 而"哈希的前八位"看着像标识符，实际上是一个可以拿去做彩虹表的把手。
 */

import type { ColumnDef } from '@tanstack/react-table'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Button,
  Empty,
  Field,
  inputClass,
  Note,
  Spinner,
  StatusPill,
  WsTag,
} from '@/components/design'
import { Drawer, DrawerSection, KeyValues } from '@/components/drawer'
import { PageHeader } from '@/components/layout'
import { ServerTable, useTableState } from '@/components/table'
import { api, qs } from '@/lib/api'
import { useApp, useQuery } from '@/lib/app'
import { cny, compact, credits, day, orDash, when } from '@/lib/format'
import { cn } from '@/lib/utils'

interface OrgRow {
  org_id: string
  name: string
  owner_email: string
  created_at: string
  members: number
  active_links: number
  credits_available: number
  credits_30d: number
  cost_micros_30d: number
  calls_30d: number
  suspended: boolean
}

interface OrgDetail {
  org: {
    id: string
    name: string
    created_at: string
    suspension: { at: string; reason: string } | null
  }
  members: { account_id: string; email: string; role: string; joined_at: string }[]
  links: {
    id: string
    workspace_id: string
    label: string
    prefix: string
    scopes: string[]
    expires_at: string
    active: boolean
    last_used_at: string | null
  }[]
  lots: {
    id: string
    kind: string
    credits: number
    remaining: number
    granted_at: string
    expires_at: string | null
  }[]
  balance: { granted: number; purchased: number }
  usage_30d: { calls: number; credits: number; cost_micros: number }
  memberships: { id: string; plan_id: string; status: string; ends_at: string }[]
}

export function OrgsPage(): React.ReactNode {
  const { t, canWrite, lang } = useApp()
  const state = useTableState()
  const [params, setParams] = useSearchParams()
  const selected = params.get('id') ?? undefined

  const list = useQuery<{ rows: OrgRow[]; total: number }>(
    `/v1/admin/orgs${qs({
      q: state.q,
      suspended: state.get('suspended'),
      sort: state.sort,
      order: state.order,
      limit: state.limit,
      offset: state.offset,
    })}`,
  )
  const detail = useQuery<OrgDetail>(
    selected === undefined ? undefined : `/v1/admin/orgs/${selected}`,
  )

  const columns: ColumnDef<OrgRow, unknown>[] = [
    {
      id: 'name',
      header: t('col.name'),
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <span className="max-w-[240px] truncate text-ws-ink">{row.original.name}</span>
          {row.original.suspended && <StatusPill tone="bad">{t('badge.suspended')}</StatusPill>}
        </span>
      ),
    },
    { id: 'members', header: t('col.members'), cell: ({ row }) => row.original.members },
    { id: 'links', header: t('col.links'), cell: ({ row }) => row.original.active_links },
    {
      id: 'balance',
      header: t('col.balance'),
      cell: ({ row }) => <span className="ws-num">{credits(row.original.credits_available)}</span>,
    },
    {
      id: 'usage30',
      header: t('col.usage30'),
      cell: ({ row }) => (
        <span className="ws-num">
          {compact(row.original.calls_30d, lang)} · {credits(row.original.credits_30d)} ·{' '}
          {cny(row.original.cost_micros_30d)}
        </span>
      ),
    },
    {
      id: 'created_at',
      header: t('col.created_at'),
      cell: ({ row }) => <span className="ws-num">{when(row.original.created_at)}</span>,
    },
  ]

  const setSelected = (id: string | undefined): void => {
    const next = new URLSearchParams(params)
    if (id === undefined) next.delete('id')
    else next.set('id', id)
    setParams(next, { replace: false })
  }

  return (
    <>
      <PageHeader
        title={t('nav.orgs')}
        note={canWrite ? undefined : <Note tone="info">{t('readonly.notice')}</Note>}
        right={
          <div className="flex items-center gap-2">
            <input
              className={cn(inputClass, 'w-56')}
              placeholder={t('search.org')}
              defaultValue={state.q ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') state.set({ q: e.currentTarget.value })
              }}
            />
            <label className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
              <input
                type="checkbox"
                checked={state.get('suspended') === 'true'}
                onChange={(e) => {
                  state.set({ suspended: e.target.checked ? 'true' : undefined })
                }}
              />
              {t('filter.suspended')}
            </label>
          </div>
        }
      />

      <ServerTable
        columns={columns}
        rows={list.data?.rows}
        total={list.data?.total ?? 0}
        state={state}
        loading={list.loading}
        onRowClick={(row) => {
          setSelected(row.org_id)
        }}
        sortable={['name', 'created_at']}
        rowKey={(row) => row.org_id}
        selectedKey={selected}
      />

      <Drawer
        open={selected !== undefined}
        title={detail.data?.org.name ?? t('loading')}
        subtitle={detail.data?.org.id}
        onClose={() => {
          setSelected(undefined)
        }}
      >
        {detail.loading && detail.data === undefined && <Spinner label={t('loading')} />}
        {detail.data !== undefined && (
          <OrgDrawer
            detail={detail.data}
            onDone={() => {
              list.reload()
              detail.reload()
            }}
          />
        )}
      </Drawer>
    </>
  )
}

function OrgDrawer({ detail, onDone }: { detail: OrgDetail; onDone: () => void }): React.ReactNode {
  const { t, canWrite } = useApp()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <DrawerSection title={t('drawer.org')}>
        <KeyValues
          rows={[
            { label: t('col.created_at'), value: when(detail.org.created_at) },
            {
              label: t('drawer.balance'),
              value: `${credits(detail.balance.granted)} · ${credits(detail.balance.purchased)}`,
            },
            {
              label: t('drawer.usage30'),
              value: `${String(detail.usage_30d.calls)} · ${credits(detail.usage_30d.credits)} · ${cny(detail.usage_30d.cost_micros)}`,
            },
            {
              label: t('badge.suspended'),
              value: detail.org.suspension === null ? '—' : detail.org.suspension.reason,
            },
          ]}
        />
      </DrawerSection>

      <DrawerSection title={t('drawer.members')}>
        <ul className="flex flex-col gap-1 text-[13px]">
          {detail.members.map((m) => (
            <li key={m.account_id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{m.email}</span>
              <WsTag>{m.role}</WsTag>
            </li>
          ))}
        </ul>
      </DrawerSection>

      <DrawerSection title={t('drawer.links')}>
        {detail.links.length === 0 ? (
          <Empty label={t('empty')} />
        ) : (
          <ul className="flex flex-col gap-2 text-[13px]">
            {detail.links.map((link) => (
              <li key={link.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-ws-ink">{link.label}</span>
                  <span className="ws-num block text-xs text-ws-muted-fg">
                    {link.prefix}··· · {link.scopes.join(' / ')} · {day(link.expires_at)}
                  </span>
                </span>
                {link.active ? (
                  canWrite ? (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        void run(() => api.post(`/v1/admin/links/${link.id}/revoke`))
                      }}
                    >
                      {t('action.revoke_link')}
                    </Button>
                  ) : (
                    <StatusPill tone="good">ok</StatusPill>
                  )
                ) : (
                  <StatusPill tone="neutral">revoked</StatusPill>
                )}
              </li>
            ))}
          </ul>
        )}
      </DrawerSection>

      <DrawerSection title={t('drawer.lots')}>
        {detail.lots.length === 0 ? (
          <Empty label={t('empty')} />
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {detail.lots.map((lot) => (
                <tr key={lot.id} className="ws-tr">
                  <td className="ws-td">
                    <WsTag>{lot.kind}</WsTag>
                  </td>
                  <td className="ws-td ws-num text-right">
                    {credits(lot.remaining)} / {credits(lot.credits)}
                  </td>
                  <td className="ws-td ws-num text-right text-ws-muted-fg">
                    {orDash(lot.expires_at === null ? undefined : day(lot.expires_at))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DrawerSection>

      {canWrite && (
        <DrawerSection
          title={detail.org.suspension === null ? t('action.suspend') : t('action.resume')}
        >
          <div className="flex flex-col gap-2">
            <Note tone="warn">{t('suspend.note')}</Note>
            {detail.org.suspension === null ? (
              <>
                <Field label={t('form.reason')}>
                  <input
                    className={inputClass}
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value)
                    }}
                  />
                </Field>
                <Button
                  variant="danger"
                  disabled={busy || reason.trim().length < 2}
                  onClick={() => {
                    void run(() => api.post(`/v1/admin/orgs/${detail.org.id}/suspend`, { reason }))
                  }}
                >
                  {t('action.suspend')}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  void run(() => api.post(`/v1/admin/orgs/${detail.org.id}/resume`))
                }}
              >
                {t('action.resume')}
              </Button>
            )}
          </div>
        </DrawerSection>
      )}

      {error !== undefined && <Note tone="bad">{error}</Note>}
    </div>
  )
}
