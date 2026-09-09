/**
 * 日历（37 §2 表 + C3）：**既是视图也是排期面**，本身不是对象。
 *
 * 四类来源合并成一份 `CalendarItem[]`：
 * 1. 会议（WP23 提供，本包只收 `CalendarItem`）
 * 2. 有排期的待办（`Todo.scheduled`）——只有 `due` 的挂在那天的「到期」栏，不占时段
 * 3. 定时任务（25 `ScheduledTask.next_fire_at`）
 * 4. 卡片到期（`ApprovalItem.expires_at` / `due_at`）——叠层，可关
 *
 * 排期 = 写 `Todo.scheduled`（拖到日历某天就是它），所以这里只读不写。
 */
import type {
  ApprovalItem,
  CalendarItem,
  CalendarRange,
  ScheduledTask,
  Todo,
} from '@agentsws/contracts'
import { isOpen } from './horizon.js'
import { ms, overlaps } from './util.js'

/** 定时任务的一行（25 §3）；只用到这几项，所以放宽成结构类型。 */
export type ScheduledTaskLike = Pick<ScheduledTask, 'id' | 'state' | 'next_fire_at'> & {
  title?: string
  role_id?: string
  assignment_id?: string
}

export interface CalendarInput {
  range: CalendarRange
  todos: readonly Todo[]
  /** WP23 的会议；本包不认识 Meeting 对象，只收已经投影好的日历项 */
  meetings?: readonly CalendarItem[]
  tasks?: readonly ScheduledTaskLike[]
  /** 待我定的卡片；`expires_at` 或 `due_at` 落在窗口里的进「卡片到期」叠层 */
  cards?: readonly ApprovalItem[]
}

const DEFAULT_TODO_MINUTES = 60

/** 有排期的待办 → 占时段；只有 due 的 → 挂在那天。 */
export function todoCalendarItem(todo: Todo): CalendarItem | undefined {
  const common = {
    id: `cal_todo_${todo.id}`,
    source: 'todo' as const,
    title: todo.title,
    ref: { type: 'todo', id: todo.id },
    status: todo.status,
    ...(todo.position_id === undefined ? {} : { position_id: todo.position_id }),
    ...(todo.matter_id === undefined ? {} : { matter_id: todo.matter_id }),
  }
  if (todo.scheduled !== undefined) {
    return { ...common, start: todo.scheduled.start, end: todo.scheduled.end, all_day: false }
  }
  if (todo.due !== undefined) return { ...common, start: todo.due, all_day: true }
  return undefined
}

function cardCalendarItem(item: ApprovalItem): CalendarItem | undefined {
  const at = item.expires_at ?? item.due_at
  if (at === undefined) return undefined
  return {
    id: `cal_card_${item.id}`,
    source: 'card_due',
    title: item.title,
    start: at,
    all_day: true,
    ref: { type: 'approval_item', id: item.id },
    status: item.state,
    ...(item.subject.matter_id === undefined ? {} : { matter_id: item.subject.matter_id }),
  }
}

function taskCalendarItem(task: ScheduledTaskLike): CalendarItem | undefined {
  if (task.next_fire_at === undefined) return undefined
  if (task.state !== 'active' && task.state !== 'pending') return undefined
  return {
    id: `cal_task_${task.id}`,
    source: 'scheduled_task',
    title: task.title ?? task.id,
    start: task.next_fire_at,
    all_day: false,
    ref: { type: 'scheduled_task', id: task.id },
    status: task.state,
    ...(task.assignment_id === undefined ? {} : { position_id: task.assignment_id }),
  }
}

function inRange(item: CalendarItem, range: CalendarRange): boolean {
  const from = ms(range.from)
  const to = ms(range.to)
  const start = ms(item.start)
  const end = item.end === undefined ? start : ms(item.end)
  return overlaps(start, end, from, to)
}

/** 日历排序：按开始时间；同一时刻先占时段的，再全天的；再按 id 定序。 */
export function sortCalendar(items: readonly CalendarItem[]): CalendarItem[] {
  return [...items].sort(
    (a, b) =>
      ms(a.start) - ms(b.start) ||
      Number(a.all_day) - Number(b.all_day) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

export function buildCalendar(input: CalendarInput): CalendarItem[] {
  const out: CalendarItem[] = []
  for (const m of input.meetings ?? []) out.push(m)
  for (const t of input.todos) {
    if (!isOpen(t)) continue
    const item = todoCalendarItem(t)
    if (item !== undefined) out.push(item)
  }
  for (const task of input.tasks ?? []) {
    const item = taskCalendarItem(task)
    if (item !== undefined) out.push(item)
  }
  if (input.range.include_card_due !== false) {
    for (const c of input.cards ?? []) {
      const item = cardCalendarItem(c)
      if (item !== undefined) out.push(item)
    }
  }
  // 时长为 0 的待办排期（拖进日历只落了一个点）给个默认时长，否则周视图里画不出来
  const normalized = out.map((i) =>
    i.source === 'todo' && !i.all_day && i.end !== undefined && ms(i.end) <= ms(i.start)
      ? { ...i, end: new Date(ms(i.start) + DEFAULT_TODO_MINUTES * 60_000).toISOString() }
      : i,
  )
  return sortCalendar(normalized.filter((i) => inRange(i, input.range)))
}
