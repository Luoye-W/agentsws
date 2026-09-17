/**
 * WP74（37 §2.5）：**一个日历，多图层**——图层这一层的纯逻辑。
 *
 * 这个文件里一行 React 都没有，理由与 `lib/work.ts` 同一条：图层是"哪几类东西现在
 * 看得见"，它是一份**可以单测**的判断，不是一段渲染。日历那一屏、职责页里嵌的那一块、
 * 以后从别处跳进来的 URL，三边读的都是这里这一份。
 *
 * 三条纪律：
 *
 * 1. **不传 = 全部**。`sources` 这个词在服务端与这里意思一致（`CalendarRange.sources`）：
 *    没有选择 ≠ 空选择。空选择（一个都不勾）是人主动做的事，回一条都不给是对的。
 * 2. **记忆是每个人自己的**，所以在 `localStorage`，不在服务端——它不是工作数据，
 *    换台电脑重新勾一次没有任何损失。读不出来（隐私窗口、清过站点数据）就用默认，
 *    不报错、不空屏。
 * 3. **从哪儿进来决定默认开哪几层**。从社媒运营的职责页点进日历，默认看到的应该是
 *    社媒排期与自己的待办，而不是七层一起糊在一屏上。
 */
import type { CalendarItem, CalendarSource } from '@agentsws/contracts'
import { CALENDAR_SOURCES } from '@agentsws/contracts'
import {
  AlarmClock,
  CheckSquare,
  CloudCog,
  ListTodo,
  type LucideIcon,
  Megaphone,
  Package,
  Users,
} from 'lucide-react'

export type CalendarView = 'day' | 'week' | 'month' | 'agenda'

export const CALENDAR_VIEWS: readonly CalendarView[] = ['day', 'week', 'month', 'agenda'] as const

/** 图层顺序 = 契约里那一份（界面不自己排一遍，否则两边迟早不一样）。 */
export const LAYERS: readonly CalendarSource[] = CALENDAR_SOURCES

export const LAYER_ICON: Record<CalendarSource, LucideIcon> = {
  todo: CheckSquare,
  meeting: Users,
  social_post: Megaphone,
  kol_deliverable: Package,
  scheduled_task: AlarmClock,
  card_due: ListTodo,
  standby: CloudCog,
}

/**
 * 每个图层一个颜色变量（shadcn 的 token，深浅色自己跟着换）。
 *
 * 用 `--chart-N` 与 `--destructive` 这几个既有 token，不新造一套颜色：
 * 新造一套的话，日历上的绿与面板上的绿会是两个绿。
 */
export const LAYER_COLOR: Record<CalendarSource, string> = {
  todo: 'var(--chart-2)',
  meeting: 'var(--chart-1)',
  social_post: 'var(--chart-3)',
  kol_deliverable: 'var(--chart-5)',
  scheduled_task: 'var(--chart-4)',
  card_due: 'var(--destructive)',
  standby: 'var(--muted-foreground)',
}

/**
 * 从哪儿进来，默认开哪几层（纪律 3）。
 *
 * `role_id` 是职责 id（`social.meta` / `kol.outreach` / `support.inbox`…），
 * 认不出来的一律回落成"待办 + 会议 + 卡片到期"——那是**任何岗位**都成立的三层。
 */
export function defaultLayersFor(role_id?: string): CalendarSource[] {
  if (role_id !== undefined) {
    if (role_id.startsWith('social.')) return ['social_post', 'todo']
    if (role_id.startsWith('kol.')) return ['kol_deliverable', 'todo']
  }
  return ['todo', 'meeting', 'card_due']
}

/** 认得出来的图层名才算数（URL 上的 `?layers=` 是别人写的，不是我们写的）。 */
export function parseLayers(raw: string | null | undefined): CalendarSource[] | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined
  const names = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x): x is CalendarSource => (LAYERS as readonly string[]).includes(x))
  return names.length === 0 ? undefined : [...new Set(names)]
}

/** 图层清单 → `?layers=` / `?sources=` 的那一段（顺序按契约，不按人点的先后）。 */
export function serializeLayers(layers: readonly CalendarSource[]): string {
  return LAYERS.filter((l) => layers.includes(l)).join(',')
}

export const LAYERS_STORAGE_KEY = 'agentsws.calendar.layers'
export const VIEW_STORAGE_KEY = 'agentsws.calendar.view'

/**
 * 记住上次（纪律 2）。`localStorage` 在隐私窗口里会直接抛，所以每一次读写都包起来：
 * 日历打不开比"没记住上次"严重得多。
 */
export function loadLayers(storage?: Pick<Storage, 'getItem'>): CalendarSource[] | undefined {
  try {
    const store = storage ?? globalThis.localStorage
    return parseLayers(store?.getItem(LAYERS_STORAGE_KEY))
  } catch {
    return undefined
  }
}

export function saveLayers(
  layers: readonly CalendarSource[],
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    const store = storage ?? globalThis.localStorage
    store?.setItem(LAYERS_STORAGE_KEY, serializeLayers(layers))
  } catch {
    // 记不住就算了
  }
}

export function loadView(storage?: Pick<Storage, 'getItem'>): CalendarView | undefined {
  try {
    const store = storage ?? globalThis.localStorage
    const raw = store?.getItem(VIEW_STORAGE_KEY)
    return CALENDAR_VIEWS.find((v) => v === raw)
  } catch {
    return undefined
  }
}

export function saveView(view: CalendarView, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const store = storage ?? globalThis.localStorage
    store?.setItem(VIEW_STORAGE_KEY, view)
  } catch {
    // 同上
  }
}

/**
 * 客户端那一次图层过滤。
 *
 * 服务端已经按 `?sources=` 过滤过一遍了，这里还要再过一遍，是因为**勾掉一层不该重新请求**
 * ——人点一下 checkbox 就等一次网络往返的日历是不能用的。两边用的是同一条判据
 * （`item.source ∈ layers`），所以不会出现"服务端算的与界面画的不一样"。
 */
export function filterByLayers(
  items: readonly CalendarItem[],
  layers: readonly CalendarSource[],
): CalendarItem[] {
  return items.filter((i) => layers.includes(i.source))
}

/** 每层各有几条（图层开关旁边那个数字）。关掉的层也要有数，否则看不出"关掉的那层里有东西"。 */
export function countByLayer(items: readonly CalendarItem[]): Record<CalendarSource, number> {
  const out = Object.fromEntries(LAYERS.map((l) => [l, 0])) as Record<CalendarSource, number>
  for (const i of items) if (i.source in out) out[i.source] += 1
  return out
}

/** 勾 / 取消勾一层（顺序始终按契约那一份，不按点击顺序）。 */
export function toggleLayer(
  layers: readonly CalendarSource[],
  layer: CalendarSource,
): CalendarSource[] {
  const next = layers.includes(layer) ? layers.filter((l) => l !== layer) : [...layers, layer]
  return LAYERS.filter((l) => next.includes(l))
}
