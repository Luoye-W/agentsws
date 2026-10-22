/**
 * WP469（决策 1522）：「帮我排进空档」——选几件没日子的待办，在这一段的空档里各提一个位置。
 *
 * 全是纯函数，三条口径（WP469 示意稿「我自己定的」）：
 * - 只排在工作时间 9:00–18:00，不排周末；
 * - 避开日历上已经占了时段的事（会议、排了钟点的待办），**直播**前后再各空半小时；
 * - 「换一个」= 这一件的下一个空档（候选在这里一次算好几个，互不重叠）。
 *
 * **这里什么都不写**：算出来的只是候选，人点「采用」才走改待办那条路写 `Todo.scheduled`。
 * 时长先按标题里的动词估（写 / 拍 / 研究约 2 小时，整理 / 核对约 1.5 小时，其余约 1 小时）。
 */
import type {
  CalendarItem,
  Iso8601,
  Todo,
  TodoSlotProposal,
  TodoSlotResult,
} from '@agentsws/contracts'
import { DAY_MS, MINUTE_MS, ms, startOfDay } from './util.js'

/** 工作时间（本地分钟）。 */
export const WORK_START_MIN = 9 * 60
export const WORK_END_MIN = 18 * 60
/** 直播前后各空多久。 */
export const LIVE_BUFFER_MIN = 30
/** 候选的起点按半小时对齐。 */
export const SLOT_STEP_MIN = 30
/** 每件最多给几个候选（头一个 + 换几次）。 */
export const SLOT_OPTIONS_MAX = 4

const LIVE_RE = /直播|live\s*stream|livestream|\blive\b/iu

/**
 * 估一件事要多久（分钟）。只看标题里的动词——估不准也没关系：这是候选，人看了不对就「换一个」或不采用。
 */
export function estimateTodoMinutes(title: string): number {
  const t = title.toLowerCase()
  if (
    /写|文案|拍|研究|调研|翻译|设计|策划|剪|报告|write|draft|research|translate|design|shoot/u.test(
      t,
    )
  )
    return 120
  if (/整理|清单|核对|对账|盘点|复盘|review|reconcile|list/u.test(t)) return 90
  return 60
}

interface Span {
  start: number
  end: number
}

/** 日历上哪些时段已经占了：会议、排了钟点的待办（只算没做完的）；直播前后各加半小时。 */
export function busySpans(items: readonly CalendarItem[]): Span[] {
  const out: Span[] = []
  for (const i of items) {
    if (i.all_day || i.end === undefined) continue
    if (i.source !== 'meeting' && i.source !== 'todo') continue
    if (i.source === 'todo' && i.status === 'done') continue
    const start = ms(i.start)
    const end = ms(i.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const pad = LIVE_RE.test(i.title) ? LIVE_BUFFER_MIN * MINUTE_MS : 0
    out.push({ start: start - pad, end: end + pad })
  }
  return out
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * 这一段里所有可能的起点（半小时对齐、在工作时间里、不是周末、不早于现在），按时间排。
 */
export function slotStarts(input: {
  from: Iso8601
  to: Iso8601
  now: Iso8601
  tz_offset_minutes: number
}): number[] {
  const from = Math.max(ms(input.from), ms(input.now))
  const to = ms(input.to)
  const out: number[] = []
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out
  const step = SLOT_STEP_MIN * MINUTE_MS
  for (let day = startOfDay(from, input.tz_offset_minutes); day < to; day += DAY_MS) {
    const weekday = new Date(day + input.tz_offset_minutes * MINUTE_MS).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (let m = WORK_START_MIN; m < WORK_END_MIN; m += SLOT_STEP_MIN) {
      const at = day + m * MINUTE_MS
      if (at < from || at >= to) continue
      // 「现在」之后的第一个整半点起
      if (at < Math.ceil(from / step) * step) continue
      out.push(at)
    }
  }
  return out
}

/**
 * 给这几件各找空档。按给的顺序一件一件排：头一个候选彼此不撞；「换一个」的那几个也不撞别人的头一个。
 * 只排没做完、没日子、不在 AI 手上的；别的原样跳过（不在结果里）。
 */
export function proposeSlots(input: {
  todos: readonly Todo[]
  items: readonly CalendarItem[]
  from: Iso8601
  to: Iso8601
  now: Iso8601
  tz_offset_minutes: number
}): TodoSlotResult {
  const busy = busySpans(input.items)
  const starts = slotStarts(input)
  const tz = input.tz_offset_minutes
  const fits = (span: Span): boolean => {
    // 不跨过下班：起点那天的 18:00 之前结束
    const day = startOfDay(span.start, tz)
    if (span.end > day + WORK_END_MIN * MINUTE_MS) return false
    return !busy.some((b) => overlaps(b, span))
  }
  const wanted = input.todos.filter(
    (t) =>
      (t.status === 'open' || t.status === 'blocked') &&
      t.due === undefined &&
      t.scheduled === undefined &&
      !(
        t.delegate !== undefined &&
        (t.delegate.state === 'pending' || t.delegate.state === 'running')
      ),
  )
  const firsts = new Map<string, Span>()
  const proposals: TodoSlotProposal[] = []
  const unplaced: string[] = []
  // 先给每件定头一个（彼此不撞）
  for (const todo of wanted) {
    const minutes = estimateTodoMinutes(todo.title)
    const taken = [...firsts.values()]
    for (const s of starts) {
      const span = { start: s, end: s + minutes * MINUTE_MS }
      if (fits(span) && !taken.some((x) => overlaps(x, span))) {
        firsts.set(todo.id, span)
        break
      }
    }
  }
  // 再给每件补「换一个」那几个：不撞别人的头一个，自己的几个也不互相撞
  for (const todo of wanted) {
    const first = firsts.get(todo.id)
    if (first === undefined) {
      unplaced.push(todo.id)
      continue
    }
    const minutes = estimateTodoMinutes(todo.title)
    const others = [...firsts.entries()].filter(([id]) => id !== todo.id).map(([, x]) => x)
    const options: Span[] = [first]
    for (const s of starts) {
      if (options.length >= SLOT_OPTIONS_MAX) break
      if (s <= first.start) continue
      const span = { start: s, end: s + minutes * MINUTE_MS }
      if (!fits(span)) continue
      if (others.some((x) => overlaps(x, span))) continue
      if (options.some((x) => overlaps(x, span))) continue
      options.push(span)
    }
    proposals.push({
      todo_id: todo.id,
      title: todo.title,
      minutes,
      options: options.map((x) => ({
        start: new Date(x.start).toISOString(),
        end: new Date(x.end).toISOString(),
      })),
    })
  }
  return { proposals, unplaced }
}
