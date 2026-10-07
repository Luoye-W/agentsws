/**
 * WP249：自家版版务卡的卡面（卡片流里那张）——原文、举报原因、AI 建议 + 理由、将执行的动作。
 *
 * 数都从卡上那份结构化字段来（`after`，服务端出卡时写好的），这里不现算、不改写。
 * 原文是外部文本：原样显示（不渲染 markdown、不自动成链接）。
 */
import type { ReactNode } from 'react'
import { StatusPill, type Tone, WsTag } from '@/components/design'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 这张卡是不是自家版的版务卡（payload 是 `staged_change` 那一份）。 */
export function isOwnSubPayload(payload: Record<string, unknown>): boolean {
  return (
    payload.kind === 'community_moderation' &&
    isRecord(payload.after) &&
    payload.after.source === 'own_sub_queue'
  )
}

const TONE: Record<string, Tone> = { approve: 'good', remove: 'bad', ignore: 'neutral' }

export function OwnSubCardBody({ payload }: { payload: Record<string, unknown> }): ReactNode {
  const { t } = useApp()
  const after = isRecord(payload.after) ? payload.after : {}
  const suggestion = isRecord(after.suggestion) ? after.suggestion : {}
  const verdict = str(suggestion.verdict) ?? 'ignore'
  const reports = Array.isArray(after.report_reasons)
    ? after.report_reasons.filter((r): r is string => typeof r === 'string')
    : []
  const title = str(after.title)
  const excerpt = str(after.excerpt)
  const removal = str(after.removal_message)
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-own-sub">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-xs text-ws-muted-fg">{t('ownsub.card.will_do')}</span>
        <b data-testid="deck-own-sub-will-do">
          {str(after.will_do) ?? str(after.action_label) ?? ''}
        </b>
      </div>
      <blockquote
        className="rounded-[10px] bg-ws-surface p-3 text-[13px] leading-5 whitespace-pre-wrap text-ws-body"
        data-testid="deck-own-sub-original"
        aria-label={t('ownsub.card.original')}
      >
        {title === undefined ? null : <div className="font-medium">{title}</div>}
        {excerpt === undefined ? null : <div className="text-ws-muted-fg">{excerpt}</div>}
        <div className="mt-1 text-xs text-ws-muted-fg">u/{str(after.author) ?? '?'}</div>
      </blockquote>
      {reports.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-ws-muted-fg">{t('ownsub.card.reports')}</span>
          {reports.map((r) => (
            <WsTag key={r}>{r}</WsTag>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ws-muted-fg">{t('ownsub.card.suggestion')}</span>
        <StatusPill tone={TONE[verdict] ?? 'neutral'}>{t(`ownsub.verdict.${verdict}`)}</StatusPill>
        <span className="min-w-0 flex-1 text-ws-body" data-testid="deck-own-sub-reason">
          {str(suggestion.reason) ?? ''}
        </span>
      </div>
      {removal === undefined ? null : (
        <p className="text-xs text-ws-muted-fg" data-testid="deck-own-sub-removal">
          {t('ownsub.card.public_reply')}：「{removal}」
        </p>
      )}
    </div>
  )
}
