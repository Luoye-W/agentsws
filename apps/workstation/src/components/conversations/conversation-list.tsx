/**
 * WP372（决策 1001 / 1004）：对话列表的几块积木——卡上（最多 4 条）与完整列表（分组、可搜）共用。
 *
 * - 一行 = 标记 + 标题，点了进那件事（`/matters/:id`）；
 * - **标记**（决策 1004）：在做 = 转圈，等你看（等你批 / 做完待看）= 黄点，其余不画——
 *   「正在做」「等你拍板」不单独成卡，进度与审批在正文对话里（卡片流），这里只带个记号；
 * - 「新对话」：一格输入，回车交给这条职责（岗位层不带职责 = 岗位自己分），走岗位入口那一条路
 *   （`askAtPosition`，与岗位页输入框、原 ⌘K「交给某个岗位」同一条），交出去跳到岗位页看它进线程。
 *
 * WP352 起助理页只有一条连续对话、没有会话列表了，所以这里没有「和助理页共用」的那一半；
 * 积木只依赖 `RailMatter`，以后哪儿要列事项都能拿去用。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { Loader2, MessageCircle, Plus, Search, Send } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useConversationActions } from '@/components/conversations/actions'
import { askAtPosition } from '@/components/position/quick-answer-store'
import { MatterMenu } from '@/components/sidebar/matter-menu'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'
import { TASK_TEXT_MAX } from '@/lib/handoff'
import { shortAgo } from '@/lib/short-ago'
import { RAIL_KEY, type RailMatter, type RailMatterState } from '@/lib/work-archive'

/**
 * 行首的记号：在做转圈、等你看黄点、其余一个灰色对话图标（WP456-T3 §3.9：每行「图标 + 名字 + 灰色时间」）。
 */
export function ConvMarker({ state }: { state: RailMatterState }): ReactNode {
  const { t } = useApp()
  if (state === 'running')
    return (
      <Loader2
        role="img"
        aria-label={t('conv.running')}
        data-testid="conv-marker"
        data-state="running"
        className="size-3.5 shrink-0 animate-spin text-ws-brand motion-reduce:animate-none"
      />
    )
  if (state === 'awaiting' || state === 'ready')
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <i
          role="img"
          aria-label={t('conv.waiting')}
          title={t('conv.waiting')}
          data-testid="conv-marker"
          data-state={state}
          className="size-1.5 rounded-full bg-ws-warn"
        />
      </span>
    )
  return <MessageCircle aria-hidden className="size-3.5 shrink-0 text-ws-faint" />
}

export function ConvRow({ matter }: { matter: RailMatter }): ReactNode {
  const actions = useConversationActions()
  const { t, lang } = useApp()
  return (
    <li
      className="group/thread flex items-center gap-0.5"
      data-testid="conv-row"
      data-id={matter.id}
    >
      <NavLink
        to={`/matters/${encodeURIComponent(matter.id)}`}
        data-testid="conv-link"
        data-state={matter.state}
        className={({ isActive }) =>
          cn(
            // WP456-T3（§3.9）：每行 32 高；选中那行品牌浅底
            'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors',
            isActive
              ? 'bg-ws-tint font-medium text-ws-brand-ink'
              : 'text-ws-body hover:bg-ws-hover',
          )
        }
      >
        <ConvMarker state={matter.state} />
        <span className="min-w-0 flex-1 truncate">{matter.title}</span>
        <span
          className="ws-num shrink-0 text-[12px] font-normal text-ws-faint"
          data-testid="conv-when"
        >
          {shortAgo(matter.last_activity, t, lang)}
        </span>
      </NavLink>
      {actions.archive === undefined ? null : (
        <MatterMenu
          title={matter.title}
          state={matter.state}
          onArchive={() => {
            actions.archive?.(matter)
          }}
        />
      )}
    </li>
  )
}

export function ConvRows({ matters }: { matters: readonly RailMatter[] }): ReactNode {
  return (
    <ul className="flex flex-col gap-px" data-testid="conv-rows">
      {matters.map((m) => (
        <ConvRow key={m.id} matter={m} />
      ))}
    </ul>
  )
}

/** 搜对话（只搜标题，就地筛；找更早的 / 归档的用 ⌘K）。 */
export function ConvSearch({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}): ReactNode {
  const { t } = useApp()
  return (
    <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] border border-ws-line bg-ws-card px-2 text-[13px]">
      <Search aria-hidden className="size-3.5 shrink-0 text-ws-muted-fg" />
      <input
        value={value}
        placeholder={t('conv.search')}
        aria-label={t('conv.search')}
        data-testid="conv-search"
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-ws-muted-fg"
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </label>
  )
}

/** 「+ 新对话」那个按钮。 */
export function NewConvButton({
  label,
  onClick,
  compact = false,
}: {
  /** tooltip 与读屏那一句（「在「店铺管理」下开一个新对话」）。 */
  label: string
  onClick: () => void
  /** 卡标题行上只画一个「+」。 */
  compact?: boolean
}): ReactNode {
  const { t } = useApp()
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="conv-new"
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-[8px] text-[12px] text-ws-muted-fg hover:bg-sidebar-accent/60 hover:text-foreground',
        compact ? 'size-6 justify-center' : 'h-8 px-2',
      )}
      onClick={onClick}
    >
      <Plus aria-hidden className="size-3.5" />
      {compact ? null : t('conv.new')}
    </button>
  )
}

/**
 * 新对话那一格：一句话，回车交出去。
 *
 * `assignment` = 岗位入口要的那条分配（职责层是这条职责的，岗位层是本人在这个岗位的第一条）；
 * `role_id` 给了 = 跳过岗位内路由、直接交给这条职责（与原来左栏职责行「+」同一个效果）。
 */
export function NewConversation({
  assignment,
  role_id,
  onDone,
}: {
  assignment: string
  role_id?: string
  onDone: () => void
}): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [text, setText] = useState('')
  const send = useMutation({
    mutationFn: async (sentence: string) => {
      // 不等它回来：岗位页那一块先出「…」，回来后自己跳进线程（WP291 三分）
      void askAtPosition({
        position: assignment,
        text: sentence,
        ...(role_id === undefined ? {} : { role_id }),
      }).then(() => client.invalidateQueries({ queryKey: RAIL_KEY }))
    },
    onSuccess: () => {
      setText('')
      onDone()
      void navigate(`/positions/${encodeURIComponent(assignment)}`)
    },
  })
  return (
    <form
      className="flex items-center gap-1.5"
      data-testid="conv-compose"
      onSubmit={(e) => {
        e.preventDefault()
        const sentence = text.trim()
        if (sentence === '' || send.isPending) return
        send.mutate(sentence)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone()
      }}
    >
      <Input
        autoFocus
        value={text}
        maxLength={TASK_TEXT_MAX}
        placeholder={t('conv.compose.placeholder')}
        aria-label={t('conv.compose.placeholder')}
        data-testid="conv-compose-input"
        className="h-8 text-[13px]"
        onChange={(e) => {
          setText(e.target.value)
        }}
      />
      <button
        type="submit"
        aria-label={t('conv.compose.send')}
        title={t('conv.compose.send')}
        data-testid="conv-compose-send"
        disabled={text.trim() === '' || send.isPending}
        className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-ws-brand text-white disabled:opacity-40"
      >
        <Send aria-hidden className="size-3.5" />
      </button>
    </form>
  )
}
