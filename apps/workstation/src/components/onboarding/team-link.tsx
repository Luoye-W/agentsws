/**
 * WP427：同事怎么连进来（发起人这边）与「我申请加入的」（同事那边）。
 *
 * - {@link TeamLinkLine}：「和同事一起用」打开之后的两行小字——同一个网络那条路开没开、不在同一个网络
 *   那条路开没开（要工坊账号的就地给一个登录，决策 690：缺设置就在原地补，不赶去设置页）；Windows 上
 *   多一句为什么防火墙会问一次。长说明进 tooltip（docs/36 少字）。
 * - {@link TeamJoins}：我递出去的申请，对方同意了就有「打开」——在浏览器里打开对方的工坊，直接登录进去。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CloudAuthForm } from '@/components/cloud/cloud-auth-form'
import { openExternal } from '@/components/connections/bridge'
import {
  TeamChannelOpen,
  teamCloudLine,
  useTeamSubscription,
} from '@/components/settings/team-channel'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { enterTeamJoin, getTeamLink, listTeamJoins, type TeamLinkView } from '@/lib/api'
import { useMode } from '@/lib/mode'
import { cn } from '@/lib/utils'

export const TEAM_LINK_KEY = ['team-link'] as const
export const TEAM_JOINS_KEY = ['team-joins'] as const

const SETTLING = new Set<TeamLinkView['cloud']['state']>(['registering', 'connecting', 'backoff'])

const isWindows = (): boolean => /Windows/i.test(globalThis.navigator?.userAgent ?? '')

function Dot({ on }: { on: boolean }): React.ReactNode {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        on ? 'bg-ws-good' : 'bg-muted-foreground/40',
      )}
    />
  )
}

/** 「和同事一起用」打开之后：两条路各自开没开。 */
export function TeamLinkLine({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useMode()
  const client = useQueryClient()
  const [login, setLogin] = useState(false)
  const link = useQuery({
    queryKey: [...TEAM_LINK_KEY, assignment],
    queryFn: () => getTeamLink(assignment),
    retry: false,
    // 正在连：每 3 秒看一眼，连上了就不再刷
    refetchInterval: (q) =>
      q.state.data !== undefined && SETTLING.has(q.state.data.cloud.state) ? 3000 : false,
  })
  const view = link.data
  const cloud =
    view === undefined || view.cloud.state === 'unavailable' ? undefined : view.cloud.state
  // WP444：跨网那条路是增值服务——登录了账号就问一下订阅（没开 / 试用剩几天 / 宽限 / 已关）
  const wantsSub = view?.open === true && cloud !== undefined && cloud !== 'needs_account'
  const sub = useTeamSubscription(wantsSub ? assignment : undefined, wantsSub)
  if (view === undefined || !view.open) return null
  const subView = sub.data?.subscription
  const subLine = cloud === 'blocked' ? undefined : teamCloudLine(t, subView)
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="team-link">
      <p className="flex items-center gap-1.5" data-testid="team-link-lan">
        <Dot on={view.lan.on} />
        {t(view.lan.on ? 'team.link.lan.on' : 'team.link.lan.off')}
        <Hint text={t('team.link.hint')} />
      </p>
      {cloud === undefined ? null : (
        <p className="flex flex-wrap items-center gap-1.5" data-testid="team-link-cloud">
          <Dot on={cloud === 'online'} />
          {subLine ??
            t(
              cloud === 'online'
                ? 'team.link.cloud.online'
                : cloud === 'needs_account'
                  ? 'team.link.cloud.needs_account'
                  : cloud === 'needs_subscription'
                    ? 'team.link.cloud.needs_subscription'
                    : cloud === 'blocked'
                      ? 'team.link.cloud.blocked'
                      : cloud === 'stopped'
                        ? 'team.link.cloud.off'
                        : cloud === 'backoff'
                          ? 'team.link.cloud.backoff'
                          : 'team.link.cloud.connecting',
            )}
          {cloud === 'blocked' ? <Hint text={t('team.link.cloud.blocked.hint')} /> : null}
          {subView !== undefined && cloud !== 'blocked' ? (
            <TeamChannelOpen view={subView} {...(assignment === undefined ? {} : { assignment })} />
          ) : null}
          {cloud === 'needs_account' && !login ? (
            <Button
              size="xs"
              variant="ghost"
              data-testid="team-link-login"
              onClick={() => {
                setLogin(true)
              }}
            >
              {t('team.link.login')}
            </Button>
          ) : null}
        </p>
      )}
      {view.lan.on && isWindows() ? (
        <p data-testid="team-link-firewall">{t('team.link.firewall')}</p>
      ) : null}
      {login && cloud === 'needs_account' ? (
        <div className="rounded-md border p-3 text-sm text-foreground">
          <CloudAuthForm
            testPrefix="team-link"
            initialTab="login"
            {...(assignment === undefined ? {} : { assignment })}
            onDone={() => {
              setLogin(false)
              void client.invalidateQueries({ queryKey: TEAM_LINK_KEY })
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/** 我申请加入的（对方同意了就能「打开」）。没有就什么都不画。 */
export function TeamJoins({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useMode()
  const joins = useQuery({
    queryKey: [...TEAM_JOINS_KEY, assignment],
    queryFn: () => listTeamJoins(assignment),
    retry: false,
    // 等对方同意的时候隔一会儿问一次
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'pending') ? 15_000 : false),
  })
  const enter = useMutation({
    mutationFn: (id: string) => enterTeamJoin(id, assignment),
    onSuccess: ({ url }) => {
      openExternal(url)
    },
  })
  const rows = joins.data ?? []
  if (rows.length === 0) return null
  return (
    <section className="flex flex-col gap-1.5" data-testid="team-joins">
      <p className="text-xs font-medium">{t('team.joins.title')}</p>
      {rows.map((j) => (
        <div
          key={j.id}
          className="flex items-center justify-between gap-2 rounded-md border p-2"
          data-testid="team-join-row"
        >
          <span className="min-w-0 truncate">
            {j.workspace_label}
            <span className="ml-2 text-xs text-muted-foreground">
              {t(`team.joins.${j.status}`)}
            </span>
          </span>
          {j.can_enter ? (
            <span className="flex items-center gap-1">
              <Button
                size="xs"
                data-testid="team-join-enter"
                disabled={enter.isPending}
                onClick={() => {
                  enter.mutate(j.id)
                }}
              >
                {t('team.joins.enter')}
              </Button>
              <Hint text={t('team.joins.enter.hint')} />
            </span>
          ) : null}
        </div>
      ))}
      {enter.error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {enter.error.message}
        </p>
      )}
    </section>
  )
}
