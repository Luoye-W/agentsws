/**
 * WP481（决策 1632，Luoye 10-23「不要挤压中栏宽度去显示本应该另外开一个右栏显示的」）：
 * 工作台的**右栏（第三栏）**打开时，主窗口**向右加宽**右栏那么宽——中栏宽度不变、左边位置不动；关掉时缩回原宽。
 *
 * 放不下就不加宽，回 `overlay`（页面改成从右侧滑出的浮层盖在中栏右侧，中栏不重排）：
 * - 窗口已最大化 / 全屏；
 * - 向右加宽会超出窗口所在那块屏幕的可用区（不往左挪窗口，左边位置不动）。
 *
 * **用户手动拖了窗口大小 / 最大化 / 全屏之后以用户的为准**：这一轮不再动窗口大小，关右栏时也不缩回
 * （`will-resize` 只在人拖时发；没有它的平台按「宽度对不上我们设的」判）。
 *
 * 页面经桥 `sidePane.sync(width | null)` 说「我现在要一个多宽的右栏 / 不要了」——幂等，页面重载后再说一遍也对得上。
 * 宽度是页面的 CSS 像素，乘上网页缩放才是窗口坐标（`main.ts` 乘好了再交进来）。
 *
 * 这里**不 import electron**（README：只有 main.ts / preload 碰它），收的是够用的那几个方法。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** `BrowserWindow` 里用得到的那一点。 */
export interface SidePaneWindow {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  isDestroyed(): boolean
  getBounds(): Rect
  setBounds(bounds: Partial<Rect>): void
  isMaximized(): boolean
  isFullScreen(): boolean
  isSimpleFullScreen?(): boolean
}

/** 窗口所在那块屏幕的可用区（`screen.getDisplayMatching(bounds).workArea`）。 */
export type WorkAreaOf = (bounds: Rect) => Rect

/** 页面拿到的答复：`widened` = 窗口加宽了，右栏并排；`overlay` = 放不下，右栏盖上去；`none` = 右栏收着。 */
export type SidePaneMode = 'widened' | 'overlay' | 'none'

/** 量出来的宽度差这么多以内算「是我们设的」（缩放取整）。 */
const TOLERANCE = 2

interface Widened {
  /** 加了多宽（窗口坐标）。 */
  added: number
  /** 加宽后窗口应有的宽度（用来认出人拖过）。 */
  expected: number
  /** 人拖过 / 最大化过：这一轮不再动窗口大小。 */
  userTook: boolean
}

export interface SidePaneController {
  /** 页面要一个 `width` 宽的右栏（`null` = 不要了）。 */
  sync(width: number | null): SidePaneMode
  /** 只给测试看。 */
  state(): { added: number; userTook: boolean } | undefined
}

/** 页面交来的宽度：正数（窗口坐标取整、最多 2000），`null` = 收起；别的都不认（回 `undefined`）。 */
export function parseSidePaneWidth(raw: unknown): number | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return Math.min(2000, Math.round(raw))
}

const fullOrMax = (win: SidePaneWindow): boolean =>
  win.isMaximized() || win.isFullScreen() || win.isSimpleFullScreen?.() === true

/** 挂到主窗口上（窗口关了自己作废）。 */
export function attachSidePane(win: SidePaneWindow, workAreaOf: WorkAreaOf): SidePaneController {
  let widened: Widened | undefined

  const takeOver = (): void => {
    if (widened !== undefined) widened.userTook = true
  }
  // 人拖窗口边（Mac / Windows 才发；setBounds 不发）
  win.on('will-resize', takeOver)
  win.on('maximize', takeOver)
  win.on('enter-full-screen', takeOver)
  // 兜底（Linux 没有 will-resize）：宽度和我们设的对不上 = 人动过
  win.on('resize', () => {
    if (widened === undefined || widened.userTook || win.isDestroyed()) return
    if (fullOrMax(win)) return
    if (Math.abs(win.getBounds().width - widened.expected) > TOLERANCE) widened.userTook = true
  })
  win.on('closed', () => {
    widened = undefined
  })

  /** 从 `base` 宽加到 `base + width`；放不下回 `false`（窗口不动）。 */
  const widen = (bounds: Rect, base: number, width: number): boolean => {
    const area = workAreaOf(bounds)
    const right = bounds.x + base + width
    if (right > area.x + area.width) return false
    // 先记下再设：setBounds 可能当场发 resize，那时要认得出是我们设的
    widened = { added: width, expected: base + width, userTook: false }
    win.setBounds({ x: bounds.x, y: bounds.y, width: base + width, height: bounds.height })
    return true
  }

  /** 缩回原宽（人没动过、窗口也没最大化时）。 */
  const shrink = (): void => {
    const was = widened
    widened = undefined
    if (was === undefined || was.userTook || win.isDestroyed() || fullOrMax(win)) return
    const bounds = win.getBounds()
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(1, bounds.width - was.added),
      height: bounds.height,
    })
  }

  return {
    sync(width) {
      if (win.isDestroyed()) return width === null ? 'none' : 'overlay'
      if (width === null) {
        shrink()
        return 'none'
      }
      // 人接管了这一轮：窗口大小照他的，右栏照旧并排（页面在中栏太窄时自己改成盖上去）
      if (widened?.userTook === true) return 'widened'
      if (fullOrMax(win)) return 'overlay'
      const bounds = win.getBounds()
      if (widened !== undefined) {
        if (widened.added === width) return 'widened'
        // 换了一格（浏览器 380 → 报表 560）/ 拖了右栏的宽：从原宽重新加
        const base = bounds.width - widened.added
        if (widen(bounds, base, width)) return 'widened'
        shrink()
        return 'overlay'
      }
      return widen(bounds, bounds.width, width) ? 'widened' : 'overlay'
    },
    state() {
      return widened === undefined
        ? undefined
        : { added: widened.added, userTook: widened.userTook }
    },
  }
}
