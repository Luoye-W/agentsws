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
/** 第三栏开着哪个面板（空 = 收起成图标轨）。 */
export const RIGHT_RAIL_PANEL_KEY = 'agentsws.rightrail.panel'
/** 第三栏的宽度（px，320–520）。 */
export const RIGHT_RAIL_WIDTH_KEY = 'agentsws.rightrail.width'

/**
 * WP74：日历上开着哪几个图层、用的哪个视图。
 *
 * 与左右栏那三个同一类：**纯界面偏好**。图层不是"哪些事存在"，是"这一屏现在画哪几类"；
 * 丢了最坏的结果是下次打开回默认的三层。所以它落在这台电脑上，不占服务端一张表。
 */
export const CALENDAR_LAYERS_KEY = 'agentsws.calendar.layers'
/** 日历上次停在哪个视图（日 / 周 / 月 / 议程）。 */
export const CALENDAR_VIEW_KEY = 'agentsws.calendar.view'

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

/** 第三栏宽度：越界一律夹回 320–520（存坏了就是默认宽）。 */
export function readRailWidth(): number {
  const raw = read(RIGHT_RAIL_WIDTH_KEY)
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return RIGHT_RAIL_DEFAULT_WIDTH
  return clampRailWidth(n)
}

export function clampRailWidth(n: number): number {
  return Math.min(RIGHT_RAIL_MAX_WIDTH, Math.max(RIGHT_RAIL_MIN_WIDTH, Math.round(n)))
}

export function writeRailWidth(n: number): void {
  write(RIGHT_RAIL_WIDTH_KEY, String(clampRailWidth(n)))
}
