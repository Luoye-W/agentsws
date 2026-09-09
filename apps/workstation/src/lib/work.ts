/**
 * 37 工作模型的前端小工具：链接、时间、分组。
 *
 * 一条纪律：**这里不算业务数字**。进度、完成率、战报四格都从服务端来（29 原则 ③），
 * 这一层只做「几点」「哪天」「跳哪去」。
 */
import type { CalendarItem, Todo } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'

export const DAY_MS = 86_400_000

/**
 * 卡片 →「进入事项并定位到那次运行」。
 *
 * `DeckCard` 目前没有 `matter_id`（它是 `packages/deck` 的冻结面，WP21 在改），
 * 所以先从 payload 里取；取不到就退回岗位页——不猜、也不跳到不存在的地方。
 * 契约建议已写进交付报告：`DeckCard` 加 `matter_id?` / `todo_id?`。
 */
export function matterUrl(card: DeckCard): string {
  const payload = card.detail.payload as { matter_id?: unknown; work_item_id?: unknown } | null
  const id =
    typeof payload?.matter_id === 'string'
      ? payload.matter_id
      : typeof payload?.work_item_id === 'string'
        ? payload.work_item_id
        : undefined
  if (id === undefined) return `/positions/${card.position_id}`
  return `/matters/${id}#card-${card.id}`
}

/** 点待办标题 = 进入事项并定位到锚点（37 §2.2b）。没有事项的待办不给链接。 */
export function todoUrl(todo: Todo): string | undefined {
  if (todo.matter_id === undefined) return undefined
  const anchor = todo.anchor?.matter_event_id
  return anchor === undefined
    ? `/matters/${todo.matter_id}`
    : `/matters/${todo.matter_id}#${anchor}`
}

/** 本地日 `YYYY-MM-DD`（浏览器时区；服务端的日界线按工作区时区，两者只在跨时区时差一天）。 */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
}

/** 一周的起点（周一）。 */
export function startOfWeek(at: Date): Date {
  const d = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  const shift = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - shift)
  return d
}

export function startOfMonthGrid(at: Date): Date {
  return startOfWeek(new Date(at.getFullYear(), at.getMonth(), 1))
}

export function addDays(at: Date, n: number): Date {
  const d = new Date(at)
  d.setDate(d.getDate() + n)
  return d
}

/** 把日历项按本地日分桶。 */
export function groupByDay(items: readonly CalendarItem[]): Map<string, CalendarItem[]> {
  const out = new Map<string, CalendarItem[]>()
  for (const item of items) {
    const key = dayKey(item.start)
    const list = out.get(key)
    if (list === undefined) out.set(key, [item])
    else list.push(item)
  }
  return out
}

/** 待办箱三段的显示顺序。 */
export const HORIZONS = ['today', 'week', 'backlog'] as const
export type HorizonName = (typeof HORIZONS)[number]

export function groupByHorizon(todos: readonly Todo[]): Record<HorizonName, Todo[]> {
  const out: Record<HorizonName, Todo[]> = { today: [], week: [], backlog: [] }
  for (const t of todos) out[t.horizon].push(t)
  return out
}

/** 「还剩 N 天」/「已过期 N 天」——只做减法，不做判断。 */
export function daysLeftLabel(days: number, t: (k: string, v?: Record<string, number>) => string) {
  return days < 0 ? t('goal.overdue', { days: -days }) : t('goal.days_left', { days })
}
