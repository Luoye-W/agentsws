/**
 * WP254（决策 117）：别的社群（非 Reddit 自家版）版务卡的卡面——将执行什么（经哪条渠道）、原话、依据。
 *
 * 改动卡（「批准执行 / 不做」）：批了才由执行器经这条渠道的适配器去做。数都从卡上那份结构化字段来
 * （`after`，服务端出卡时写好的），这里不现算、不改写。原话是外部文本：原样显示（不渲染 markdown）。
 */
import type { ReactNode } from 'react'
import { WsTag } from '@/components/design'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 这张卡是不是版务卡（payload 是 `staged_change` 那一份）。 */
export function isModerationPayload(payload: Record<string, unknown>): boolean {
  return payload.kind === 'community_moderation' && isRecord(payload.after)
}

export function ModerationCardBody({ payload }: { payload: Record<string, unknown> }): ReactNode {
  const { t } = useApp()
  const after = isRecord(payload.after) ? payload.after : {}
  const excerpt = str(after.excerpt)
  const reason = str(after.reason)
  const rules = Array.isArray(after.rule_texts)
    ? after.rule_texts.filter((r): r is string => typeof r === 'string')
    : []
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-moderation">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-xs text-ws-muted-fg">{t('moderation.card.will_do')}</span>
        <b data-testid="deck-moderation-will-do">
          {str(after.will_do) ?? str(after.action_label) ?? str(after.action) ?? ''}
        </b>
      </div>
      {excerpt === undefined ? null : (
        <blockquote
          className="rounded-[10px] bg-ws-surface p-3 text-[13px] leading-5 whitespace-pre-wrap text-ws-body"
          data-testid="deck-moderation-original"
          aria-label={t('moderation.card.original')}
        >
          <div className="text-ws-muted-fg">{excerpt}</div>
          {str(after.author) === undefined ? null : (
            <div className="mt-1 text-xs text-ws-muted-fg">{str(after.author)}</div>
          )}
        </blockquote>
      )}
      {rules.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-ws-muted-fg">{t('moderation.card.rules')}</span>
          {rules.map((r) => (
            <WsTag key={r}>{r}</WsTag>
          ))}
        </div>
      )}
      {reason === undefined ? null : (
        <p className="text-xs text-ws-body" data-testid="deck-moderation-reason">
          <span className="text-ws-muted-fg">{t('moderation.card.reason')}：</span>
          {reason}
        </p>
      )}
    </div>
  )
}
