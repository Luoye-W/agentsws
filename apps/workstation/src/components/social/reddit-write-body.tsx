/**
 * WP329（docs/102 §2.3 / §4，docs/96「发出去」家族）：Reddit「发出去」卡的卡面。
 *
 * - 被回的那句话（外部文本，原样显示、不渲染 markdown）；版块与回复谁在卡的标题里，这里不再写一遍；
 * - **卡上能改字**：标题（发帖才有）+ 正文；改过就带着改过的那一版批（`approve_edited`）；
 * - 依据：用上的 FAQ 卡、版规条数（说明进问号，界面少字）；
 * - 主按钮在卡身里（同连接卡的做法，卡底那排不再出一个）：**点了就是批准，不自动开任何页面**（WP432）。
 *   WP445（决策 1322）：AI 起草的 Reddit 回帖 / 发帖平时**不在工坊出卡**（在浏览器插件「等你发」里审、发）；工坊里
 *   只剩公司模式「主管先批」的那一种——按钮叫「批准」，批完进发起人的插件「等你发」，由他点「打开这一条」、自己点发送。
 * - WP411（#11）：品牌号在这串里已经说过的（「你 10-12 已回：……」）放在被回那句下面；几道检查没过的
 *   （和已说过的对不上 / 没依据已换掉 / 口吻不符 / 整串没现读成）一条一行标黄，细节进问号。
 */
import { REDDIT_WRITE_FORM, type RedditWritePayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useReportDeckAfter } from '@/components/deck/deck-follow-strip'
import { InfoTip } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { decide, followOf } from '@/lib/api'
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
  // WP414：「发送」之后同类卡只问「要一起发吗」（回包里带回来，交给牌堆顶上那一行）
  const reportAfter = useReportDeckAfter()
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
    onSuccess: (out) => {
      const follow = followOf(out)
      if (follow !== undefined) reportAfter({ card, action: 'approve', follow })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['matter'] })
    },
  })
  const facts = (payload.facts ?? []).filter((f) => f.text !== '')
  const prior = payload.prior_replies ?? []
  const checks = payload.checks ?? []
  const rules = payload.rules ?? []
  const blank = text.trim() === '' || (target.kind === 'submit' && title.trim() === '')
  const field =
    'w-full rounded-lg border border-ws-border bg-ws-surface p-2.5 text-sm leading-6 text-ws-body disabled:opacity-70'
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-reddit-write">
      {/* 版块与回复谁已经在卡的标题里（界面少字）；这里只放版规条数，原文进问号 */}
      {rules.length === 0 ? null : (
        <InfoTip text={rules.join('\n')}>
          <span className="w-fit text-xs text-ws-muted-fg" data-testid="reddit-write-rules">
            {t('redditw.rules', { n: rules.length })}
          </span>
        </InfoTip>
      )}
      {payload.in_reply_to === undefined ? null : (
        <blockquote
          data-testid="reddit-write-quote"
          className="rounded-lg bg-ws-surface p-3 text-[13px] leading-5 whitespace-pre-wrap text-ws-muted-fg"
        >
          {payload.in_reply_to}
        </blockquote>
      )}
      {prior.length === 0 ? null : (
        <div className="flex flex-col gap-1" data-testid="reddit-write-prior">
          {prior.map((c) => (
            <p key={c.fullname} className="text-xs leading-5 text-ws-muted-fg">
              {t('redditw.prior', { day: (c.created_at ?? '').slice(5, 10) })}
              <span className="whitespace-pre-wrap">「{c.text.slice(0, 200)}」</span>
            </p>
          ))}
        </div>
      )}
      {checks.length === 0 ? null : (
        <ul className="flex flex-col gap-1" data-testid="reddit-write-checks">
          {checks.map((c, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 同一张卡上的检查不重排
              key={i}
              className="w-fit rounded-[8px] bg-ws-warn-bg px-2 py-1 text-xs text-ws-warn"
              data-check={c.kind}
            >
              <InfoTip
                text={[
                  c.quote,
                  c.prior === undefined ? undefined : t('redditw.check.prior', { text: c.prior }),
                ]
                  .filter((x): x is string => x !== undefined && x !== '')
                  .join('\n')}
              >
                <span>
                  {c.fixed === true ? t('redditw.check.fixed', { message: c.message }) : c.message}
                </span>
              </InfoTip>
            </li>
          ))}
        </ul>
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
          {send.isSuccess ? (
            <span className="text-xs text-ws-muted-fg" data-testid="reddit-write-awaiting-note">
              {t('redditw.sent.awaiting')}
            </span>
          ) : null}
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
