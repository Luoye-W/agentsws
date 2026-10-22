/**
 * WP444（决策 1377–1381）：团队通道这项增值服务——跨网那条路按月收积分，同一个网络照常免费。
 *
 * 三处用它：
 * - 设置 →「个人与团队」里「和同事一起用」那块的跨网一行（`team-link.tsx` 用 {@link teamCloudLine} 与
 *   {@link TeamChannelOpen}）：没开就地给「开通（7 天免费试用）」，点了在原地弹一张小卡写清每月多少积分、含几人
 *   （决策 690：就地完成，不赶去别的页）；
 * - 设置 →「账号与积分」里一张卡（{@link TeamChannelCard}），和红人营销增值服务同一个样式；
 * - 价钱与档位从云上取（后台可改），这里不写死。长说明进问号（界面少字）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  cancelTeamChannel,
  getTeamSubscription,
  subscribeTeamChannel,
  type TeamSubscriptionLocalView,
  type TeamSubscriptionView,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const TEAM_SUB_KEY = ['team-subscription'] as const

type T = (key: string, vars?: Record<string, string>) => string

const DAY = 86_400_000

/** 剩几天（向上取整，过了是 0）。 */
export function daysLeft(iso: string | undefined, now = Date.now()): number {
  if (iso === undefined) return 0
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / DAY))
}

/** 北京时间的「月-日」。 */
export function monthDay(iso: string | undefined): string {
  if (iso === undefined) return ''
  const d = new Date(Date.parse(iso) + 8 * 3_600_000)
  return `${String(d.getUTCMonth() + 1)}-${String(d.getUTCDate())}`
}

/** 问号里那段长说明（档位从云上那一份拼）。 */
export function teamSubHint(t: T, view: TeamSubscriptionView | undefined): string {
  const pricing = view?.pricing
  const tiers = pricing?.tiers ?? []
  const top = tiers[tiers.length - 1]
  return t('team.sub.hint', {
    tiers: tiers
      .map((x) => t('team.sub.tier', { members: String(x.members), credits: String(x.credits) }))
      .join(t('team.sub.tier.sep')),
    top: String(top?.members ?? ''),
    extra: String(pricing?.extra_per_member ?? ''),
  })
}

/** 「每月 X 积分 · 含 N 人」。 */
export function teamSubPrice(t: T, view: TeamSubscriptionView): string {
  return view.tier.extra_members > 0
    ? t('team.sub.price.extra', {
        credits: String(view.tier.credits),
        members: String(view.members),
      })
    : t('team.sub.price', {
        credits: String(view.tier.credits),
        members: String(view.tier.members),
      })
}

/** 状态那一个词（长期免费压过别的）。 */
export function teamSubState(t: T, view: TeamSubscriptionView): string {
  return view.comped ? t('team.sub.state.comped') : t(`team.sub.state.${view.status}`)
}

/** 状态下面那一句。 */
export function teamSubNote(t: T, view: TeamSubscriptionView, now = Date.now()): string {
  if (view.comped) return t('team.sub.note.comped')
  switch (view.status) {
    case 'trial':
      return t(view.cancel_at_period_end ? 'team.sub.note.trial_cancel' : 'team.sub.note.trial', {
        days: String(daysLeft(view.trial_ends_at, now)),
      })
    case 'active':
      return t('team.sub.note.active', { date: monthDay(view.current_cycle_end) })
    case 'grace':
      return t('team.sub.note.grace', { date: monthDay(view.grace_until) })
    case 'suspended':
      return t('team.sub.note.suspended')
    case 'cancelling':
      return t('team.sub.note.cancelling', { date: monthDay(view.current_cycle_end) })
    default:
      return t('team.sub.note.none')
  }
}

/**
 * 「和同事一起用」里跨网那一行要不要换成订阅的话：没开 / 宽限 / 已关 / 试用剩几天。
 * 回 undefined = 照旧显示连接状态（已开 / 连接中……）。
 */
export function teamCloudLine(
  t: T,
  view: TeamSubscriptionView | undefined,
  now = Date.now(),
): string | undefined {
  if (view === undefined || view.comped) return undefined
  switch (view.status) {
    case 'none':
      return t('team.link.cloud.needs_subscription')
    case 'suspended':
      return t('team.link.cloud.suspended')
    case 'grace':
      return t('team.link.cloud.grace', { date: monthDay(view.grace_until) })
    case 'trial':
      return t('team.link.cloud.trial', { days: String(daysLeft(view.trial_ends_at, now)) })
    default:
      return undefined
  }
}

/** 开通 / 续费 / 继续用那个按钮上写什么（不该有按钮回 undefined）。 */
export function teamSubAction(t: T, view: TeamSubscriptionView): string | undefined {
  if (view.comped) return undefined
  if (view.status === 'none')
    return t(view.trial_available ? 'team.sub.open.trial' : 'team.sub.open')
  if (view.status === 'grace' || view.status === 'suspended') return t('team.sub.renew')
  if (view.cancel_at_period_end) return t('team.sub.resume')
  return undefined
}

export function useTeamSubscription(assignment?: string, enabled = true) {
  return useQuery<TeamSubscriptionLocalView>({
    queryKey: [...TEAM_SUB_KEY, assignment],
    queryFn: () => getTeamSubscription(assignment),
    retry: false,
    enabled,
  })
}

function useTeamSubMutations(assignment: string | undefined, onNote: (s: string) => void) {
  const { t } = useApp()
  const qc = useQueryClient()
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: TEAM_SUB_KEY })
    void qc.invalidateQueries({ queryKey: ['team-link'] })
  }
  const subscribe = useMutation({
    mutationFn: () => subscribeTeamChannel(assignment),
    onSuccess: (got) => {
      if (got.subscription !== undefined) onNote(t('team.sub.opened'))
      else if (got.reason !== undefined) onNote(got.reason)
      refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: () => cancelTeamChannel(assignment),
    onSuccess: () => {
      onNote(t('team.sub.cancelled'))
      refresh()
    },
  })
  return { subscribe, cancel }
}

/**
 * 「和同事一起用」跨网那一行后面：开通按钮 + 点了就地弹的小卡（每月多少积分、含几人、问号里长说明）。
 * 已开 / 试用中没有按钮；宽限 / 已关是「续费」（当场再扣一次，钱不够照样进宽限）。
 */
export function TeamChannelOpen({
  assignment,
  view,
}: {
  assignment?: string
  view: TeamSubscriptionView
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const { subscribe } = useTeamSubMutations(assignment, setNote)
  const label = teamSubAction(t, view)
  if (label === undefined && note === undefined) return null
  return (
    // `contents`：按钮跟在那一行字后面，小卡与回执占满一行、换到下一行（不把那一行字撑高）
    <span className="contents" data-testid="team-sub-open">
      {label !== undefined && !open ? (
        <Button
          size="xs"
          variant="outline"
          data-testid="team-sub-open-button"
          onClick={() => {
            setNote(undefined)
            setOpen(true)
          }}
        >
          {label}
        </Button>
      ) : null}
      {open ? (
        // 占满一行的外框：小卡自己限宽（max-width 会让 flex 不换行，所以分两层）
        <span className="mt-1 basis-full">
          <span
            className="flex flex-col gap-2 rounded-md border bg-card p-2.5 text-xs text-foreground sm:max-w-sm"
            data-testid="team-sub-confirm"
          >
            <span className="flex items-center gap-1 font-medium">
              {teamSubPrice(t, view)}
              <Hint text={teamSubHint(t, view)} />
            </span>
            {view.status === 'none' && view.trial_available ? (
              <span className="text-muted-foreground">{t('team.sub.note.none')}</span>
            ) : null}
            <span className="flex items-center gap-1.5">
              <Button
                size="xs"
                disabled={subscribe.isPending}
                data-testid="team-sub-confirm-yes"
                onClick={() => {
                  subscribe.mutate(undefined, {
                    onSuccess: () => {
                      setOpen(false)
                    },
                  })
                }}
              >
                {view.status === 'none' ? t('team.sub.confirm') : (label ?? t('team.sub.confirm'))}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={subscribe.isPending}
                onClick={() => {
                  setOpen(false)
                }}
              >
                {t('team.sub.later')}
              </Button>
            </span>
            {subscribe.isError ? (
              <span role="alert" className="text-destructive">
                {subscribe.error instanceof Error
                  ? subscribe.error.message
                  : String(subscribe.error)}
              </span>
            ) : null}
          </span>
        </span>
      ) : null}
      {note !== undefined && !open ? (
        <span
          role="status"
          className="basis-full text-muted-foreground"
          data-testid="team-sub-note-line"
        >
          {note}
        </span>
      ) : null}
    </span>
  )
}

/** 设置 → 账号与积分里那一张（和红人营销增值服务同一个样式）。 */
export function TeamChannelCard({
  assignment,
  onLinkFirst,
}: {
  assignment?: string | undefined
  onLinkFirst?: (() => void) | undefined
}): React.ReactNode {
  const { t } = useApp()
  const [note, setNote] = useState<string | undefined>(undefined)
  const status = useTeamSubscription(assignment)
  const { subscribe, cancel } = useTeamSubMutations(assignment, setNote)
  if (status.isPending) return <Skeleton className="h-24 w-full" />
  const local = status.data
  // 这个服务没有团队通道（托管实例等）：不出这张卡
  if (local === undefined) return null
  const view = local.subscription
  const state = view === undefined ? 'none' : view.comped ? 'comped' : view.status
  const busy = subscribe.isPending || cancel.isPending
  const failed = [subscribe, cancel].find((m) => m.isError)?.error ?? undefined
  const action = view === undefined ? undefined : teamSubAction(t, view)
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border p-2.5"
      data-slot="card"
      data-testid="team-channel-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-1 text-xs font-medium">
            {t('team.sub.title')}
            <Hint text={teamSubHint(t, view)} />
          </h4>
          {view === undefined ? null : (
            <p className="text-xs text-muted-foreground" data-slot="status">
              {teamSubPrice(t, view)}
            </p>
          )}
        </div>
        <span
          data-slot="status"
          data-testid="team-channel-state"
          data-state={state}
          className={
            state === 'grace' || state === 'suspended'
              ? 'rounded bg-ws-warn-bg px-1.5 py-0.5 text-xs text-ws-warn'
              : 'rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground'
          }
        >
          {view === undefined ? t('team.sub.state.none') : teamSubState(t, view)}
        </span>
      </div>

      {local.linked === false ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" data-testid="team-channel-not-linked">
            {t('team.sub.not_linked')}
          </p>
          {onLinkFirst === undefined ? null : (
            <Button size="xs" variant="outline" onClick={onLinkFirst}>
              {t('credits.link_first')}
            </Button>
          )}
        </div>
      ) : view === undefined ? (
        <p className="text-xs text-muted-foreground" data-testid="team-channel-reason">
          {local.reason}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="team-channel-note">
            {teamSubNote(t, view)}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {action === undefined ? null : (
              <Button
                size="xs"
                disabled={busy}
                data-testid="team-channel-subscribe"
                onClick={() => {
                  setNote(undefined)
                  subscribe.mutate()
                }}
              >
                {action}
              </Button>
            )}
            {view.usable && !view.comped && !view.cancel_at_period_end && view.status !== 'none' ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                data-testid="team-channel-cancel"
                onClick={() => {
                  setNote(undefined)
                  cancel.mutate()
                }}
              >
                {t('team.sub.cancel')}
              </Button>
            ) : null}
          </div>
        </>
      )}

      {failed !== undefined ? (
        <p className="text-xs text-destructive" role="alert" data-testid="team-channel-error">
          {failed instanceof Error ? failed.message : String(failed)}
        </p>
      ) : note !== undefined ? (
        <p className="text-xs text-muted-foreground" role="status">
          {note}
        </p>
      ) : null}
    </section>
  )
}
