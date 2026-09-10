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
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
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
import { useApp } from '@/lib/app-context'
import { DAY_MS, groupByHorizon, HORIZONS, todoUrl } from '@/lib/work'

export const TODO_DRAG_TYPE = 'application/x-agentsws-todo'

function TodoRow({
  todo,
  onDone,
  onDrop,
  onPostpone,
  onDelegate,
  busy,
}: {
  todo: Todo
  onDone(): void
  onDrop(): void
  onPostpone(): void
  onDelegate(): void
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

export function TodosPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [title, setTitle] = useState('')

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

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="todos">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-base font-semibold">{t('todos.title')}</h1>
        <span className="text-xs text-muted-foreground">{t('todos.drag_hint')}</span>
      </div>

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
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}
