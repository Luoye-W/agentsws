/**
 * WP194：公司页「积分」tab——公司统一充值、给成员 / 岗位设每月上限。
 *
 * 分配不是把积分划成小钱包：钱只有公司那一份，这里设的是「每个人 / 每个岗位每月最多用多少」。
 * 默认不限（和以前一样）。执行在云上（预扣那一刻判），所以不管谁用哪台电脑、走 AI 还是数据，
 * 都算在一起。
 *
 * 四块：公司余额 + 本月已用（按能力四格）→ 充值四档（与设置 → 积分同一组卡）→ 成员表 →
 * 岗位表；最下面折着最近的改动记录（谁、从多少改到多少）。
 *
 * 纪律：**这一层不算账**——每个数都是云上那一份的透传；名字是本机的（云上只认 id）。
 * 只有公司的 owner / admin 进得来（判在服务端；别人来是 403 人话）。
 */
import type {
  AllocationAuditEntry,
  AllocationBucket,
  AllocationRow,
  AllocationSubjectKind,
} from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { TierCards } from '@/components/settings/credits-panel'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import type { OrgMemberView, OrgPositionView } from '@/lib/api'
import {
  ApiClientError,
  createTopup,
  getCloudAllocation,
  getCloudAllocationAudit,
  getCloudCredits,
  getTopupTiers,
  setCloudAllocationLimit,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

const BUCKETS: AllocationBucket[] = ['ai', 'data', 'task', 'other']

interface Line {
  id: string
  name: string
  left: boolean
  row: AllocationRow | undefined
}

export function CreditsTab({
  assignment,
  members,
  positions,
}: {
  assignment?: string
  members: OrgMemberView[]
  positions: OrgPositionView[]
}): React.ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [auditOpen, setAuditOpen] = useState(false)
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US'
  const num = (n: number): string =>
    n.toLocaleString(locale, { maximumFractionDigits: 2, minimumFractionDigits: 0 })

  const credits = useQuery({
    queryKey: ['cloud-credits', assignment],
    queryFn: () => getCloudCredits(assignment),
    retry: false,
  })
  const view = useQuery({
    queryKey: ['cloud-allocation', assignment],
    queryFn: () => getCloudAllocation(assignment),
    retry: false,
  })
  const tiers = useQuery({
    queryKey: ['cloud-topup-tiers', assignment],
    queryFn: () => getTopupTiers(assignment),
    retry: false,
  })
  const audit = useQuery({
    queryKey: ['cloud-allocation-audit', assignment],
    queryFn: () => getCloudAllocationAudit(assignment),
    enabled: auditOpen && view.data?.report !== undefined,
    retry: false,
  })
  const order = useMutation({
    mutationFn: (tier_id: string) => createTopup(tier_id, assignment),
    onSuccess: (created) => {
      // 付款永远在对方的页面上（13 §4.3），新窗口打开
      if (created.checkout_url !== undefined)
        window.open(created.checkout_url, '_blank', 'noreferrer,noopener')
    },
  })
  const save = useMutation({
    mutationFn: (input: {
      kind: AllocationSubjectKind
      subject_id: string
      monthly_limit: number | null
    }) => setCloudAllocationLimit(input, assignment),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['cloud-allocation'] })
      await client.invalidateQueries({ queryKey: ['cloud-allocation-audit'] })
    },
  })

  if (view.isPending) return <Skeleton className="h-64 w-full" />
  if (view.isError)
    return (
      <p className="text-sm text-muted-foreground" data-testid="alloc-error">
        {view.error instanceof ApiClientError ? view.error.message : t('error.generic')}
      </p>
    )
  const report = view.data?.report
  if (report === undefined)
    return (
      <p className="text-sm text-muted-foreground" data-testid="alloc-not-linked">
        {view.data?.reason ?? t('credits.not_linked')}
      </p>
    )

  /*
   * 名字：所有者这边有成员 / 岗位两张清单（公司页已经取了）；公司的 admin 拿不到那两张，
   * 就用服务端随报表给的名册（`view.names`）。
   */
  const names = view.data?.names
  const memberName = new Map<string, { name: string }>([
    ...Object.entries(names?.members ?? {}).map(([id, name]) => [id, { name }] as const),
    ...members.map((m) => [m.person_id, { name: m.name }] as const),
  ])
  const positionName = new Map<string, string>([
    ...Object.entries(names?.positions ?? {}),
    ...positions.map((p) => [p.id, lang === 'zh' ? p.name : p.name_en || p.name] as const),
  ])
  const roster =
    members.length > 0
      ? members
      : Object.keys(names?.members ?? {}).map((id) => ({ person_id: id, left_at: undefined }))
  const memberLines: Line[] = [
    ...roster
      .filter((m) => m.left_at === undefined)
      .map((m) => ({
        id: m.person_id,
        name: memberName.get(m.person_id)?.name ?? m.person_id,
        left: false,
        row: report.members.find((r) => r.subject_id === m.person_id),
      })),
    // 云上有账、本机已经不在成员里的（离开了的）：历史照样显示，账对得上
    ...report.members
      .filter((r) => !roster.some((m) => m.person_id === r.subject_id && m.left_at === undefined))
      .map((r) => ({
        id: r.subject_id,
        name: memberName.get(r.subject_id)?.name ?? r.subject_id,
        left: true,
        row: r,
      })),
  ]
  const positionIds =
    positions.length > 0 ? positions.map((p) => p.id) : Object.keys(names?.positions ?? {})
  const positionLines: Line[] = [
    ...positionIds.map((id) => ({
      id,
      name: positionName.get(id) ?? id,
      left: false,
      row: report.positions.find((r) => r.subject_id === id),
    })),
    ...report.positions
      .filter((r) => !positionIds.includes(r.subject_id))
      .map((r) => ({
        id: r.subject_id,
        name: positionName.get(r.subject_id) ?? r.subject_id,
        left: true,
        row: r,
      })),
  ]
  const nameOf = (kind: AllocationSubjectKind, id: string): string =>
    kind === 'member' ? (memberName.get(id)?.name ?? id) : (positionName.get(id) ?? id)
  const actorName = (actor: string): string =>
    actor.startsWith('account:') ? t('alloc.actor.account') : (memberName.get(actor)?.name ?? actor)

  const balance = credits.data?.balance ?? view.data?.balance
  const linked = credits.data?.linked === true || view.data?.linked === true
  /** Fable 09-29 定：认不出公司时区的按上海切，页面上注一句。 */
  const beijing = report.timezone === 'Asia/Shanghai' || report.timezone === 'Etc/GMT-8'

  return (
    <div className="flex flex-col gap-4" data-testid="alloc-tab">
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6 text-sm">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {t('alloc.title')}
            <Hint text={t('alloc.hint')} />
            {beijing ? (
              <span className="ml-auto text-[11px]" data-testid="alloc-timezone">
                {t('alloc.timezone.beijing')}
              </span>
            ) : null}
          </div>
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-6" data-testid="alloc-summary">
            <Figure
              label={t('alloc.balance')}
              value={balance === undefined ? '—' : num(balance.available)}
              strong
              testId="alloc-balance"
            />
            <Figure
              label={t('alloc.month_total')}
              value={num(report.total_credits)}
              {...(report.unattributed_credits > 0
                ? { note: t('alloc.unattributed', { n: num(report.unattributed_credits) }) }
                : {})}
            />
            {BUCKETS.map((b) => {
              const cell = report.buckets.find((x) => x.bucket === b)
              return (
                <Figure
                  key={b}
                  label={t(`alloc.bucket.${b}`)}
                  value={num(cell?.credits ?? 0)}
                  testId={`alloc-bucket-${b}`}
                />
              )
            })}
          </section>
          {/* 充值：进得了设置 → 积分的人才有（公司的 admin 不一定有那一档权限，就不画一排点不动的卡） */}
          {tiers.data === undefined ? null : <Separator />}
          {tiers.data === undefined ? null : (
            <TierCards
              tiers={tiers.data?.tiers}
              unavailable={tiers.data?.unavailable_reason}
              pending={tiers.isPending}
              linked={linked}
              busy={order.isPending}
              num={num}
              onPick={(id) => {
                order.mutate(id)
              }}
            />
          )}
          {order.isError ? (
            <p className="text-[11px] text-destructive" data-testid="alloc-topup-error">
              {order.error instanceof ApiClientError ? order.error.message : t('error.generic')}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <LimitTable
        kind="member"
        title={t('alloc.members')}
        lines={memberLines}
        num={num}
        busy={save.isPending}
        onSave={(subject_id, monthly_limit) => {
          save.mutate({ kind: 'member', subject_id, monthly_limit })
        }}
      />
      <LimitTable
        kind="position"
        title={t('alloc.positions')}
        lines={positionLines}
        num={num}
        busy={save.isPending}
        onSave={(subject_id, monthly_limit) => {
          save.mutate({ kind: 'position', subject_id, monthly_limit })
        }}
      />
      {save.isError ? (
        <p className="text-xs text-destructive" data-testid="alloc-save-error">
          {save.error instanceof ApiClientError ? save.error.message : t('error.generic')}
        </p>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-2 pt-4">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground"
            data-testid="alloc-audit-toggle"
            onClick={() => {
              setAuditOpen(!auditOpen)
            }}
          >
            {auditOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t('alloc.audit')}
          </button>
          {auditOpen ? (
            <ul
              className="flex flex-col gap-1 text-xs text-muted-foreground"
              data-testid="alloc-audit"
            >
              {(audit.data?.entries ?? []).slice(0, 10).map((e: AllocationAuditEntry) => (
                <li key={e.id} className="tabular-nums">
                  <span className="mr-2">{e.at.slice(5, 16).replace('T', ' ')}</span>
                  {t(
                    e.action === 'member_removed'
                      ? 'alloc.audit.removed'
                      : e.action === 'clear'
                        ? 'alloc.audit.clear'
                        : 'alloc.audit.set',
                    {
                      who: actorName(e.actor),
                      subject: nameOf(e.kind, e.subject_id),
                      from: e.from === undefined ? t('alloc.unlimited') : num(e.from),
                      to: e.to === undefined ? t('alloc.unlimited') : num(e.to),
                    },
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function Figure({
  label,
  value,
  note,
  strong = false,
  testId,
}: {
  label: string
  value: string
  note?: string
  strong?: boolean
  testId?: string
}): React.ReactNode {
  return (
    <div
      className="rounded-lg border p-2"
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={strong ? 'text-lg font-semibold tabular-nums' : 'text-base tabular-nums'}>
        {value}
      </p>
      {note === undefined ? null : <p className="text-[10px] text-muted-foreground">{note}</p>}
    </div>
  )
}

/** 一张「谁 / 本月已用 / 每月上限 / 改」的表（成员与岗位各一张）。 */
function LimitTable({
  kind,
  title,
  lines,
  num,
  busy,
  onSave,
}: {
  kind: AllocationSubjectKind
  title: string
  lines: Line[]
  num: (n: number) => string
  busy: boolean
  onSave: (subject_id: string, monthly_limit: number | null) => void
}): React.ReactNode {
  const { t } = useApp()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  return (
    <Card data-testid={`alloc-${kind}s`}>
      <CardContent className="pt-6">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 text-left font-normal">{title}</th>
              <th className="py-1.5 text-right font-normal">{t('alloc.col.used')}</th>
              <th className="w-40 py-1.5 text-right font-normal">{t('alloc.col.limit')}</th>
              <th className="w-44 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const row = line.row
              const limit = row?.monthly_limit
              const used = row?.used ?? 0
              const percent = row?.percent ?? 0
              const state =
                limit === undefined
                  ? 'none'
                  : percent >= 100
                    ? 'full'
                    : percent >= 80
                      ? 'near'
                      : 'ok'
              return (
                <tr
                  key={line.id}
                  className="border-b last:border-0"
                  data-testid="alloc-row"
                  data-subject={line.id}
                  data-state={state}
                >
                  <td className="py-2">
                    {line.name}
                    {line.left ? (
                      <span className="text-muted-foreground">{t('alloc.left')}</span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right tabular-nums">{num(used)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {editing === line.id ? (
                      <Input
                        autoFocus
                        inputMode="decimal"
                        className="ml-auto h-7 w-24 text-right"
                        placeholder={t('alloc.placeholder')}
                        value={draft}
                        data-testid="alloc-input"
                        onChange={(e) => {
                          setDraft(e.target.value)
                        }}
                      />
                    ) : limit === undefined ? (
                      <span className="text-muted-foreground">{t('alloc.unlimited')}</span>
                    ) : (
                      <div className="flex flex-col items-end gap-1">
                        <span className="flex items-center gap-1.5">
                          {state === 'full' || state === 'near' ? (
                            <span
                              className={`rounded px-1 text-[10px] ${
                                state === 'full'
                                  ? 'bg-destructive/10 text-destructive'
                                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                              }`}
                            >
                              {t(state === 'full' ? 'alloc.full' : 'alloc.near')}
                            </span>
                          ) : null}
                          {num(limit)}
                        </span>
                        <span className="h-1 w-24 overflow-hidden rounded bg-muted">
                          <span
                            className={`block h-full ${
                              state === 'full'
                                ? 'bg-destructive'
                                : state === 'near'
                                  ? 'bg-amber-500'
                                  : 'bg-primary'
                            }`}
                            style={{ width: `${String(Math.min(100, percent))}%` }}
                          />
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {editing === line.id ? (
                      <span className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          className="h-7"
                          disabled={busy || draft.trim() === '' || !(Number(draft) >= 0)}
                          data-testid="alloc-save"
                          onClick={() => {
                            onSave(line.id, Number(draft))
                            setEditing(null)
                          }}
                        >
                          {t('alloc.save')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          disabled={busy}
                          data-testid="alloc-clear"
                          onClick={() => {
                            onSave(line.id, null)
                            setEditing(null)
                          }}
                        >
                          {t('alloc.clear')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => {
                            setEditing(null)
                          }}
                        >
                          {t('alloc.cancel')}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        disabled={busy}
                        data-testid="alloc-edit"
                        onClick={() => {
                          setDraft(limit === undefined ? '' : String(limit))
                          setEditing(line.id)
                        }}
                      >
                        {t('alloc.edit')}
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
