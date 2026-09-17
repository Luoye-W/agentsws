/**
 * 日历（37 §2 表 + C3、§2.5）：**既是视图也是排期面**，本身不是对象。
 *
 * **一个日历，多图层**（WP74）。七类来源合并成一份 `CalendarItem[]`：
 * 1. 会议（WP23 提供，本包只收 `CalendarItem`）
 * 2. 有排期的待办（`Todo.scheduled`）——只有 `due` 的挂在那天的「到期」栏，不占时段
 * 3. 定时任务（25 `ScheduledTask.next_fire_at`）
 * 4. 卡片到期（`ApprovalItem.expires_at` / `due_at`）——叠层，可关
 * 5. 社媒排期（56 §2 `SocialPost.scheduled_at`）
 * 6. 红人交付物到期（`Deliverable.due_at`）
 * 7. 在线值守的续期日（`StandbyWorkspace.period_end`）
 *
 * 两条纪律：
 * - **排期 = 写各自那张表**（待办写 `Todo.scheduled`、社媒写 `SocialPost.scheduled_at`），
 *   所以这里只读不写；每一条带上 `drag` 说明**它能不能拖、拖了走哪条路**，界面照着做，
 *   不自己判断（否则同一条规则会在服务端与界面上各写一遍，迟早对不上）。
 * - **图层过滤在最后一步**（`CalendarRange.sources`）：不传 = 全部，老调用方行为一个字不变。
 */
import type {
  ApprovalItem,
  CalendarItem,
  CalendarRange,
  Deliverable,
  Iso8601,
  ScheduledTask,
  SocialPost,
  StandbyWorkspace,
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

/** 一条社媒排期（56 §2）；只用到这几项，所以放宽成结构类型。 */
export type SocialPostLike = Pick<SocialPost, 'id' | 'account_id' | 'channel' | 'status'> & {
  scheduled_at?: Iso8601
  body?: string
  /** 服务端算好的撞车说明（`social-core` 的 `scheduleConflicts`）；界面原样显示 */
  conflicts?: readonly string[]
}

/** 一件红人交付物（48）；只用到这几项。 */
export type DeliverableLike = Pick<Deliverable, 'id' | 'collaboration_id' | 'kind' | 'due_at'> & {
  submitted_at?: Iso8601
  /** 卡面上那句人话（「@anna 的开箱视频」）；不给就用 `kind` */
  title?: string
}

/** 在线值守的续期日（49 §6）；`period_end` 就是"这一期付到什么时候"。 */
export type StandbyRenewalLike = Pick<StandbyWorkspace, 'workspace_id' | 'status'> & {
  period_end: Iso8601
  seats?: number
}

export interface CalendarInput {
  range: CalendarRange
  todos: readonly Todo[]
  /** WP23 的会议；本包不认识 Meeting 对象，只收已经投影好的日历项 */
  meetings?: readonly CalendarItem[]
  tasks?: readonly ScheduledTaskLike[]
  /** 待我定的卡片；`expires_at` 或 `due_at` 落在窗口里的进「卡片到期」叠层 */
  cards?: readonly ApprovalItem[]
  /** WP74：社媒排期图层 */
  social_posts?: readonly SocialPostLike[]
  /** WP74：红人交付物到期图层 */
  deliverables?: readonly DeliverableLike[]
  /** WP74：值守续期图层（一个工作区最多一条） */
  standby?: readonly StandbyRenewalLike[]
}

const DEFAULT_TODO_MINUTES = 60

/**
 * 社媒排期画多长。它本质是一个**时刻**（到点就发），但周视图里一个零宽的点看不见，
 * 所以给半小时的块——与待办那 60 分钟同样是**只为画得出来**，不写回任何一张表。
 */
const SOCIAL_POST_MINUTES = 30

/** 有排期的待办 → 占时段；只有 due 的 → 挂在那天。 */
export function todoCalendarItem(todo: Todo): CalendarItem | undefined {
  const common = {
    id: `cal_todo_${todo.id}`,
    source: 'todo' as const,
    title: todo.title,
    ref: { type: 'todo', id: todo.id },
    status: todo.status,
    // 拖待办 = 写 `Todo.scheduled`，这是日历上唯一"拖了就改好了"的一类
    drag: 'reschedule' as const,
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
    // 卡片的期限是 14 定的，不是人在日历上挪的
    drag: 'readonly',
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
    // 定时任务的下一次在 25 的 trigger 上，改 trigger 才算改；在日历上挪一下什么也没改
    drag: 'readonly',
    ...(task.assignment_id === undefined ? {} : { position_id: task.assignment_id }),
  }
}

/** 社媒排期 → 图层 `social_post`。没排期的（草稿）不上日历：它还没有时间。 */
export function socialPostCalendarItem(post: SocialPostLike): CalendarItem | undefined {
  if (post.scheduled_at === undefined) return undefined
  const start = ms(post.scheduled_at)
  if (!Number.isFinite(start)) return undefined
  const preview = (post.body ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
  return {
    id: `cal_social_${post.id}`,
    source: 'social_post',
    title: preview === '' ? post.id : preview,
    start: post.scheduled_at,
    end: new Date(start + SOCIAL_POST_MINUTES * 60_000).toISOString(),
    all_day: false,
    ref: { type: 'social_post', id: post.id },
    status: post.status,
    channel: post.channel,
    // 已经发出去的不能再"改排期"——那是历史，不是计划
    drag: post.status === 'published' ? 'readonly' : 'reschedule',
    ...(post.conflicts === undefined || post.conflicts.length === 0
      ? {}
      : { notes: [...post.conflicts] }),
  }
}

/** 红人交付物 → 图层 `kol_deliverable`。已经交了的不再占日历（那一天的压力已经过去）。 */
export function deliverableCalendarItem(row: DeliverableLike): CalendarItem | undefined {
  if (row.submitted_at !== undefined) return undefined
  if (row.due_at === '' || !Number.isFinite(ms(row.due_at))) return undefined
  return {
    id: `cal_deliverable_${row.id}`,
    source: 'kol_deliverable',
    title: row.title ?? row.kind,
    start: row.due_at,
    all_day: true,
    ref: { type: 'deliverable', id: row.id },
    status: row.kind,
    // 到期日是与红人谈定的，改它要走合作那一侧；在日历上挪一下只会让两边对不上
    drag: 'readonly',
  }
}

/** 值守续期日 → 图层 `standby`。一个工作区最多一条。 */
export function standbyCalendarItem(row: StandbyRenewalLike): CalendarItem | undefined {
  if (!Number.isFinite(ms(row.period_end))) return undefined
  return {
    id: `cal_standby_${row.workspace_id}`,
    source: 'standby',
    title: row.workspace_id,
    start: row.period_end,
    all_day: true,
    ref: { type: 'standby', id: row.workspace_id },
    status: row.status,
    // 续期是账上的事（49 §6），不是日历上的事
    drag: 'readonly',
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
  // 会议：拖了**不直接改**，出一张"改时间"卡走秘书那条约时间（41 §1.2）——
  // 一个人在自己日历上把别人的会挪走，对方那一侧什么也不会发生
  for (const m of input.meetings ?? [])
    out.push(m.drag === undefined ? { ...m, drag: 'propose' } : m)
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
  for (const p of input.social_posts ?? []) {
    const item = socialPostCalendarItem(p)
    if (item !== undefined) out.push(item)
  }
  for (const d of input.deliverables ?? []) {
    const item = deliverableCalendarItem(d)
    if (item !== undefined) out.push(item)
  }
  for (const w of input.standby ?? []) {
    const item = standbyCalendarItem(w)
    if (item !== undefined) out.push(item)
  }
  // 时长为 0 的待办排期（拖进日历只落了一个点）给个默认时长，否则周视图里画不出来
  const normalized = out.map((i) =>
    i.source === 'todo' && !i.all_day && i.end !== undefined && ms(i.end) <= ms(i.start)
      ? { ...i, end: new Date(ms(i.start) + DEFAULT_TODO_MINUTES * 60_000).toISOString() }
      : i,
  )
  // 图层过滤是**最后一步**：不传 `sources` = 全部（老调用方行为一个字不变）
  const wanted = input.range.sources
  const layered =
    wanted === undefined ? normalized : normalized.filter((i) => wanted.includes(i.source))
  return sortCalendar(layered.filter((i) => inRange(i, input.range)))
}
