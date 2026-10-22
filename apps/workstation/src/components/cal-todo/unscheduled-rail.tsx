/**
 * WP469（决策 1522）：日历左边「还没排期的」（示意稿 `calendar` / `calendar-drag` / `calendar-undated`）。
 *
 * - 分「本周要做」「以后」两组；每行：拖动把手 + 勾选框（没排也能直接打勾做完）+ 标题；AI 在做的那件
 *   标「AI 在做」、不能拖。
 * - 拖到日历上就是排期（日历那边接）；从日历拖回这里就是不排了——落在「以后」那组进「以后」，别处进「本周要做」。
 * - 点一行（不是勾）= 选上它给「帮我排进空档」；什么都没选就排「本周要做」里能排的那几件。
 *   找好之后选上的那几行右边写「约 2 小时 ✓」，底部按钮变成「已找好 3 个空档」。
 */
import type { Todo } from '@agentsws/contracts'
import { Check, GripVertical, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { aiBusy, type Ghost, unscheduled } from '@/lib/cal-todo'
import { cn } from '@/lib/utils'
import { getDragging, setDragging } from './drag-state'
import { TodoCheck } from './todo-check'
import { TODO_DRAG_TYPE, todoMinutes } from './todo-row'

export function UnscheduledRail({
  open,
  selected,
  ghosts,
  busy,
  focus,
  onToggleSelect,
  onCheck,
  onDropBack,
  onPropose,
}: {
  open: readonly Todo[]
  selected: ReadonlySet<string>
  ghosts: readonly Ghost[]
  busy: boolean
  /** 从清单「排进日历」点过来的那一件：滚到它、标出来 */
  focus?: string | undefined
  onToggleSelect(id: string): void
  onCheck(id: string): void
  onDropBack(id: string, horizon: 'week' | 'backlog'): void
  onPropose(): void
}): ReactNode {
  const { t } = useApp()
  const groups = unscheduled(open)
  const total = groups.week.length + groups.later.length
  const [over, setOver] = useState<'week' | 'backlog' | undefined>()
  const picked = ghosts.length > 0
  const pickable = groups.week.filter((x) => !aiBusy(x))
  const n = selected.size

  const dropZone = (horizon: 'week' | 'backlog') => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(TODO_DRAG_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (over !== horizon) setOver(horizon)
    },
    onDragLeave: (e: React.DragEvent) => {
      const next = e.relatedTarget as Node | null
      if (next === null || !(e.currentTarget as Node).contains(next)) setOver(undefined)
    },
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(TODO_DRAG_TYPE) || getDragging()?.id || ''
      setOver(undefined)
      setDragging(undefined)
      if (id === '') return
      e.preventDefault()
      e.stopPropagation()
      onDropBack(id, horizon)
    },
  })

  const row = (todo: Todo): ReactNode => (
    <RailRow
      key={todo.id}
      todo={todo}
      selected={selected.has(todo.id)}
      focused={focus === todo.id}
      ghost={ghosts.find((g) => g.todo_id === todo.id)}
      onToggle={() => {
        onToggleSelect(todo.id)
      }}
      onCheck={() => {
        onCheck(todo.id)
      }}
    />
  )

  return (
    <section
      className={cn(
        'ws-card flex flex-col py-2',
        over !== undefined && 'outline-2 outline-dashed outline-ws-brand',
      )}
      data-testid="caltodo-rail"
      aria-label={t('caltodo.rail.title')}
      {...dropZone('week')}
    >
      <div className="flex items-center gap-1.5 px-3.5 pt-1.5 pb-1">
        <h2 className="text-[14px] font-semibold text-ws-ink">{t('caltodo.rail.title')}</h2>
        <span className="ws-num text-[13px] text-ws-faint">{total}</span>
        <span className="flex-1" />
        <Hint text={t('caltodo.rail.hint')} className="text-ws-faint" testId="caltodo-rail-help" />
      </div>
      {total === 0 ? (
        <p className="px-3.5 py-2 text-[13px] text-ws-faint" data-testid="caltodo-rail-empty">
          {t('caltodo.rail.empty')}
        </p>
      ) : null}
      {groups.week.length === 0 ? null : (
        <div data-testid="caltodo-rail-week">
          <div className="ws-group-label px-3.5 pt-1.5 pb-1">
            {t('caltodo.rail.week')}
            <span className="ws-num font-medium text-ws-faint">{groups.week.length}</span>
          </div>
          <ul>{groups.week.map(row)}</ul>
        </div>
      )}
      <div
        data-testid="caltodo-rail-later"
        className={cn(over === 'backlog' && 'bg-ws-tint')}
        {...dropZone('backlog')}
      >
        <div className="ws-group-label px-3.5 pt-2 pb-1">
          {t('caltodo.rail.later')}
          <span className="ws-num font-medium text-ws-faint">{groups.later.length}</span>
        </div>
        <ul>{groups.later.map(row)}</ul>
      </div>
      <div className="px-3 pt-2 pb-1">
        <button
          type="button"
          data-testid="caltodo-ai"
          data-state={picked ? 'found' : busy ? 'busy' : 'idle'}
          aria-disabled={!picked && (busy || (n === 0 && pickable.length === 0))}
          className={cn(
            'ws-btn w-full',
            picked ? 'ws-btn-primary cursor-default' : 'ws-btn-secondary',
          )}
          onClick={() => {
            if (picked || busy || (n === 0 && pickable.length === 0)) return
            onPropose()
          }}
        >
          <Sparkles className="size-3.5" aria-hidden />
          {picked
            ? t('caltodo.ai.found', { n: ghosts.length })
            : busy
              ? t('caltodo.ai.busy')
              : n > 0
                ? t('caltodo.ai.button.n', { n })
                : t('caltodo.ai.button')}
        </button>
      </div>
    </section>
  )
}

function RailRow({
  todo,
  selected,
  focused,
  ghost,
  onToggle,
  onCheck,
}: {
  todo: Todo
  selected: boolean
  focused: boolean
  ghost: Ghost | undefined
  onToggle(): void
  onCheck(): void
}): ReactNode {
  const { t } = useApp()
  const ai = aiBusy(todo)
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [focused])
  return (
    <li
      ref={ref}
      className={cn(
        'group flex min-h-10 items-center gap-2 px-2 text-[13px] text-ws-ink',
        selected || ghost !== undefined ? 'bg-ws-tint' : 'hover:bg-ws-hover',
        focused && 'shadow-[inset_3px_0_0_var(--ws-brand)]',
      )}
      data-testid="caltodo-rail-row"
      data-todo={todo.id}
      data-selected={selected ? 'true' : undefined}
      draggable={!ai}
      onDragStart={(e) => {
        e.dataTransfer.setData(TODO_DRAG_TYPE, todo.id)
        e.dataTransfer.setData('text/plain', todo.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging({ id: todo.id, minutes: todoMinutes(todo) })
      }}
      onDragEnd={() => {
        setDragging(undefined)
      }}
    >
      <GripVertical
        aria-hidden
        className={cn('size-3.5 shrink-0 text-ws-faint', ai ? 'invisible' : 'cursor-grab')}
      />
      <TodoCheck
        checked={false}
        label={t('todos.done')}
        onToggle={onCheck}
        testId="caltodo-rail-check"
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
        aria-pressed={selected}
        disabled={ai}
        title={ai ? undefined : t('caltodo.rail.pick')}
        onClick={onToggle}
      >
        <span className="min-w-0 flex-1 truncate">{todo.title}</span>
        {ai ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ws-brand-ink">
            <Sparkles className="size-3" aria-hidden />
            {t('todos.delegating')}
          </span>
        ) : ghost !== undefined ? (
          <span
            className="ws-num inline-flex shrink-0 items-center gap-1 text-xs text-ws-brand-ink"
            data-testid="caltodo-rail-est"
          >
            {t('caltodo.ai.est', { h: Math.round((ghost.minutes / 60) * 10) / 10 })}
            <Check className="size-3.5" aria-hidden />
          </span>
        ) : selected ? (
          <Check className="size-3.5 shrink-0 text-ws-brand" aria-hidden />
        ) : null}
      </button>
    </li>
  )
}
