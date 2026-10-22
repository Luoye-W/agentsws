/**
 * WP459：收件箱的几块边角——顶上「今天的简报」、筛选那一排（分段 + 岗位下拉，决策 1501 甲）、
 * 右栏「等对方回」「收好的」（v1 那两堆，照 v2）、清空之后的样子（`inbox-empty`）。
 */
import type { InboxFilter, InboxView } from '@agentsws/deck'
import { INBOX_UNASSIGNED } from '@agentsws/deck'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Filter,
  Info,
  Sunrise,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CountBadge, EmptyState, Segmented, StatusPill } from '@/components/design'
import { useMessageOverview } from '@/components/messages/hand-actions'
import { Popover } from '@/components/messages/popover'
import { MESSAGE_DIGEST_ADDRESS, MESSAGE_RULES_ADDRESS } from '@/components/messages/rules-address'
import { useRailState } from '@/components/rail/rail-state'
import { PositionIcon } from '@/components/role-icons/role-icon'
import { ackMessageNotices, actOnMessageFollowUp, listMessageFollowUps } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { cn } from '@/lib/utils'
import type { InboxNotice } from './inbox-actions'
import { setInboxOpen, useInboxRefresh } from './inbox-model'

/** 「10-23」（只写日子）。 */
const dayOf = (iso: string | undefined): string => {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 顶上「今天的简报」：一句话 + 两个可点的数；打开第三栏、清空时收成一行。 */
export function InboxBrief({ view, folded }: { view: InboxView; folded: boolean }): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const [open, setOpen] = useState(!folded)
  const b = view.brief
  const show = open && !folded
  const guessedLink = (
    <button
      type="button"
      data-testid="inbox-brief-guessed"
      className="ws-link"
      onClick={() => {
        setInboxOpen({ kind: 'guessed' })
      }}
    >
      {t('inbox.brief.guessed', { n: b.guessed })}
    </button>
  )
  const parts: ReactNode[] = []
  if (b.auto_sent > 0)
    parts.push(<span key="auto">{t('inbox.brief.auto', { n: b.auto_sent })}</span>)
  if (b.guessed > 0) parts.push(<span key="guess">{guessedLink}</span>)
  if (b.notices > 0)
    parts.push(<span key="notice">{t('inbox.brief.notices', { n: b.notices })}</span>)
  return (
    <section
      className="ws-card px-5 py-4"
      data-testid="inbox-brief"
      data-folded={show ? 'false' : 'true'}
    >
      <div className="flex items-center gap-2">
        <Sunrise aria-hidden className="size-4 shrink-0 text-ws-brand" />
        <h2 className="shrink-0 text-[14px] font-semibold text-ws-ink">{t('inbox.brief.title')}</h2>
        {show ? null : (
          <span
            className="min-w-0 truncate text-[13px] text-ws-muted-fg"
            data-testid="inbox-brief-line"
          >
            {t('inbox.brief.done', { n: b.done })}
            {b.top === undefined || b.top === ''
              ? ''
              : ` · ${t('inbox.brief.top', { title: b.top })}`}
          </span>
        )}
        <button
          type="button"
          className="ws-link-muted ml-auto shrink-0 text-xs"
          data-testid="inbox-brief-digest"
          onClick={() => {
            rail.openAddress(MESSAGE_DIGEST_ADDRESS)
          }}
        >
          {t('rail.panel.message-digest')}
        </button>
        {folded ? null : (
          <button
            type="button"
            aria-label={t(show ? 'inbox.brief.less' : 'inbox.brief.more')}
            aria-expanded={show}
            data-testid="inbox-brief-toggle"
            className="grid size-6 shrink-0 place-items-center rounded-[6px] text-ws-muted-fg hover:bg-ws-surface"
            onClick={() => {
              setOpen((v) => !v)
            }}
          >
            <ChevronDown
              aria-hidden
              className={cn('size-4 transition-transform', show && 'rotate-180')}
            />
          </button>
        )}
      </div>
      {show ? (
        <p className="mt-2 text-[14px] leading-6 text-ws-body" data-testid="inbox-brief-text">
          {t('inbox.brief.done', { n: b.done })}
          {parts.length === 0 ? '' : '：'}
          {parts.flatMap((p, i) =>
            // biome-ignore lint/suspicious/noArrayIndexKey: 几个数之间的逗号，只按位置区分
            i === 0 ? [p] : [<span key={`sep-${i}`}>，</span>, p],
          )}
          {parts.length === 0 ? '' : '。'}
          {b.top === undefined || b.top === '' ? null : (
            <b className="font-semibold text-ws-ink"> {t('inbox.brief.top', { title: b.top })}</b>
          )}
        </p>
      ) : null}
    </section>
  )
}

/** 筛选那一排：全部 / 等我批 / 只看信（带件数）+ 岗位下拉（带件数，最后一行「还没归岗位的信」）。 */
export function InboxFilterBar({
  view,
  filter,
  onChange,
}: {
  view: InboxView
  filter: InboxFilter
  onChange(next: InboxFilter): void
}): ReactNode {
  const { t, lang } = useApp()
  const [menu, setMenu] = useState(false)
  const seg: 'all' | 'card' | 'mail' = filter.type ?? 'all'
  // 件数跟着岗位筛：筛了客服，分段上的数也只数客服的
  const scoped = view.items.filter((i) =>
    filter.position === undefined
      ? true
      : filter.position === INBOX_UNASSIGNED
        ? i.position === undefined
        : i.position === filter.position,
  )
  const n = (type?: 'card' | 'mail'): number =>
    scoped.filter((i) => type === undefined || i.type === type).length
  const picked = view.positions.find((p) => p.id === filter.position)
  const pickedName =
    filter.position === INBOX_UNASSIGNED
      ? t('inbox.filter.unassigned')
      : picked === undefined
        ? t('inbox.filter.position')
        : lang === 'en'
          ? picked.name_en
          : picked.name_zh
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="inbox-filters">
      <Segmented
        label={t('inbox.filter')}
        testId="inbox-filter-type"
        value={seg}
        options={[
          { value: 'all', label: t('inbox.filter.all'), count: n(), testId: 'inbox-filter-all' },
          {
            value: 'card',
            label: t('inbox.filter.cards'),
            count: n('card'),
            testId: 'inbox-filter-card',
          },
          {
            value: 'mail',
            label: t('inbox.filter.mail'),
            count: n('mail'),
            testId: 'inbox-filter-mail',
          },
        ]}
        onChange={(v) => {
          const { type: _drop, ...rest } = filter
          onChange(v === 'all' ? rest : { ...rest, type: v })
        }}
      />
      <Popover
        open={menu}
        onOpenChange={setMenu}
        testId="inbox-position-menu"
        trigger={
          <button
            type="button"
            data-testid="inbox-filter-position"
            aria-expanded={menu}
            data-on={filter.position === undefined ? 'false' : 'true'}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px]',
              filter.position === undefined
                ? 'bg-ws-surface text-ws-body hover:text-ws-ink'
                : 'bg-ws-tint font-medium text-ws-brand-ink',
            )}
            onClick={() => {
              setMenu((v) => !v)
            }}
          >
            <Filter aria-hidden className="size-3.5" />
            {pickedName}
            <ChevronDown aria-hidden className="size-3.5" />
          </button>
        }
      >
        <div
          className="flex w-56 flex-col p-1"
          role="listbox"
          aria-label={t('inbox.filter.position')}
        >
          <PositionOption
            on={filter.position === undefined}
            label={t('inbox.filter.position.all')}
            count={view.items.length}
            testId="inbox-position-all"
            onPick={() => {
              setMenu(false)
              const { position: _drop, ...rest } = filter
              onChange(rest)
            }}
          />
          {view.positions.map((p) => (
            <PositionOption
              key={p.id}
              on={filter.position === p.id}
              icon={<PositionIcon position_id={p.id} icon={p.icon} size={14} />}
              label={lang === 'en' ? p.name_en : p.name_zh}
              count={p.count}
              testId={`inbox-position-${p.id}`}
              onPick={() => {
                setMenu(false)
                onChange({ ...filter, position: p.id })
              }}
            />
          ))}
          <div className="my-1 h-px bg-ws-line" />
          <PositionOption
            on={filter.position === INBOX_UNASSIGNED}
            label={t('inbox.filter.unassigned')}
            count={view.unassigned}
            testId="inbox-position-none"
            onPick={() => {
              setMenu(false)
              onChange({ ...filter, position: INBOX_UNASSIGNED })
            }}
          />
        </div>
      </Popover>
      {picked?.assignment_id === undefined ? null : (
        <Link
          to={`/positions/${picked.assignment_id}`}
          className="ws-link ml-auto inline-flex items-center gap-1 text-[13px]"
          data-testid="inbox-go-position"
        >
          {t('inbox.filter.go_position', { name: lang === 'en' ? picked.name_en : picked.name_zh })}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      )}
    </div>
  )
}

function PositionOption({
  on,
  icon,
  label,
  count,
  testId,
  onPick,
}: {
  on: boolean
  icon?: ReactNode
  label: string
  count: number
  testId: string
  onPick(): void
}): ReactNode {
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      data-testid={testId}
      className={cn(
        'flex items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-ws-surface',
        on && 'font-medium text-ws-brand-ink',
      )}
      onClick={onPick}
    >
      <span className="grid size-4 place-items-center text-ws-muted-fg">
        {on ? <Check aria-hidden className="size-3.5 text-ws-brand" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={cn('ws-num text-xs', count === 0 ? 'text-ws-faint' : 'text-ws-muted-fg')}>
        {count}
      </span>
    </button>
  )
}

/** 右栏：等对方回 · 收好的 · 规则一行。`compact` = 一张一张里那两行（只报数）。 */
export function InboxSide({
  compact = false,
  onNotice,
}: {
  compact?: boolean
  onNotice(n: InboxNotice): void
}): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const navigate = useNavigate()
  const refresh = useInboxRefresh()
  const overview = useMessageOverview()
  const follow = useQuery({
    queryKey: ['messages', 'follow-ups'],
    queryFn: listMessageFollowUps,
    retry: false,
  })
  const nudge = useMutation({
    mutationFn: (thread_id: string) => actOnMessageFollowUp(thread_id, 'nudge'),
    onError: (e) => {
      onNotice({ tone: 'error', text: apiErrorText(e, t) })
    },
    onSettled: refresh,
  })
  const ack = useMutation({
    mutationFn: () => ackMessageNotices({}),
    onSuccess: (r) => {
      onNotice({ tone: 'ok', text: t('messages.inbox.acked', { n: r.acked }) })
    },
    onError: (e) => {
      onNotice({ tone: 'error', text: apiErrorText(e, t) })
    },
    onSettled: refresh,
  })
  const rows = (follow.data?.rows ?? []).filter((r) => r.follow_up.state !== 'stopped')
  const now = Date.now()
  const groups = overview.data?.notice_groups ?? []
  const kept = overview.data?.notice ?? 0
  const due = rows.filter(
    (r) => r.follow_up.state === 'carded' || Date.parse(r.follow_up.due_at) <= now,
  )
  if (compact)
    return (
      <div className="ws-group" data-testid="inbox-side" data-compact="true">
        <div className="ws-row">
          <span className="text-[14px] font-semibold">{t('inbox.side.waiting')}</span>
          <span className="ws-num text-[13px] text-ws-faint">{rows.length}</span>
          {due.length > 0 ? (
            <StatusPill tone="warn" className="ml-auto">
              {t('inbox.side.due_now')} {due.length}
            </StatusPill>
          ) : null}
        </div>
        <div className="ws-row">
          <span className="text-[14px] font-semibold">{t('inbox.side.kept')}</span>
          <span className="ws-num text-[13px] text-ws-faint">{kept}</span>
          {kept > 0 ? (
            <button
              type="button"
              className="ws-link-muted ml-auto text-xs"
              disabled={ack.isPending}
              onClick={() => {
                ack.mutate()
              }}
            >
              {t('inbox.side.ack_all')}
            </button>
          ) : null}
        </div>
      </div>
    )
  return (
    <aside className="flex w-full flex-col gap-4" data-testid="inbox-side">
      <section className="flex flex-col gap-2" data-testid="inbox-waiting">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-[14px] font-semibold text-ws-ink">{t('inbox.side.waiting')}</h2>
          <span className="ws-num text-[13px] text-ws-faint">{rows.length}</span>
          <Clock aria-hidden className="ml-auto size-4 text-ws-faint" />
        </div>
        {rows.length === 0 ? (
          <div className="ws-group">
            <div className="ws-row text-[13px] text-ws-muted-fg">
              {t('inbox.side.waiting.empty')}
            </div>
          </div>
        ) : (
          <div className="ws-group">
            {rows.slice(0, 5).map((r) => {
              const f = r.follow_up
              const who = f.waiting_on?.name ?? f.waiting_on?.email
              const carded = f.state === 'carded' && f.card_id !== undefined
              const overdue = Date.parse(f.due_at) <= now
              return (
                <div
                  key={r.thread_id}
                  className="ws-row items-center gap-3"
                  data-testid="inbox-waiting-row"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ws-ink">
                      {who === undefined ? r.subject : `${who} · ${r.subject}`}
                    </p>
                    <p className="truncate text-xs text-ws-muted-fg">
                      {t('inbox.side.waiting.sub', { day: dayOf(f.since) })}
                    </p>
                  </div>
                  {carded || overdue ? (
                    <button
                      type="button"
                      data-testid="inbox-waiting-nudge"
                      className="ws-btn ws-btn-secondary ws-btn-sm shrink-0"
                      disabled={nudge.isPending}
                      onClick={() => {
                        if (carded) setInboxOpen({ kind: 'item', id: `card:${f.card_id}` })
                        else nudge.mutate(r.thread_id)
                      }}
                    >
                      {t('inbox.side.nudge')}
                    </button>
                  ) : (
                    <StatusPill tone="neutral" className="shrink-0">
                      {t('inbox.side.due', { day: dayOf(f.due_at) })}
                    </StatusPill>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2" data-testid="inbox-kept">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-[14px] font-semibold text-ws-ink">{t('inbox.side.kept')}</h2>
          <span className="ws-num text-[13px] text-ws-faint">{kept}</span>
          {kept > 0 ? (
            <button
              type="button"
              data-testid="inbox-kept-ack"
              className="ws-link-muted ml-auto inline-flex items-center gap-1 text-xs"
              disabled={ack.isPending}
              onClick={() => {
                ack.mutate()
              }}
            >
              <CheckCheck aria-hidden className="size-3.5" />
              {t('inbox.side.ack_all')}
            </button>
          ) : null}
        </div>
        <div className="ws-group">
          {groups.length === 0 ? (
            <div className="ws-row gap-2 text-[13px] text-ws-muted-fg">
              <Check aria-hidden className="size-3.5" />
              {t('inbox.side.kept.empty')}
            </div>
          ) : (
            groups.map((g) => (
              <button
                key={g.kind}
                type="button"
                className="ws-row w-full gap-3 text-left"
                data-testid="inbox-kept-row"
                onClick={() => {
                  navigate('/messages?view=all')
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ws-ink">
                    {g.kind === 'suspicious'
                      ? t('messages.inbox.suspicious')
                      : t(`messages.kind.${g.kind}`)}{' '}
                    <span className="ws-num font-normal text-ws-faint">{g.count}</span>
                  </span>
                  <span className="block truncate text-xs text-ws-muted-fg">
                    {g.senders.join('、')}
                  </span>
                </span>
                <ChevronRight aria-hidden className="size-4 text-ws-faint" />
              </button>
            ))
          )}
        </div>
      </section>
      {overview.data === undefined ? null : (
        <button
          type="button"
          data-testid="inbox-rules"
          className="ws-link-muted flex w-fit items-center gap-1.5 px-1 text-xs"
          onClick={() => {
            rail.openAddress(MESSAGE_RULES_ADDRESS)
          }}
        >
          <Info aria-hidden className="size-3.5" />
          {t('inbox.side.rules', { n: overview.data.taught.rules })}
          <ArrowRight aria-hidden className="size-3" />
        </button>
      )}
    </aside>
  )
}

/** 清空之后：灰图标 + 一句话 + 一个链接（不画插图）。 */
export function InboxEmpty({ filtered }: { filtered: boolean }): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  return (
    <div className="ws-card py-14" data-testid="inbox-empty">
      <EmptyState
        icon={CheckCheck}
        text={filtered ? t('inbox.empty.filtered') : t('inbox.empty')}
        {...(filtered
          ? {}
          : {
              action: {
                label: t('inbox.empty.link'),
                testId: 'inbox-empty-link',
                onClick: () => {
                  rail.openAddress(MESSAGE_DIGEST_ADDRESS)
                },
              },
            })}
      />
    </div>
  )
}

/** 左栏「收件箱」旁那颗品牌色数字（清空了就不显示）。 */
export function InboxNavBadge({ n }: { n: number | undefined }): ReactNode {
  if (n === undefined || n === 0) return null
  return <CountBadge n={n} tone="brand" className="ml-auto" data-testid="nav-inbox-count" />
}
