/**
 * WP469：清单里的一行待办（示意稿 `list` / `list-menu`）。
 *
 * 左边勾选框（打勾 = 做完，不导航）+ 标题（有事项的点了进事项并定位到锚点，37 §2.2b）；
 * 右边依次：岗位标签、「来自收件箱」、AI 在做 +「N 张卡等你定 →」、**这一行在哪一档**
 * （钟点用时钟图标、日子用日历图标、没日子写灰字「没排日子」+ 一颗「排进日历」）、「⋯」。
 * 「⋯」里：改到明天 / 改日子… / 交给 AI 做 / 交给同事…（同事模式）/ 关闭（不做了）。
 */
import type { Todo } from '@agentsws/contracts'
import {
  ArrowRight,
  CalendarDays,
  CalendarPlus,
  Clock3,
  MoreVertical,
  Sparkles,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { CategoryTag, ListRow } from '@/components/design'
import { Popover } from '@/components/messages/popover'
import { useApp } from '@/lib/app-context'
import {
  aiBusy,
  clock,
  DEFAULT_BLOCK_MIN,
  dayKeyOf,
  dropPatch,
  type TodoPatch,
  whenLabel,
} from '@/lib/cal-todo'
import { cn } from '@/lib/utils'
import { DAY_MS, todoUrl } from '@/lib/work'
import { setDragging } from './drag-state'
import { TodoCheck } from './todo-check'
import type { TodoOp } from './use-todos'

export const TODO_DRAG_TYPE = 'application/x-agentsws-todo'

/** 这一件现在占多长（分钟）：有钟点的按钟点，没有的按默认一小时。 */
export function todoMinutes(todo: Pick<Todo, 'scheduled'>): number {
  if (todo.scheduled === undefined) return DEFAULT_BLOCK_MIN
  return Math.max(
    15,
    Math.round((Date.parse(todo.scheduled.end) - Date.parse(todo.scheduled.start)) / 60_000),
  )
}

export function TodoRow({
  todo,
  now,
  position,
  waiting,
  busy,
  fresh,
  onAct,
  onHandOff,
}: {
  todo: Todo
  now: Date
  /** 岗位名（认得出才有） */
  position?: string | undefined
  /** 交给同事了、等谁接（「等 林峰 接」） */
  waiting?: string | undefined
  busy: boolean
  /** 刚从收件箱记过来的那一行（浅绿底） */
  fresh?: boolean
  onAct(op: TodoOp): void
  onHandOff?: (() => void) | undefined
}): ReactNode {
  const { t, lang } = useApp()
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const done = todo.status === 'done'
  const href = todoUrl(todo)
  const when = whenLabel(todo, now, lang)
  const ai = aiBusy(todo)
  const title = (
    <span className={cn('min-w-0 truncate text-[14px]', done && 'text-ws-faint line-through')}>
      {todo.title}
    </span>
  )
  return (
    <ListRow
      as="li"
      className={cn(
        'group',
        fresh === true && 'bg-ws-tint shadow-[inset_3px_0_0_var(--ws-brand)]',
        done && 'text-ws-faint',
      )}
      data-testid="todo-row"
      data-todo={todo.id}
      data-level={
        todo.scheduled !== undefined ? 'timed' : todo.due !== undefined ? 'dated' : 'undated'
      }
      data-done={done ? 'true' : undefined}
      draggable={!done && !ai}
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
      <TodoCheck
        checked={done}
        label={t('todos.done')}
        disabled={busy}
        onToggle={() => {
          onAct(done ? { op: 'undone' } : { op: 'done' })
        }}
      />
      {href === undefined ? (
        <span className="flex min-w-0 flex-1" data-testid="todo-title">
          {title}
        </span>
      ) : (
        <Link to={href} className="flex min-w-0 flex-1 hover:underline" data-testid="todo-title">
          {title}
        </Link>
      )}
      <span className="flex shrink-0 items-center gap-2.5 text-xs text-ws-muted-fg">
        {done ? (
          todo.closed_at === undefined ? null : (
            <span className="ws-num text-ws-faint" data-slot="status">
              {t('caltodo.done_at', { time: clock(new Date(todo.closed_at)) })}
            </span>
          )
        ) : (
          <>
            {position === undefined ? null : <CategoryTag>{position}</CategoryTag>}
            {todo.origin?.inbox_item === undefined ? null : (
              <Link to="/inbox" className="ws-link-muted" data-testid="todo-from-inbox">
                {t('caltodo.from_inbox')}
              </Link>
            )}
            {todo.delegate === undefined ? null : (
              <span
                className="inline-flex items-center gap-1 text-ws-brand-ink"
                data-testid="todo-delegated"
              >
                <Sparkles className="size-3.5" aria-hidden />
                {t('todos.delegating')}
              </span>
            )}
            {todo.cards.length === 0 ? null : (
              <Link
                to="/inbox"
                className="ws-pill bg-ws-warn-bg text-ws-warn"
                data-testid="todo-cards"
              >
                {t('todos.cards', { count: todo.cards.length })}
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            )}
            {waiting === undefined ? null : <span data-testid="todo-waiting">{waiting}</span>}
            <WhenTag when={when} />
            {when.kind === 'none' && !ai ? (
              <Link
                to={`/planner?view=calendar&focus=${encodeURIComponent(todo.id)}`}
                title={t('caltodo.place')}
                aria-label={t('caltodo.place')}
                data-testid="todo-place"
                className="grid size-7 place-items-center rounded-md text-ws-muted-fg opacity-0 group-hover:opacity-100 hover:bg-ws-hover hover:text-ws-ink focus-visible:opacity-100"
              >
                <CalendarPlus className="size-4" aria-hidden />
              </Link>
            ) : null}
          </>
        )}
        <Popover
          open={menu || editing}
          onOpenChange={(open) => {
            if (!open) {
              setMenu(false)
              setEditing(false)
            }
          }}
          align="end"
          testId={editing ? 'todo-date-editor' : 'todo-menu'}
          trigger={
            <button
              type="button"
              aria-label={t('todos.menu')}
              aria-expanded={menu}
              className={cn(
                'grid size-7 place-items-center rounded-md text-ws-muted-fg hover:bg-ws-hover hover:text-ws-ink',
                !menu && !editing && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              )}
              onClick={() => {
                setEditing(false)
                setMenu((v) => !v)
              }}
            >
              <MoreVertical className="size-4" aria-hidden />
            </button>
          }
        >
          {editing ? (
            <DateEditor
              todo={todo}
              onSave={(patch) => {
                setEditing(false)
                onAct({ op: 'patch', patch })
              }}
              onCancel={() => {
                setEditing(false)
              }}
            />
          ) : (
            <TodoMenu
              todo={todo}
              onPick={(what) => {
                setMenu(false)
                if (what === 'date') setEditing(true)
                else if (what === 'peer') onHandOff?.()
                else if (what === 'tomorrow') {
                  const day = dayKeyOf(new Date(now.getTime() + DAY_MS))
                  const patch = dropPatch(
                    todo,
                    todo.scheduled === undefined
                      ? { kind: 'day', day }
                      : { kind: 'day', day, keepClock: true },
                  )
                  if (patch !== undefined) onAct({ op: 'patch', patch })
                } else onAct({ op: what })
              }}
              peers={onHandOff !== undefined}
            />
          )}
        </Popover>
      </span>
    </ListRow>
  )
}

/** 右边那一格：钟点（时钟图标）/ 日子（日历图标；从收件箱带来的期限写「周五前」）/「没排日子」。 */
export function WhenTag({ when }: { when: ReturnType<typeof whenLabel> }): ReactNode {
  if (when.kind === 'none')
    return (
      <span className="text-ws-faint" data-testid="todo-when" data-kind="none">
        {when.text}
      </span>
    )
  if (when.deadline === true)
    return (
      <span
        className="ws-pill bg-ws-warn-bg text-ws-warn"
        data-testid="todo-when"
        data-kind="deadline"
      >
        <i aria-hidden className="ws-pill-dot" />
        {when.text}
      </span>
    )
  const Icon = when.kind === 'clock' ? Clock3 : CalendarDays
  return (
    <span
      className="ws-num inline-flex items-center gap-1 text-ws-body"
      data-testid="todo-when"
      data-kind={when.kind}
    >
      <Icon className="size-3.5 text-ws-muted-fg" aria-hidden />
      {when.text}
    </span>
  )
}

type MenuPick = 'tomorrow' | 'date' | 'delegate' | 'peer' | 'drop'

function TodoMenu({
  todo,
  peers,
  onPick,
}: {
  todo: Todo
  peers: boolean
  onPick(what: MenuPick): void
}): ReactNode {
  const { t } = useApp()
  const done = todo.status === 'done'
  const items: { what: MenuPick; label: string; danger?: boolean }[] = [
    ...(done ? [] : [{ what: 'tomorrow' as const, label: t('todos.postpone') }]),
    ...(done ? [] : [{ what: 'date' as const, label: t('caltodo.menu.date') }]),
    ...(done || todo.delegate !== undefined
      ? []
      : [{ what: 'delegate' as const, label: t('todos.delegate') }]),
    ...(peers && !done ? [{ what: 'peer' as const, label: t('caltodo.menu.peer') }] : []),
    { what: 'drop' as const, label: t('caltodo.menu.close'), danger: true },
  ]
  return (
    <div role="menu" className="flex w-44 flex-col p-1">
      {items.map((m) => (
        <button
          key={m.what}
          type="button"
          role="menuitem"
          data-testid={`todo-menu-${m.what}`}
          className={cn(
            'rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-ws-surface',
            m.danger === true && 'mt-1 border-t border-ws-line text-ws-bad',
          )}
          onClick={() => {
            onPick(m.what)
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/** 「改日子…」：一个日子 + 一个可不填的钟点；「不排了」= 回到没日子。 */
function DateEditor({
  todo,
  onSave,
  onCancel,
}: {
  todo: Todo
  onSave(patch: TodoPatch): void
  onCancel(): void
}): ReactNode {
  const { t } = useApp()
  const at = todo.scheduled?.start ?? todo.due
  const [day, setDay] = useState(at === undefined ? dayKeyOf(new Date()) : dayKeyOf(new Date(at)))
  const [time, setTime] = useState(
    todo.scheduled === undefined
      ? ''
      : (() => {
          const d = new Date(todo.scheduled.start)
          return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
        })(),
  )
  const save = (): void => {
    if (day === '') return
    if (time === '') {
      const patch = dropPatch(todo, { kind: 'day', day })
      if (patch === undefined) onCancel()
      else onSave(patch)
      return
    }
    const [h, m] = time.split(':').map(Number)
    const patch = dropPatch(todo, { kind: 'time', day, minutes: (h ?? 9) * 60 + (m ?? 0) })
    if (patch === undefined) onCancel()
    else onSave(patch)
  }
  return (
    <form
      className="flex w-60 flex-col gap-2 p-3 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ws-muted-fg">{t('caltodo.date.day')}</span>
        <input
          type="date"
          value={day}
          data-testid="todo-date-day"
          className="h-8 rounded-md border border-ws-line bg-ws-card px-2"
          onChange={(e) => {
            setDay(e.target.value)
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ws-muted-fg">
          {t('caltodo.date.time', { n: DEFAULT_BLOCK_MIN })}
        </span>
        <input
          type="time"
          value={time}
          step={900}
          data-testid="todo-date-time"
          className="h-8 rounded-md border border-ws-line bg-ws-card px-2"
          onChange={(e) => {
            setTime(e.target.value)
          }}
        />
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          className="ws-btn ws-btn-primary ws-btn-sm"
          data-testid="todo-date-save"
        >
          {t('caltodo.date.save')}
        </button>
        {todo.due === undefined && todo.scheduled === undefined ? null : (
          <button
            type="button"
            className="ws-btn ws-btn-ghost ws-btn-sm"
            data-testid="todo-date-clear"
            onClick={() => {
              onSave({ due: null, scheduled: null, horizon: 'week' })
            }}
          >
            {t('caltodo.date.clear')}
          </button>
        )}
      </div>
    </form>
  )
}
