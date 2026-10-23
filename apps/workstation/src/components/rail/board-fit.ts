/**
 * WP437（Luoye 10-21「中栏宽度优先」）：三栏怎么摆，一处算。
 *
 * [左栏] [中栏：核心内容区 + 靠右的看板（卡片列）] [第三栏：点了才弹出的那一格]
 *
 * - **核心内容区最小宽度** {@link CORE_MIN_WIDTH}：对话 / 内容那一块（含它自己左右各 28px 的边距）至少这么宽。
 *   600 的依据：正文 544px ≈ 15px 字一行 36 个汉字（读起来不挤）；底部那个完整对话框（最宽 760）缩到 544 时
 *   左下「+ / 模型 / 思考档」和右下「发送」还排得进一行；「要你拍板」的卡上两三个按钮不折行。再窄就开始折。
 * - **看板**宽度跟窗口走（{@link boardWidthAt}，300–400）。中栏可用宽度 = 窗口 − 左栏 − 并排开着的第三栏；
 *   放不下「核心区最小宽度 + 看板」时看板**自动隐藏**，放得下了自动回来。不在本机记「手动收起」——宽度够了就一定显示。
 * - **第三栏**并排时占它自己的宽度（拖出来的，320–720，最多半个窗口）；并排之后核心区连最小宽度都保不住
 *   （或窗口窄于 900）时，第三栏改成**盖在中栏上**（带遮罩，点外面 / × 收起），不再挤中栏。
 *
 * 宽度从外壳量（`shell-body` 那一块 = 窗口 − 左栏，ResizeObserver），量不到时（单测、没有外壳）当作放得下。
 *
 * WP481（决策 1632，Luoye 10-23「不要挤压中栏宽度」）：第三栏**一律不挤中栏**——
 * - 桌面壳能把窗口向右加宽（`lib/side-pane-window.ts` 回 `widened`）：窗口多出来的那一截就是第三栏，并排，
 *   中栏宽度和开之前一样；看板宽度按「窗口 − 第三栏」算（不然窗口变宽看板跟着变宽，中栏反倒窄了）。
 *   人把窗口拖窄了、并排后核心区保不住最小宽度，照旧改成盖上去。
 * - 放不下（最大化 / 全屏 / 右边没地方）、浏览器里、老壳（`overlay`）：第三栏从右侧滑出、盖在中栏右侧，中栏不重排。
 */
import { createContext, useContext } from 'react'

/** 核心内容区最小宽度（px，含左右边距）。 */
export const CORE_MIN_WIDTH = 600
/** 看板宽度：窗口的 26%，夹在 300–400。 */
export const BOARD_MIN_WIDTH = 300
export const BOARD_MAX_WIDTH = 400
const BOARD_VW = 0.26
/** 第三栏并排时最窄 300、最宽半个窗口（与外壳里那一格的 min / max 同一份）。 */
export const THIRD_DOCK_MIN_WIDTH = 300
/** 窗口窄于这个宽度（接近手机），第三栏一律盖在中栏上。 */
export const THIRD_OVERLAY_BELOW = 900

export function boardWidthAt(viewport: number): number {
  return Math.round(Math.min(BOARD_MAX_WIDTH, Math.max(BOARD_MIN_WIDTH, viewport * BOARD_VW)))
}

/** 第三栏并排时实际占多宽（拖出来的宽度，夹在 300 与半个窗口之间）。 */
export function thirdDockedWidth(width: number, viewport: number): number {
  return Math.round(Math.max(THIRD_DOCK_MIN_WIDTH, Math.min(width, viewport * 0.5)))
}

export interface ShellSize {
  /** 中栏 + 第三栏能用的宽度（窗口 − 左栏）；0 = 量不到。 */
  body: number
  /** 窗口宽度（看板 / 第三栏按它定宽）。 */
  viewport: number
}

export interface ColumnsLayout {
  /** 看板放得下（显示在中栏右边）。 */
  board: boolean
  /** 看板宽度（px）。 */
  boardWidth: number
  /** 第三栏开着且盖在中栏上（不占宽度）。 */
  overlay: boolean
  /** 第三栏并排占掉的宽度（收着 / 盖着时 0）。 */
  third: number
  /** 核心内容区这会儿有多宽（量不到时 0）。 */
  core: number
}

/**
 * 三栏怎么摆。`third` 是第三栏要的宽度（收着时 `null`）。
 * 量不到宽度（`body <= 0`）时：看板照常显示，第三栏只在窗口窄于 900 时盖上去。
 */
export function columnsLayout({
  size,
  third,
  narrow,
  docking = 'widened',
}: {
  size: ShellSize
  third: number | null
  /** 窗口窄于 900（媒体查询给的；量不到宽度时靠它）。 */
  narrow: boolean
  /**
   * WP481：窗口为第三栏加宽了没有（`widened` = 加宽了，可以并排；`overlay` = 没加宽——浏览器里、老壳、
   * 最大化 / 全屏 / 右边没地方——第三栏一律盖上去，不挤中栏）。
   */
  docking?: 'widened' | 'overlay'
}): ColumnsLayout {
  const viewport = size.viewport > 0 ? size.viewport : size.body
  if (size.body <= 0) {
    return {
      board: true,
      boardWidth: boardWidthAt(viewport),
      overlay: third !== null && (narrow || docking === 'overlay'),
      third: 0,
      core: 0,
    }
  }
  const docked = third === null ? 0 : thirdDockedWidth(third, viewport)
  const overlay =
    third !== null &&
    (docking === 'overlay' ||
      narrow ||
      viewport < THIRD_OVERLAY_BELOW ||
      size.body - docked < CORE_MIN_WIDTH)
  const taken = third !== null && !overlay ? docked : 0
  // 看板按「窗口 − 并排的第三栏」定宽：窗口为第三栏加宽了，看板不跟着变宽
  const boardWidth = boardWidthAt(viewport - taken)
  const board = size.body - taken - boardWidth >= CORE_MIN_WIDTH
  return {
    board,
    boardWidth,
    overlay,
    third: taken,
    core: size.body - taken - (board ? boardWidth : 0),
  }
}

/** 外壳量出来的宽度（没有外壳 = 量不到）。 */
export const ShellSizeContext = createContext<ShellSize>({ body: 0, viewport: 0 })

export function useShellSize(): ShellSize {
  return useContext(ShellSizeContext)
}
