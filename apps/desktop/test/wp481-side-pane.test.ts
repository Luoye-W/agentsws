/** WP481（决策 1632）：右栏开着时主窗口向右加宽、关掉缩回；放不下 / 最大化走浮层；人拖过就照人的。 */
import { describe, expect, it } from 'vitest'
import { attachSidePane, parseSidePaneWidth, type Rect } from '../src/side-pane-window.js'

function fakeWindow(start: Rect = { x: 100, y: 80, width: 1280, height: 840 }) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const state = {
    bounds: { ...start },
    maximized: false,
    fullscreen: false,
    destroyed: false,
    sets: [] as Partial<Rect>[],
  }
  const emit = (event: string, ...args: unknown[]) => {
    for (const l of listeners.get(event) ?? []) l(...args)
  }
  const win = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return win
    },
    isDestroyed: () => state.destroyed,
    getBounds: () => ({ ...state.bounds }),
    setBounds(next: Partial<Rect>) {
      state.sets.push(next)
      state.bounds = { ...state.bounds, ...next }
      // Electron 上 setBounds 也会发 resize（不发 will-resize）
      emit('resize')
    },
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullscreen,
  }
  /** 人拖窗口边：先 will-resize，再真的变宽。 */
  const userResize = (width: number) => {
    emit('will-resize')
    state.bounds = { ...state.bounds, width }
    emit('resize')
  }
  return { win, state, emit, userResize }
}

const screenOf =
  (area: Rect = { x: 0, y: 25, width: 2560, height: 1415 }) =>
  (_bounds: Rect): Rect =>
    area

describe('WP481 右栏加宽窗口', () => {
  it('打开：窗口向右加宽右栏那么宽，左边位置不动；关掉缩回原宽', () => {
    const { win, state } = fakeWindow()
    const pane = attachSidePane(win, screenOf())
    expect(pane.sync(380)).toBe('widened')
    expect(state.bounds).toEqual({ x: 100, y: 80, width: 1660, height: 840 })
    expect(pane.sync(null)).toBe('none')
    expect(state.bounds).toEqual({ x: 100, y: 80, width: 1280, height: 840 })
  })

  it('同一宽度再说一遍是空操作（页面重载后对得上）；换一格（380 → 560）从原宽重新加', () => {
    const { win, state } = fakeWindow()
    const pane = attachSidePane(win, screenOf())
    pane.sync(380)
    pane.sync(380)
    expect(state.sets).toHaveLength(1)
    expect(pane.sync(560)).toBe('widened')
    expect(state.bounds.width).toBe(1280 + 560)
    expect(pane.state()).toEqual({ added: 560, userTook: false })
    pane.sync(null)
    expect(state.bounds.width).toBe(1280)
  })

  it('向右加宽会超出屏幕：不动窗口，回 overlay（页面改浮层）', () => {
    const { win, state } = fakeWindow({ x: 600, y: 80, width: 1280, height: 840 })
    const pane = attachSidePane(win, screenOf({ x: 0, y: 25, width: 1920, height: 1055 }))
    expect(pane.sync(380)).toBe('overlay')
    expect(state.sets).toHaveLength(0)
    expect(pane.sync(null)).toBe('none')
    expect(state.sets).toHaveLength(0)
  })

  it('正好贴到屏幕右边也算放得下（不往左挪窗口）', () => {
    const { win, state } = fakeWindow({ x: 260, y: 80, width: 1280, height: 840 })
    const pane = attachSidePane(win, screenOf({ x: 0, y: 25, width: 1920, height: 1055 }))
    expect(pane.sync(380)).toBe('widened')
    expect(state.bounds.x).toBe(260)
  })

  it('换成更宽的一格放不下：缩回原宽、改浮层', () => {
    const { win, state } = fakeWindow({ x: 100, y: 80, width: 1280, height: 840 })
    const pane = attachSidePane(win, screenOf({ x: 0, y: 25, width: 1800, height: 1055 }))
    expect(pane.sync(380)).toBe('widened')
    expect(pane.sync(560)).toBe('overlay')
    expect(state.bounds.width).toBe(1280)
    expect(pane.state()).toBeUndefined()
  })

  it('最大化 / 全屏：一律浮层，窗口不动', () => {
    const { win, state } = fakeWindow()
    const pane = attachSidePane(win, screenOf())
    state.maximized = true
    expect(pane.sync(380)).toBe('overlay')
    state.maximized = false
    state.fullscreen = true
    expect(pane.sync(380)).toBe('overlay')
    expect(state.sets).toHaveLength(0)
  })

  it('人拖了窗口大小：这一轮不再动窗口，关右栏也不缩回', () => {
    const { win, state, userResize } = fakeWindow()
    const pane = attachSidePane(win, screenOf())
    pane.sync(380)
    userResize(1500)
    expect(pane.state()?.userTook).toBe(true)
    // 换一格也不动窗口（照人的）
    expect(pane.sync(560)).toBe('widened')
    expect(state.bounds.width).toBe(1500)
    expect(pane.sync(null)).toBe('none')
    expect(state.bounds.width).toBe(1500)
    // 下一次再开从现在的宽度加
    expect(pane.sync(380)).toBe('widened')
    expect(state.bounds.width).toBe(1880)
  })

  it('没有 will-resize 的平台：宽度和设的对不上也算人动过', () => {
    const { win, state, emit } = fakeWindow()
    const pane = attachSidePane(win, screenOf())
    pane.sync(380)
    state.bounds = { ...state.bounds, width: 1400 }
    emit('resize')
    expect(pane.state()?.userTook).toBe(true)
  })

  it('加宽之后人又最大化：照人的，关右栏不缩', () => {
    const { win, state, emit } = fakeWindow()
    const pane = attachSidePane(win, screenOf())
    pane.sync(380)
    state.maximized = true
    emit('maximize')
    pane.sync(null)
    expect(state.sets).toHaveLength(1)
  })

  it('窗口关了：不再动它', () => {
    const { win, state } = fakeWindow()
    const pane = attachSidePane(win, screenOf())
    state.destroyed = true
    expect(pane.sync(380)).toBe('overlay')
    expect(pane.sync(null)).toBe('none')
    expect(state.sets).toHaveLength(0)
  })

  it('页面交来的宽度：正数取整、封顶 2000；null = 收起；别的不认', () => {
    expect(parseSidePaneWidth(380.4)).toBe(380)
    expect(parseSidePaneWidth(99999)).toBe(2000)
    expect(parseSidePaneWidth(null)).toBeNull()
    for (const bad of [0, -5, Number.NaN, '380', undefined, {}])
      expect(parseSidePaneWidth(bad)).toBeUndefined()
  })
})
