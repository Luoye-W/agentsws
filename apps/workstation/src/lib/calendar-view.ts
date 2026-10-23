/**
 * WP456-T5（WP456 §3.6）：日历页「这一屏」的几样纯判断——页头写什么、数哪几条、一条事件里画什么。
 *
 * 和 `calendar-layers.ts` / `calendar-allday.ts` 同一条理由：这些是可以单测的判断，不是渲染。
 */
import type { CalendarItem } from '@agentsws/contracts'
import type { CalendarView } from '@/lib/calendar-layers'

/** 本地零点那一天往后挪 n 天（按日历日挪，不按 24 小时——夏令时那天也对）。 */
function shiftDays(at: Date, n: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + n)
}

/**
 * 这一屏**画出来**的是哪一段（本地时间，左闭右开）。
 *
 * 和 `windowFor`（向服务端要哪一段）不是一回事：那一段前后各放宽了一周，翻页不必立刻再请求；
 * 页头的「本周 N 项」和图层旁边的数字只数这一屏，否则「本周」数的是三周。
 */
export function visibleRange(view: CalendarView, anchor: Date): { from: Date; to: Date } {
  const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  if (view === 'day') return { from: day, to: shiftDays(day, 1) }
  if (view === 'week') {
    const monday = shiftDays(day, -((day.getDay() + 6) % 7))
    return { from: monday, to: shiftDays(monday, 7) }
  }
  return {
    from: new Date(anchor.getFullYear(), anchor.getMonth(), 1),
    to: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1),
  }
}

/** 落在这一段里的（按开始时刻；跨进来的长事项也算——它在这一屏上画着）。 */
export function withinRange(
  items: readonly CalendarItem[],
  range: { from: Date; to: Date },
): CalendarItem[] {
  const from = range.from.getTime()
  const to = range.to.getTime()
  return items.filter((i) => {
    const start = Date.parse(i.start)
    const end = i.end === undefined ? start : Date.parse(i.end)
    return start < to && Math.max(start, end) >= from
  })
}

/** 页头那句「本周 N 项」随视图换说法（日 = 这一天，月 / 议程 = 这个月）。 */
export function countKey(view: CalendarView): string {
  if (view === 'day') return 'calendar.count.day'
  if (view === 'week') return 'calendar.count'
  return 'calendar.count.month'
}

/** 页头大标题：「2026 年 10 月」/「October 2026」。 */
export function monthTitle(anchor: Date, lang: string): string {
  return lang === 'en'
    ? anchor.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
    : `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`
}

/**
 * 时间格里一条事项**至少按 1 小时高画**。
 *
 * 只有一个时刻的（社媒排期的发布时刻、没写结束的待办）原来按 0 分钟画，半小时的按半小时画——
 * 库给它 4% 高（约 26px），标题和钟点挤成一行、截到只剩三四个字（WP461 改后那张图）。
 * 只是画得高一点：拖完回写时仍按原来的长度（{@link writeBackEnd}），不会给它凭空改长。
 */
export const MIN_BLOCK_MIN = 60

const MIN_BLOCK_MS = MIN_BLOCK_MIN * 60_000

export function displayEnd(item: CalendarItem): { end: string; padded: boolean } {
  const start = Date.parse(item.start)
  const end = item.end === undefined ? start : Date.parse(item.end)
  if (item.all_day || end - start >= MIN_BLOCK_MS)
    return { end: item.end ?? item.start, padded: false }
  return { end: new Date(start + MIN_BLOCK_MS).toISOString(), padded: true }
}

/**
 * 拖完 / 拉完之后回写的结束时刻。画的时候补过长度、而这一下只是挪（长度还是补过的那一小时）——
 * 回写原来的长度；人真把它拉长拉短了，就听人的。
 */
export function writeBackEnd(item: CalendarItem, start: string, end: string): string {
  if (!displayEnd(item).padded) return end
  const moved = Date.parse(end) - Date.parse(start)
  if (moved !== MIN_BLOCK_MS) return end
  const original =
    (item.end === undefined ? Date.parse(item.start) : Date.parse(item.end)) -
    Date.parse(item.start)
  return new Date(Date.parse(start) + Math.max(0, original)).toISOString()
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 「9:00」「14:00–15:30」——钟点不补零，和时间轴同一种写法。 */
export function clockRange(start: Date, end: Date | undefined): string {
  const fmt = (d: Date) => `${d.getHours()}:${`${d.getMinutes()}`.padStart(2, '0')}`
  return end === undefined || end.getTime() <= start.getTime()
    ? fmt(start)
    : `${fmt(start)}–${fmt(end)}`
}

/**
 * 一条事件在格子里画什么（Schedule-X 的 `_customContent`，HTML 字符串——库就收这个）。
 *
 * 照示意稿：左边一条图层色的细条（颜色只在这条上，底色是同色的淡版）、标题、
 * 时间格里第二行灰字「9:00 · 社媒排期」。字一律转义——标题是别人写的。
 */
export function eventContent(
  item: CalendarItem,
  opts: {
    color: string
    layerName: string
    /**
     * WP469（决策 1522 / 1524）：待办那几条——标题前一个勾选框（打勾就是做完），做完的划掉；
     * `drag` = 整块用浏览器自己的拖放（能拖到全天、时间格、拖回左边「还没排期的」）。
     */
    todo?: { checkLabel: string; drag: boolean }
  },
): { timeGrid: string; dateGrid: string; monthGrid: string; monthAgenda: string } {
  const bar = `<span class="ws-ev-bar" style="background:${opts.color}"></span>`
  const todoId =
    item.source === 'todo' && opts.todo !== undefined ? escapeHtml(item.ref.id) : undefined
  // 只有待办「做完」才划掉（会议、社媒那几层的 status 是它们自己的状态）
  const done = item.source === 'todo' && item.status === 'done'
  const check =
    opts.todo === undefined || todoId === undefined
      ? ''
      : `<span class="ws-ev-check" role="checkbox" tabindex="0" aria-checked="${done ? 'true' : 'false'}" aria-label="${escapeHtml(opts.todo.checkLabel)}" data-todo-check="${todoId}" data-done="${done ? 'true' : 'false'}"></span>`
  const title = escapeHtml(item.title)
  const start = new Date(item.start)
  const end = item.end === undefined ? undefined : new Date(item.end)
  const meta = escapeHtml(`${clockRange(start, end)} · ${opts.layerName}`)
  const clock = item.all_day
    ? ''
    : `<span class="ws-ev-clock">${clockRange(start, undefined)}</span>`
  const titleCls = done ? 'ws-ev-title ws-ev-done' : 'ws-ev-title'
  const twoLines = `${bar}<div class="${titleCls}">${check}${title}</div><div class="ws-ev-meta">${meta}</div>`
  const wrap = (html: string): string =>
    opts.todo?.drag === true && todoId !== undefined && !done
      ? `<div class="ws-ev-drag" draggable="true" data-todo-drag="${todoId}">${html}</div>`
      : html
  return {
    timeGrid: wrap(twoLines),
    dateGrid: wrap(`${bar}${check}<span class="${titleCls}">${title}</span>`),
    monthGrid: wrap(`${bar}${clock}${check}<span class="${titleCls}">${title}</span>`),
    // 议程是一条条的列表：和时间格同一种两行
    monthAgenda: twoLines,
  }
}

/** 「13:30–15:30」那一行和「采用 / 换一个」两颗钮——「帮我排进空档」的虚线候选块（WP469）。 */
export function ghostContent(input: {
  todo_id: string
  title: string
  start: string
  end: string
  take: string
  swap: string
  canSwap: boolean
}): string {
  const id = escapeHtml(input.todo_id)
  const range = escapeHtml(clockRange(new Date(input.start), new Date(input.end)))
  const swap = input.canSwap
    ? `<button type="button" class="ws-ghost-btn" data-ghost-act="swap" data-ghost="${id}">${escapeHtml(input.swap)}</button>`
    : ''
  return `<div class="ws-ghost" data-ghost-id="${id}"><div class="ws-ghost-title">${escapeHtml(input.title)}</div><div class="ws-ghost-time">${range}</div><div class="ws-ghost-acts"><button type="button" class="ws-ghost-btn ws-ghost-take" data-ghost-act="take" data-ghost="${id}">${escapeHtml(input.take)}</button>${swap}</div></div>`
}
