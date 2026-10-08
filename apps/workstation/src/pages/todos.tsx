/**
 * 待办箱（37 §2.2 / §2.2b）：backlog / 本周 / 今天三段。
 *
 * 每条待办上能做的事，就是 37 §2.2b 那一行：
 * - **打勾 = 完成**（不进事项现场，不导航）
 * - **⋯ = 关闭 / 改期 / 委托**
 * - **点标题 = 进入事项并定位到锚点**（没有事项的待办不给链接，只能打勾）
 * - **拖到日历某天 = 排期**（拖出去的 payload 就是 todo id，日历页接住）
 *
 * 委托之后这条待办上会显示「N 张卡等你定」——那是 AI 回头问人的卡片回填过来的。
 */
import type { Todo } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { HandoffDialog } from '@/components/peers/handoff-dialog'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { CollisionCard } from '@/components/work/collision-card'
import {
  ApiClientError,
  completeTodo,
  createTodo,
  delegateTodo,
  dropTodo,
  listTodos,
  type SimilarCandidate,
  updateTodo,
} from '@/lib/api'
import { type HandoffView, listHandoffs, withdrawHandoff } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'
import { useMode } from '@/lib/mode'
import { DAY_MS, groupByHorizon, HORIZONS, todoUrl } from '@/lib/work'
// WP113（63 §1）：目标入口从左栏收进这一页的 tab（`/goals` 路由仍然留着）
import { GoalsPage } from '@/pages/goals'

export const TODO_DRAG_TYPE = 'application/x-agentsws-todo'

function TodoRow({
  todo,
  onDone,
  onDrop,
  onPostpone,
  onDelegate,
  onHandOff,
  waiting,
  busy,
}: {
  todo: Todo
  onDone(): void
  onDrop(): void
  onPostpone(): void
  onDelegate(): void
  /** WP276：「交给同事」（② 里才给）。 */
  onHandOff?: (() => void) | undefined
  /** WP276：交出去了、等谁接（「等 林峰 接」）。 */
  waiting?: string | undefined
  busy: boolean
}): React.ReactNode {
  const { t } = useApp()
  const [menuOpen, setMenuOpen] = useState(false)
  const href = todoUrl(todo)
  return (
    <li
      className="flex items-center gap-2 rounded-md border px-2 py-1.5"
      data-testid="todo-row"
      data-todo={todo.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TODO_DRAG_TYPE, todo.id)
        e.dataTransfer.setData('text/plain', todo.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <input
        type="checkbox"
        aria-label={t('todos.done')}
        data-testid="todo-check"
        className="size-4 shrink-0 accent-primary"
        checked={todo.status === 'done'}
        disabled={busy}
        onChange={onDone}
      />
      {href === undefined ? (
        <span className="min-w-0 flex-1 truncate text-sm" data-testid="todo-title">
          {todo.title}
        </span>
      ) : (
        <Link
          to={href}
          className="min-w-0 flex-1 truncate text-sm hover:underline"
          data-testid="todo-title"
        >
          {todo.title}
        </Link>
      )}
      {todo.delegate === undefined ? null : (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
          data-testid="todo-delegated"
        >
          <Bot className="size-3" aria-hidden />
          {t('todos.delegating')}
        </span>
      )}
      {waiting === undefined ? null : (
        <span className="shrink-0 text-[11px] text-muted-foreground" data-testid="todo-waiting">
          {waiting}
        </span>
      )}
      {todo.cards.length === 0 ? null : (
        <span
          className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[11px]"
          data-testid="todo-cards"
        >
          {t('todos.cards', { count: todo.cards.length })}
        </span>
      )}
      {/*
        这里用一枚按钮 + 一小段行内菜单，不上 Radix 的浮层：
        菜单只有三条固定动作，浮层的定位 / 焦点陷阱都用不上，少一层反而更稳。
      */}
      <div className="relative shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('todos.menu')}
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((v) => !v)
          }}
        >
          <MoreHorizontal aria-hidden />
        </Button>
        {menuOpen ? (
          <div
            role="menu"
            data-testid="todo-menu"
            className="absolute right-0 z-10 mt-1 flex min-w-32 flex-col rounded-md border bg-popover p-1 shadow-md"
          >
            {(
              [
                ['todos.postpone', onPostpone],
                ['todos.delegate', onDelegate],
                ...(onHandOff === undefined ? [] : [['handoff.give', onHandOff] as const]),
                ['todos.close', onDrop],
              ] as const
            ).map(([key, action]) => (
              <button
                key={key}
                type="button"
                role="menuitem"
                className="rounded px-2 py-1 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setMenuOpen(false)
                  action()
                }}
              >
                {t(key)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  )
}

/**
 * WP113（63 §1）：**目标收进这一页的一个 tab**。
 *
 * 左栏那一格换成「消息」之后，目标需要一个去处。放这儿而不是别处的理由：
 * 待办与目标本来就是同一件事的两端（37 §2.3「目标 → 待办」那条链），
 * 人看完"这周还剩什么"顺手想看一眼"这个月定的数走到哪了"，中间不该隔一次导航。
 *
 * **目标模型一个字没删**：`/goals` 路由留着，⌘K 搜得到，首页那一行也还跳它。
 * 这里只是多开一扇门。tab 记在 URL 的 `?tab=goals` 上——刷新之后还在那一格。
 */
export function TodosPage(): React.ReactNode {
  const { t } = useApp()
  const { mode } = useMode()
  const client = useQueryClient()
  const [title, setTitle] = useState('')
  const [params, setParams] = useSearchParams()
  // WP276：② 里多一个「我交出去的」
  const tab =
    params.get('tab') === 'goals'
      ? 'goals'
      : params.get('tab') === 'sent' && mode !== 'solo'
        ? 'sent'
        : 'todos'
  const [handing, setHanding] = useState<Todo | undefined>(undefined)
  const sent = useQuery({
    queryKey: ['handoffs', 'all'],
    queryFn: () => listHandoffs(true),
    enabled: mode !== 'solo',
    retry: false,
  })
  const waitingOf = (todo: Todo): string | undefined => {
    if (todo.handoff?.state !== 'offered') return undefined
    const hit = sent.data?.from_me.find((h) => h.kind === 'todo' && h.id === todo.id)
    return hit === undefined ? undefined : t('handoff.waiting', { name: hit.to_label })
  }

  const todos = useQuery({
    queryKey: ['todos'],
    queryFn: () => listTodos('?status=open,doing,blocked'),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['todos'] })
    void client.invalidateQueries({ queryKey: ['home'] })
    void client.invalidateQueries({ queryKey: ['calendar'] })
  }

  const act = useMutation({
    mutationFn: async (input: { id: string; op: 'done' | 'drop' | 'postpone' | 'delegate' }) => {
      if (input.op === 'done') return completeTodo(input.id)
      if (input.op === 'drop') return dropTodo(input.id)
      if (input.op === 'delegate') return delegateTodo(input.id)
      return updateTodo(input.id, { due: new Date(Date.now() + DAY_MS).toISOString() })
    },
    onSettled: refresh,
  })

  /**
   * 建之前先查（40 §3.1）：服务端撞上进行中的相似项就回 409，
   * 这里把候选接住、出一张选择题卡，而不是把「建不成」丢给用户。
   */
  const [candidates, setCandidates] = useState<SimilarCandidate[]>([])

  const add = useMutation({
    mutationFn: (input: {
      title: string
      collision?: 'join' | 'handoff' | 'force'
      collision_target?: string
      distinct_reason?: string
    }) => createTodo(input),
    onSuccess: () => {
      setTitle('')
      setCandidates([])
    },
    onError: (err: unknown) => {
      const hit =
        err instanceof ApiClientError && err.details?.reason === 'similar_in_progress'
          ? ((err.details.candidates ?? []) as SimilarCandidate[])
          : []
      setCandidates(hit)
    },
    onSettled: refresh,
  })

  if (todos.isPending) return <Skeleton className="h-64 w-full" />
  if (todos.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{todos.error.message}
      </p>
    )

  const groups = groupByHorizon(todos.data.todos)

  const tabs = (
    <div className="flex gap-1" role="tablist" data-testid="todos-tabs">
      {(mode === 'solo'
        ? (['todos', 'goals'] as const)
        : (['todos', 'goals', 'sent'] as const)
      ).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          data-testid={`todos-tab-${id}`}
          className={
            tab === id
              ? 'rounded-[10px] bg-sidebar-accent px-3 py-1.5 text-[13px] font-medium text-sidebar-accent-foreground'
              : 'rounded-[10px] px-3 py-1.5 text-[13px] text-ws-muted-fg hover:bg-sidebar-accent/60'
          }
          onClick={() => {
            setParams(id === 'todos' ? {} : { tab: id }, { replace: true })
          }}
        >
          {t(id === 'goals' ? 'goals.title' : id === 'sent' ? 'todos.filter.sent' : 'todos.title')}
        </button>
      ))}
    </div>
  )

  if (tab === 'goals')
    return (
      <div className="flex max-w-3xl flex-col gap-4" data-testid="todos">
        {tabs}
        <GoalsPage />
      </div>
    )

  // WP276（docs/95 §4.3 第 5 步）：我交出去的——事项和待办都在，带现在的结果
  if (tab === 'sent')
    return (
      <div className="flex max-w-3xl flex-col gap-4" data-testid="todos">
        {tabs}
        <SentList items={sent.data?.from_me ?? []} />
      </div>
    )

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="todos">
      {tabs}
      <h1 className="flex items-center gap-1 text-base font-semibold">
        {t('todos.title')}
        <Hint text={t('todos.drag_hint')} />
      </h1>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim() === '') return
          add.mutate({ title: title.trim() })
        }}
      >
        <Input
          value={title}
          aria-label={t('todos.new')}
          placeholder={t('todos.new.placeholder')}
          onChange={(e) => {
            setTitle(e.target.value)
          }}
        />
        <Button type="submit" size="sm" disabled={title.trim() === ''}>
          {t('todos.new')}
        </Button>
      </form>

      {candidates.length === 0 ? null : (
        <CollisionCard
          candidates={candidates}
          busy={add.isPending}
          onJoin={(target) => {
            add.mutate({ title: title.trim(), collision: 'join', collision_target: target.id })
          }}
          onHandoff={(target) => {
            add.mutate({ title: title.trim(), collision: 'handoff', collision_target: target.id })
          }}
          onForce={(target, reason) => {
            add.mutate({
              title: title.trim(),
              collision: 'force',
              collision_target: target.id,
              distinct_reason: reason,
            })
          }}
          onCancel={() => {
            setCandidates([])
          }}
        />
      )}

      {HORIZONS.map((horizon) => (
        <section key={horizon} data-testid={`horizon-${horizon}`}>
          <h2 className="mb-2 text-sm font-medium">{t(`todos.horizon.${horizon}`)}</h2>
          {groups[horizon].length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('todos.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {groups[horizon].map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  busy={act.isPending && act.variables?.id === todo.id}
                  onDone={() => {
                    act.mutate({ id: todo.id, op: 'done' })
                  }}
                  onDrop={() => {
                    act.mutate({ id: todo.id, op: 'drop' })
                  }}
                  onPostpone={() => {
                    act.mutate({ id: todo.id, op: 'postpone' })
                  }}
                  onDelegate={() => {
                    act.mutate({ id: todo.id, op: 'delegate' })
                  }}
                  {...(mode === 'solo' || todo.handoff?.state === 'offered'
                    ? {}
                    : {
                        onHandOff: () => {
                          setHanding(todo)
                        },
                      })}
                  waiting={waitingOf(todo)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
      {handing === undefined ? null : (
        <HandoffDialog
          kind="todo"
          id={handing.id}
          title={handing.title}
          open
          onOpenChange={(open) => {
            if (!open) setHanding(undefined)
          }}
        />
      )}
    </div>
  )
}

/** WP276：「我交出去的」那一栏——标题 + 现在的结果（等谁接 / 谁接下了 / 退回了），还在等的能撤回。 */
function SentList({ items }: { items: HandoffView[] }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const withdraw = useMutation({
    mutationFn: (h: HandoffView) => withdrawHandoff(h.kind, h.id),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['handoffs'] })
      await client.invalidateQueries({ queryKey: ['todos'] })
    },
  })
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t('handoff.sent.empty')}</p>
  return (
    <ul className="flex flex-col gap-1.5" data-testid="handoff-sent">
      {items.map((h) => (
        <li
          key={`${h.kind}:${h.id}`}
          className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
          data-state={h.handoff.state}
        >
          {h.matter_id === undefined ? (
            <span className="min-w-0 flex-1 truncate">{h.title}</span>
          ) : (
            <Link
              to={`/matters/${h.matter_id}`}
              className="min-w-0 flex-1 truncate hover:underline"
            >
              {h.title}
            </Link>
          )}
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            {t(`handoff.state.${h.handoff.state}`, { name: h.to_label })}
          </span>
          {h.handoff.state !== 'offered' ? null : (
            <Button
              size="xs"
              variant="ghost"
              disabled={withdraw.isPending}
              onClick={() => {
                withdraw.mutate(h)
              }}
            >
              {t('handoff.withdraw')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}
