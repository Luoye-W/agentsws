/**
 * WP339：主窗口「窗口多大、网页就多大」的体检，对不上就落一行 desktop.log。
 *
 * Luoye 10-15 在 Windows 真机上见过：拖了窗口大小之后，界面停在窗口左上一块、右边和下边留白，
 * 再怎么拖也不跟着变；重启后恢复。当时 desktop.log 里一行相关记录都没有，事后无从判断是
 * 网页以为自己还是旧尺寸（视口没跟上），还是网页尺寸对、只是画面没跟上（显卡合成那一层）。
 *
 * 现在：窗口换大小 / 最大化 / 还原 / 全屏进出、显示器增减或缩放变化之后，停 1 秒再量一次——
 * 网页视口（innerWidth × 缩放）和窗口内容区（getContentBounds）差过 2 像素就记一行 WARN，
 * 对回来了再记一行 INFO；显示器那几件事本身也各记一行（编号、缩放、尺寸）。**只记，不动窗口。**
 *
 * 这里**不 import electron**（README：只有 main.ts / preload 碰它），收的是够用的那几个方法。
 */
import type { Logger } from './logging.js'

interface Size {
  width: number
  height: number
}

/** `BrowserWindow` 里用得到的那一点。 */
export interface FitWindow {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  isDestroyed(): boolean
  getContentBounds(): Size
  webContents: {
    getZoomFactor(): number
    executeJavaScript(code: string): Promise<unknown>
  }
}

/** `screen` 里用得到的那一点。 */
export interface FitScreen {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface FitOptions {
  /** 最后一次变化之后等多久再量（毫秒）。默认 1000。 */
  delayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface FitSample {
  window: Size
  zoom: number
  page: Size
  dpr: number
}

const TOLERANCE = 2

/** 网页视口（CSS 像素 × 缩放 = 窗口坐标）和窗口内容区差过 2 像素算对不上。 */
export function fitMismatch(sample: FitSample): boolean {
  return (
    Math.abs(sample.page.width * sample.zoom - sample.window.width) > TOLERANCE ||
    Math.abs(sample.page.height * sample.zoom - sample.window.height) > TOLERANCE
  )
}

const WINDOW_EVENTS = [
  'resize',
  'maximize',
  'unmaximize',
  'restore',
  'enter-full-screen',
  'leave-full-screen',
] as const

const SCREEN_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'] as const

const describeDisplay = (raw: unknown): Record<string, unknown> => {
  const d = raw as { id?: unknown; scaleFactor?: unknown; bounds?: Partial<Size> } | undefined
  return {
    id: d?.id,
    scale: d?.scaleFactor,
    size: d?.bounds === undefined ? undefined : `${d.bounds.width}x${d.bounds.height}`,
  }
}

/** 挂上体检；窗口关了自动把 `screen` 上的监听摘掉。 */
export function watchWindowFit(
  win: FitWindow,
  screen: FitScreen,
  logger: Logger,
  options: FitOptions = {},
): void {
  const delay = options.delayMs ?? 1000
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let timer: unknown
  let mismatched = false

  const check = async (): Promise<void> => {
    if (win.isDestroyed()) return
    const window = win.getContentBounds()
    const zoom = win.webContents.getZoomFactor()
    let raw: unknown
    try {
      raw = await win.webContents.executeJavaScript(
        '[window.innerWidth, window.innerHeight, window.devicePixelRatio]',
      )
    } catch {
      return // 页面正在换 / 还没加载好：下次变化再量
    }
    if (!Array.isArray(raw) || raw.length < 3 || win.isDestroyed()) return
    const [w, h, dpr] = raw.map(Number)
    const sample: FitSample = {
      window: { width: window.width, height: window.height },
      zoom,
      page: { width: w ?? 0, height: h ?? 0 },
      dpr: dpr ?? 0,
    }
    const bad = fitMismatch(sample)
    const fields = {
      window: `${sample.window.width}x${sample.window.height}`,
      page: `${sample.page.width}x${sample.page.height}`,
      zoom: sample.zoom,
      dpr: sample.dpr,
    }
    if (bad && !mismatched) logger.warn('窗口和网页尺寸对不上（网页没跟着窗口变）', fields)
    if (!bad && mismatched) logger.info('窗口和网页尺寸又对上了', fields)
    mismatched = bad
  }

  const schedule = (): void => {
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(() => {
      timer = undefined
      void check()
    }, delay)
  }

  for (const event of WINDOW_EVENTS) win.on(event, schedule)

  const onScreen =
    (event: (typeof SCREEN_EVENTS)[number]) =>
    (...args: unknown[]) => {
      const changed = event === 'display-metrics-changed' ? { changed: args[2] } : {}
      logger.info(`显示器变化 ${event}`, { ...describeDisplay(args[1]), ...changed })
      schedule()
    }
  const screenListeners = SCREEN_EVENTS.map((event) => [event, onScreen(event)] as const)
  for (const [event, listener] of screenListeners) screen.on(event, listener)

  win.on('closed', () => {
    if (timer !== undefined) clearTimer(timer)
    for (const [event, listener] of screenListeners) screen.removeListener(event, listener)
  })
}
