/**
 * WP276（docs/95 §2.2 / §3.6，决策 236 / 237 / 256）：② 团队页的「同事」tab。
 *
 * 平级的几个人：名单（带忙闲、发起人一个小字）、请同事一起用（一个邀请码 + 它的链接，两套邀请合一）、
 * 想一起用的人（谁先点同意算谁的）、数据放哪一句、退出 / 请他离开。
 *
 * 不像公司：没有负责人卡、没有上级、没有成员额度、没有范围；发起人只管家务（请人离开、删品牌、搬数据）。
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { WsAvatar } from '@/components/design'
import { JoinPanel } from '@/components/onboarding/join-panel'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Separator } from '@/components/ui/separator'
import type { InviteView, MembershipRequestView, OrgMemberView } from '@/lib/api'
import { listColleagues } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'

/** 邀请链接：带着码的申请页（同事点开填名字邮箱 → 申请一起用）。 */
export const inviteLinkOf = (code: string): string =>
  `${globalThis.location?.origin ?? ''}/join/${encodeURIComponent(code)}`

export function ColleaguesTab({
  me,
  initiator,
  members,
  invites,
  requests,
  busy,
  error,
  onCreateInvite,
  onDecide,
  onRemove,
  onLeave,
  onExport,
}: {
  me: string | undefined
  /** 发起人的 person_id（组织所有者）。 */
  initiator: string | undefined
  members: OrgMemberView[]
  invites: InviteView[]
  requests: MembershipRequestView[]
  busy: boolean
  error?: string
  onCreateInvite: () => void
  onDecide: (id: string, approve: boolean) => void
  onRemove: (person_id: string, name: string) => void
  onLeave: () => void
  onExport: () => void
}): React.ReactNode {
  const { t } = useApp()
  const load = useQuery({ queryKey: ['colleagues'], queryFn: listColleagues, retry: false })
  const loads = new Map((load.data?.colleagues ?? []).map((c) => [c.person_id, c.load]))
  const live = members.filter((m) => m.left_at === undefined)
  const names = Object.fromEntries(members.map((m) => [m.person_id, m.name]))
  const iAmInitiator = me !== undefined && me === initiator

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="colleagues-tab">
      <ul className="flex flex-col gap-1.5">
        {live.map((m) => {
          const mine = m.person_id === me
          return (
            <li
              key={m.person_id}
              className="flex items-center gap-2.5 rounded-md border px-3 py-2"
              data-testid="colleague-row"
              data-person={m.person_id}
            >
              <WsAvatar name={m.name} className="size-7 text-xs" />
              <span className="font-medium">{mine ? `${m.name}（${t('team.you')}）` : m.name}</span>
              {m.person_id === initiator ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {t('team.initiator')}
                  <Hint text={t('team.initiator.hint')} />
                </span>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {mine ? null : (loads.get(m.person_id) ?? '')}
              </span>
              {!mine && iAmInitiator ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  data-testid="colleague-remove"
                  onClick={() => {
                    onRemove(m.person_id, m.name)
                  }}
                >
                  {t('team.remove')}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>

      {/* 决策 236：数据默认在发起人的电脑上——一句话 + 搬去哪（只有发起人搬） */}
      <p
        className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="team-data"
      >
        {t('team.data')}
        {iAmInitiator ? (
          <Link to="/connections#data-backend" className="underline-offset-2 hover:underline">
            {t('team.data.move')}
          </Link>
        ) : null}
        <Hint text={t('team.data.hint')} />
      </p>

      <Separator />
      <JoinPanel
        joinable={false}
        busy={busy}
        sent={false}
        invites={invites}
        requests={requests}
        names={names}
        inviteLink={inviteLinkOf}
        {...(error === undefined ? {} : { error })}
        onJoin={() => undefined}
        onCreateInvite={onCreateInvite}
        onDecide={onDecide}
      />

      <Separator />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          data-testid="team-export"
          onClick={onExport}
        >
          {t('team.export')}
        </Button>
        <Hint text={t('team.export.hint')} />
        {/* 发起人不直接退（先把发起人交给同事）——不出按钮，也不多说一句 */}
        {iAmInitiator ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-ws-bad"
            disabled={busy}
            data-testid="team-leave"
            onClick={onLeave}
          >
            {t('team.leave')}
          </Button>
        )}
      </div>
    </div>
  )
}
