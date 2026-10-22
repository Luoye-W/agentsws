import { describe, expect, it } from 'vitest'
import { isSupersededLoad } from '../src/load-superseded.js'

describe('窗口加载被更新的一次顶掉（ERR_ABORTED）', () => {
  it('认得出 Electron 的 -3', () => {
    expect(
      isSupersededLoad(Object.assign(new Error('x'), { code: 'ERR_ABORTED', errno: -3 })),
    ).toBe(true)
    expect(isSupersededLoad(new Error("Error:  (-3) loading 'http://127.0.0.1:57425/'"))).toBe(true)
  })
  it('别的加载错误照旧算错', () => {
    expect(
      isSupersededLoad(
        Object.assign(new Error('x'), { code: 'ERR_CONNECTION_REFUSED', errno: -102 }),
      ),
    ).toBe(false)
    expect(isSupersededLoad(new Error("Error:  (-102) loading 'http://127.0.0.1:1/'"))).toBe(false)
    expect(isSupersededLoad(undefined)).toBe(false)
    expect(isSupersededLoad('ERR_ABORTED')).toBe(false)
  })
})
