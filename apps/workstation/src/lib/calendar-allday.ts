/**
 * WP457（WP456 §3.6 P0）：日 / 周视图的全天区——**一条横带，不是一根柱子**。
 *
 * Schedule-X 的月格有「每天最多几条」（`nEventsPerDay`），周视图的全天区没有：某一天堆了 13 条
 * 到期卡，全天区就被撑到 280px 高，下面的小时格只剩两行（WP456 改前那张图）。所以在交给库之前
 * 先折一次：每天最多画 {@link ALL_DAY_MAX} 条，多的收成一条「还有 N 项」，点开再列。
 *
 * 一天正好比上限多 1 条时照画——「还有 1 项」占的也是一行，不如直接把那一条画出来。
 * 纯函数、不碰 React，单测直接测。
 */
import type { CalendarItem } from '@agentsws/contracts'

/** 每天全天区最多画几条（多的折成「还有 N 项」）。 */
export const ALL_DAY_MAX = 2

/** 「还有 N 项」那一条的事件 id 前缀（后面跟那一天 `YYYY-MM-DD`）。 */
export const MORE_ID_PREFIX = 'cal_more_'

export interface AllDayFold {
  /** 照画的：时间格里的全部 + 每天全天区的前几条 */
  shown: CalendarItem[]
  /** 那一天（`YYYY-MM-DD`）→ 折起来的那几条（按原来的顺序） */
  hidden: Map<string, CalendarItem[]>
}

/**
 * 折全天项。`dayOf` 把开始时刻换成「那一天」（按浏览器时区，和日历画格子用的是同一个时区）。
 */
export function foldAllDay(
  items: readonly CalendarItem[],
  dayOf: (iso: string) => string,
  max: number = ALL_DAY_MAX,
): AllDayFold {
  const shown: CalendarItem[] = []
  const perDay = new Map<string, CalendarItem[]>()
  for (const item of items) {
    if (!item.all_day) {
      shown.push(item)
      continue
    }
    const day = dayOf(item.start)
    const list = perDay.get(day)
    if (list === undefined) perDay.set(day, [item])
    else list.push(item)
  }
  const hidden = new Map<string, CalendarItem[]>()
  for (const [day, list] of perDay) {
    if (list.length <= max + 1) {
      shown.push(...list)
      continue
    }
    shown.push(...list.slice(0, max))
    hidden.set(day, list.slice(max))
  }
  return { shown, hidden }
}

/** 事件 id 是不是「还有 N 项」那一条；是的话回那一天。 */
export function moreDayOf(eventId: string): string | undefined {
  return eventId.startsWith(MORE_ID_PREFIX) ? eventId.slice(MORE_ID_PREFIX.length) : undefined
}

/**
 * WP456-T5（§3.6「日 / 月视图顺带对齐同一套」）：月格也每天最多画 {@link ALL_DAY_MAX} 条，
 * 多的折成同一条「还有 N 项」、点开是同一张小卡——原来月格是库自己折的（每天 4 条 + 「+ 9 场活动」），
 * 和周视图两种说法、两种点开的样子。
 *
 * 和 {@link foldAllDay} 的区别：月格里定了钟点的也算进那一天（月格里它们和全天项挤在同一个格子里），
 * 每天先按开始时刻排好再截，画出来的是那天最早的几条。
 */
export function foldMonth(
  items: readonly CalendarItem[],
  dayOf: (iso: string) => string,
  max: number = ALL_DAY_MAX,
): AllDayFold {
  const perDay = new Map<string, CalendarItem[]>()
  for (const item of items) {
    const day = dayOf(item.start)
    const list = perDay.get(day)
    if (list === undefined) perDay.set(day, [item])
    else list.push(item)
  }
  const shown: CalendarItem[] = []
  const hidden = new Map<string, CalendarItem[]>()
  for (const [day, list] of perDay) {
    // 全天项排在前面（它们没有钟点，月格里本来就画在那天最上面），其余按开始时刻
    const sorted = [...list].sort(
      (a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start),
    )
    if (sorted.length <= max + 1) {
      shown.push(...sorted)
      continue
    }
    shown.push(...sorted.slice(0, max))
    hidden.set(day, sorted.slice(max))
  }
  return { shown, hidden }
}
