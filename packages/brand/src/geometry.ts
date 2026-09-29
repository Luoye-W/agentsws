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

/**
 * 一变一队两段各自的时长（§3.3 那段 CSS 里的数，WP195 提到这里）：领头 0.5s，五块各 0.55s。
 * 工作台「悬停播一次一变一队再回待机」要知道整段多长，才知道什么时候回去。
 */
export const SPLIT_LEAD_DURATION_MS = 500
export const SPLIT_BLOCK_DURATION_MS = 550

/** 一变一队整段播完要多久：最后一块起步的延迟 + 它自己那 0.55s（领头那 0.5s 早就完了）。 */
export const SPLIT_TOTAL_MS = Math.max(
  SPLIT_LEAD_MS + SPLIT_LEAD_DURATION_MS,
  SPLIT_FIRST_DELAY_MS + (BLOCKS.length - 1) * SPLIT_STEP_MS + SPLIT_BLOCK_DURATION_MS,
)

// ── 待机（WP195，Luoye 09-29「静态的 logo 其实不好看」）────────────────

/**
 * 待机：给**一直挂在屏幕上**的标记用（左栏顶部、登录页、空态……）。
 *
 * 母品牌规范里没有这一段——它是产品界面自己加的第五种姿态，所以参数只在这里，
 * 不回规范对表。四条共同的规矩：
 *
 * 1. **一轮 ≥ 6 秒，大部分时间一动不动**：动的那一下不到一轮的五分之一；
 * 2. **幅度小**：位移不超过方块间缝（7 个单位）的一半多一点，24px 时约 1.5px；
 * 3. **只动 transform**：不动颜色、不动渐变、不动布局——GPU 合成层就能跑完；
 * 4. **和呼吸分得开**：呼吸是一直在起伏（缩放 + 透明度，2.6s 一轮，说的是
 *    「Agent 正在干活」）；待机是长时间静止里偶尔一下，说的只是「这个牌子是活的」。
 *
 * 位移的单位是标记自己的坐标（外框 65×65），CSS 里写成 `px` 就是这个单位。
 */
export type IdleStyle = 'wave-sheen' | 'wave' | 'sheen' | 'blink'

/**
 * 四个候选，预览页（`docs/design/brand-motion.html`）按这个顺序并排放着让 Luoye 挑。
 * `wave-sheen`（波 + 流光）是 Luoye 09-29 看完前三个之后点的「波和流光结合看看」，排最前。
 */
export const IDLE_STYLES: readonly IdleStyle[] = ['wave-sheen', 'wave', 'sheen', 'blink']

/**
 * 默认那一个：波 + 流光（理由写在 `docs/briefs/reports/WP195.md`：光与起伏是同一件事，
 * 比单独的波多一层"有光扫过"的质感，又不像单独的流光那样块一动不动、小尺寸几乎看不见）。
 */
export const DEFAULT_IDLE_STYLE: IdleStyle = 'wave-sheen'

/**
 * 待机只给**渐变**那一档：单色（小于 `MIN_GRADIENT_PX`，或明写 mono）一律不挂。
 * 那么小的标记一动，看起来就是抖——模型列表里的小图标只在悬停时播一次。
 */
export const MIN_IDLE_PX = MIN_GRADIENT_PX

/** 挂上之后先静这么久才动第一下——一打开就动，像在抢注意力。 */
export const IDLE_START_MS = 1600

/**
 * 波：六块沿渐变方向（左下 → 右上，领头最后）依次轻轻抬起再落回，一轮 7.2s。
 *
 * 每块抬起 4 个单位用 0.36s、落回用 0.54s，然后一直静到下一轮。
 * 先后顺序按每块中心在渐变轴上的位置排——波走的就是那条渐变的方向。
 */
export const IDLE_WAVE = {
  periodMs: 7200,
  riseMs: 360,
  fallMs: 540,
  lift: 4,
  /** 第一块到领头之间拉开多少毫秒。 */
  spreadMs: 480,
} as const

/**
 * 流光：一道很淡的亮带沿渐变方向从左下扫到右上，只落在方块上，一轮 8s，扫一次 1.5s。
 *
 * 亮带是一层叠在方块上的白色渐变（被六块裁出来），动的只是它的位置——
 * 标记本身的颜色一个像素都不改。
 */
export const IDLE_SHEEN = {
  periodMs: 8000,
  sweepMs: 1500,
  /** 亮带最亮处的不透明度。 */
  peakOpacity: 0.5,
  /** 亮带宽度占整条对角线的比例（两侧羽化各一半）。 */
  bandWidth: 0.4,
} as const

/**
 * 眨眼：隔 9s，领头那块往右上方探出一点再归位（回来时带一下回弹，缓动用 `EASING.lead`），
 * 其余五块不动。
 *
 * 演的还是品牌故事：领头的那一个先动。
 */
export const IDLE_BLINK = {
  periodMs: 9000,
  outMs: 270,
  backMs: 450,
  /** 探出去的位移（右上，单位同上）。 */
  dx: 3,
  dy: -3,
} as const

/** 某块中心在渐变轴上的位置（0–1）。 */
function blockAxis(b: Block): number {
  return axisParam(b.x + BLOCK_SIZE / 2, b.y + BLOCK_SIZE / 2)
}

/**
 * 波：六块（b1…b5 + 领头，顺序同 `ALL_BLOCKS`）各自的起步延迟，不含 `IDLE_START_MS`。
 *
 * 按中心在渐变轴上的位置线性排进 `0 … spreadMs`：最靠左下那块 0，领头 `spreadMs`。
 */
export const IDLE_WAVE_DELAYS_MS: readonly number[] = (() => {
  const t = ALL_BLOCKS.map(blockAxis)
  const lo = Math.min(...t)
  const hi = Math.max(...t)
  return t.map((v) => Math.round(((v - lo) / (hi - lo)) * IDLE_WAVE.spreadMs))
})()

/** 毫秒 → 一轮里的百分比（keyframes 用），保留三位小数。 */
export function idlePercent(ms: number, periodMs: number): string {
  return `${Number(((ms / periodMs) * 100).toFixed(3))}%`
}

/**
 * 波 + 流光（Luoye 09-29「波和流光的一个结合看看」）：**同一道光带着方块起伏**。
 *
 * 一道亮带沿渐变方向**匀速**从左下扫到右上（2s），扫过哪块，哪块就在亮带中心经过它中心的
 * 那一刻抬到最高再落回。两件事不是两套各跑各的动画：每块抬起的延迟是从亮带的位置
 * 算出来的（`IDLE_WAVE_SHEEN_DELAYS_MS`），亮带匀速走（linear），所以对得上。
 *
 * 亮带每块一份、被那块自己裁出来、和那块一起抬——抬起的块上不会有光漏到缝里。
 * 暗底上亮度压在 0.42：看得见，不刺眼。一轮 8s，其余 6s 一动不动。
 */
export const IDLE_WAVE_SHEEN = {
  periodMs: 8000,
  sweepMs: 2000,
  /** 亮带中心从渐变轴 `0.5 - travel` 走到 `0.5 + travel`（= 两头都完全出了标记）。 */
  travel: 0.7,
  peakOpacity: 0.42,
  bandWidth: 0.4,
  lift: 3,
  riseMs: 280,
  fallMs: 460,
} as const

/**
 * 波 + 流光：六块（顺序同 `ALL_BLOCKS`）各自开始抬起的时刻，从亮带起扫算起，不含 `IDLE_START_MS`。
 *
 * 亮带中心在渐变轴上的位置 u(t) = 0.5 − travel + 2·travel·t / sweepMs（匀速）；
 * 它经过某块中心（轴上位置 tb）的时刻减去抬起用的 `riseMs`，就是那块起步的时刻——
 * 于是亮带正好在那块抬到最高时经过它。
 */
export const IDLE_WAVE_SHEEN_DELAYS_MS: readonly number[] = ALL_BLOCKS.map((blk) => {
  const w = IDLE_WAVE_SHEEN
  const cross = ((blockAxis(blk) - 0.5 + w.travel) / (2 * w.travel)) * w.sweepMs
  return Math.round(cross - w.riseMs)
})

// ── 流光在明暗两种底上的颜色（WP200）─────────────────────────────────

/**
 * 那道光的颜色与力度：`color` 是亮带的颜色，`strength` 乘在亮带最亮处的不透明度上
 * （`IDLE_WAVE_SHEEN.peakOpacity` / `IDLE_SHEEN.peakOpacity`）。
 */
export interface SheenTint {
  readonly color: string
  readonly strength: number
}

/** 深底：纯白、原样（WP195 调好的那一版，不动）。 */
export const SHEEN_ON_DARK: SheenTint = { color: '#FFFFFF', strength: 1 }

/**
 * 浅底（WP200，Luoye 09-29 同意）：纯白 0.42 扫过压暗那套端点时，那块会短暂发白
 * （WP195 截图 `compare-1000ms.png`）。换成一道**极淡的品牌青**、力度压到一半多一点
 * （波 + 流光最亮处 0.42 × 0.55 ≈ 0.23）：光还看得见，块不再褪成灰白。
 *
 * 没用深底那套亮青（`#2FE0C8`）：它扫过领头那块时会把品牌黄染成绿。
 */
export const SHEEN_ON_LIGHT: SheenTint = { color: '#E0FAF4', strength: 0.55 }

/**
 * 亮带那一层的矩形（WP200 修「块中间一条竖直分界」）。
 *
 * WP195 的亮带是一个和外框一样大（65×65）的矩形，渐变用 `objectBoundingBox` 从它的左下角到
 * 右上角。那样亮带最亮的那条线正好是矩形的另一条对角线（左上角 → 右下角），**亮带在矩形的四条边
 * 上被切断**；矩形一平移，它竖直的右边 / 水平的上边就扫过方块，块中间于是出现一条硬的明暗分界
 * （96px 起肉眼可见，官网首屏 180px 更明显）。和尺寸、精度无关，是几何上的。
 *
 * 修法：渐变改成 `userSpaceOnUse`、轴就是 `GRADIENT_AXIS`（= 原来那个 65×65 矩形的左下 → 右上，
 * 所以光的位置、宽度、亮度一个像素都不变），矩形往四周各放宽两个外框（325×325）。平移最远
 * ±65（单独的流光）时它离标记四边仍有一个外框远，被切断的地方永远裁不到块上。
 */
export const SHEEN_BAND_BOX = {
  x: MARK_BOX.x - 2 * MARK_BOX.width,
  y: MARK_BOX.y - 2 * MARK_BOX.height,
  width: MARK_BOX.width * 5,
  height: MARK_BOX.height * 5,
} as const
