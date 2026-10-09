/**
 * WP276（docs/95 §2.2 / §3.6，决策 236 / 237 / 256）：② 团队页的「同事」tab。
 *
 * 平级的几个人：名单（带忙闲、发起人一个小字）、请同事一起用（一个邀请码 + 它的链接，两套邀请合一）、
 * 想一起用的人（谁先点同意算谁的）、数据放哪一句、退出 / 请他离开。
 *
 * 不像公司：没有负责人卡、没有上级、没有成员额度、没有范围；发起人只管家务（请人离开、删品牌、搬数据）。
 *
 * WP282：名单下面是每个人这个月的积分（三块 + 次数，「没标注」单独一行）。
 *
 * WP278（决策 276 / 278）：发起人自己那一行多一个「把发起人交给…」（选一位同事，对方接下才换，
 * 还在等的时候那一行是「等 X 接 · 撤回」）；「退出」先问一句（列出会断开的个人连接）。
 * WP289（决策 293）：「请他离开」也先问一句，同一个框，列的是他的个人连接。
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { WsAvatar } from '@/components/design'
import { JoinPanel } from '@/components/onboarding/join-panel'
import { LeaveConfirm } from '@/components/peers/leave-confirm'
import { PeopleUsage } from '@/components/settings/people-usage'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Separator } from '@/components/ui/separator'
import type { InviteView, MembershipRequestView, OrgMemberView } from '@/lib/api'
import { listColleagues, type PeerOfferView } from '@/lib/api-peers'
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
  workspaceId,
  offers = [],
  onOfferInitiator,
  onWithdrawOffer,
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
  /** 点了「请他离开」框里的确认（框是这里自己开的：先问一句）。 */
  onRemove: (person_id: string, name: string) => void
  /** 点了退出框里的「退出」（框是这里自己开的：先问一句）。 */
  onLeave: () => void
  onExport: () => void
  /** WP278：退出前那一问要读这个工作区会断开哪几条个人连接。 */
  workspaceId?: string | undefined
  /** WP278：我发出去的「交出发起人」（还在等的 + 最近没接 / 退回的）。 */
  offers?: PeerOfferView[]
  /** WP278：把发起人交给这位同事（对方接下才换）。不给 = 不出入口。 */
  onOfferInitiator?: (person_id: string) => void
  onWithdrawOffer?: (id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const load = useQuery({ queryKey: ['colleagues'], queryFn: listColleagues, retry: false })
  const loads = new Map((load.data?.colleagues ?? []).map((c) => [c.person_id, c.load]))
  const live = members.filter((m) => m.left_at === undefined)
  const names = Object.fromEntries(members.map((m) => [m.person_id, m.name]))
  const iAmInitiator = me !== undefined && me === initiator
  const [picking, setPicking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  /** WP289（决策 293）：请谁离开（先问一句，列出会一起断开的他的个人连接）。 */
  const [removing, setRemoving] = useState<{ id: string; name: string } | undefined>(undefined)
  const handing = offers.filter((o) => o.kind === 'initiator')
  const waiting = handing.find((o) => o.state === 'offered')
  const ended = waiting === undefined ? handing.find((o) => o.state !== 'offered') : undefined
  const others = live.filter((m) => m.person_id !== me)

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
              {mine && iAmInitiator && onOfferInitiator !== undefined ? (
                waiting === undefined ? (
                  others.length === 0 ? null : (
                    <span className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        data-testid="initiator-give"
                        onClick={() => {
                          setPicking((v) => !v)
                        }}
                      >
                        {t('team.initiator.give')}
                      </Button>
                      <Hint text={t('team.initiator.give.hint')} />
                    </span>
                  )
                ) : (
                  <span
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                    data-testid="initiator-waiting"
                  >
                    {t('team.offer.waiting', { name: waiting.to_name })}
                    <span aria-hidden>·</span>
                    <Button
                      size="xs"
                      variant="link"
                      className="h-auto px-0"
                      disabled={busy}
                      data-testid="initiator-withdraw"
                      onClick={() => {
                        onWithdrawOffer?.(waiting.id)
                      }}
                    >
                      {t('team.offer.withdraw')}
                    </Button>
                  </span>
                )
              ) : null}
              {!mine && iAmInitiator ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  data-testid="colleague-remove"
                  onClick={() => {
                    setRemoving({ id: m.person_id, name: m.name })
                  }}
                >
                  {t('team.remove')}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
      {/* WP278：交出发起人——挑一位同事（对方收一张「交给你」的卡，接下才换） */}
      {picking && waiting === undefined && onOfferInitiator !== undefined ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="initiator-pick">
          {others.map((m) => (
            <Button
              key={m.person_id}
              size="sm"
              variant="outline"
              disabled={busy}
              data-person={m.person_id}
              onClick={() => {
                setPicking(false)
                onOfferInitiator(m.person_id)
              }}
            >
              {m.name}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPicking(false)
            }}
          >
            {t('action.cancel')}
          </Button>
        </div>
      ) : null}
      {ended === undefined || !iAmInitiator ? null : (
        <p className="text-xs text-muted-foreground" data-testid="initiator-ended">
          {ended.state === 'returned'
            ? t('team.offer.returned', { name: ended.to_name })
            : ended.reason === undefined
              ? t('team.offer.declined', { name: ended.to_name })
              : t('team.offer.declined.reason', { name: ended.to_name, reason: ended.reason })}
        </p>
      )}

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

      {/* WP282：每个人这个月的积分（共用一个余额，按人看得见；没关联云时是本机记的次数 / token） */}
      <PeopleUsage localFallback />

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
            onClick={() => {
              setLeaving(true)
            }}
          >
            {t('team.leave')}
          </Button>
        )}
      </div>
      <LeaveConfirm
        open={leaving}
        workspaceId={workspaceId}
        busy={busy}
        onCancel={() => {
          setLeaving(false)
        }}
        onConfirm={() => {
          setLeaving(false)
          onLeave()
        }}
      />
      <LeaveConfirm
        open={removing !== undefined}
        workspaceId={workspaceId}
        person={removing}
        busy={busy}
        onCancel={() => {
          setRemoving(undefined)
        }}
        onConfirm={() => {
          if (removing !== undefined) onRemove(removing.id, removing.name)
          setRemoving(undefined)
        }}
      />
    </div>
  )
}
