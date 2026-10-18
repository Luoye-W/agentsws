/**
 * WP424（Luoye 10-19）：桌面壳把系统标题栏藏起来了没有（学 Claude 桌面版的顶栏）。
 *
 * 判据是壳的桥上有没有 `titleBar`（`@agentsws/desktop` 的 `DesktopTitleBarBridge`，preload 只在
 * 主窗口藏了标题栏时才给）——工作台不 import 桌面壳的任何东西，只在运行时看一眼 `window.agentsws`。
 *
 * - `inset`（Mac）：红黄绿三个按钮嵌在左上——左栏顶部留出它们的位置，窄窗（左栏收起）时顶栏左边让出；
 * - `overlay`（Windows）：三个系统按钮叠在右上——顶栏右边让出（`env(titlebar-area-*)`），颜色跟主题；
 * - 普通浏览器、老壳、Linux：`undefined`，照普通网页排，不留那块空、不设拖动区。
 */
import { createElement, type ReactNode, useEffect } from 'react'

export type DesktopChrome = 'inset' | 'overlay'

interface TitleBarBridgeLike {
  style?: unknown
  setTheme?: (theme: 'light' | 'dark') => Promise<boolean>
}

function titleBarBridge(): TitleBarBridgeLike | undefined {
  const w = globalThis.window as unknown as
    | { agentsws?: { titleBar?: TitleBarBridgeLike } }
    | undefined
  return w?.agentsws?.titleBar
}

/** 现在是不是在藏了标题栏的桌面壳里、是哪一种。 */
export function desktopChrome(): DesktopChrome | undefined {
  const style = titleBarBridge()?.style
  return style === 'inset' || style === 'overlay' ? style : undefined
}

/** 工作台换了深 / 浅色 → 告诉壳（Windows 叠加按钮那一块跟着换底色）。不在壳里什么都不做。 */
export function useDesktopChromeTheme(theme: 'light' | 'dark'): void {
  useEffect(() => {
    const bridge = titleBarBridge()
    if (bridge?.setTheme === undefined) return
    void bridge.setTheme(theme).catch(() => false)
  }, [theme])
}

/**
 * 没有外壳的那几屏（登录页、启动集结）顶上一条 28px 的拖动区——藏了标题栏之后，不给它这一条
 * 窗口就拖不动了。外壳挂上之后由 CSS 收起（`html[data-shell] .ws-drag-strip`），顶栏自己能拖。
 */
export function DesktopDragStrip(): ReactNode {
  if (desktopChrome() === undefined) return null
  return createElement('div', {
    'aria-hidden': true,
    'data-testid': 'desktop-drag-strip',
    className: 'ws-drag ws-drag-strip fixed inset-x-0 top-0 z-[60] h-7',
  })
}
