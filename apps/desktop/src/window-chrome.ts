/**
 * WP424（Luoye 10-19 真机）：主窗口的顶栏学 Claude 桌面版。
 *
 * 以前是系统默认的标题栏：Mac 上一条黑色的空「Agents 工坊」压在工作台自己的顶栏上面，很割裂。
 * 现在系统标题栏藏起来，窗口按钮嵌进工作台自己那条 44px 的顶栏：
 *
 * - **Mac**：`titleBarStyle: 'hidden'` + `trafficLightPosition`——红黄绿三个按钮落在左栏顶部、
 *   与工作台顶栏同一条水平线上（左栏顶部给它们留位置，见工作台 `app-shell.tsx`）；
 * - **Windows**：`titleBarStyle: 'hidden'` + `titleBarOverlay`——右上角三个系统按钮叠在顶栏上，
 *   颜色跟工作台的深 / 浅主题（页面经桥 `titleBar.setTheme` 告诉壳），工作台顶栏右边按
 *   `env(titlebar-area-*)` 让出那一截；
 * - **Linux**：照旧系统标题栏（各家窗口管理器的叠加支持参差不齐，不赌）。
 *
 * 拖动窗口靠工作台顶栏的 `-webkit-app-region: drag`（上面的按钮 `no-drag`）。
 * 工作台怎么知道自己在藏了标题栏的壳里：桥的 `titleBar` 在不在（老壳没有它，页面就不留那块空）。
 *
 * 本文件不 import electron（纯数据，vitest 直接测）。
 */

/** 工作台顶栏的高度（`app-shell.tsx` 的 `h-11`）。窗口按钮按它居中。 */
export const TITLE_BAR_HEIGHT = 44

/** 桥上报给页面的样子：`inset` = Mac 红绿灯嵌在左上；`overlay` = Windows 按钮叠在右上。 */
export type TitleBarStyle = 'inset' | 'overlay'

export type ChromeTheme = 'light' | 'dark'

/**
 * 两种主题下顶栏的底色与按钮颜色——与工作台 `index.css` 的 `--ws-paper` / `--ws-ink` 同值
 * （顶栏是 `bg-ws-paper`），叠上去的系统按钮才和顶栏是一块。
 */
export const TITLE_BAR_COLORS: Readonly<
  Record<ChromeTheme, { color: string; symbolColor: string }>
> = {
  light: { color: '#f3f5f2', symbolColor: '#263331' },
  dark: { color: '#0e100f', symbolColor: '#f1f4f0' },
}

/** 这个平台上主窗口藏不藏系统标题栏、怎么藏。Linux 回 `undefined`（照旧）。 */
export function titleBarStyleOf(platform: string): TitleBarStyle | undefined {
  if (platform === 'darwin') return 'inset'
  if (platform === 'win32') return 'overlay'
  return undefined
}

/** Windows 叠加按钮那一块的参数（`titleBarOverlay` / `setTitleBarOverlay` 都吃这个形状）。 */
export function titleBarOverlay(theme: ChromeTheme): {
  color: string
  symbolColor: string
  height: number
} {
  return { ...TITLE_BAR_COLORS[theme], height: TITLE_BAR_HEIGHT }
}

/**
 * 主窗口构造参数里与标题栏有关的那几项（摊进 `new BrowserWindow({...})`）。
 *
 * Mac 红绿灯：三个按钮约 12px 高，`y = (44 − 12) / 2 = 16` 正好落在顶栏中线上；`x = 16` 与左栏内边距对齐。
 */
export function windowChromeOptions(
  platform: string,
  theme: ChromeTheme = 'light',
): {
  titleBarStyle?: 'hidden'
  trafficLightPosition?: { x: number; y: number }
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
} {
  const style = titleBarStyleOf(platform)
  if (style === 'inset') return { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 16 } }
  if (style === 'overlay')
    return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(theme) }
  return {}
}

/** 页面经桥发来的主题：只认 `light` / `dark`，别的一律不理（回 `undefined`）。 */
export function parseChromeTheme(raw: unknown): ChromeTheme | undefined {
  return raw === 'light' || raw === 'dark' ? raw : undefined
}
