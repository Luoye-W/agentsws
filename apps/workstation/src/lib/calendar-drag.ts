/**
 * WP74（37 §2.5）：**拖拽语义按来源**——判断与分发这一层，没有 React。
 *
 * 一条纪律压过其余：**判据是服务端给的**（`CalendarItem.drag`），这一层只**执行**。
 * 界面上一条"什么能拖"的规则都不自己写——写了的话，同一条规则会在服务端与界面上
 * 各有一份，迟早对不上，而对不上的那一天，人看到的是"拖得动但没保存"。
 *
 * 四条路：
 * - 待办 → `POST /v1/todos/:id/schedule`（就是 WP37 那条，没换）
 * - 社媒排期 → `PATCH /v1/social/posts/:id/schedule`（换个时间发也是一次发布，
 *   所以回来的是"提上去了，等人点头"，不是"改好了"——WP73 纪律 2）
 * - 会议 → **不改**，出一张"改时间"卡走秘书那条约时间（41 §1.2）
 * - 交付物 / 值守 / 卡片到期 / 定时任务 → 回弹，并说为什么
 */
import type { CalendarItem } from '@agentsws/contracts'

export type DragVerdict =
  /** 拖得动，接着往下走 */
  | { kind: 'allow' }
  /** 回弹，并且带一句"为什么" */
  | { kind: 'bounce'; why: string }
  /** 回弹，但要提一次"改时间"（会议） */
  | { kind: 'propose' }

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** 拖不动时那句"为什么"。每一类有自己的一句；没有专门那句就用通用那句。 */
export function readonlyReason(item: CalendarItem, t: Translate): string {
  // 社媒那一层只有"已经发出去了"这一种拖不动
  if (item.source === 'social_post') return t('calendar.drag.why.social_published')
  const key = `calendar.drag.why.${item.source}`
  const line = t(key)
  return line === key ? t('calendar.drag.why.default') : line
}

/**
 * 这一下拖拽该怎么办。
 *
 * `item` 认不出来（事件在这一屏上，但数据已经换了一批）也按回弹处理：
 * 拿不准的时候不改东西，比改错一件强。
 */
export function dragVerdict(item: CalendarItem | undefined, t: Translate): DragVerdict {
  if (item === undefined) return { kind: 'bounce', why: t('calendar.drag.why.default') }
  if (item.drag === 'propose') return { kind: 'propose' }
  if (item.drag !== 'reschedule')
    return {
      kind: 'bounce',
      why: t('calendar.drag.readonly', { title: item.title, why: readonlyReason(item, t) }),
    }
  return { kind: 'allow' }
}

/** 拖完了往哪条路由发。`none` = 这一类没有"改排期"这回事（不该走到这里）。 */
export type DragRoute = 'todo' | 'social_post' | 'none'

export function dragRoute(item: CalendarItem): DragRoute {
  if (item.drag !== 'reschedule') return 'none'
  if (item.source === 'todo') return 'todo'
  if (item.source === 'social_post') return 'social_post'
  return 'none'
}

export interface DragSinks {
  /** 待办改排期（带时段：周视图里拖的是一个块，不是一个点） */
  todo(id: string, slot: { start: string; end: string }): void
  /** 社媒改排期（只有一个时刻：到点就发） */
  socialPost(id: string, at: string): void
}

/** 分发。返回走了哪条路，方便调用方与测试看清楚。 */
export function dispatchDrag(
  item: CalendarItem,
  slot: { start: string; end: string },
  sinks: DragSinks,
): DragRoute {
  const route = dragRoute(item)
  if (route === 'todo') sinks.todo(item.ref.id, slot)
  if (route === 'social_post') sinks.socialPost(item.ref.id, slot.start)
  return route
}
