/** jsdom 里 Radix 需要的两个浏览器 API，jsdom 没实现。 */
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

if (globalThis.window !== undefined) {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  /*
   * jsdom 没有顶层（top layer）：`:modal` / `:popover-open` / `:fullscreen` 永远不成立。
   * nwsapi 2.2.27 匹配这几个伪类时会绕回 `matches` 自己、递归到栈溢出再吞掉异常，
   * floating-ui 每次算弹层位置都要对每一层祖先问一遍（`isTopLayer`）——一个下拉就能卡十几秒。
   */
  const nativeMatches = Element.prototype.matches
  const TOP_LAYER = new Set([':modal', ':popover-open', ':fullscreen'])
  Element.prototype.matches = function matches(this: Element, selector: string): boolean {
    return TOP_LAYER.has(selector) ? false : nativeMatches.call(this, selector)
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
