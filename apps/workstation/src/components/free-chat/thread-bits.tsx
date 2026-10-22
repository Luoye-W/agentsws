/**
 * WP352（决策 931）：助理只有一条长对话，这一页多出来的几样小东西（出现规则写在各自头上，docs/96 §4）。
 *
 * - {@link DayDivider}：换了一天，中间一行日期；
 * - {@link TopicDivider}：换了话题，一条淡线 + 上一个话题的一行小结（悬停看整段小结）；
 * - {@link HistorySearch}：顶部搜索（搜以前聊过的原话与小结，点一条跳到那里）；
 * - {@link NewTopicButton}：「换个话题」；
 *   WP456-T8（§3.7）：搜索、换个话题都是顶栏右边那排图标钮（悬停出字）；
 * - {@link RecalledRefs}：助理翻了以前聊过的，回复下面一排出处（点了跳过去）；
 * - {@link ModelSwitchDivider}：WP373，换了模型那一句「上面是 X 答的，接下来用 Y」。
 */
import { useQuery } from '@tanstack/react-query'
import { History, MessageSquarePlus, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { TOPBAR_ICON, TOPBAR_ICON_IDLE } from '@/components/shell/top-bar-slots'
import { useApp } from '@/lib/app-context'
import {
  type AssistantHistoryHit,
  type AssistantSegment,
  type FreeChatMessage,
  searchAssistantHistory,
} from '@/lib/free-chat'
import { cn } from '@/lib/utils'

/** 本地日历日（分天用）。 */
export const dayOf = (at: string): string => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function useDate(): (at: string, withWeekday?: boolean) => string {
  const { lang } = useApp()
  return (at, withWeekday = false) =>
    new Date(at).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
      ...(withWeekday ? { weekday: 'short' as const } : {}),
    })
}

/** 出现：这条话和上一条不是同一天（第一条也出）。 */
export function DayDivider({ at }: { at: string }): React.ReactNode {
  const date = useDate()
  return (
    <div className="flex items-center justify-center py-1" data-testid="thread-day">
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
        {date(at, true)}
      </span>
    </div>
  )
}

/**
 * 出现：这条话和上一条不在同一段话题（含刚点了「换个话题」、新段还空着）。上一个话题的小结还没出来时只有线。
 */
export function TopicDivider({
  previous,
}: {
  previous?: AssistantSegment | undefined
}): React.ReactNode {
  const title = previous?.title
  return (
    <div
      className="flex items-center gap-3 py-1 text-xs text-muted-foreground"
      data-testid="thread-topic"
      {...(previous === undefined ? {} : { 'data-segment': previous.id })}
      {...(previous?.summary === undefined ? {} : { title: previous.summary })}
    >
      <span className="h-px flex-1 bg-ws-line" />
      {title === undefined ? null : <span className="max-w-[60%] truncate">{title}</span>}
      <span className="h-px flex-1 bg-ws-line" />
    </div>
  )
}

/** 「换个话题」。出现：这段已经说过话（空的新段不再出）。 */
export function NewTopicButton({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}): React.ReactNode {
  const { t } = useApp()
  return (
    <button
      type="button"
      data-testid="assistant-new-topic"
      title={t('assistant.topic.new')}
      aria-label={t('assistant.topic.new')}
      className={cn(TOPBAR_ICON, TOPBAR_ICON_IDLE, 'disabled:opacity-40')}
      onClick={onClick}
      disabled={disabled === true}
    >
      <MessageSquarePlus aria-hidden className="size-4" />
    </button>
  )
}

/** 顶部搜索：点放大镜展开，输两个字以上就搜；点一条跳过去。出现：对话里有话。 */
export function HistorySearch({
  onJump,
}: {
  onJump: (hit: AssistantHistoryHit) => void
}): React.ReactNode {
  const { t } = useApp()
  const date = useDate()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(id)
  }, [text])
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  const hits = useQuery({
    queryKey: ['free-chat', 'search', q],
    queryFn: () => searchAssistantHistory(q),
    enabled: open && q.length >= 2,
    retry: false,
  })
  if (!open)
    return (
      <button
        type="button"
        aria-label={t('assistant.search')}
        title={t('assistant.search')}
        data-testid="assistant-search"
        className={cn(TOPBAR_ICON, TOPBAR_ICON_IDLE)}
        onClick={() => setOpen(true)}
      >
        {/* 顶栏左边已经有一颗放大镜（全局搜索），这颗用「历史」区分开 */}
        <History aria-hidden className="size-4" />
      </button>
    )
  const close = (): void => {
    setOpen(false)
    setText('')
    setQ('')
  }
  return (
    <div className="relative w-64" data-testid="assistant-search-box">
      <div className="flex h-7 items-center gap-1.5 rounded-md bg-ws-card px-2 shadow-[inset_0_0_0_1px_var(--ws-line-strong)]">
        <Search aria-hidden className="size-3.5 text-muted-foreground" />
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
          }}
          placeholder={t('assistant.search.placeholder')}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          data-testid="assistant-search-input"
        />
        <button
          type="button"
          aria-label={t('answer.close')}
          title={t('answer.close')}
          onClick={close}
        >
          <X aria-hidden className="size-3.5 text-muted-foreground" />
        </button>
      </div>
      {q.length < 2 ? null : (
        <div
          className="absolute top-full right-0 z-50 mt-1 max-h-80 w-80 overflow-y-auto rounded-xl bg-ws-pop p-1 shadow-ws-pop"
          data-testid="assistant-search-results"
        >
          {(hits.data ?? []).length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
              {hits.isFetching ? '…' : t('assistant.search.none')}
            </p>
          ) : (
            (hits.data ?? []).map((h) => (
              <button
                key={`${h.segment_id}:${h.message_id ?? 'sum'}`}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                data-testid="assistant-search-hit"
                data-kind={h.kind}
                onClick={() => {
                  onJump(h)
                  close()
                }}
              >
                <span className="text-xs text-muted-foreground">
                  {date(h.at)}
                  {h.title === undefined ? '' : ` · ${h.title}`}
                </span>
                <span className="line-clamp-2 text-[13px]">{h.snippet}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** 助理翻了以前聊过的：回复下面一排出处。出现：这一轮真翻到了。 */
export function RecalledRefs({
  hits,
  onJump,
}: {
  hits: readonly AssistantHistoryHit[]
  onJump: (hit: AssistantHistoryHit) => void
}): React.ReactNode {
  const { t } = useApp()
  const date = useDate()
  if (hits.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 pl-1" data-testid="assistant-recalled">
      {hits.slice(0, 5).map((h) => (
        <button
          key={`${h.segment_id}:${h.message_id ?? 'sum'}`}
          type="button"
          className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          data-testid="assistant-recalled-ref"
          title={h.snippet}
          onClick={() => onJump(h)}
        >
          {t('assistant.recalled', { date: date(h.at) })}
        </button>
      ))}
    </div>
  )
}

/** WP373（决策 978）：一条回复用的哪个模型（只认模型答的那几条；派出去的事回来报的那句没有 `model`）。 */
type ReplyModel = NonNullable<FreeChatMessage['model']>

/**
 * WP373（决策 978）：哪几句用户的话前面要插「上面是 X 答的，接下来用 Y」。照官方 dsh：只在**真换了**模型时——
 * 这句话的回答用的模型，跟它前面最后一条回答的模型不一样（没换不插；只换了思考程度也不插）。
 * 和服务端给模型那一句（`withModelSwitchNotices`）同一个判法。
 */
export function modelSwitches(
  rows: readonly FreeChatMessage[],
): Map<string, { from: ReplyModel; to: ReplyModel }> {
  const out = new Map<string, { from: ReplyModel; to: ReplyModel }>()
  let previous: ReplyModel | undefined
  rows.forEach((m, i) => {
    if (m.role === 'assistant') {
      if (m.model !== undefined && m.error === undefined) previous = m.model
      return
    }
    const next = rows.slice(i + 1).find((x) => x.role === 'assistant' || x.role === 'user')
    const to = next?.role === 'assistant' && next.error === undefined ? next.model : undefined
    if (previous !== undefined && to !== undefined && to.id !== previous.id)
      out.set(m.id, { from: previous, to })
  })
  return out
}

/** 出现：上面那条回答和下面这条用的不是同一个模型（{@link modelSwitches}）。 */
export function ModelSwitchDivider({
  from,
  to,
}: {
  /** 事项时间线上只有 id（`provider_id/model`）；随便聊还有来源名。 */
  from: { id: string; label?: string }
  to: { id: string; label?: string }
}): React.ReactNode {
  const { t } = useApp()
  const short = (m: { id: string }): string => m.id.slice(m.id.indexOf('/') + 1)
  // 两边模型名一样（同一个模型、换了来源）就带上来源
  const same = short(from) === short(to)
  const name = (m: { id: string; label?: string }): string =>
    same ? (m.label === undefined ? m.id : `${m.label} · ${short(m)}`) : short(m)
  return (
    <div
      className="flex items-center justify-center py-0.5"
      data-testid="thread-model-switch"
      data-from={from.id}
      data-to={to.id}
    >
      <span className="text-xs text-muted-foreground">
        {t('chat.model_switch', { from: name(from), to: name(to) })}
      </span>
    </div>
  )
}
