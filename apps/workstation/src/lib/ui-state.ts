/**
 * WP71：左栏展开态与右栏（第三栏）开合态存在哪儿；WP74 之后日历的图层与视图也在这里。
 *
 * 两条规矩：
 *
 * 1. **只存"界面上折着还是开着"**，不存任何业务数据（36 §3 / 40 §1.3：本机只放缓存
 *    与偏好，真源永远在服务端）。存不下（无痕窗口、浏览器禁了本地存储）也照常工作，
 *    只是刷新后回默认值——所以每个读都带兜底，没有一处会因为读不到而抛。
 * 2. **键名全部带 `agentsws.` 前缀**，与主题 / 语言 / 会话那几个同一片命名空间。
 */

/**
 * 左栏里每个岗位折着还是开着（`position_id` → true / false）。
 *
 * 存的是**显式选择**，不是最终状态：没记过的岗位按"当前岗位默认展开"算
 * （36 §10）。两者分开之后，用户把当前岗位收起来这件事也留得住——
 * 只存一张"开着的清单"的话，收起来 = 不在清单里 = 又被默认规则打开。
 */
export const RAIL_EXPANDED_KEY = 'agentsws.rail.expanded'
/**
 * WP95（36 §11，`docs/upstream/sidebar-compare.md` #5）：第三栏的**布局**——
 * 按作用域分桶的 `{ open_panel_id, width }`，一个桶一行。
 *
 * 它替掉了 WP71 那两个键（开着哪个面板、多宽，各存一行）。换掉的理由两条：
 *
 * 1. **按作用域分桶**：从岗位 A 切到 B 再切回来，A 的第三栏还开在原处
 *    （#8 那条"切走不删状态"的语义——官方绑 session，我们绑岗位 / 事项 / 职责）；
 * 2. **只存结构**：这一份里永远只有"开哪个面板、多宽"。哪条记忆、哪个事项的证据、
 *    面板取回来的任何一个字**一律不存**——存了就等于在 localStorage 里放业务数据，
 *    与 40 §1.2 第一条规则（个人电脑上不存真源）正面冲突。刷新之后各面板拿着
 *    作用域自己重新取，与官方"拿 tab 身份 + 资源地址自己找回来"是同一条。
 */
/** WP342：左下角账号菜单里「工作内容 / 设置」两组哪组展开着（没记过 = 都收着）。 */
export const ACCOUNT_GROUPS_KEY = 'agentsws.account.groups'

export const RIGHT_RAIL_LAYOUT_KEY = 'agentsws.rightrail.layout'

/**
 * WP351：「消息 → 网站聊天」每段访客对话在这台电脑上看到了哪一刻（会话 id → `updated_at`）。
 * 只用来画未读小点；值里只有 id 与时间，没有一个字的对话内容。丢了最坏是每段都再亮一次点。
 */
export const SITE_CHAT_SEEN_KEY = 'agentsws.site_chat.seen'

/**
 * WP74：日历上开着哪几个图层、用的哪个视图。
 *
 * 与左右栏那三个同一类：**纯界面偏好**。图层不是"哪些事存在"，是"这一屏现在画哪几类"；
 * 丢了最坏的结果是下次打开回默认的三层。所以它落在这台电脑上，不占服务端一张表。
 */
export const CALENDAR_LAYERS_KEY = 'agentsws.calendar.layers'
/** 日历上次停在哪个视图（日 / 周 / 月 / 议程）。 */
export const CALENDAR_VIEW_KEY = 'agentsws.calendar.view'

/**
 * WP195：「界面动效：跟随系统 / 开 / 关」（`system` | `on` | `off`）。与主题、语言同一类——
 * 纯偏好，丢了回「跟随系统」。读写在 `components/design/motion-pref.ts`。
 */
export const MOTION_PREF_KEY = 'agentsws.motion'

/**
 * WP241（docs/54 §7.5）：岗位页「工作」在**这个岗位**上停在哪个视图、怎么筛 / 分组 / 排序、表格开了哪几列。
 * 与日历那两个键同一类——**纯界面偏好**，值里只有视图名、职责 id、状态名这些结构，没有一条工作项的内容；
 * 丢了最坏的结果是下次打开回默认列表。键 = 前缀 + 岗位模板 id（id 本来就在地址栏里）。
 */
export const POSITION_WORK_KEY_PREFIX = 'agentsws.position_work.'

export const RIGHT_RAIL_MIN_WIDTH = 320
export const RIGHT_RAIL_MAX_WIDTH = 520
export const RIGHT_RAIL_DEFAULT_WIDTH = 380

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // 存不下也照常工作，只是刷新后回默认
  }
}

/** 读一张 `id → 布尔` 的表（存坏了 / 存的不是对象，一律当"什么都没记过"）。 */
export function readFlags(key: string): Record<string, boolean> {
  const raw = read(key)
  if (raw === null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function writeFlags(key: string, value: Record<string, boolean>): void {
  write(key, JSON.stringify(value))
}

export function readString(key: string): string | null {
  return read(key)
}

export function writeString(key: string, value: string): void {
  write(key, value)
}

export function clampRailWidth(n: number): number {
  return Math.min(RIGHT_RAIL_MAX_WIDTH, Math.max(RIGHT_RAIL_MIN_WIDTH, Math.round(n)))
}

/**
 * WP95：第三栏一个作用域桶里的布局。**只有这两格**。
 *
 * 想往这里加第三格之前先问一句："它是结构还是内容？"——
 * 内容（列表、正文、取回来的数字）不进本机，一条都不进。
 */
export interface RailLayoutEntry {
  /** 开着哪个面板的 id；`null` = 收起成图标轨。 */
  open_panel_id: string | null
  /** 面板宽度（px，320–520）。 */
  width: number
}

export const DEFAULT_RAIL_LAYOUT: RailLayoutEntry = {
  open_panel_id: null,
  width: RIGHT_RAIL_DEFAULT_WIDTH,
}

/**
 * 读整张布局表（`作用域桶 → { open_panel_id, width }`）。
 *
 * **每一格都当成不可信**：存坏了、是上一版留下的形状、被人手改过——
 * 一律按默认值算，不抛。宽度越界夹回 320–520，`open_panel_id` 不是字符串就当收起。
 */
export function readRailLayouts(): Record<string, RailLayoutEntry> {
  const raw = read(RIGHT_RAIL_LAYOUT_KEY)
  if (raw === null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, RailLayoutEntry> = {}
    for (const [bucket, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const v = value as { open_panel_id?: unknown; width?: unknown }
      const width = typeof v.width === 'number' && Number.isFinite(v.width) ? v.width : undefined
      out[bucket] = {
        open_panel_id: typeof v.open_panel_id === 'string' ? v.open_panel_id : null,
        width: width === undefined ? RIGHT_RAIL_DEFAULT_WIDTH : clampRailWidth(width),
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 写一个桶（别的桶原样留着——切回那个岗位时还要用）。 */
export function writeRailLayout(bucket: string, entry: RailLayoutEntry): void {
  const all = readRailLayouts()
  all[bucket] = { open_panel_id: entry.open_panel_id, width: clampRailWidth(entry.width) }
  write(RIGHT_RAIL_LAYOUT_KEY, JSON.stringify(all))
}

export function readRailLayout(bucket: string): RailLayoutEntry {
  return readRailLayouts()[bucket] ?? DEFAULT_RAIL_LAYOUT
}

/**
 * WP298：「刚因为新版分块加载失败整页重载过」的时刻（毫秒数）。放 **sessionStorage**：
 * 只活在这一个窗口、关了就没；不是业务对象，只为了不让重载转圈。
 */
export const PRELOAD_RELOAD_KEY = 'agentsws.preload_reload_at'

/**
 * WP298：这个窗口的 sessionStorage（拿不到就 `undefined`）。全工作台只有这里碰它
 * （40 §1.2 的边界用例钉着：碰存储的只有三个文件）。
 */
export function sessionStore(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return globalThis.sessionStorage ?? undefined
  } catch {
    return undefined
  }
}
