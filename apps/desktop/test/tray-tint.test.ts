import { describe, expect, it } from 'vitest'
import { tintBitmap, WINDOWS_TRAY_TINT } from '../src/tray-tint.js'

describe('tintBitmap（WP218 Windows 托盘图标上色）', () => {
  it('颜色换成品牌青绿，透明度原样', () => {
    const src = Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 0, 10, 20, 30, 128])
    const { r, g, b } = WINDOWS_TRAY_TINT
    expect([...tintBitmap(src)]).toEqual([b, g, r, 255, b, g, r, 0, b, g, r, 128])
  })

  it('可以指定颜色；尾巴上不满 4 字节的残片不管', () => {
    expect([...tintBitmap(Uint8Array.from([0, 0, 0, 9, 7]), { r: 1, g: 2, b: 3 })]).toEqual([
      3, 2, 1, 9, 0,
    ])
  })
})
