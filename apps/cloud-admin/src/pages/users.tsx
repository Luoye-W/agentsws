/**
 * 用户（65 §5）：表 + 右侧抽屉。
 *
 * 抽屉里的动作按"可逆程度"从上往下排：吊销会话（随时能再登）→ 封禁（可撤）→
 * 改角色 → **删除**（最下面，红色，要先封禁、要手打邮箱）。
 *
 * **这里没有"模拟登录"**。云上只有账号、钱和计量，没有商家的业务正文（21），
 * 所以"以他的身份看一眼"没有东西可看——那个按钮只会制造一种我们能看的错觉。
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
  type Tone,
  WsTag,
} from '@/components/design'
import { Drawer, DrawerSection, KeyValues } from '@/components/drawer'
import { PageHeader } from '@/components/layout'
import { ServerTable, useTableState } from '@/components/table'
import { api, qs } from '@/lib/api'
import { useApp, useQuery } from '@/lib/app'
import { cny, credits, orDash, when } from '@/lib/format'
import type { Key } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface AccountRow {
  account_id: string
  email: string
  role: 'user' | 'support' | 'admin'
  created_at: string
  email_verified: boolean
  badge: 'banned' | 'member' | 'paid' | 'free'
  org_id: string | null
  org_name: string | null
  credits_granted: number
  credits_purchased: number
  banned: boolean
  ban_reason?: string
}

interface AccountDetail {
  account: {
    id: string
    email: string
    role: string
    created_at: string
    email_verified: boolean
  }
  org: { id: string; name: string; members: number; suspended: boolean } | null
  balance: { granted: number; purchased: number }
  usage_30d: { calls: number; credits: number; cost_micros: number }
  ban: { reason: string; banned_at: string; expires_at?: string } | null
  memberships: { id: string; plan_id: string; ends_at: string; status: string }[]
}

const BADGE_TONE: Record<AccountRow['badge'], Tone> = {
  banned: 'bad',
  member: 'brand',
  paid: 'good',
  free: 'neutral',
}

export function UsersPage(): React.ReactNode {
  const { t, canWrite } = useApp()
  const state = useTableState()
  const [params, setParams] = useSearchParams()
  const selected = params.get('id') ?? undefined

  const path = `/v1/admin/accounts${qs({
    q: state.q,
    role: state.get('role'),
    banned: state.get('banned'),
    sort: state.sort,
    order: state.order,
    limit: state.limit,
    offset: state.offset,
  })}`
  const list = useQuery<{ rows: AccountRow[]; total: number }>(path)
  const detail = useQuery<AccountDetail>(
    selected === undefined ? undefined : `/v1/admin/accounts/${selected}`,
  )

  const columns: ColumnDef<AccountRow, unknown>[] = [
    {
      id: 'email',
      header: t('col.email'),
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <span className="max-w-[240px] truncate text-ws-ink">{row.original.email}</span>
          {!row.original.email_verified && <WsTag>{t('badge.unverified')}</WsTag>}
        </span>
      ),
    },
    {
      id: 'role',
      header: t('col.role'),
      cell: ({ row }) => t(`role.${row.original.role}` as Key),
    },
    {
      id: 'badge',
      header: t('col.badge'),
      cell: ({ row }) => (
        <StatusPill tone={BADGE_TONE[row.original.badge]}>
          {t(`badge.${row.original.badge}` as Key)}
        </StatusPill>
      ),
    },
    {
      id: 'balance',
      header: t('col.balance'),
      cell: ({ row }) => (
        <span className="ws-num">
          {credits(row.original.credits_granted)}
          <span className="text-ws-muted-fg"> · </span>
          {credits(row.original.credits_purchased)}
        </span>
      ),
    },
    {
      id: 'org',
      header: t('col.org'),
      cell: ({ row }) => (
        <span className="max-w-[200px] truncate">{orDash(row.original.org_name)}</span>
      ),
    },
    {
      id: 'created_at',
      header: t('col.created_at'),
      cell: ({ row }) => <span className="ws-num">{when(row.original.created_at)}</span>,
    },
  ]

  const openRow = (row: AccountRow): void => {
    const next = new URLSearchParams(params)
    next.set('id', row.account_id)
    setParams(next, { replace: false })
  }
  const closeDrawer = (): void => {
    const next = new URLSearchParams(params)
    next.delete('id')
    setParams(next, { replace: false })
  }
  const refresh = (): void => {
    list.reload()
    detail.reload()
  }

  return (
    <>
      <PageHeader
        title={t('nav.users')}
        note={canWrite ? undefined : <Note tone="info">{t('readonly.notice')}</Note>}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={cn(inputClass, 'w-56')}
              placeholder={t('search.email')}
              defaultValue={state.q ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') state.set({ q: e.currentTarget.value })
              }}
            />
            <select
              className={cn(inputClass, 'w-36')}
              value={state.get('role') ?? ''}
              onChange={(e) => {
                state.set({ role: e.target.value })
              }}
            >
              <option value="">{t('filter.all')}</option>
              <option value="admin">{t('role.admin')}</option>
              <option value="support">{t('role.support')}</option>
              <option value="user">{t('role.user')}</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
              <input
                type="checkbox"
                checked={state.get('banned') === 'true'}
                onChange={(e) => {
                  state.set({ banned: e.target.checked ? 'true' : undefined })
                }}
              />
              {t('filter.banned')}
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
        onRowClick={openRow}
        sortable={['email', 'role', 'created_at']}
        rowKey={(row) => row.account_id}
        selectedKey={selected}
      />

      <Drawer
        open={selected !== undefined}
        title={detail.data?.account.email ?? t('loading')}
        subtitle={detail.data?.account.id}
        onClose={closeDrawer}
      >
        {detail.loading && detail.data === undefined && <Spinner label={t('loading')} />}
        {detail.data !== undefined && (
          <AccountDrawer detail={detail.data} onDone={refresh} onClosed={closeDrawer} />
        )}
      </Drawer>
    </>
  )
}

function AccountDrawer({
  detail,
  onDone,
  onClosed,
}: {
  detail: AccountDetail
  onDone: () => void
  onClosed: () => void
}): React.ReactNode {
  const { t, canWrite } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [banReason, setBanReason] = useState('')
  const [banUntil, setBanUntil] = useState('')
  const [role, setRole] = useState(detail.account.role)
  const [confirmEmail, setConfirmEmail] = useState('')
  const [deleteReason, setDeleteReason] = useState('')

  const run = async (fn: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      onDone()
      after?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const id = detail.account.id
  return (
    <div className="flex flex-col gap-1">
      <DrawerSection title={t('drawer.account')}>
        <KeyValues
          rows={[
            { label: t('col.role'), value: t(`role.${detail.account.role}` as Key) },
            { label: t('col.created_at'), value: when(detail.account.created_at) },
            {
              label: t('col.badge'),
              value: detail.account.email_verified ? t('badge.verified') : t('badge.unverified'),
            },
            { label: t('drawer.org'), value: orDash(detail.org?.name) },
            {
              label: t('drawer.balance'),
              value: `${credits(detail.balance.granted)} · ${credits(detail.balance.purchased)}`,
            },
            {
              label: t('drawer.usage30'),
              value: `${String(detail.usage_30d.calls)} · ${credits(detail.usage_30d.credits)} · ${cny(detail.usage_30d.cost_micros)}`,
            },
          ]}
        />
      </DrawerSection>

      <DrawerSection title={t('drawer.memberships')}>
        {detail.memberships.length === 0 ? (
          <Empty label={t('empty')} />
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {detail.memberships.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2">
                <WsTag>{m.plan_id}</WsTag>
                <span className="ws-num text-ws-muted-fg">
                  {m.status} · {when(m.ends_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DrawerSection>

      <Note tone="neutral">{t('no.impersonation')}</Note>

      {canWrite && (
        <>
          <DrawerSection title={t('drawer.ban')}>
            {detail.ban === null ? (
              <div className="flex flex-col gap-2">
                <Field label={t('form.reason')}>
                  <input
                    className={inputClass}
                    value={banReason}
                    onChange={(e) => {
                      setBanReason(e.target.value)
                    }}
                  />
                </Field>
                <Field label={t('form.expires_at')}>
                  <input
                    className={inputClass}
                    type="datetime-local"
                    value={banUntil}
                    onChange={(e) => {
                      setBanUntil(e.target.value)
                    }}
                  />
                </Field>
                <Button
                  variant="primary"
                  disabled={busy || banReason.trim().length < 2}
                  onClick={() => {
                    void run(() =>
                      api.post(`/v1/admin/accounts/${id}/ban`, {
                        reason: banReason,
                        ...(banUntil === ''
                          ? {}
                          : { expires_at: new Date(banUntil).toISOString() }),
                      }),
                    )
                  }}
                >
                  {t('action.ban')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <KeyValues
                  rows={[
                    { label: t('form.reason'), value: detail.ban.reason },
                    { label: t('col.at'), value: when(detail.ban.banned_at) },
                    { label: t('col.expires'), value: when(detail.ban.expires_at) },
                  ]}
                />
                <Button
                  disabled={busy}
                  onClick={() => {
                    void run(() => api.post(`/v1/admin/accounts/${id}/unban`))
                  }}
                >
                  {t('action.unban')}
                </Button>
              </div>
            )}
          </DrawerSection>

          <DrawerSection title={t('action.role')}>
            <div className="flex items-end gap-2">
              <Field label={t('form.new_role')}>
                <select
                  className={inputClass}
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value)
                  }}
                >
                  <option value="user">{t('role.user')}</option>
                  <option value="support">{t('role.support')}</option>
                  <option value="admin">{t('role.admin')}</option>
                </select>
              </Field>
              <Button
                disabled={busy || role === detail.account.role}
                onClick={() => {
                  void run(() => api.post(`/v1/admin/accounts/${id}/role`, { role }))
                }}
              >
                {t('action.confirm')}
              </Button>
            </div>
          </DrawerSection>

          <DrawerSection title={t('action.revoke_sessions')}>
            <Button
              disabled={busy}
              onClick={() => {
                void run(() => api.post(`/v1/admin/accounts/${id}/revoke-sessions`))
              }}
            >
              {t('action.revoke_sessions')}
            </Button>
          </DrawerSection>

          <DrawerSection title={t('action.delete')}>
            <div className="flex flex-col gap-2">
              <Note tone="bad">{t('delete.warning')}</Note>
              <Field label={t('form.reason')}>
                <input
                  className={inputClass}
                  value={deleteReason}
                  onChange={(e) => {
                    setDeleteReason(e.target.value)
                  }}
                />
              </Field>
              <Field label={t('form.email_confirm')}>
                <input
                  className={inputClass}
                  autoComplete="off"
                  value={confirmEmail}
                  onChange={(e) => {
                    setConfirmEmail(e.target.value)
                  }}
                />
              </Field>
              <Button
                variant="danger"
                disabled={
                  busy ||
                  detail.ban === null ||
                  deleteReason.trim().length < 2 ||
                  confirmEmail.trim().toLowerCase() !== detail.account.email.toLowerCase()
                }
                onClick={() => {
                  void run(
                    () =>
                      api.post(`/v1/admin/accounts/${id}/delete`, {
                        email_confirm: confirmEmail,
                        reason: deleteReason,
                      }),
                    onClosed,
                  )
                }}
              >
                {t('action.delete')}
              </Button>
            </div>
          </DrawerSection>
        </>
      )}

      {error !== undefined && <Note tone="bad">{error}</Note>}
    </div>
  )
}
