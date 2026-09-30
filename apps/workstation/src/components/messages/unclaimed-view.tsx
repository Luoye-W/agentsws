/**
 * WP212（docs/88 §4.1，方向 A 定稿）：消息页的默认视图「没人接的」。
 *
 * 消息页不是第二个待办箱：一件要你拍板的事只在卡片流里出现（09-30 Luoye 定）。这里只放**没人管的**：
 *
 * - 顶上一行「已交给岗位 N · 客服 x · …」+「卡片流里 N 张等你批 →」——只报数，不列卡；
 * - **没人接的**：每条一张卡——人 + 来源 + 时间；✦ 一行 AI 摘要；类型胶囊（拿不准写把握，点开改判）；
 *   原文一句；三个建议（AI 挑一个做主按钮）；右下 → 看原件；
 * - **只是通知**：按类型成捆（可疑单独一捆），整捆「知道了」；
 * - 右边：今天这些去了哪、你教过它。
 */
import type { MessageKind, MessageOverview, MessageThreadSummary } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, LayoutList, ShieldAlert, Sparkles } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { GoButton, StatusPill, WsAvatar, WsCard } from '@/components/design'
import { Skeleton } from '@/components/ui/skeleton'
import { ackMessageNotices, listMessageThreads, messageQuery } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { HandActions, type HandNotice, positionName, useMessageOverview } from './hand-actions'
import { KindChip } from './kind-chip'

const RANK: Record<string, number> = { high: 0, normal: 1, low: 2 }

/** 「没人接的」按急不急排：要紧的在前，同档新的在前。 */
export function byUrgency(a: MessageThreadSummary, b: MessageThreadSummary): number {
  const r = (RANK[a.priority ?? 'normal'] ?? 1) - (RANK[b.priority ?? 'normal'] ?? 1)
  return r !== 0 ? r : Date.parse(b.last_at) - Date.parse(a.last_at)
}

export function UnclaimedView({
  onOpenOriginal,
  onReplySelf,
  onNotice,
}: {
  /** → 看原件：切到「全部」、打开这条会话。 */
  onOpenOriginal(thread_id: string): void
  /** 我自己回：切到「全部」、打开这条会话和写信框。 */
  onReplySelf(thread_id: string): void
  onNotice(notice: HandNotice): void
}): ReactNode {
  const { t } = useApp()
  const overview = useMessageOverview()
  const query = messageQuery({ claim: 'unclaimed', limit: 100 })
  const list = useQuery({
    queryKey: ['messages', 'threads', query],
    queryFn: () => listMessageThreads(query),
  })
  const rows = useMemo(() => [...(list.data?.threads ?? [])].sort(byUrgency), [list.data])
  const o = overview.data

  return (
    <div className="flex flex-col gap-4" data-testid="messages-unclaimed">
      <p className="text-[14px] font-medium text-ws-body" data-testid="messages-headline">
        {o === undefined
          ? null
          : o.unclaimed > 0
            ? t('messages.inbox.headline', { n: o.unclaimed, m: o.handed + o.notice })
            : t('messages.inbox.headline_empty', { m: o.handed + o.notice })}
      </p>
      {o === undefined ? null : <HandedStrip overview={o} />}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-baseline gap-2 px-1">
            <h2 className="text-[15px] font-semibold">{t('messages.inbox.section.unclaimed')}</h2>
            <span className="ws-num text-[13px] text-ws-muted-fg">{rows.length}</span>
            <span className="ml-auto text-[12px] text-ws-muted-fg">{t('messages.inbox.sort')}</span>
          </div>
          {list.error !== null && list.data === undefined ? (
            <p role="alert" className="text-sm text-destructive">
              {apiErrorText(list.error, t)}
            </p>
          ) : list.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <WsCard
              className="p-5 text-center text-sm text-ws-muted-fg"
              data-testid="unclaimed-empty"
            >
              {t('messages.inbox.empty')}
            </WsCard>
          ) : (
            rows.map((row) => (
              <UnclaimedCard
                key={row.thread_id}
                row={row}
                onOpen={() => {
                  onOpenOriginal(row.thread_id)
                }}
                onSelf={() => {
                  onReplySelf(row.thread_id)
                }}
                onNotice={onNotice}
              />
            ))
          )}
          {o === undefined || o.notice_groups.length === 0 ? null : (
            <NoticeBundles overview={o} onOpen={onOpenOriginal} onNotice={onNotice} />
          )}
        </div>
        {o === undefined ? null : <SideColumn overview={o} />}
      </div>
    </div>
  )
}

/** 「已交给岗位 21 · 客服 12 · …」+「卡片流里 3 张等你批 →」。只报数，不列卡。 */
function HandedStrip({ overview }: { overview: MessageOverview }): ReactNode {
  const { t, lang } = useApp()
  const total = overview.handed_by_position.reduce((n, p) => n + p.count, 0)
  return (
    <WsCard
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]"
      data-testid="messages-handed"
    >
      <i aria-hidden className="size-2 rounded-full bg-ws-brand" />
      <span>
        {t('messages.inbox.handed')} <b className="ws-num">{total}</b>
      </span>
      {overview.handed_by_position.map((p) => (
        <span
          key={p.position_id}
          className="text-ws-brand-ink"
          data-testid="messages-handed-position"
        >
          {positionName(overview.positions, p.position_id, lang)}{' '}
          <span className="ws-num">{p.count}</span>
        </span>
      ))}
      {overview.cards_waiting > 0 ? (
        <Link
          to="/"
          data-testid="messages-cards-link"
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-ws-tint px-3 py-1 text-[12px] font-medium text-ws-brand-ink hover:underline"
        >
          <LayoutList aria-hidden className="size-3.5" />
          {t('messages.inbox.cards', { n: overview.cards_waiting })}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      ) : null}
    </WsCard>
  )
}

/** 没人接的一条。 */
function UnclaimedCard({
  row,
  onOpen,
  onSelf,
  onNotice,
}: {
  row: MessageThreadSummary
  onOpen(): void
  onSelf(): void
  onNotice(notice: HandNotice): void
}): ReactNode {
  const { t, lang } = useApp()
  const who = row.participants[0]
  const name = who?.name ?? who?.email ?? ''
  const account = row.accounts[0]
  const id = row.claim_message_id ?? row.last_message_id
  return (
    <WsCard className="flex gap-3 p-4" data-testid="unclaimed-card" data-thread={row.thread_id}>
      <WsAvatar name={name} id={who?.email ?? ''} className="mt-0.5 size-9 text-[12px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-medium">{name}</span>
          {account === undefined ? null : (
            <span className="truncate text-[12px] text-ws-muted-fg">{shortAccount(account)}</span>
          )}
          <span className="ml-auto shrink-0 text-[12px] text-ws-muted-fg">
            {formatDateTime(row.last_at, lang)}
          </span>
        </div>
        <div
          className="flex items-start gap-1.5 text-[15px] font-semibold"
          data-testid="unclaimed-summary"
        >
          <Sparkles aria-hidden className="mt-1 size-3.5 shrink-0 text-ws-brand" />
          <span>{row.summary ?? row.subject}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {row.kind === undefined ? null : (
            <KindChip
              messageId={id}
              kind={row.kind}
              confidence={row.kind_confidence}
              by={row.kind_by}
              onDone={(text, tone) => {
                onNotice({ text, tone })
              }}
            />
          )}
          {row.priority === 'high' ? (
            <StatusPill tone="warn">{t('messages.ai.triage.priority.high')}</StatusPill>
          ) : null}
          {row.snippet === '' ? null : (
            <span className="min-w-0 flex-1 truncate text-[13px] text-ws-muted-fg italic">
              “{row.snippet}”
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <HandActions
            messageId={id}
            kind={row.kind}
            suggest={row.suggest}
            onDone={onNotice}
            onSelf={onSelf}
          />
          <GoButton
            label={t('messages.inbox.open')}
            onClick={onOpen}
            className="ml-auto shrink-0"
          />
        </div>
      </div>
    </WsCard>
  )
}

/** 「只是通知」：按类型成捆（可疑单独一捆），整捆「知道了」。 */
function NoticeBundles({
  overview,
  onOpen,
  onNotice,
}: {
  overview: MessageOverview
  onOpen(thread_id: string): void
  onNotice(notice: HandNotice): void
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const ack = useMutation({
    mutationFn: (input: { kind?: MessageKind; suspicious?: boolean }) => ackMessageNotices(input),
    onSuccess: (r) => {
      onNotice({
        tone: r.writeback === 'failed' ? 'warn' : 'ok',
        text:
          r.writeback === 'failed'
            ? `${t('messages.inbox.acked', { n: r.acked })}。${t('messages.writeback.failed')}`
            : t('messages.inbox.acked', { n: r.acked }),
      })
    },
    onError: (e) => {
      onNotice({ tone: 'error', text: apiErrorText(e, t) })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['messages'] })
    },
  })
  return (
    <section className="mt-3 flex flex-col gap-3" data-testid="messages-notices">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-[15px] font-semibold">{t('messages.inbox.section.notice')}</h2>
        <span className="text-[13px] text-ws-muted-fg">
          <span className="ws-num">{overview.notice}</span> · {t('messages.inbox.notice.sub')}
        </span>
        <button
          type="button"
          data-testid="notice-ack-all"
          disabled={ack.isPending}
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-ws-muted-fg hover:text-foreground disabled:opacity-60"
          onClick={() => {
            ack.mutate({})
          }}
        >
          <Check aria-hidden className="size-3.5" />
          {t('messages.inbox.ack_all')}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {overview.notice_groups.map((g) => (
          <NoticeGroup
            key={g.kind}
            group={g}
            busy={ack.isPending}
            onAck={() => {
              ack.mutate(g.kind === 'suspicious' ? { suspicious: true } : { kind: g.kind })
            }}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  )
}

function NoticeGroup({
  group,
  busy,
  onAck,
  onOpen,
}: {
  group: MessageOverview['notice_groups'][number]
  busy: boolean
  onAck(): void
  onOpen(thread_id: string): void
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const query = messageQuery({ claim: 'notice', limit: 100 })
  const rows = useQuery({
    queryKey: ['messages', 'threads', query],
    queryFn: () => listMessageThreads(query),
    enabled: open,
  })
  const suspicious = group.kind === 'suspicious'
  const mine = (rows.data?.threads ?? []).filter((r) =>
    suspicious
      ? r.labels.includes('suspicious')
      : !r.labels.includes('suspicious') && r.kind === group.kind,
  )
  return (
    <WsCard
      className={cn('flex flex-col gap-2 p-4', suspicious && 'ring-1 ring-destructive/30')}
      data-testid="notice-group"
      data-kind={group.kind}
    >
      <div className="flex items-center gap-1.5 text-[14px] font-semibold">
        {suspicious ? <ShieldAlert aria-hidden className="size-4 text-destructive" /> : null}
        {suspicious ? t('messages.inbox.suspicious') : t(`messages.kind.${group.kind}`)}
        <span className="ws-num text-[13px] font-normal text-ws-muted-fg">{group.count}</span>
      </div>
      <p className="truncate text-[13px] text-ws-muted-fg">{group.senders.join(' · ')}</p>
      {open ? (
        <ul className="flex flex-col gap-0.5" data-testid="notice-group-rows">
          {mine.map((r) => (
            <li key={r.thread_id}>
              <button
                type="button"
                className="w-full truncate rounded-[8px] px-2 py-1 text-left text-[12px] hover:bg-ws-surface"
                onClick={() => {
                  onOpen(r.thread_id)
                }}
              >
                {r.summary ?? r.subject}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="notice-ack"
          disabled={busy}
          className="rounded-[10px] border border-ws-line px-2.5 py-1 text-[12px] font-medium hover:bg-ws-surface disabled:opacity-60"
          onClick={onAck}
        >
          {t('messages.inbox.ack')}
        </button>
        <button
          type="button"
          data-testid="notice-expand"
          aria-expanded={open}
          className="px-1 text-[12px] text-ws-muted-fg hover:text-foreground"
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          {t(open ? 'messages.inbox.collapse' : 'messages.inbox.expand')}
        </button>
      </div>
    </WsCard>
  )
}

/** 右边：这些信去了哪、你教过它。 */
function SideColumn({ overview }: { overview: MessageOverview }): ReactNode {
  const { t, lang } = useApp()
  const total = Math.max(1, overview.handed + overview.notice + overview.unclaimed)
  const bars: { key: string; n: number; tone: string }[] = [
    { key: 'handed', n: overview.handed, tone: 'bg-ws-brand' },
    { key: 'notice', n: overview.notice, tone: 'bg-ws-muted-fg/40' },
    { key: 'unclaimed', n: overview.unclaimed, tone: 'bg-ws-warn' },
  ]
  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-72" data-testid="messages-side">
      <WsCard className="flex flex-col gap-2.5 p-4">
        <h3 className="text-[13px] font-semibold">{t('messages.flow.title')}</h3>
        {bars.map((b) => (
          <div
            key={b.key}
            className="flex items-center gap-2 text-[12px]"
            data-testid="messages-flow"
          >
            <span className="w-20 shrink-0 text-ws-muted-fg">{t(`messages.flow.${b.key}`)}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ws-surface">
              <span
                className={cn('block h-full rounded-full', b.tone)}
                style={{ width: `${Math.round((b.n / total) * 100)}%` }}
              />
            </span>
            <span className="ws-num w-6 text-right">{b.n}</span>
          </div>
        ))}
      </WsCard>
      <WsCard className="flex flex-col gap-2 p-4" data-testid="messages-taught">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Sparkles aria-hidden className="size-3.5 text-ws-brand" />
          {t('messages.taught.title')}
        </h3>
        {overview.taught.rules === 0 && overview.taught.recent.length === 0 ? (
          <p className="text-[12px] text-ws-muted-fg">{t('messages.taught.empty')}</p>
        ) : (
          <>
            <p className="text-[18px] font-semibold">
              {t('messages.taught.saved', { n: overview.taught.saved })}
            </p>
            <ul className="flex flex-col gap-1 text-[12px]">
              {overview.taught.recent.slice(0, 3).map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-1.5 truncate"
                  data-testid="messages-taught-row"
                >
                  <Check aria-hidden className="size-3 shrink-0 text-ws-muted-fg" />
                  <span className="truncate">
                    {c.sender_domain} →{' '}
                    {c.field === 'kind'
                      ? t(`messages.kind.${c.to}`)
                      : positionName(overview.positions, c.to, lang)}
                  </span>
                </li>
              ))}
            </ul>
            <span className="text-[12px] text-ws-muted-fg">
              {t('messages.taught.rules', { n: overview.taught.rules })}
            </span>
          </>
        )}
      </WsCard>
    </aside>
  )
}

/** `support@shop.example` → `support@`（卡上只要认得出是哪只邮箱）。 */
function shortAccount(address: string): string {
  const at = address.indexOf('@')
  return at < 0 ? address : address.slice(0, at + 1)
}
