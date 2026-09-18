/**
 * 出海Agents工坊 · 标记的几何与颜色。
 *
 * **真源不在这里**：真源是母品牌规范
 * `Luoye/projects/AgentsWorkshop/00_Brand/品牌设计规范-v2.md`
 * （几何 §1.1、整体渐变 §1.2、动效每块渐变 §3.0、缓动 §3.1、集结 §3.2、
 * 一变一队 §3.3、呼吸 §3.4）。这个文件是那份规范在代码里的**副本**——
 * 要改块的位置、间距、圆角或配色，先回规范改，再回来同步，并重跑
 * `00_Brand/assets/gen.py` 与 `render_motion.py`。
 *
 * 这个包**零依赖**：工作台的 React 组件、将来云端的登录页与邮件模板、
 * 桌面壳的图标生成脚本都从这里取同一份数字，不各写一遍。
 */

export interface Block {
  readonly x: number
  readonly y: number
}

/** 方块 17×17，圆角 2.5（§1.1）。 */
export const BLOCK_SIZE = 17
export const BLOCK_RADIUS = 2.5

/**
 * 五块随从，顺序就是动效里的 b1…b5（§3.0 那张表的行序）。
 * 列距 / 行距均为 24，三列 x = 14 / 38 / 62。
 */
export const BLOCKS: readonly Block[] = [
  { x: 14, y: 44 },
  { x: 38, y: 52 },
  { x: 38, y: 28 },
  { x: 62, y: 60 },
  { x: 62, y: 36 },
]

/** 领头那块（右上角，青）。 */
export const LEAD: Block = { x: 62, y: 12 }

/** 六块，b1…b5 + 领头。 */
export const ALL_BLOCKS: readonly Block[] = [...BLOCKS, LEAD]

/**
 * 标记外框 65×65（x 14→79，y 12→77）。
 *
 * ⚠️ 居中按**外框**算，不是按 100×100 画布算——按画布居中会偏左上且显小（§1.1）。
 */
export const MARK_BOX = { x: 14, y: 12, width: 65, height: 65 } as const

/** `viewBox` 就是外框，于是"把 SVG 摆正"这件事不需要再算一次偏移。 */
export const VIEW_BOX = `${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}`

/** 渐变轴：对角 ↗，外框左下 (14,77) → 右上 (79,12)（§1.2）。 */
export const GRADIENT_AXIS = { x1: 14, y1: 77, x2: 79, y2: 12 } as const

/**
 * 渐变的最小尺寸。母品牌规范 §1.3 写的是 28px（位图 / 视频口径）；产品界面里 Luoye 定左栏
 * logo 缩到 24（09-18）——屏幕上是矢量渲染、多为 2x 屏，24 时缝仍分得开。再小一律退单色。
 */
export const MIN_GRADIENT_PX = 24

/** 安全区：外框四周留不小于一个方块宽（§1.4）。 */
export const SAFE_AREA = BLOCK_SIZE

/** 底 · 墨 / 纸白（§1.2）。 */
export const INK = '#1B1D22'
export const PAPER = '#FBFAF8'

export interface Stop {
  readonly offset: number
  readonly color: string
}

/** 深底那套亮端点（§1.2）。 */
export const STOPS_ON_DARK: readonly Stop[] = [
  { offset: 0, color: '#4EA8FF' },
  { offset: 0.52, color: '#2FE0C8' },
  { offset: 1, color: '#FFD84D' },
]

/**
 * 浅底压暗版（§1.2「浅底的坑」第 2 条解法）。
 *
 * 亮端点在纸白上对比不足，**黄那一头几乎消失**。浅底要么给标记加深色圆底
 * （favicon 与桌面图标走这条），要么换这套压暗 15–20% 的端点（界面里的标记走这条）。
 */
export const STOPS_ON_LIGHT: readonly Stop[] = [
  { offset: 0, color: '#2E86D8' },
  { offset: 0.52, color: '#1FB8A4' },
  { offset: 1, color: '#D9A82E' },
]

/** 单色 fallback（§1.2）：深底用纸白，浅底用墨。 */
export const MONO_ON_DARK = PAPER
export const MONO_ON_LIGHT = INK

// ── 在渐变轴上取色 ───────────────────────────────────────────────────

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function hex(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0').toUpperCase()
}

function channels(color: string): [number, number, number] {
  const r = Number.parseInt(color.slice(1, 3), 16)
  const g = Number.parseInt(color.slice(3, 5), 16)
  const b = Number.parseInt(color.slice(5, 7), 16)
  return [r, g, b]
}

/** 渐变上 t 处的颜色（与 `gen.py` 的 `ramp()` 同一套算法）。 */
export function sampleStops(t: number, stops: readonly Stop[] = STOPS_ON_DARK): string {
  const u = clamp01(t)
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (first === undefined || last === undefined) throw new Error('渐变至少要两个端点')
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i]
    const b = stops[i + 1]
    if (a === undefined || b === undefined) continue
    if (u < a.offset || u > b.offset) continue
    const k = b.offset === a.offset ? 0 : (u - a.offset) / (b.offset - a.offset)
    const ca = channels(a.color)
    const cb = channels(b.color)
    return `#${hex(ca[0] + (cb[0] - ca[0]) * k)}${hex(ca[1] + (cb[1] - ca[1]) * k)}${hex(
      ca[2] + (cb[2] - ca[2]) * k,
    )}`
  }
  return u > last.offset ? last.color : first.color
}

/** 一个点投影到渐变轴上的位置（0–1）。 */
export function axisParam(x: number, y: number): number {
  const vx = GRADIENT_AXIS.x2 - GRADIENT_AXIS.x1
  const vy = GRADIENT_AXIS.y2 - GRADIENT_AXIS.y1
  const l2 = vx * vx + vy * vy
  return clamp01(((x - GRADIENT_AXIS.x1) * vx + (y - GRADIENT_AXIS.y1) * vy) / l2)
}

export interface BlockGradient {
  readonly from: string
  readonly to: string
}

/**
 * 动效里一块自己那一段渐变（§3.0）。
 *
 * 取的是这块**在整体渐变上覆盖的那一段**：从块的左下角到右上角（与整体渐变同向），
 * 于是块飞出去的时候带走的还是它本来那一片颜色。
 *
 * ⚠️ 不是"取中心点一个纯色"——那样块内的渐变没了，大尺寸下和静态 logo
 * 明显不是一个东西（规范里记着的 2026-08-25 第一版动效的错）。
 */
export function blockGradient(block: Block, stops: readonly Stop[] = STOPS_ON_DARK): BlockGradient {
  return {
    from: sampleStops(axisParam(block.x, block.y + BLOCK_SIZE), stops),
    to: sampleStops(axisParam(block.x + BLOCK_SIZE, block.y), stops),
  }
}

/** 六块各自那一段（深底）——应当与规范 §3.0 那张表逐格相等。 */
export const MOTION_GRADIENTS_ON_DARK: readonly BlockGradient[] = ALL_BLOCKS.map((b) =>
  blockGradient(b, STOPS_ON_DARK),
)

/** 六块各自那一段（浅底压暗版）：同一套推法，换一组端点。 */
export const MOTION_GRADIENTS_ON_LIGHT: readonly BlockGradient[] = ALL_BLOCKS.map((b) =>
  blockGradient(b, STOPS_ON_LIGHT),
)

// ── 动效参数（§3.1 – §3.4）─────────────────────────────────────────

/** 缓动（§3.1）。 */
export const EASING = {
  /** 主体入场 */
  enter: 'cubic-bezier(.22, 1, .36, 1)',
  /** 领头块回弹 */
  lead: 'cubic-bezier(.34, 1.56, .64, 1)',
  /** 过场进出（横掠用；产品内不用横掠，留着是为了别处复用） */
  transition: 'cubic-bezier(.65, 0, .35, 1)',
} as const

/** 集结：五块的延迟与领头块的延迟（§3.2）。 */
export const ASSEMBLE_DELAYS_MS: readonly number[] = [0, 100, 160, 240, 300]
export const ASSEMBLE_LEAD_DELAY_MS = 380

export interface Offset {
  readonly dx: number
  readonly dy: number
}

/**
 * 一变一队：五块相对领头块的位移（§3.3）。
 *
 * 就是"领头块的位置减自己的位置"——五块**从领头那一块里分出去**，
 * 演的是品牌故事本身：一个活做通了，复制成一队。
 */
export const SPLIT_OFFSETS: readonly Offset[] = BLOCKS.map((b) => ({
  dx: LEAD.x - b.x,
  dy: LEAD.y - b.y,
}))

/** 一变一队：领头块先出现，其余五块间隔 100ms 依次分出去（§3.3）。 */
export const SPLIT_LEAD_MS = 0
export const SPLIT_FIRST_DELAY_MS = 300
export const SPLIT_STEP_MS = 100

/** 呼吸（§3.4）：六块错峰缩放 0.94↔1、透明度 0.55↔1，相位差 46ms，2.6s 一轮。 */
export const BREATHE_PERIOD_MS = 2600
export const BREATHE_PHASE_MS = 46
export const BREATHE_SCALE = [0.94, 1] as const
export const BREATHE_OPACITY = [0.55, 1] as const
