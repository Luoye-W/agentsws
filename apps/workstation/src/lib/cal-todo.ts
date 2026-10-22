/**
 * WP469（决策 1521–1527）：「日历与待办」一页里那几样纯判断——待办在哪一档、清单分组、
 * 每行右边写什么、「记一条待办」认的说法、拖到哪儿改什么、从收件箱记过来带不带期限、首页那一行。
 *
 * 待办分三档（决策 1522），每档在日历上只有一个位置：
 * - ① 没日子（`due` 和 `scheduled` 都没有）→ 左边「还没排期的」，分「本周要做」（horizon=week/today）/「以后」；
 * - ② 有日子没钟点（只有 `due`）→ 那天的「全天」一格；
 * - ③ 有钟点（`scheduled`）→ 时间格里一块。
 *
 * 拖动就是换档：拖到某个钟点 = 给 `scheduled`；拖到「全天」/ 月格某天 = 给 `due`（清掉钟点）；
 * 拖回左边 = 两样都清掉（`horizon` 按落在哪一组）。日子统一记成那天本地中午——跨几个时区也还是那一天。
 */
import type { Todo, TodoHorizon } from '@agentsws/contracts'
import { CAL_TODO_FACE_KEY, CALENDAR_DONE_KEY, readString, writeString } from '@/lib/ui-state'

export type TodoLevel = 'undated' | 'dated' | 'timed'

export function levelOf(todo: Pick<Todo, 'due' | 'scheduled'>): TodoLevel {
  if (todo.scheduled !== undefined) return 'timed'
  if (todo.due !== undefined) return 'dated'
  return 'undated'
}

/** AI 正在做的那件（交出去了、还没回来）：不能拖、不进「帮我排进空档」。 */
export function aiBusy(todo: Pick<Todo, 'delegate'>): boolean {
  const s = todo.delegate?.state
  return s === 'pending' || s === 'running'
}

/* ── 日子 ─────────────────────────────────────────────── */

const DAY_MS = 86_400_000

/** 本地日 `YYYY-MM-DD`。 */
export function dayKeyOf(at: Date): string {
  const m = `${at.getMonth() + 1}`.padStart(2, '0')
  const d = `${at.getDate()}`.padStart(2, '0')
  return `${at.getFullYear()}-${m}-${d}`
}

function parseDayKey(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

/** 那一天本地中午（只有日子的待办记成它：换个时区看也还落在同一天）。 */
export function dayNoon(day: string): string {
  const d = parseDayKey(day)
  d.setHours(12, 0, 0, 0)
  return d.toISOString()
}

/** 那一天本地 `minutes`（从零点起的分钟）。 */
export function dayAt(day: string, minutes: number): Date {
  const d = parseDayKey(day)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d
}

/** 两个本地日差几天（b − a，按日历日算）。 */
export function dayDiff(a: Date, b: Date): number {
  const x = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const y = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((y - x) / DAY_MS)
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 「今天」「明天」「周五」「11 月 3 日」——一周以内写星期，再远写日子。 */
export function dayWord(at: Date, now: Date, lang: string): string {
  const diff = dayDiff(now, at)
  const en = lang === 'en'
  if (diff === 0) return en ? 'Today' : '今天'
  if (diff === 1) return en ? 'Tomorrow' : '明天'
  if (diff === -1) return en ? 'Yesterday' : '昨天'
  if (diff > 1 && diff < 7) return (en ? WEEKDAY_EN : WEEKDAY_ZH)[at.getDay()] as string
  return en
    ? at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : `${at.getMonth() + 1} 月 ${at.getDate()} 日`
}

/** 「9:00」——钟点不补零，和日历时间轴同一种写法。 */
export function clock(at: Date): string {
  return `${at.getHours()}:${`${at.getMinutes()}`.padStart(2, '0')}`
}

/** 页头那句「10 月 22 日 周四」/「Thu, Oct 22」。 */
export function todayTitle(now: Date, lang: string): string {
  return lang === 'en'
    ? now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : `${now.getMonth() + 1} 月 ${now.getDate()} 日 ${WEEKDAY_ZH[now.getDay()]}`
}

/* ── 清单 ─────────────────────────────────────────────── */

export type ListGroupName = 'today' | 'week' | 'later'

export interface ListGroups {
  today: Todo[]
  week: Todo[]
  later: Todo[]
  /** 做完的（今天做完的那几条留在「今天」里到当天结束，不在这里） */
  done: Todo[]
}

function sortKey(t: Todo): number {
  const at = t.scheduled?.start ?? t.due
  return at === undefined ? Number.POSITIVE_INFINITY : Date.parse(at)
}

/**
 * 清单分组：今天 / 本周 / 以后（照 `horizon`）+ 做完的。
 * 「今天」那组做完的那几行留到当天结束（划掉、排在最后），再收进「做完的」。
 * 收件箱记过来的排在本周最上面（刚记的那一行要一眼看见）；
 * WP474（决策 1531）：上周没做完挪过来的（`carried_over`）排在它们之前——周一一打开先看到。
 */
export function groupForList(open: readonly Todo[], done: readonly Todo[], now: Date): ListGroups {
  const out: ListGroups = { today: [], week: [], later: [], done: [] }
  for (const t of open) {
    if (t.horizon === 'today') out.today.push(t)
    else if (t.horizon === 'week') out.week.push(t)
    else out.later.push(t)
  }
  const byTime = (a: Todo, b: Todo): number => sortKey(a) - sortKey(b)
  out.today.sort(byTime)
  out.week.sort((a, b) => {
    const ca = a.carried_over === true ? 0 : 1
    const cb = b.carried_over === true ? 0 : 1
    if (ca !== cb) return ca - cb
    const ia = a.origin?.inbox_item === undefined ? 1 : 0
    const ib = b.origin?.inbox_item === undefined ? 1 : 0
    if (ia !== ib) return ia - ib
    if (ia === 0) return Date.parse(b.created_at) - Date.parse(a.created_at)
    return byTime(a, b)
  })
  out.later.sort(byTime)
  const sortedDone = [...done].sort(
    (a, b) => Date.parse(b.closed_at ?? b.updated_at) - Date.parse(a.closed_at ?? a.updated_at),
  )
  for (const t of sortedDone) {
    const closed = new Date(t.closed_at ?? t.updated_at)
    if (dayDiff(closed, now) === 0) out.today.push(t)
    else out.done.push(t)
  }
  return out
}

/** 每行右边那一格写什么：钟点（时钟图标）/ 日子（日历图标）/「没排日子」。 */
export interface WhenLabel {
  kind: 'clock' | 'day' | 'none'
  text: string
  /** 从收件箱带过来的期限（「周五前」，用要留意的颜色） */
  deadline?: boolean
}

export function whenLabel(todo: Todo, now: Date, lang: string): WhenLabel {
  const en = lang === 'en'
  if (todo.scheduled !== undefined) {
    const at = new Date(todo.scheduled.start)
    const word = dayDiff(now, at) === 0 ? '' : `${dayWord(at, now, lang)} `
    return { kind: 'clock', text: `${word}${clock(at)}` }
  }
  if (todo.due !== undefined) {
    const word = dayWord(new Date(todo.due), now, lang)
    if (todo.origin?.inbox_item !== undefined)
      return { kind: 'day', text: en ? `By ${word}` : `${word}前`, deadline: true }
    return { kind: 'day', text: word }
  }
  return { kind: 'none', text: en ? 'No date' : '没排日子' }
}

/** 页头那句「今天 3 件 · 本周 5 件」要的两个数（只数没做完的）。 */
export function listCounts(open: readonly Todo[]): { today: number; week: number } {
  return {
    today: open.filter((t) => t.horizon === 'today').length,
    week: open.filter((t) => t.horizon === 'week').length,
  }
}

/** 还没排期的（第一档）：分「本周要做」/「以后」。 */
export function unscheduled(open: readonly Todo[]): { week: Todo[]; later: Todo[] } {
  const none = open.filter((t) => levelOf(t) === 'undated')
  // WP474：上周没做完的排在「本周要做」最上面（其余照原来的先后）
  const carriedFirst = (a: Todo, b: Todo): number =>
    (a.carried_over === true ? 0 : 1) - (b.carried_over === true ? 0 : 1)
  return {
    week: none.filter((t) => t.horizon !== 'backlog').sort(carriedFirst),
    later: none.filter((t) => t.horizon === 'backlog'),
  }
}

/* ── 「记一条待办」认的说法 ─────────────────────────────── */

export interface QuickTodo {
  title: string
  due?: string
  scheduled?: { start: string; end: string }
  /** 什么日子都没写就进「本周」、没日子 */
  horizon?: TodoHorizon
}

const ZH_DAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const EN_DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const PART_MIN: Record<string, number> = {
  上午: 10 * 60,
  中午: 12 * 60,
  下午: 14 * 60,
  晚上: 19 * 60,
}

/** 「周五」「下周一」：本周还没过的那天；过了就是下周那天。今天就是今天。 */
function weekdayFrom(now: Date, target: number, nextWeek: boolean): Date {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (nextWeek) {
    const monday = new Date(base)
    monday.setDate(base.getDate() - ((base.getDay() + 6) % 7) + 7)
    const offset = (target + 6) % 7
    monday.setDate(monday.getDate() + offset)
    return monday
  }
  const diff = (target - base.getDay() + 7) % 7
  base.setDate(base.getDate() + diff)
  return base
}

/** 一小时（拖到某个钟点、写了钟点的都默认占这么长）。 */
export const DEFAULT_BLOCK_MIN = 60

/**
 * 「周五下午拍样品」→ 标题「拍样品」+ 周五 14:00–15:00；「周五 给 Maya 回报价」→ 周五（只有日子）；
 * 什么都没写 → 本周、没日子。认不出的原样当标题。
 */
export function parseQuickTodo(raw: string, now: Date): QuickTodo {
  let text = raw.trim()
  let day: Date | undefined
  let minutes: number | undefined

  const zhDay = text.match(/(今天|明天|后天|(下)?(?:周|星期)([一二三四五六日天]))/u)
  if (zhDay !== null) {
    const word = zhDay[1] as string
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (word === '今天') day = base
    else if (word === '明天') day = new Date(base.getTime() + DAY_MS)
    else if (word === '后天') day = new Date(base.getTime() + 2 * DAY_MS)
    else day = weekdayFrom(now, ZH_DAY[zhDay[3] as string] ?? 0, zhDay[2] !== undefined)
    text = text.replace(zhDay[0], ' ')
  } else {
    const enDay = text.match(/\b(today|tomorrow|(next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*)\b/iu)
    if (enDay !== null) {
      const word = (enDay[1] as string).toLowerCase()
      const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      if (word === 'today') day = base
      else if (word === 'tomorrow') day = new Date(base.getTime() + DAY_MS)
      else
        day = weekdayFrom(
          now,
          EN_DAY[(enDay[3] as string).toLowerCase()] ?? 0,
          enDay[2] !== undefined,
        )
      text = text.replace(enDay[0], ' ')
    }
  }

  const hm = text.match(/(上午|中午|下午|晚上)?\s*(\d{1,2})[:：](\d{2})/u)
  const dian = text.match(/(上午|中午|下午|晚上)?\s*(\d{1,2})\s*点(半)?/u)
  const ampm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/iu)
  const part = text.match(/(上午|中午|下午|晚上)/u)
  const pm = (p: string | undefined, h: number): number =>
    (p === '下午' || p === '晚上') && h < 12 ? h + 12 : h
  if (hm !== null) {
    minutes = pm(hm[1], Number(hm[2])) * 60 + Number(hm[3])
    text = text.replace(hm[0], ' ')
  } else if (dian !== null) {
    minutes = pm(dian[1], Number(dian[2])) * 60 + (dian[3] === undefined ? 0 : 30)
    text = text.replace(dian[0], ' ')
  } else if (ampm !== null) {
    let h = Number(ampm[1]) % 12
    if ((ampm[3] as string).toLowerCase() === 'pm') h += 12
    minutes = h * 60 + (ampm[2] === undefined ? 0 : Number(ampm[2]))
    text = text.replace(ampm[0], ' ')
  } else if (part !== null) {
    minutes = PART_MIN[part[1] as string]
    text = text.replace(part[0], ' ')
  }
  if (minutes !== undefined && (minutes < 0 || minutes >= 24 * 60)) minutes = undefined

  const title = text.replace(/\s+/gu, ' ').trim()
  const finalTitle = title === '' ? raw.trim() : title
  if (day === undefined && minutes === undefined) return { title: finalTitle, horizon: 'week' }
  const on = day ?? new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const key = dayKeyOf(on)
  if (minutes === undefined) return { title: finalTitle, due: dayNoon(key) }
  const start = dayAt(key, minutes)
  return {
    title: finalTitle,
    scheduled: {
      start: start.toISOString(),
      end: new Date(start.getTime() + DEFAULT_BLOCK_MIN * 60_000).toISOString(),
    },
  }
}

/* ── 拖到哪儿改什么 ─────────────────────────────────────── */

export type DropTarget =
  /** 时间格里某天某个钟点（从零点起的分钟） */
  | { kind: 'time'; day: string; minutes: number }
  /** 「全天」那一格 / 月格某天；`keepClock` = 月视图里拖的是有钟点的，换天不换钟点 */
  | { kind: 'day'; day: string; keepClock?: boolean }
  /** 拖回「还没排期的」（落在哪一组） */
  | { kind: 'rail'; horizon: 'week' | 'backlog' }

export interface TodoPatch {
  due?: string | null
  scheduled?: { start: string; end: string } | null
  horizon?: TodoHorizon
}

/** 拖完要改什么；`undefined` = 落回原处，什么都不用改。 */
export function dropPatch(todo: Todo, target: DropTarget): TodoPatch | undefined {
  const lenMs =
    todo.scheduled === undefined
      ? DEFAULT_BLOCK_MIN * 60_000
      : Math.max(15 * 60_000, Date.parse(todo.scheduled.end) - Date.parse(todo.scheduled.start))
  if (target.kind === 'rail') {
    if (levelOf(todo) === 'undated') {
      const now = todo.horizon === 'backlog' ? 'backlog' : 'week'
      return now === target.horizon ? undefined : { horizon: target.horizon }
    }
    return { due: null, scheduled: null, horizon: target.horizon }
  }
  if (target.kind === 'time') {
    const start = dayAt(target.day, target.minutes)
    const slot = {
      start: start.toISOString(),
      end: new Date(start.getTime() + lenMs).toISOString(),
    }
    if (todo.scheduled?.start === slot.start) return undefined
    return { scheduled: slot }
  }
  if (target.keepClock === true && todo.scheduled !== undefined) {
    const old = new Date(todo.scheduled.start)
    const start = dayAt(target.day, old.getHours() * 60 + old.getMinutes())
    if (start.getTime() === old.getTime()) return undefined
    return {
      scheduled: {
        start: start.toISOString(),
        end: new Date(start.getTime() + lenMs).toISOString(),
      },
    }
  }
  const due = dayNoon(target.day)
  if (
    todo.scheduled === undefined &&
    todo.due !== undefined &&
    dayKeyOf(new Date(todo.due)) === target.day
  )
    return undefined
  return { due, scheduled: null }
}

/** 拖到一半那句话：「松手：排到周四 14:00」/「松手：排到周四（全天）」/「松手：不排了」。 */
export function dropWord(target: DropTarget, now: Date, lang: string): string {
  const en = lang === 'en'
  if (target.kind === 'rail') return en ? 'Release: unschedule' : '松手：不排了'
  const day = parseDayKey(target.day)
  const word = dayWord(day, now, lang)
  if (target.kind === 'time') {
    const at = dayAt(target.day, target.minutes)
    return en ? `Release: ${word} ${clock(at)}` : `松手：排到${word} ${clock(at)}`
  }
  return en ? `Release: ${word}, no time` : `松手：排到${word}（只定日子）`
}

/* ── 记住上次那一面（决策 1523）、画不画做完的（决策 1524） ── */

export type CalTodoFace = 'list' | 'calendar'

export function parseFace(raw: string | null | undefined): CalTodoFace | undefined {
  return raw === 'list' || raw === 'calendar' ? raw : undefined
}

/** 上次那一面；第一次（本机没记）是清单。 */
export function loadFace(): CalTodoFace {
  return parseFace(readString(CAL_TODO_FACE_KEY)) ?? 'list'
}

export function saveFace(face: CalTodoFace): void {
  writeString(CAL_TODO_FACE_KEY, face)
}

export function loadShowDone(): boolean {
  return readString(CALENDAR_DONE_KEY) !== 'off'
}

export function saveShowDone(on: boolean): void {
  writeString(CALENDAR_DONE_KEY, on ? 'on' : 'off')
}

/* ── 收件箱「记成待办」 ───────────────────────────────── */

/**
 * 那一行有没有期限：卡的到期（7 天以内）、信里写的「3 天内 / 3 个工作日内 / within 3 days」。
 * 有就带上那一天（清单上读作「周五前」）；没有就进「本周」、没日子。
 */
export function inboxDeadline(
  input: { expires_at?: string | undefined; text?: string | undefined },
  now: Date,
): string | undefined {
  if (input.expires_at !== undefined) {
    const at = new Date(input.expires_at)
    const diff = dayDiff(now, at)
    if (Number.isFinite(at.getTime()) && diff >= 0 && diff < 7) return dayNoon(dayKeyOf(at))
  }
  const m = input.text?.match(/(\d{1,2})\s*(?:个工作日|天|日)内|within\s+(\d{1,2})\s+days?/iu)
  if (m !== null && m !== undefined) {
    const n = Number(m[1] ?? m[2])
    if (n >= 0 && n < 31) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n)
      return dayNoon(dayKeyOf(at))
    }
  }
  return undefined
}

/* ── 首页那一行 ─────────────────────────────────────── */

export interface HomeTodoLine {
  /** 今天还没做完的 */
  today: number
  /** 下一件有钟点的（今天、还没开始） */
  next?: { title: string; at: string }
  /** 还没排期的（第一档） */
  unscheduled: number
}

export function homeTodoLine(open: readonly Todo[], now: Date): HomeTodoLine {
  const next = open
    .filter(
      (t) =>
        t.scheduled !== undefined &&
        Date.parse(t.scheduled.start) >= now.getTime() &&
        dayDiff(now, new Date(t.scheduled.start)) === 0,
    )
    .sort((a, b) => sortKey(a) - sortKey(b))[0]
  return {
    today: open.filter((t) => t.horizon === 'today').length,
    ...(next?.scheduled === undefined
      ? {}
      : { next: { title: next.title, at: next.scheduled.start } }),
    unscheduled: open.filter((t) => levelOf(t) === 'undated').length,
  }
}

/* ── 帮我排进空档：「换一个」 ─────────────────────────── */

export interface Ghost {
  todo_id: string
  title: string
  minutes: number
  options: { start: string; end: string }[]
  /** 现在画的是第几个候选 */
  at: number
}

function overlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)
}

/** 「换一个」：这一件的下一个候选（不撞别的虚线块）；没有了就留在原处。 */
export function nextOption(ghost: Ghost, others: readonly Ghost[]): number {
  const shown = others
    .filter((g) => g.todo_id !== ghost.todo_id)
    .map((g) => g.options[g.at])
    .filter((x): x is { start: string; end: string } => x !== undefined)
  for (let step = 1; step < ghost.options.length; step += 1) {
    const i = (ghost.at + step) % ghost.options.length
    const opt = ghost.options[i]
    if (opt !== undefined && !shown.some((s) => overlap(s, opt))) return i
  }
  return ghost.at
}
