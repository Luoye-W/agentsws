/** WP339：窗口换大小 / 显示器变化之后，网页视口和窗口内容区对不上就落一行 desktop.log。 */
import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/logging.js'
import { memoryFileStore } from '../src/node-files.js'
import { fitMismatch, watchWindowFit } from '../src/window-fit.js'
import { fakeClock } from './fakes.js'

function emitter() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return this
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      )
      return this
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) l(...args)
    },
    count(event: string) {
      return (listeners.get(event) ?? []).length
    },
  }
}

const setup = () => {
  const files = memoryFileStore()
  const logger = createLogger({ files, path: '/logs/desktop.log', clock: fakeClock() })
  const state = { content: { width: 1280, height: 800 }, page: [1280, 800, 1.5], zoom: 1 }
  const win = Object.assign(emitter(), {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    getContentBounds: () => state.content,
    webContents: {
      getZoomFactor: () => state.zoom,
      executeJavaScript: async () => state.page,
    },
  })
  const screen = emitter()
  const timers: Array<() => void> = []
  watchWindowFit(win, screen, logger, {
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {
      timers.length = 0
    },
  })
  return {
    state,
    win,
    screen,
    /** 跑掉排着的那次体检并等它落盘。 */
    flush: async () => {
      const due = timers.splice(0)
      for (const fn of due) fn()
      await new Promise((r) => setTimeout(r, 0))
    },
    pending: () => timers.length,
    lines: () => (files.readText('/logs/desktop.log') ?? '').split('\n').filter((l) => l !== ''),
  }
}

describe('fitMismatch', () => {
  const base = { window: { width: 1280, height: 800 }, zoom: 1, dpr: 1.5 }
  it('一样大、差 2 像素以内都算对得上', () => {
    expect(fitMismatch({ ...base, page: { width: 1280, height: 800 } })).toBe(false)
    expect(fitMismatch({ ...base, page: { width: 1278, height: 801 } })).toBe(false)
  })
  it('网页停在旧尺寸（Luoye 10-15 那种）算对不上', () => {
    expect(fitMismatch({ ...base, page: { width: 1131, height: 707 } })).toBe(true)
  })
  it('按缩放换算后再比', () => {
    expect(fitMismatch({ ...base, zoom: 1.25, page: { width: 1024, height: 640 } })).toBe(false)
  })
})

describe('watchWindowFit', () => {
  it('对得上不记；一连串 resize 只量最后一次', async () => {
    const t = setup()
    t.win.emit('resize')
    t.win.emit('resize')
    t.win.emit('maximize')
    expect(t.pending()).toBe(1)
    await t.flush()
    expect(t.lines()).toEqual([])
  })

  it('网页没跟上记一行 WARN（带两边尺寸），不重复记；对回来记一行 INFO', async () => {
    const t = setup()
    t.state.content = { width: 1600, height: 1000 }
    t.win.emit('resize')
    await t.flush()
    t.win.emit('resize')
    await t.flush()
    let lines = t.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('WARN')
    expect(lines[0]).toContain('window=1600x1000')
    expect(lines[0]).toContain('page=1280x800')

    t.state.page = [1600, 1000, 1.5]
    t.win.emit('unmaximize')
    await t.flush()
    lines = t.lines()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('INFO')
    expect(lines[1]).toContain('又对上了')
  })

  it('显示器缩放变化记一行并排一次体检', async () => {
    const t = setup()
    t.screen.emit(
      'display-metrics-changed',
      {},
      { id: 7, scaleFactor: 1.25, bounds: { x: 0, y: 0, width: 2048, height: 1152 } },
      ['scaleFactor'],
    )
    expect(t.pending()).toBe(1)
    expect(t.lines()[0]).toContain('display-metrics-changed')
    expect(t.lines()[0]).toContain('scale=1.25')
    expect(t.lines()[0]).toContain('size=2048x1152')
  })

  it('页面量不到（正在换页）就跳过；窗口关了摘掉 screen 监听', async () => {
    const t = setup()
    t.win.webContents.executeJavaScript = async () => {
      throw new Error('navigating')
    }
    t.state.content = { width: 999, height: 999 }
    t.win.emit('resize')
    await t.flush()
    expect(t.lines()).toEqual([])
    expect(t.screen.count('display-added')).toBe(1)
    t.win.emit('closed')
    expect(t.screen.count('display-added')).toBe(0)
    expect(t.screen.count('display-metrics-changed')).toBe(0)
  })
})
