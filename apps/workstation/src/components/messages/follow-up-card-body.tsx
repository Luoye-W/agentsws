/**
 * WP442（docs/108 §5.3，WP458 示意 `b-open`）：**催促卡**的卡面——「X 还没回（3 个工作日）」。
 *
 * - 一行灰字：你哪天发的（对方说过哪天答复的写那一天；第二次提醒写「之后不再提醒」）；
 * - 我们上一封的开头一段（外部文本原样显示）；
 * - 催促草稿：平时只读，点「修改」就地改，改过就带着改过的那一版批（`approve` + `edited_payload`）；
 * - 主按钮「发出」在卡身里（同 Reddit「发出去」卡），卡底那排只剩「再等等」「不用跟了」；
 * - 最底一行：这条怎么来的（系统规则）· 改（打开消息页右栏「规则」）。
 *
 * 少字：为什么要这样发、出站门那些说明进问号。
 */
import type { FollowUpNudgePayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { Link, useInRouterContext } from 'react-router-dom'
import { type FootAction, FootButtons, useCardFootActions } from '@/components/deck/card-foot'
import { MESSAGE_RULES_HREF } from '@/components/messages/rules-address'
import { Hint } from '@/components/ui/hint'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** ISO → 当地「10-23」（卡上写日子，不写钟点）。 */
const dayOf = (iso: string | undefined): string => {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function FollowUpCardBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: FollowUpNudgePayload
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const inRouter = useInRouterContext()
  const f = payload.follow_up
  const [text, setText] = useState(payload.body.text)
  const [editing, setEditing] = useState(false)
  const decidable = card.available_actions.includes('approve')
  const edited = text.trim() !== payload.body.text.trim()
  const send = useMutation({
    mutationFn: () =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          ...(edited
            ? { edited_payload: { ...payload, body: { ...payload.body, text: text.trim() } } }
            : {}),
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['messages'] })
    },
  })
  const to = payload.recipients.map((a) => a.name ?? a.email).join(', ')
  const meta = [
    t('follow_up.card.sent_on', { day: dayOf(f.since) }),
    f.basis === 'promised' && f.promised_reply_at !== undefined
      ? t('follow_up.card.promised', { day: dayOf(f.promised_reply_at) })
      : undefined,
    f.reminder > 1 ? t('follow_up.card.second') : undefined,
  ].filter((x): x is string => x !== undefined && x !== '')
  const field =
    'w-full rounded-lg border border-ws-border bg-ws-surface p-2.5 text-sm leading-6 text-ws-body'
  // WP478：「发出 / 修改」并进卡底那一排（没有卡底时照旧画在卡身里）
  const actions: FootAction[] | null = decidable
    ? [
        {
          key: 'follow-up-send',
          label: t('follow_up.card.send'),
          primary: true,
          disabled: text.trim() === '' || send.isPending || send.isSuccess,
          testId: 'follow-up-send',
          onSelect: () => {
            send.mutate()
          },
        },
        {
          key: 'follow-up-edit',
          label: editing ? t('follow_up.card.edit_done') : t('follow_up.card.edit'),
          disabled: send.isPending || send.isSuccess,
          testId: 'follow-up-edit',
          onSelect: () => {
            setEditing((v) => !v)
          },
        },
      ]
    : null
  const hosted = useCardFootActions(actions)
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-follow-up">
      <p className="text-xs text-ws-muted-fg" data-testid="follow-up-meta">
        {meta.join(' · ')}
      </p>
      {payload.quote === undefined ? null : (
        <blockquote
          data-testid="follow-up-quote"
          className="rounded-lg bg-ws-surface p-3 text-[13px] leading-5 whitespace-pre-wrap text-ws-muted-fg"
        >
          {payload.quote}
        </blockquote>
      )}
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
          <span className="font-medium text-foreground">{t('follow_up.card.draft')}</span>
          <span className="truncate" data-testid="follow-up-to">
            {t('follow_up.card.to', { to })}
          </span>
        </p>
        {editing ? (
          <textarea
            aria-label={t('follow_up.card.draft')}
            data-testid="follow-up-text"
            className={`${field} min-h-28`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <p
            data-testid="follow-up-draft"
            className="rounded-lg border border-ws-line bg-ws-card p-2.5 text-sm leading-6 whitespace-pre-wrap text-ws-body"
          >
            {text}
          </p>
        )}
      </div>
      {decidable ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {hosted ? null : <FootButtons actions={actions ?? []} />}
          <Hint text={t('follow_up.card.send.hint')} />
          {send.isSuccess ? (
            <span className="text-xs text-ws-muted-fg" data-testid="follow-up-sent">
              {t('follow_up.card.sent')}
            </span>
          ) : null}
          {send.isError ? (
            <span className="text-xs text-ws-bad" data-testid="follow-up-failed">
              {t('follow_up.card.failed', {
                message: send.error instanceof Error ? send.error.message : String(send.error),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-ws-muted-fg" data-testid="follow-up-rule">
        {t('follow_up.card.rule', { n: f.business_days })}
        {inRouter ? (
          <>
            {' · '}
            <Link to={MESSAGE_RULES_HREF} className="text-ws-brand hover:underline">
              {t('follow_up.card.rule.edit')}
            </Link>
          </>
        ) : null}
      </p>
    </div>
  )
}
