/**
 * WP510（决策 1515，WP459-T2）：收件箱的**团队那一面**——只在 ② 同事互联 / ③ 公司里出现；① 个人里这里的
 * 每一个组件都画空（收件箱回来的 `team` / `owners` 本来就没有），一个字都不多。
 *
 * - 「X 在看」：别人正开着这一件（心跳，离开就消失）；
 * - 「给 X」/「X 不在，转给你」：这一件归谁（「全部」里别人的、负责人不在转来的）；
 * - 页头「给我的 / 全部」与「分工」（每只邮箱的负责人、多少天没上线算不在、不在时交给谁）；
 * - 右栏「刚处理」：谁批了 / 不要了哪一张（处理留名）。
 */
import {
  TEAM_INBOX_AWAY_DAYS_MAX,
  TEAM_INBOX_AWAY_DAYS_MIN,
  type TeamInboxFallback,
  type TeamInboxPatch,
  type TeamInboxView,
} from '@agentsws/contracts'
import type { InboxHandled, InboxItem, InboxScope, InboxView } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Segmented, StatusPill, WsAvatar } from '@/components/design'
import { Popover } from '@/components/messages/popover'
import { getInboxTeam, setInboxTeam } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { useMode } from '@/lib/mode'
import { cn } from '@/lib/utils'
import { shortTime, useInboxRefresh, useInboxViewers } from './inbox-model'

const TEAM_QUERY = ['inbox', 'team-settings'] as const

/** 「林峰在看」（有人开着这一件才出）。`bare` = 只要头像（窄地方）。 */
export function ViewerChip({
  id,
  bare = false,
}: {
  id: string | undefined
  bare?: boolean
}): ReactNode {
  const { t } = useApp()
  const viewers = useInboxViewers(id)
  if (viewers.length === 0) return null
  const text = t('inbox.team.viewing', { name: viewers.map((v) => v.name).join('、') })
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ws-tint py-0.5 pr-2 pl-0.5 text-xs text-ws-brand-ink"
      data-testid="inbox-viewing"
      title={text}
    >
      <span className="flex -space-x-1">
        {viewers.slice(0, 2).map((v) => (
          <WsAvatar
            key={v.person_id}
            id={v.person_id}
            name={v.name}
            className="size-[18px] text-xs ring-2 ring-ws-tint"
          />
        ))}
      </span>
      {bare ? null : text}
    </span>
  )
}

/** 这一件归谁：「全部」里别人的写「给 X」；负责人不在转给我的写「X 不在，转给你」。 */
export function OwnerNote({ item }: { item: InboxItem }): ReactNode {
  const { t } = useApp()
  if (item.fallback_from !== undefined && item.mine === true)
    return (
      <span
        className="shrink-0 text-xs text-ws-warn"
        data-testid="inbox-owner"
        data-kind="fallback"
      >
        {t('inbox.team.fallback', { name: item.fallback_from.map((p) => p.name).join('、') })}
      </span>
    )
  if (item.mine !== false || item.owners === undefined || item.owners.length === 0) return null
  return (
    <span
      className="shrink-0 text-xs text-ws-muted-fg"
      data-testid="inbox-owner"
      data-kind="others"
    >
      {t('inbox.team.for', { name: item.owners.map((p) => p.name).join('、') })}
    </span>
  )
}

/** 页头「给我的 / 全部」（只在 ② / ③）。 */
export function InboxScopeSwitch({
  view,
  scope,
  onChange,
}: {
  view: InboxView | undefined
  scope: InboxScope
  onChange(next: InboxScope): void
}): ReactNode {
  const { t } = useApp()
  const team = view?.team
  if (team === undefined) return null
  return (
    <Segmented
      label={t('inbox.team.scope')}
      testId="inbox-scope"
      value={scope}
      options={[
        {
          value: 'mine',
          label: t('inbox.team.scope.mine'),
          count: team.mine,
          testId: 'inbox-scope-mine',
        },
        {
          value: 'all',
          label: t('inbox.team.scope.all'),
          count: team.all,
          testId: 'inbox-scope-all',
        },
      ]}
      onChange={onChange}
    />
  )
}

/** 「林峰批了「…」」这一句（「刚处理」、一张一张的「刚才」、第三栏「已经处理了」共用）。 */
export function handledText(
  h: InboxHandled,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  const name = h.self ? t('inbox.team.you') : h.by.name
  return t(`inbox.team.did.${h.action}`, { name, title: h.title })
}

/** 右栏「刚处理」：最近 24 小时谁处理了什么（处理留名）。 */
export function InboxHandledList({ view }: { view: InboxView | undefined }): ReactNode {
  const { t, lang } = useApp()
  const rows = view?.team?.handled ?? []
  if (view?.team === undefined || rows.length === 0) return null
  return (
    <section className="ws-card p-4" data-testid="inbox-handled">
      <h3 className="mb-2 text-[13px] font-semibold text-ws-ink">{t('inbox.team.handled')}</h3>
      <ul className="flex flex-col gap-2">
        {rows.slice(0, 5).map((h) => (
          <li
            key={`${h.card_id}-${h.at}`}
            className="flex items-center gap-2 text-[13px]"
            data-testid="inbox-handled-row"
            data-by={h.self ? 'self' : 'other'}
          >
            <WsAvatar id={h.by.person_id} name={h.by.name || '?'} className="size-[22px] text-xs" />
            <span className="min-w-0 flex-1 truncate text-ws-body">{handledText(h, t)}</span>
            <span className="shrink-0 text-xs text-ws-faint">
              {shortTime(h.at, Date.now(), lang)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 页头「分工」（只在 ② / ③）：点开是收件箱分工那一格。 */
export function InboxTeamButton({ view }: { view: InboxView | undefined }): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  if (view?.team === undefined) return null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      testId="inbox-team-popover"
      trigger={
        <button
          type="button"
          data-testid="inbox-team-button"
          aria-expanded={open}
          className="ws-link-muted inline-flex items-center gap-1 text-[13px]"
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          <Users aria-hidden className="size-3.5" />
          {t('inbox.team.button')}
        </button>
      }
    >
      <InboxTeamPanel />
    </Popover>
  )
}

/** 收件箱分工：每只邮箱的负责人（点名字勾上 / 去掉）+ 一行「负责人 N 天没上线，交给…」。 */
export function InboxTeamPanel(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const refresh = useInboxRefresh()
  const q = useQuery({ queryKey: TEAM_QUERY, queryFn: getInboxTeam, retry: false })
  const [error, setError] = useState<string | undefined>()
  const save = useMutation({
    mutationFn: (patch: TeamInboxPatch) => setInboxTeam(patch),
    onSuccess: (next) => {
      setError(undefined)
      client.setQueryData(TEAM_QUERY, next)
      refresh()
    },
    onError: (e: unknown) => {
      setError(apiErrorText(e, t))
    },
  })
  const data = q.data
  if (data === undefined)
    return (
      <div className="w-80 p-3 text-[13px] text-ws-muted-fg" data-testid="inbox-team-panel">
        {q.error === null ? '' : apiErrorText(q.error, t)}
      </div>
    )
  const edit = data.can_edit && !save.isPending
  const toggle = (account: string, owners: string[], person: string): void => {
    const next = owners.includes(person) ? owners.filter((p) => p !== person) : [...owners, person]
    save.mutate({ mailbox: { account, owners: next } })
  }
  return (
    <div className="flex w-[360px] flex-col gap-3 p-3" data-testid="inbox-team-panel">
      <h3 className="text-[14px] font-semibold text-ws-ink">{t('inbox.team.title')}</h3>
      <section className="flex flex-col gap-2">
        <span className="text-xs text-ws-muted-fg">{t('inbox.team.mailbox_owners')}</span>
        {data.mailboxes.length === 0 ? (
          <p className="text-[13px] text-ws-muted-fg">{t('inbox.team.no_mailbox')}</p>
        ) : (
          data.mailboxes.map((m) => (
            <div
              key={m.account}
              className="flex flex-col gap-1.5 rounded-[12px] bg-ws-surface p-2.5"
              data-testid="inbox-team-mailbox"
              data-account={m.account}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ws-ink">
                  {m.account}
                </span>
                {m.owners.length === 0 ? (
                  <span className="shrink-0 text-xs text-ws-faint">{t('inbox.team.no_owner')}</span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {data.members.map((p) => {
                  const on = m.owners.includes(p.person_id)
                  return (
                    <button
                      key={p.person_id}
                      type="button"
                      aria-pressed={on}
                      disabled={!edit}
                      data-testid="inbox-team-owner"
                      data-person={p.person_id}
                      data-on={on ? 'true' : 'false'}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-0.5 text-xs',
                        on
                          ? 'bg-ws-tint font-medium text-ws-brand-ink'
                          : 'bg-ws-card text-ws-body hover:text-ws-ink',
                        !edit && 'cursor-default opacity-80',
                      )}
                      onClick={() => {
                        toggle(m.account, m.owners, p.person_id)
                      }}
                    >
                      <WsAvatar id={p.person_id} name={p.name} className="size-[18px] text-xs" />
                      {p.person_id === data.me ? t('inbox.team.you') : p.name}
                      {p.away ? (
                        <StatusPill tone="warn" className="ml-0.5">
                          {t('inbox.team.away_pill')}
                        </StatusPill>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </section>
      <AwayRow data={data} edit={edit} onSave={(patch) => save.mutate(patch)} />
      {data.can_edit ? null : (
        <p className="text-xs text-ws-faint" data-testid="inbox-team-readonly">
          {t('inbox.team.read_only')}
        </p>
      )}
      {error === undefined ? null : (
        <p className="text-xs text-ws-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** 「负责人 [3] 天没上线，交给 [发起人 | 同岗位的同事]」。 */
function AwayRow({
  data,
  edit,
  onSave,
}: {
  data: TeamInboxView
  edit: boolean
  onSave(patch: TeamInboxPatch): void
}): ReactNode {
  const { t } = useApp()
  const [days, setDays] = useState(String(data.settings.away_days))
  const commit = (): void => {
    const n = Number(days)
    if (!Number.isFinite(n) || n < TEAM_INBOX_AWAY_DAYS_MIN || n > TEAM_INBOX_AWAY_DAYS_MAX) {
      setDays(String(data.settings.away_days))
      return
    }
    if (Math.round(n) !== data.settings.away_days) onSave({ away_days: Math.round(n) })
  }
  return (
    <section
      className="flex flex-wrap items-center gap-1.5 border-t border-ws-line pt-3 text-[13px] text-ws-body"
      data-testid="inbox-team-away"
    >
      {t('inbox.team.away_before')}
      <input
        type="number"
        min={TEAM_INBOX_AWAY_DAYS_MIN}
        max={TEAM_INBOX_AWAY_DAYS_MAX}
        value={days}
        disabled={!edit}
        aria-label={t('inbox.team.away_days')}
        data-testid="inbox-team-days"
        className="ws-num h-7 w-12 rounded-[8px] bg-ws-surface px-1.5 text-center text-[13px] text-ws-ink"
        onChange={(e) => {
          setDays(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      {t('inbox.team.away_after')}
      <Segmented<TeamInboxFallback>
        size="sm"
        label={t('inbox.team.fallback_to')}
        testId="inbox-team-fallback"
        value={data.settings.fallback}
        disabled={!edit}
        options={[
          {
            value: 'admins',
            // ② 叫发起人，③ 是老板 / 管理员（按分工那一格回来的用法写）
            label: t(
              data.mode === 'peers'
                ? 'inbox.team.fallback.admins@peers'
                : 'inbox.team.fallback.admins',
            ),
          },
          { value: 'position', label: t('inbox.team.fallback.position') },
        ]}
        onChange={(v) => {
          if (v !== data.settings.fallback) onSave({ fallback: v })
        }}
      />
    </section>
  )
}

/**
 * 人 id → 名字（② / ③ 里事项页「林峰批了」那一句用）；① 里不取、回 `undefined`。
 * 看的人自己也回 `undefined`（自己定的照旧写「你批了」）。
 */
export function useTeamNames(): ((id: string) => string | undefined) | undefined {
  const { mode, known } = useMode()
  const team = known && mode !== 'solo'
  const q = useQuery({
    queryKey: TEAM_QUERY,
    queryFn: getInboxTeam,
    retry: false,
    enabled: team,
    staleTime: 60_000,
  })
  const data = q.data
  if (!team || data === undefined || data.mode === 'solo') return undefined
  return (id) => (id === data.me ? undefined : data.members.find((m) => m.person_id === id)?.name)
}

/** 一张一张、第三栏头上那一行：归谁 +「X 在看」（两样都没有就不画）。 */
export function TeamLine({ item, className }: { item: InboxItem; className?: string }): ReactNode {
  const viewers = useInboxViewers(item.id)
  const owner =
    (item.fallback_from !== undefined && item.mine === true) ||
    (item.mine === false && (item.owners?.length ?? 0) > 0)
  if (!owner && viewers.length === 0) return null
  return (
    <div
      className={cn('flex flex-wrap items-center gap-2', className)}
      data-testid="inbox-team-line"
    >
      <OwnerNote item={item} />
      <ViewerChip id={item.id} />
    </div>
  )
}

/** 这一件（`card:<id>`）刚被谁处理了（不是自己的那一条才算）。 */
export function handledByOther(view: InboxView | undefined, id: string): InboxHandled | undefined {
  return view?.team?.handled.find((h) => `card:${h.card_id}` === id && !h.self)
}
