/**
 * WP469（决策 1521）：收件箱一行「记成待办」（示意稿 `from-inbox` / `from-inbox-landed`）。
 *
 * - 在每行「⋯」的第一项，快捷键 T（列表里是打开的那一行，一张一张里是当前这张）；
 * - 默认落「日历与待办 · 本周」、没日子；信里 / 卡上有期限（「3 天内」、卡的到期）就带上那天，清单上读作「周五前」；
 * - 记完那一行在收件箱里收成一行「已记成待办「…」· 本周 · 周五前 / 在日历与待办里看 / 撤销」——
 *   认的是待办上记着的 `origin.inbox_item`，所以刷新之后也还是收着的；那条待办做完 / 关掉了，这一行再展开；
 * - 底部提示条「记进「日历与待办 · 本周」 … · 去看 · 撤销」；「去看」打开清单、那一行浅绿底。
 *
 * 卡本身不动（不批、不撤）：记成待办只是「这件我记下了，回头处理」，岗位那张卡照旧等你。
 */
import type { Todo } from '@agentsws/contracts'
import type { InboxItem } from '@agentsws/deck'
import { useMutation } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useOpenTodos, useTodoRefresh } from '@/components/cal-todo/use-todos'
import { createTodo, dropTodo } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { inboxDeadline, whenLabel } from '@/lib/cal-todo'
import { apiErrorText } from '@/lib/error-text'
import type { InboxNotice } from './inbox-actions'

/** 记成待办用的标题：卡用卡的标题；信用主题（没有主题用 AI 那一句）。 */
export function todoTitleOf(item: InboxItem): string {
  if (item.card !== undefined) return item.card.title
  const m = item.mail
  if (m === undefined) return item.id
  return (m.subject.trim() === '' ? (m.summary ?? m.from.email) : m.subject).slice(0, 200)
}

/** 那一行有没有期限（卡的到期、信里写的「3 天内」）。 */
export function deadlineOf(item: InboxItem, now = new Date()): string | undefined {
  return inboxDeadline(
    {
      expires_at: item.card?.expires_at,
      text: [item.mail?.subject, item.mail?.summary, item.card?.summary].filter(Boolean).join(' '),
    },
    now,
  )
}

/** 落在清单哪一组（「本周」/「今天」/「以后」）。 */
export function landedGroup(todo: Todo, t: (k: string) => string): string {
  return t(
    `caltodo.group.${todo.horizon === 'today' ? 'today' : todo.horizon === 'week' ? 'week' : 'later'}`,
  )
}

/** 「本周」或「本周 · 周五前」。 */
export function landedWhen(todo: Todo, t: (k: string) => string, lang: string): string {
  const when = todo.due === undefined ? undefined : whenLabel(todo, new Date(), lang).text
  return when === undefined ? landedGroup(todo, t) : `${landedGroup(todo, t)} · ${when}`
}

export function useInboxTodo(onNotice: (n: InboxNotice) => void): {
  /** 这一行记过、还没做完的那条待办 */
  recorded: ReadonlyMap<string, Todo>
  record(item: InboxItem): void
  undo(todo: Todo): void
  busy: boolean
} {
  const { t, lang } = useApp()
  const open = useOpenTodos()
  const refresh = useTodoRefresh()
  const recorded = useMemo(() => {
    const m = new Map<string, Todo>()
    for (const x of open.data?.todos ?? [])
      if (x.origin?.inbox_item !== undefined) m.set(x.origin.inbox_item, x)
    return m
  }, [open.data])
  const fail = (e: unknown): void => {
    onNotice({ tone: 'error', text: apiErrorText(e, t) })
  }
  const drop = useMutation({
    mutationFn: (id: string) => dropTodo(id),
    onSettled: refresh,
  })
  const undo = (todo: Todo): void => {
    drop.mutate(todo.id, { onError: fail })
  }
  const add = useMutation({
    mutationFn: (item: InboxItem) => {
      const due = deadlineOf(item)
      return createTodo({
        title: todoTitleOf(item),
        ...(due === undefined ? { horizon: 'week' as const } : { due }),
        from_inbox: item.id,
        // 收件箱记下的是「这件我回头处理」，不和别人手上的相似项撞车（同一行记两次服务端只留一条）
        collision: 'force',
        distinct_reason: t('inbox.todo.reason'),
      })
    },
    onSettled: refresh,
  })
  const record = (item: InboxItem): void => {
    if (recorded.has(item.id)) return
    add.mutate(item, {
      onSuccess: ({ todo }) => {
        onNotice({
          tone: 'ok',
          text: t('inbox.todo.done', { where: landedGroup(todo, t) }),
          detail: `${todo.title}${todo.due === undefined ? '' : ` · ${whenLabel(todo, new Date(), lang).text}`}`,
          go: {
            label: t('inbox.todo.go'),
            to: `/planner?view=list&fresh=${encodeURIComponent(todo.id)}`,
          },
          undo: () => {
            undo(todo)
          },
        })
      },
      onError: fail,
    })
  }
  return { recorded, record, undo, busy: add.isPending || drop.isPending }
}

/** 记完那一行收成的样子（示意稿 `from-inbox` 里第二行）。 */
export function RecordedRow({ todo, onUndo }: { todo: Todo; onUndo(): void }): ReactNode {
  const { t, lang } = useApp()
  return (
    <div
      className="flex items-center gap-2.5 border-t border-ws-line px-4 py-2.5 text-[13px] text-ws-muted-fg first:border-t-0"
      data-testid="inbox-row-recorded"
      data-todo={todo.id}
    >
      <Check aria-hidden className="size-4 shrink-0 text-ws-brand" />
      <span className="min-w-0 flex-1 truncate">
        {t('inbox.todo.row', { title: todo.title, when: landedWhen(todo, t, lang) })}
      </span>
      <Link
        to={`/planner?view=list&fresh=${encodeURIComponent(todo.id)}`}
        className="ws-link-muted shrink-0 text-xs"
        data-testid="inbox-row-recorded-go"
      >
        {t('inbox.todo.row.go')}
      </Link>
      <button
        type="button"
        className="ws-link-muted shrink-0 text-xs"
        data-testid="inbox-row-recorded-undo"
        onClick={onUndo}
      >
        {t('messages.undo')}
      </button>
    </div>
  )
}
