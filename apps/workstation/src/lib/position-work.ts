/**
 * WP241（docs/54 §7）：岗位页「工作」的界面规则——筛选、分组、排序、时间说法、快捷视图、
 * 本机偏好。纯函数，单测在 `test/position-work-view.test.ts`。
 *
 * 分组与「能不能拖」的规则不在这里：那是前后端同一份，在 `@agentsws/contracts` 的
 * `position-work.ts`。这里只管「人怎么看」。
 */
import {
  POSITION_WORK_GROUPS,
  type PositionWorkGroup,
  type PositionWorkItem,
  type PositionWorkSource,
} from '@agentsws/contracts'
import { channelOfRole } from '@/components/kol/kol-panel'
import { socialChannelOfRole } from '@/components/social/social-calendar'
import { POSITION_WORK_KEY_PREFIX, readString, writeString } from '@/lib/ui-state'

export type BaseView = 'list' | 'board' | 'calendar' | 'table'
export const BASE_VIEWS: readonly BaseView[] = ['list', 'board', 'calendar', 'table']

/**
 * 截止筛选。WP248（决策 79）：加 `by_today`「今天及已过期」——页头「今天 N 个待办（M 个已过期）」
 * 点过去就是它（没做完、截止在今天或更早），与服务端 `counts.todos_today` 同一个口径。
 */
export type DueFilter = 'all' | 'by_today' | 'overdue' | 'today' | 'week' | 'none'
export const DUE_FILTERS: readonly DueFilter[] = [
  'all',
  'by_today',
  'overdue',
  'today',
  'week',
  'none',
]
export type GroupBy = 'status' | 'duty' | 'none'
export const GROUP_BYS: readonly GroupBy[] = ['status', 'duty', 'none']
export type SortBy = 'due' | 'updated' | 'title'
export const SORT_BYS: readonly SortBy[] = ['due', 'updated', 'title']

export type ColumnId = 'kind' | 'duty' | 'status' | 'due' | 'source' | 'progress' | 'updated'
export const ALL_COLUMNS: readonly ColumnId[] = [
  'kind',
  'duty',
  'status',
  'due',
  'source',
  'progress',
  'updated',
]
export const DEFAULT_COLUMNS: readonly ColumnId[] = ['duty', 'status', 'due', 'source', 'updated']

export interface WorkFilters {
  duty: string[]
  group: PositionWorkGroup[]
  due: DueFilter
  source: PositionWorkSource[]
}

export const NO_FILTERS: WorkFilters = { duty: [], group: [], due: 'all', source: [] }

/** 这个岗位上记住的看法（本机偏好，docs/54 §7.5）。 */
export interface WorkPrefs {
  /** 四种基本视图之一，或一个快捷视图的 id（`quick:<种类>:<职责>`） */
  view: string
  groupBy: GroupBy
  sort: SortBy
  filters: WorkFilters
  columns: ColumnId[]
  calendar: 'month' | 'week'
}

/** #74（Luoye 10-06）：一律默认列表。 */
export const DEFAULT_PREFS: WorkPrefs = {
  view: 'list',
  groupBy: 'status',
  sort: 'due',
  filters: NO_FILTERS,
  columns: [...DEFAULT_COLUMNS],
  calendar: 'month',
}

const PREFS_KEY = (position_id: string): string => `${POSITION_WORK_KEY_PREFIX}${position_id}`

const oneOf = <T extends string>(all: readonly T[], v: unknown, fallback: T): T =>
  typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : fallback

const listOf = <T extends string>(all: readonly T[] | undefined, v: unknown): T[] =>
  Array.isArray(v)
    ? (v.filter(
        (x) =>
          typeof x === 'string' && (all === undefined || (all as readonly string[]).includes(x)),
      ) as T[])
    : []

/** 读这个岗位记住的看法（本机存储只经 `ui-state.ts`）；读不到（隐私模式、坏数据、没存过）就是默认列表。 */
export function loadWorkPrefs(position_id: string): WorkPrefs {
  try {
    const raw = readString(PREFS_KEY(position_id))
    if (raw === null) return { ...DEFAULT_PREFS }
    const v = JSON.parse(raw) as Record<string, unknown>
    const f = (v.filters ?? {}) as Record<string, unknown>
    const columns = listOf(ALL_COLUMNS, v.columns)
    return {
      view: typeof v.view === 'string' && v.view !== '' ? v.view : 'list',
      groupBy: oneOf(GROUP_BYS, v.groupBy, 'status'),
      sort: oneOf(SORT_BYS, v.sort, 'due'),
      filters: {
        duty: listOf(undefined, f.duty),
        group: listOf(POSITION_WORK_GROUPS, f.group),
        due: oneOf(DUE_FILTERS, f.due, 'all'),
        source: listOf<PositionWorkSource>(
          ['you', 'agent', 'schedule', 'inbound', 'meeting'],
          f.source,
        ),
      },
      columns: columns.length === 0 ? [...DEFAULT_COLUMNS] : columns,
      calendar: v.calendar === 'week' ? 'week' : 'month',
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function saveWorkPrefs(position_id: string, prefs: WorkPrefs): void {
  // 存不下（隐私模式 / 满了）由 `writeString` 吞掉：只在这一次打开里有效，不影响看
  writeString(PREFS_KEY(position_id), JSON.stringify(prefs))
}

export function activeFilterCount(f: WorkFilters): number {
  return f.duty.length + f.group.length + (f.due === 'all' ? 0 : 1) + f.source.length
}

// ── 时间 ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

/** 本地日历日（YYYY-MM-DD），按浏览器时区。 */
export function localDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 截止落在哪种筛选里。 */
export function dueMatches(due: string | undefined, filter: DueFilter, now: Date): boolean {
  if (filter === 'all') return true
  if (filter === 'none') return due === undefined
  if (due === undefined) return false
  const at = Date.parse(due)
  if (filter === 'overdue') return at < now.getTime()
  if (filter === 'today') return localDay(due) === localDay(now)
  // 今天及更早（没做完的那一半在 `filterItems` 里看分组）
  if (filter === 'by_today') return localDay(due) <= localDay(now)
  return at >= now.getTime() - DAY_MS && at <= now.getTime() + 7 * DAY_MS
}

/**
 * 一个时刻的短说法：今天 18:00 / 明天 / 10-08 09:00。
 * 零点整的不带时间（那是「这一天」，不是「零点」）。
 */
export function whenText(iso: string, now: Date, t: (k: string) => string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  const time =
    d.getHours() === 0 && d.getMinutes() === 0 ? '' : ` ${p(d.getHours())}:${p(d.getMinutes())}`
  const day = localDay(d)
  if (day === localDay(now)) return `${t('pos2.when.today')}${time}`
  if (day === localDay(new Date(now.getTime() + DAY_MS))) return t('pos2.when.tomorrow')
  if (day === localDay(new Date(now.getTime() - DAY_MS))) return t('pos2.when.yesterday')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}${time}`
}

/** 截止的颜色：没做完、已过期 = 红；今天 = 橙；其余不上色。 */
export function dueTone(item: PositionWorkItem, now: Date): 'bad' | 'warn' | undefined {
  if (item.due_at === undefined || item.group === 'done') return undefined
  if (Date.parse(item.due_at) < now.getTime() && localDay(item.due_at) !== localDay(now))
    return 'bad'
  if (localDay(item.due_at) === localDay(now)) return 'warn'
  return undefined
}

// ── 筛选 / 排序 / 分组 ─────────────────────────────────────────────────

export function filterItems(
  items: readonly PositionWorkItem[],
  f: WorkFilters,
  now: Date,
): PositionWorkItem[] {
  return items.filter(
    (i) =>
      (f.duty.length === 0 || (i.role_id !== undefined && f.duty.includes(i.role_id))) &&
      (f.group.length === 0 || f.group.includes(i.group)) &&
      (f.source.length === 0 || f.source.includes(i.source)) &&
      dueMatches(i.due_at, f.due, now) &&
      (f.due !== 'by_today' || i.group !== 'done'),
  )
}

export function sortItems(items: readonly PositionWorkItem[], by: SortBy): PositionWorkItem[] {
  const out = [...items]
  if (by === 'title') out.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  else if (by === 'updated') out.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  else
    out.sort(
      (a, b) =>
        (a.due_at ?? '￿').localeCompare(b.due_at ?? '￿') ||
        b.updated_at.localeCompare(a.updated_at),
    )
  return out
}

export interface WorkGroup {
  /** 分组 id：状态名、职责 id、`all`、`none`（没归职责） */
  id: string
  items: PositionWorkItem[]
}

/** 按状态分组时四组都在（空组也给，界面决定画不画）；按职责按职责顺序，没归职责的放最后。 */
export function groupItems(
  items: readonly PositionWorkItem[],
  by: GroupBy,
  dutyOrder: readonly string[],
): WorkGroup[] {
  if (by === 'none') return [{ id: 'all', items: [...items] }]
  if (by === 'status')
    return POSITION_WORK_GROUPS.map((g) => ({ id: g, items: items.filter((i) => i.group === g) }))
  const seen = [...dutyOrder]
  for (const i of items)
    if (i.role_id !== undefined && !seen.includes(i.role_id)) seen.push(i.role_id)
  const out = seen
    .map((r) => ({ id: r, items: items.filter((i) => i.role_id === r) }))
    .filter((g) => g.items.length > 0)
  const loose = items.filter((i) => i.role_id === undefined)
  return loose.length === 0 ? out : [...out, { id: 'none', items: loose }]
}

// ── 快捷视图 ───────────────────────────────────────────────────────────

/** 职责专属快捷视图的种类（docs/54 §7.5 那张表）。 */
export type QuickKind =
  | 'schedule'
  | 'broadcast'
  | 'kol'
  | 'outbound'
  | 'sales'
  | 'chat'
  // WP249：自家版待处理（只有 `social.reddit`）
  | 'modqueue'

export interface QuickView {
  /** `quick:<kind>:<role_id>`——记在偏好里的就是它 */
  id: string
  kind: QuickKind
  role_id: string
  role_name: string
  assignment_id: string
}

/** 社群组五条（有「群里的人」，才有群发）。与 `pages/duty.tsx` 同一份名单。 */
export const COMMUNITY_CHANNELS: readonly string[] = [
  'facebook_group',
  'reddit',
  'discord',
  'telegram_group',
  'whatsapp',
]

/** 「面板」那一类快捷视图（老链接 `?tab=view` 落到它们上面）。 */
export const PANEL_QUICK_KINDS: readonly QuickKind[] = ['kol', 'outbound', 'sales', 'chat']

/**
 * 本人这几条职责各自带的快捷视图。#74：社媒类的「发帖排期」排在最前；
 * 其余按职责顺序。
 */
export function quickViewsOf(
  duties: readonly { role_id: string; role_name: string; assignment_id: string }[],
): QuickView[] {
  const out: QuickView[] = []
  const add = (kind: QuickKind, d: (typeof duties)[number]): void => {
    out.push({ id: `quick:${kind}:${d.role_id}`, kind, ...d })
  }
  for (const d of duties) {
    const social = socialChannelOfRole(d.role_id)
    if (social !== undefined) add('schedule', d)
  }
  for (const d of duties) {
    const social = socialChannelOfRole(d.role_id)
    if (social !== undefined && COMMUNITY_CHANNELS.includes(social)) add('broadcast', d)
    if (d.role_id === 'social.reddit') add('modqueue', d)
    if (channelOfRole(d.role_id) !== undefined) add('kol', d)
    if (d.role_id === 'b2b.outbound') add('outbound', d)
    if (d.role_id === 'b2b.sales') add('sales', d)
    if (d.role_id === 'dtc.live-chat') add('chat', d)
  }
  return out
}

/** 同一种快捷视图有几条（多条时标签后面带职责名）。 */
export function quickLabelNeedsDuty(views: readonly QuickView[], v: QuickView): boolean {
  return views.filter((x) => x.kind === v.kind).length > 1
}

// ── WP248（决策 82）：拖到「排着的」时选的那个时间 ─────────────────────────

/** 排着的默认排到「明天上午」：明天 09:00（浏览器时区）。 */
export function defaultQueueAt(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0)
  return d
}

/** `Date` → `<input type="datetime-local">` 的值（本地时间，到分钟）。 */
export function toLocalInput(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${localDay(d)}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 排期占一小时（日历上要有一段；人要改长短去日历里拖）。 */
export const QUEUE_SLOT_MS = 3_600_000

/**
 * `datetime-local` 的值 → 排期时段。读不出来、或不在以后（「排着的」= 排在以后某个时段）回 `undefined`。
 */
export function queueSlotOf(value: string, now: Date): { start: string; end: string } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined
  const at = new Date(value)
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return undefined
  return {
    start: at.toISOString(),
    end: new Date(at.getTime() + QUEUE_SLOT_MS).toISOString(),
  }
}
