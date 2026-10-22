/**
 * WP469（决策 1521）：「日历与待办」的**清单**那一面（示意稿 `list`）。原来的待办箱改成这一面，
 * 地址 `/planner?view=list`（老地址 `/todos` 自动转过来，决策 1526）。
 *
 * - 页头：左边「清单 / 日历」分段（两面来回切位置不动）+ 今天的日期 + 灰字「今天 3 件 · 本周 5 件」；
 * - 「记一条待办」认「周五下午」这类说法（`parseQuickTodo`），没写日子就进「本周」、没日子；按 N 跳到这一格；
 * - 今天 / 本周 / 以后 / 做完的；今天做完的那几行留到当天结束（划掉）；每行右边写清在哪一档；
 * - 右边三张小卡：今天的安排、还没排期的、目标（1525 甲）。
 *
 * 目标页还在 `?tab=goals`（「全部目标」进这里），同事模式的「我交出去的」在 `?tab=sent`。
 * 37 §2.2b 那几条照旧：打勾 = 完成不导航；点标题进事项并定位到锚点；能拖到日历上。
 */
import type { Todo } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Search } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CalTodoHead } from '@/components/cal-todo/cal-todo-head'
import { GoalsCard, TodaySchedule, UndatedCard } from '@/components/cal-todo/list-side'
import { TodoRow } from '@/components/cal-todo/todo-row'
import {
  useDoneTodos,
  useOpenTodos,
  usePositionName,
  useTodoAct,
  useTodoRefresh,
} from '@/components/cal-todo/use-todos'
import { GroupLabel, ListGroup, NoticeLine, SkeletonList } from '@/components/design'
import { HandoffDialog } from '@/components/peers/handoff-dialog'
import { Button } from '@/components/ui/button'
import { CollisionCard } from '@/components/work/collision-card'
import { ApiClientError, createTodo, type SimilarCandidate } from '@/lib/api'
import { type HandoffView, listHandoffs, withdrawHandoff } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'
import { groupForList, listCounts, parseQuickTodo, todayTitle } from '@/lib/cal-todo'
import { apiErrorText } from '@/lib/error-text'
import { useMode } from '@/lib/mode'
import { GoalsPage } from '@/pages/goals'

export { TODO_DRAG_TYPE } from '@/components/cal-todo/todo-row'

/** 按 N 跳到「记一条待办」（打字时不响应）。 */
function useKeyToFocus(key: string, target: React.RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== key) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el !== null && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(el.tagName)))
        return
      e.preventDefault()
      target.current?.focus()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => {
      globalThis.removeEventListener('keydown', onKey)
    }
  }, [key, target])
}

export function TodosPage({ switcher }: { switcher?: ReactNode } = {}): ReactNode {
  const { t, lang } = useApp()
  const { mode } = useMode()
  const [params, setParams] = useSearchParams()
  const tab =
    params.get('tab') === 'goals'
      ? 'goals'
      : params.get('tab') === 'sent' && mode !== 'solo'
        ? 'sent'
        : 'todos'
  const fresh = params.get('fresh') ?? undefined
  const open = useOpenTodos()
  const done = useDoneTodos()
  const positionName = usePositionName()
  const refresh = useTodoRefresh()
  const [error, setError] = useState<string | undefined>()
  const act = useTodoAct((e) => {
    setError(apiErrorText(e, t))
  })
  const [now, setNow] = useState(() => new Date())
  // 跨过零点：「今天」那组换一天（做完的那几行收进「做完的」）
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date())
    }, 60_000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  const [title, setTitle] = useState('')
  const [candidates, setCandidates] = useState<SimilarCandidate[]>([])
  const [showDone, setShowDone] = useState(false)
  const [search, setSearch] = useState<string | undefined>()
  const [handing, setHanding] = useState<Todo | undefined>(undefined)
  const input = useRef<HTMLInputElement>(null)
  useKeyToFocus('n', input)

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

  /**
   * 建之前先查（40 §3.1）：撞上进行中的相似项就回 409，这里把候选接住、出一张选择题卡。
   * 标题里的「周五下午」先认出来：有钟点就排上，只有日子就给日子，什么都没写就进「本周」。
   */
  const add = useMutation({
    mutationFn: (extra: {
      collision?: 'join' | 'handoff' | 'force'
      collision_target?: string
      distinct_reason?: string
    }) => {
      const quick = parseQuickTodo(title, new Date())
      return createTodo({
        title: quick.title,
        ...(quick.due === undefined ? {} : { due: quick.due }),
        ...(quick.scheduled === undefined ? {} : { scheduled: quick.scheduled }),
        ...(quick.horizon === undefined ? {} : { horizon: quick.horizon }),
        ...extra,
      })
    },
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
      if (hit.length === 0) setError(apiErrorText(err, t))
    },
    onSettled: refresh,
  })

  const openTodos = useMemo(() => open.data?.todos ?? [], [open.data])
  const doneTodos = useMemo(() => done.data?.todos ?? [], [done.data])
  const groups = useMemo(() => {
    const q = search?.trim().toLowerCase() ?? ''
    const match = (x: Todo): boolean => q === '' || x.title.toLowerCase().includes(q)
    return groupForList(openTodos.filter(match), doneTodos.filter(match), now)
  }, [openTodos, doneTodos, now, search])
  const counts = listCounts(openTodos)

  const back =
    tab === 'todos' ? null : (
      <button
        type="button"
        className="ws-btn ws-btn-ghost ws-btn-sm"
        data-testid="todos-tab-todos"
        onClick={() => {
          setParams(
            (prev) => {
              const p = new URLSearchParams(prev)
              p.delete('tab')
              return p
            },
            { replace: true },
          )
        }}
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('caltodo.back_to_list')}
      </button>
    )

  if (tab === 'goals')
    return (
      <div className="flex max-w-3xl flex-col gap-4" data-testid="todos">
        <CalTodoHead switcher={switcher} title={t('goals.title')} actions={back} />
        <GoalsPage />
      </div>
    )

  if (tab === 'sent')
    return (
      <div className="flex max-w-3xl flex-col gap-4" data-testid="todos">
        <CalTodoHead switcher={switcher} title={t('todos.filter.sent')} actions={back} />
        <SentList items={sent.data?.from_me ?? []} />
      </div>
    )

  const head = (
    <CalTodoHead
      switcher={switcher}
      testId="todos-head"
      title={todayTitle(now, lang)}
      titleTestId="todos-title"
      sub={t('caltodo.list.sub', counts)}
      actions={
        <>
          {mode === 'solo' ? null : (
            <Link
              to="/planner?view=list&tab=sent"
              className="ws-link-muted text-[13px]"
              data-testid="todos-tab-sent"
            >
              {t('todos.filter.sent')}
            </Link>
          )}
          {search === undefined ? (
            <button
              type="button"
              aria-label={t('caltodo.search')}
              title={t('caltodo.search')}
              data-testid="todos-search-open"
              className="grid size-8 place-items-center rounded-md text-ws-muted-fg hover:bg-ws-hover hover:text-ws-ink"
              onClick={() => {
                setSearch('')
              }}
            >
              <Search className="size-4" aria-hidden />
            </button>
          ) : (
            <input
              // biome-ignore lint/a11y/noAutofocus: 点了放大镜就是要找
              autoFocus
              value={search}
              aria-label={t('caltodo.search')}
              placeholder={t('caltodo.search')}
              data-testid="todos-search"
              className="h-8 w-48 rounded-md border border-ws-line bg-ws-card px-2.5 text-[13px]"
              onChange={(e) => {
                setSearch(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch(undefined)
              }}
              onBlur={() => {
                if (search === '') setSearch(undefined)
              }}
            />
          )}
        </>
      }
    />
  )

  const rowsOf = (list: readonly Todo[]): ReactNode => (
    <ListGroup as="ul">
      {list.map((todo) => (
        <TodoRow
          key={todo.id}
          todo={todo}
          now={now}
          position={positionName(todo.position_id)}
          busy={act.isPending && act.variables?.id === todo.id}
          fresh={fresh === todo.id}
          waiting={waitingOf(todo)}
          onAct={(op) => {
            setError(undefined)
            act.mutate({ id: todo.id, ...op })
          }}
          {...(mode === 'solo' || todo.handoff?.state === 'offered'
            ? {}
            : {
                onHandOff: () => {
                  setHanding(todo)
                },
              })}
        />
      ))}
    </ListGroup>
  )

  const section = (key: 'today' | 'week' | 'later', list: readonly Todo[]): ReactNode => (
    <section
      key={key}
      data-testid={`horizon-${key === 'later' ? 'backlog' : key}`}
      className="flex flex-col gap-2"
    >
      <GroupLabel count={list.filter((x) => x.status !== 'done').length}>
        {t(`caltodo.group.${key}`)}
      </GroupLabel>
      {list.length === 0 ? (
        <p className="px-1 text-[13px] text-ws-faint">{t('caltodo.group.empty')}</p>
      ) : (
        rowsOf(list)
      )}
    </section>
  )

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 pb-16" data-testid="todos">
      {head}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          <form
            className="ws-card flex items-center gap-3 px-4 py-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (title.trim() === '') return
              setError(undefined)
              add.mutate({})
            }}
          >
            <Plus className="size-4 shrink-0 text-ws-muted-fg" aria-hidden />
            <input
              ref={input}
              value={title}
              aria-label={t('todos.new')}
              placeholder={t('caltodo.new.placeholder')}
              data-testid="todos-new"
              className="h-8 min-w-0 flex-1 bg-transparent text-[14px] text-ws-ink outline-none placeholder:text-ws-faint"
              onChange={(e) => {
                setTitle(e.target.value)
              }}
            />
            {title.trim() === '' ? (
              <kbd className="ws-num rounded-md bg-ws-surface px-1.5 text-xs text-ws-muted-fg">
                N
              </kbd>
            ) : (
              <Button type="submit" size="sm" disabled={add.isPending}>
                {t('todos.new')}
              </Button>
            )}
          </form>

          {candidates.length === 0 ? null : (
            <CollisionCard
              candidates={candidates}
              busy={add.isPending}
              onJoin={(target) => {
                add.mutate({ collision: 'join', collision_target: target.id })
              }}
              onHandoff={(target) => {
                add.mutate({ collision: 'handoff', collision_target: target.id })
              }}
              onForce={(target, reason) => {
                add.mutate({
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

          {error === undefined ? null : (
            <NoticeLine tone="bad" role="alert">
              {error}
            </NoticeLine>
          )}

          {open.isPending ? (
            <SkeletonList rows={5} />
          ) : open.error !== null ? (
            <NoticeLine tone="bad" role="alert">
              {apiErrorText(open.error, t)}
            </NoticeLine>
          ) : (
            <>
              {section('today', groups.today)}
              {section('week', groups.week)}
              {section('later', groups.later)}
              <section data-testid="horizon-done" className="flex flex-col gap-2">
                <GroupLabel count={groups.done.length}>
                  {t('caltodo.group.done')}
                  {groups.done.length === 0 ? null : (
                    <button
                      type="button"
                      className="ws-link-muted ml-1 font-normal"
                      data-testid="todos-done-toggle"
                      aria-expanded={showDone}
                      onClick={() => {
                        setShowDone((v) => !v)
                      }}
                    >
                      {showDone ? t('caltodo.done.hide') : t('caltodo.done.show')}
                    </button>
                  )}
                </GroupLabel>
                {showDone && groups.done.length > 0 ? rowsOf(groups.done.slice(0, 50)) : null}
              </section>
            </>
          )}
        </div>
        <aside className="flex flex-col gap-4" data-testid="todos-side">
          <TodaySchedule now={now} />
          <UndatedCard open={openTodos} />
          <GoalsCard />
        </aside>
      </div>
      {handing === undefined ? null : (
        <HandoffDialog
          kind="todo"
          id={handing.id}
          title={handing.title}
          open
          onOpenChange={(o) => {
            if (!o) setHanding(undefined)
          }}
        />
      )}
    </div>
  )
}

/** WP276：「我交出去的」那一栏——标题 + 现在的结果（等谁接 / 谁接下了 / 退回了），还在等的能撤回。 */
function SentList({ items }: { items: HandoffView[] }): ReactNode {
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
    <ListGroup as="ul" data-testid="handoff-sent">
      {items.map((h) => (
        <li key={`${h.kind}:${h.id}`} className="ws-row" data-state={h.handoff.state}>
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
          <span className="shrink-0 text-xs text-ws-muted-fg">
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
    </ListGroup>
  )
}
