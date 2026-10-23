/**
 * WP489（决策 1709）：「N 段往来没对上红人 / N 个红人没找到往来」那张卡的卡面。
 *
 * 一段往来一行（主题 · 对方 · 日期，摘要放悬停）+ 一个下拉（候选人排前面、带「凭什么」悬停；「不是红人」）；
 * 没找到往来的红人一行一个邮箱框。主按钮「记下」在卡身里，带着选过 / 填过的那几处批（`edited_payload`）；
 * 不确定的留空就行。界面少字。
 */
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { FootButtons, useCardFootActions } from '@/components/deck/card-foot'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

interface MatchThreadRow {
  thread_id: string
  subject: string
  from: string
  at: string
  snippet: string
  candidates: { creator_id: string; name: string; signals: string[] }[]
}

export interface KolMailMatchPayload {
  form: 'kol_mail_match'
  threads: MatchThreadRow[]
  creators: { creator_id: string; name: string; has_email: boolean }[]
  pool: { creator_id: string; name: string }[]
  [k: string]: unknown
}

export function isKolMailMatchPayload(p: unknown): p is KolMailMatchPayload {
  const r = rec(p)
  return r.form === 'kol_mail_match' && Array.isArray(r.threads) && Array.isArray(r.creators)
}

const NOT_CREATOR = '__none__'
const selectCls =
  'h-7 max-w-56 rounded-md border border-input bg-background px-1.5 text-xs text-foreground'

export function KolMailMatchBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: KolMailMatchPayload
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [assign, setAssign] = useState<Record<string, string>>({})
  const [emails, setEmails] = useState<Record<string, string>>({})
  const decidable = card.available_actions.includes('approve')
  const send = useMutation({
    mutationFn: () =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          edited_payload: {
            ...payload,
            assign: Object.entries(assign)
              .filter(([, v]) => v !== '' && v !== NOT_CREATOR)
              .map(([thread_id, creator_id]) => ({ thread_id, creator_id })),
            not_creator: Object.entries(assign)
              .filter(([, v]) => v === NOT_CREATOR)
              .map(([thread_id]) => thread_id),
            emails: Object.entries(emails)
              .filter(([, v]) => v.trim() !== '')
              .map(([creator_id, email]) => ({ creator_id, email: email.trim() })),
          },
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      for (const key of ['approval', 'deck', 'kol-collaborations', 'kol-creators'])
        void client.invalidateQueries({ queryKey: [key] })
    },
  })
  const actions = decidable
    ? [
        {
          key: 'kol-mail-match-save',
          label: t('kol.match.save'),
          primary: true,
          disabled: send.isPending || send.isSuccess,
          testId: 'kol-mail-match-save',
          onSelect: () => send.mutate(),
        },
      ]
    : null
  const hosted = useCardFootActions(actions)
  return (
    <div className="mt-2.5 flex flex-col gap-2.5 text-[13px]" data-testid="deck-kol-mail-match">
      {payload.threads.length === 0 ? null : (
        <ul className="flex flex-col gap-1.5">
          {payload.threads.map((th) => {
            const firstIds = new Set(th.candidates.map((c) => c.creator_id))
            return (
              <li
                key={th.thread_id}
                className="flex flex-wrap items-center gap-2"
                data-testid="kol-mail-match-thread"
              >
                <span className="min-w-0 flex-1 truncate" title={th.snippet}>
                  {th.subject || t('kol.match.no_subject')}
                  <span className="text-ws-muted-fg">
                    {' '}
                    · {th.from} · {th.at.slice(0, 10)}
                  </span>
                </span>
                <select
                  className={selectCls}
                  value={assign[th.thread_id] ?? ''}
                  disabled={!decidable || send.isSuccess}
                  data-testid="kol-mail-match-select"
                  aria-label={t('kol.match.who')}
                  onChange={(e) =>
                    setAssign((prev) => ({ ...prev, [th.thread_id]: e.target.value }))
                  }
                >
                  <option value="">{t('kol.match.unsure')}</option>
                  {th.candidates.map((c) => (
                    <option key={c.creator_id} value={c.creator_id} title={c.signals.join('；')}>
                      {c.name}
                    </option>
                  ))}
                  {payload.pool
                    .filter((p) => !firstIds.has(p.creator_id))
                    .map((p) => (
                      <option key={p.creator_id} value={p.creator_id}>
                        {p.name}
                      </option>
                    ))}
                  <option value={NOT_CREATOR}>{t('kol.match.not_creator')}</option>
                </select>
              </li>
            )
          })}
        </ul>
      )}
      {payload.creators.length === 0 ? null : (
        <ul className="flex flex-col gap-1.5" data-testid="kol-mail-match-creators">
          {payload.creators.map((c) => (
            <li key={c.creator_id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <input
                type="email"
                className="h-7 w-56 rounded-md border border-input bg-background px-1.5 text-xs"
                placeholder={t('kol.match.email')}
                aria-label={t('kol.match.email')}
                value={emails[c.creator_id] ?? ''}
                disabled={!decidable || send.isSuccess}
                data-testid="kol-mail-match-email"
                onChange={(e) => setEmails((prev) => ({ ...prev, [c.creator_id]: e.target.value }))}
              />
            </li>
          ))}
        </ul>
      )}
      {decidable && !hosted ? <FootButtons actions={actions ?? []} /> : null}
    </div>
  )
}
