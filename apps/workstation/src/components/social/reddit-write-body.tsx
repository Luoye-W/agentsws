/**
 * WP329（docs/102 §2.3 / §4，docs/96「发出去」家族）：Reddit「发出去」卡的卡面。
 *
 * - 一行：Reddit · r/版 · 回复谁 / 回帖 / 发帖；被回的那句话（外部文本，原样显示、不渲染 markdown）；
 * - **卡上能改字**：标题（发帖才有）+ 正文；改过就带着改过的那一版批（`approve_edited`）；
 * - 依据：用上的 FAQ 卡、版规条数（说明进问号，界面少字）；
 * - 主按钮「发送」在卡身里（同连接卡的做法，卡底那排不再出一个）：批了两分钟后插件把它填进 Reddit 页面，
 *   **你自己点发送**。
 */
import { REDDIT_WRITE_FORM, type RedditWritePayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { InfoTip, WsTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 这张卡是不是 Reddit「发出去」卡。 */
export function isRedditWritePayload(p: unknown): p is RedditWritePayload {
  return isRecord(p) && p.form === REDDIT_WRITE_FORM && isRecord(p.reddit) && isRecord(p.body)
}

export function RedditWriteBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: RedditWritePayload
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const target = payload.reddit
  const [text, setText] = useState(payload.body.text)
  const [title, setTitle] = useState(payload.body.subject ?? '')
  const decidable = card.available_actions.includes('approve')
  const edited =
    text.trim() !== payload.body.text.trim() || title.trim() !== (payload.body.subject ?? '').trim()
  const send = useMutation({
    mutationFn: () =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          ...(edited
            ? {
                edited_payload: {
                  ...payload,
                  body: {
                    text: text.trim(),
                    ...(target.kind === 'submit' ? { subject: title.trim() } : {}),
                  },
                },
              }
            : {}),
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['matter'] })
    },
  })
  const kindLabel =
    target.kind === 'reply'
      ? t('redditw.kind.reply', { who: target.parent_author ?? '' })
      : t(`redditw.kind.${target.kind}`)
  const facts = (payload.facts ?? []).filter((f) => f.text !== '')
  const rules = payload.rules ?? []
  const blank = text.trim() === '' || (target.kind === 'submit' && title.trim() === '')
  const field =
    'w-full rounded-[10px] border border-ws-border bg-ws-surface p-2.5 text-sm leading-6 text-ws-body disabled:opacity-70'
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-reddit-write">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <WsTag>{payload.channel_label}</WsTag>
        <span className="text-ws-muted-fg">{kindLabel}</span>
        {rules.length === 0 ? null : (
          <InfoTip text={rules.join('\n')}>
            <span className="text-xs text-ws-muted-fg" data-testid="reddit-write-rules">
              {t('redditw.rules', { n: rules.length })}
            </span>
          </InfoTip>
        )}
      </div>
      {payload.in_reply_to === undefined ? null : (
        <blockquote
          data-testid="reddit-write-quote"
          className="rounded-[10px] bg-ws-surface p-3 text-[13px] leading-5 whitespace-pre-wrap text-ws-muted-fg"
        >
          {payload.in_reply_to}
        </blockquote>
      )}
      {target.kind === 'submit' ? (
        <input
          aria-label={t('redditw.title')}
          data-testid="reddit-write-title"
          className={field}
          value={title}
          disabled={!decidable}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
        />
      ) : null}
      <textarea
        aria-label={t('redditw.text')}
        data-testid="reddit-write-text"
        className={`${field} min-h-24`}
        value={text}
        disabled={!decidable}
        onChange={(e) => setText(e.target.value)}
      />
      {facts.length === 0 && payload.reason === undefined ? null : (
        <p
          className="flex items-center gap-1 text-xs text-ws-muted-fg"
          data-testid="reddit-write-basis"
        >
          {facts.length === 0 ? null : (
            <InfoTip text={facts.map((f) => f.text).join('\n')}>
              <span>
                {t('redditw.facts')} · {facts.length}
              </span>
            </InfoTip>
          )}
          {payload.reason === undefined ? null : <span className="truncate">{payload.reason}</span>}
        </p>
      )}
      {decidable ? (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            data-testid="reddit-write-send"
            disabled={blank || send.isPending || send.isSuccess}
            onClick={() => send.mutate()}
          >
            {t('redditw.send')}
          </Button>
          <Hint text={t('redditw.send.hint')} />
          {send.isError ? (
            <span className="text-xs text-ws-bad">
              {t('redditw.failed', {
                message: send.error instanceof Error ? send.error.message : String(send.error),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
