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

/** 订阅那一行的摘要（后台抽屉与订阅列表共用这个形状）。 */
interface KolServiceSummary {
  org_id: string
  subscription: {
    status: 'none' | 'active' | 'grace' | 'suspended' | 'cancelling'
    current_cycle_end?: string
    granted_months: number
  }
  object_count: number
  pending_conflicts: number
  last_sync_at?: string
  charges: { cycle_start: string; credits: number; status: 'paid' | 'failed'; reason?: string }[]
}

/**
 * 抽屉里的「红人营销增值服务」那一块（67 §3 / WP118）。
 *
 * 为什么单独一次请求而不是塞进组织详情：这一块的数据在**另一个对象**里
 * （每个组织一个 `KolTenantDO`），而组织详情读的是账号库。合成一次请求就得让
 * 账号那一层去等租户对象——那一头没开通的时候，整个抽屉都会慢一拍。
 *
 * 没开通那一档**不画一堆 0**，写一句"这个节点没开通"（与看板页同一条）。
 */
function KolServiceSection({
  org_id,
  onDone,
}: {
  org_id: string
  onDone: () => void
}): React.ReactNode {
  const { t, canWrite } = useApp()
  const [months, setMonths] = useState('1')
  const [busy, setBusy] = useState(false)
  const summary = useQuery<KolServiceSummary>(`/v1/admin/orgs/${org_id}/kol-service`)

  if (summary.error !== undefined)
    return (
      <DrawerSection title={t('drawer.kol_service')}>
        <Note tone="warn">{t('kol_service.off')}</Note>
      </DrawerSection>
    )
  if (summary.data === undefined)
    return (
      <DrawerSection title={t('drawer.kol_service')}>
        <Spinner label={t('loading')} />
      </DrawerSection>
    )

  const row = summary.data
  const n = Number(months)
  return (
    <DrawerSection title={t('drawer.kol_service')}>
      <div className="flex flex-col gap-2">
        <KeyValues
          rows={[
            {
              label: t('kol_service.status'),
              value: t(`kol_service.status.${row.subscription.status}`),
            },
            {
              label: t('kol_service.cycle_end'),
              value: orDash(
                row.subscription.current_cycle_end === undefined
                  ? undefined
                  : day(row.subscription.current_cycle_end),
              ),
            },
            { label: t('kol_service.objects'), value: compact(row.object_count) },
            { label: t('kol_service.conflicts'), value: compact(row.pending_conflicts) },
            {
              label: t('kol_service.last_sync'),
              value: orDash(row.last_sync_at === undefined ? undefined : when(row.last_sync_at)),
            },
            {
              label: t('kol_service.granted'),
              value: t('kol_service.months', { n: String(row.subscription.granted_months) }),
            },
          ]}
        />
        {row.charges.length > 0 && (
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {row.charges.map((charge) => (
                <tr key={charge.cycle_start} className="ws-tr">
                  <td className="ws-td">{day(charge.cycle_start)}</td>
                  <td className="ws-td">
                    <WsTag>{charge.status}</WsTag>
                  </td>
                  <td className="ws-td ws-num text-right">{credits(charge.credits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canWrite && (
          <>
            <Note>{t('kol_service.grant.note')}</Note>
            <div className="flex items-end gap-2">
              <Field label={t('kol_service.grant')}>
                <input
                  className={inputClass}
                  value={months}
                  inputMode="numeric"
                  onChange={(e) => {
                    setMonths(e.target.value)
                  }}
                />
              </Field>
              <Button
                variant="primary"
                disabled={busy || !Number.isInteger(n) || n < 1 || n > 24}
                onClick={() => {
                  setBusy(true)
                  void api
                    .post(`/v1/admin/orgs/${org_id}/kol-service/grant`, { months: n })
                    .then(() => {
                      onDone()
                    })
                    .finally(() => {
                      setBusy(false)
                    })
                }}
              >
                {t('kol_service.grant')}
              </Button>
            </div>
          </>
        )}
      </div>
    </DrawerSection>
  )
}

/** 客服增值服务那一块的摘要（形状与 `@agentsws/hosted` 的 `SupportServiceSummary` 一致）。 */
interface SupportServiceSummary {
  org_id: string
  workspaces: {
    workspace_id: string
    subscription_status: 'none' | 'active' | 'grace' | 'suspended' | 'cancelling'
    current_cycle_end?: string
    grace_until?: string
    hosted?: {
      desired: 'run' | 'stop'
      state: 'running' | 'starting' | 'sleeping' | 'stopped'
      instance_type: string
      last_heartbeat_at?: string
      restarts_this_month: number
      snapshot?: { at: string; bytes: number; source: 'hosted' | 'local' }
      snapshot_kept_until?: string
      cost_estimate_usd_this_month: number
      cost_estimate_usd_full_month: number
      last_error?: string
    }
  }[]
}

const HOSTED_TONE = {
  running: 'good',
  starting: 'info',
  sleeping: 'warn',
  stopped: 'neutral',
} as const

const usd = (n: number): string => `$${n.toFixed(2)}`

/**
 * 抽屉里的「客服增值服务」那一块（WP128 / docs/64 §11）。
 *
 * 一个组织可能有好几个品牌，每个订阅的工作区一个容器，所以这里一行一个工作区：
 * 订阅状态、容器状态（运行 / 休眠 / 停止）、最近心跳、本月费用估算。
 * **只读**：起停只跟着订阅走，后台不提供手动开关（不然「扣了钱容器却停着」说不清）。
 */
function SupportServiceSection({ org_id }: { org_id: string }): React.ReactNode {
  const { t } = useApp()
  const summary = useQuery<SupportServiceSummary>(`/v1/admin/orgs/${org_id}/support-service`)
  if (summary.error !== undefined)
    return (
      <DrawerSection title={t('drawer.support_service')}>
        <Note tone="warn">{t('support_service.off')}</Note>
      </DrawerSection>
    )
  if (summary.data === undefined)
    return (
      <DrawerSection title={t('drawer.support_service')}>
        <Spinner label={t('loading')} />
      </DrawerSection>
    )
  if (summary.data.workspaces.length === 0)
    return (
      <DrawerSection title={t('drawer.support_service')}>
        <Empty label={t('support_service.empty')} />
      </DrawerSection>
    )
  return (
    <DrawerSection title={t('drawer.support_service')}>
      <div className="flex flex-col gap-3" data-testid="support-service">
        {summary.data.workspaces.map((row) => (
          <div key={row.workspace_id} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <WsTag>{row.workspace_id}</WsTag>
              {row.hosted !== undefined && (
                <StatusPill tone={HOSTED_TONE[row.hosted.state]}>
                  {t(`support_service.state.${row.hosted.state}`)}
                </StatusPill>
              )}
            </div>
            <KeyValues
              rows={[
                {
                  label: t('support_service.subscription'),
                  value: t(`kol_service.status.${row.subscription_status}`),
                },
                ...(row.hosted === undefined
                  ? []
                  : [
                      {
                        label: t('support_service.heartbeat'),
                        value: orDash(
                          row.hosted.last_heartbeat_at === undefined
                            ? undefined
                            : when(row.hosted.last_heartbeat_at),
                        ),
                      },
                      {
                        label: t('support_service.restarts'),
                        value: compact(row.hosted.restarts_this_month),
                      },
                      {
                        label: t('support_service.cost_month'),
                        value: usd(row.hosted.cost_estimate_usd_this_month),
                      },
                      {
                        label: t('support_service.cost_full'),
                        value: `${usd(row.hosted.cost_estimate_usd_full_month)} · ${row.hosted.instance_type}`,
                      },
                      {
                        label: t('support_service.snapshot'),
                        value: orDash(
                          row.hosted.snapshot === undefined
                            ? undefined
                            : `${when(row.hosted.snapshot.at)} · ${compact(row.hosted.snapshot.bytes)} B`,
                        ),
                      },
                      ...(row.hosted.snapshot_kept_until === undefined
                        ? []
                        : [
                            {
                              label: t('support_service.kept_until'),
                              value: day(row.hosted.snapshot_kept_until),
                            },
                          ]),
                    ]),
              ]}
            />
            {row.hosted?.last_error !== undefined && (
              <Note tone="warn">
                {t('support_service.error')}：{row.hosted.last_error}
              </Note>
            )}
          </div>
        ))}
        <Note>{t('support_service.cost_note')}</Note>
      </div>
    </DrawerSection>
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

      <KolServiceSection org_id={detail.org.id} onDone={onDone} />
      <SupportServiceSection org_id={detail.org.id} />

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
