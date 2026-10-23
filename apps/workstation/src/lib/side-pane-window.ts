/**
 * WP481（决策 1632，Luoye 10-23「不要挤压中栏宽度去显示本应该另外开一个右栏显示的」）：
 * 右栏（第三栏）怎么开才不挤中栏。
 *
 * - **桌面壳**（桥上有 `sidePane`）：右栏要开时告诉壳「要一个多宽的右栏」，壳把窗口**向右加宽**那么宽
 *   （中栏宽度不变、左边位置不动），回 `widened` → 右栏并排；关掉告诉壳 `null`，窗口缩回原宽。
 *   窗口已最大化 / 全屏 / 右边没地方时壳回 `overlay` → 右栏改成**从右侧滑出的浮层**盖在中栏右侧，中栏不重排。
 *   人手动拖过窗口大小，壳以人的为准（不再动窗口）。
 * - **浏览器里 / 老壳**（没有 `sidePane`）：一律浮层。
 *
 * 这里只管「跟壳说一声、记下答复」。外壳里只有一个地方说（`RailHost`，{@link useSidePaneSync}），
 * 顶栏与宿主都按 {@link useSidePaneMode} 读同一个答复（模块级的一份，和 `right-pane.ts` 一个做法）。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

/** 右栏这会儿的摆法：`widened` 并排（窗口加宽了）/ `overlay` 浮层 / `pending` 刚开、等壳回话（先不画）。 */
export type SidePaneMode = 'widened' | 'overlay' | 'pending'

interface SidePaneBridgeLike {
  sync(width: number | null): Promise<'widened' | 'overlay' | 'none'>
}

function sidePaneBridge(): SidePaneBridgeLike | undefined {
  const w = globalThis.window as unknown as
    | { agentsws?: { sidePane?: Partial<SidePaneBridgeLike> } }
    | undefined
  const sync = w?.agentsws?.sidePane?.sync
  return typeof sync === 'function' ? { sync: sync.bind(w?.agentsws?.sidePane) } : undefined
}

/** 现在能不能加宽窗口（在有 `sidePane` 的桌面壳里）。 */
export function canWidenWindow(): boolean {
  return sidePaneBridge() !== undefined
}

/** 拖右栏的宽 / 换一格时，停这么久再跟壳说（拖的过程中不一帧一帧地改窗口）。 */
export const WIDTH_SETTLE_MS = 250
/** 收起时等这么久再缩窗口：换一格（先收后开）时窗口不来回弹。 */
export const CLOSE_SETTLE_MS = 150

let mode: SidePaneMode = 'overlay'
const listeners = new Set<() => void>()
const setMode = (next: SidePaneMode): void => {
  if (mode === next) return
  mode = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** 右栏这会儿怎么摆（没在桌面壳里一律 `overlay`）。 */
export function useSidePaneMode(): SidePaneMode {
  return useSyncExternalStore(
    subscribe,
    () => mode,
    () => mode,
  )
}

/** 只给测试用。 */
export function resetSidePaneMode(): void {
  mode = 'overlay'
}

/**
 * 外壳里那一个右栏宿主调用：`width` = 右栏要多宽（CSS 像素；`null` = 收着）。
 * 开 → 立刻问壳（等回话时 `pending`）；换宽度 → 停 {@link WIDTH_SETTLE_MS} 再问；收 → 停 {@link CLOSE_SETTLE_MS} 再缩。
 * 挂上时先说一次「收着」（页面重载前窗口加宽过、这会儿没开右栏，壳把它缩回去）。
 */
export function useSidePaneSync(width: number | null): void {
  const last = useRef<number | null | undefined>(undefined)
  const seq = useRef(0)
  useEffect(() => {
    const bridge = sidePaneBridge()
    if (bridge === undefined) {
      setMode('overlay')
      return
    }
    const prev = last.current
    last.current = width
    if (prev === width) return
    const ask = (): void => {
      const mine = ++seq.current
      bridge
        .sync(width)
        .then((answer) => {
          if (mine !== seq.current || width === null) return
          setMode(answer === 'widened' ? 'widened' : 'overlay')
        })
        .catch(() => {
          if (mine === seq.current && width !== null) setMode('overlay')
        })
    }
    if (width !== null && (prev === null || prev === undefined)) {
      // 刚开：等壳回话之前先不画（不然先挤一下中栏再弹开）
      setMode('pending')
      ask()
      return
    }
    const timer = setTimeout(ask, width === null ? CLOSE_SETTLE_MS : WIDTH_SETTLE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [width])
  // 外壳拆掉（退出登录 / 整页换掉）：右栏也就没了，窗口缩回
  useEffect(
    () => () => {
      seq.current += 1
      last.current = undefined
      // 幂等：没加宽过壳那边什么都不做
      void sidePaneBridge()
        ?.sync(null)
        .catch(() => 'none')
    },
    [],
  )
}
