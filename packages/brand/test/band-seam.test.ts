/**
 * WP200：「波 + 流光」光扫到右下那块时块中间一条竖直分界（96px 起可见，官网 180px 更明显）。
 *
 * 根因是几何上的：WP195 的亮带矩形和外框一样大（65×65），渐变 `objectBoundingBox` 从它左下到右上，
 * 最亮那条线恰好是矩形的另一条对角线，亮带在矩形四条边上被切断；矩形平移时它的竖直右边扫过
 * 方块，就切出一条硬分界。修法：渐变改 `userSpaceOnUse`（轴 = `GRADIENT_AXIS`，光的位置、宽度不变），
 * 矩形放大到 `SHEEN_BAND_BOX`。这里钉住「矩形在整个平移过程中都盖满标记」这条不变式。
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCK_SIZE,
  GRADIENT_AXIS,
  IDLE_BLINK,
  IDLE_WAVE,
  IDLE_WAVE_SHEEN,
  MARK_BOX,
  markSvg,
  README_MARK_PAD,
  SHEEN_BAND_BOX,
} from '../src/index.js'

/** 亮带矩形平移 (dx, dy) 之后，是否盖满外框再往外 `m` 个单位的范围。 */
function covers(dx: number, dy: number, m: number): boolean {
  const r = SHEEN_BAND_BOX
  return (
    r.x + dx <= MARK_BOX.x - m &&
    r.y + dy <= MARK_BOX.y - m &&
    r.x + dx + r.width >= MARK_BOX.x + MARK_BOX.width + m &&
    r.y + dy + r.height >= MARK_BOX.y + MARK_BOX.height + m
  )
}

describe('亮带矩形不会在方块上被切断', () => {
  // 余量：抬起 / 探出的最大幅度，外加 README 那张四周留的边
  const margin = Math.max(IDLE_WAVE_SHEEN.lift, IDLE_WAVE.lift, IDLE_BLINK.dx, README_MARK_PAD)

  it('波 + 流光：平移 ±65×travel 的整段里都盖满标记', () => {
    const far = MARK_BOX.width * IDLE_WAVE_SHEEN.travel
    for (let k = 0; k <= 20; k += 1) {
      const d = -far + (2 * far * k) / 20
      expect(covers(d, -d, margin)).toBe(true)
    }
  })

  it('单独的流光：平移 ±65 的整段里都盖满标记', () => {
    const far = MARK_BOX.width
    for (let k = 0; k <= 20; k += 1) {
      const d = -far + (2 * far * k) / 20
      expect(covers(d, -d, margin)).toBe(true)
    }
  })

  it('WP195 那个 65×65 的矩形做不到（这条就是那道分界的来历）', () => {
    const far = MARK_BOX.width * IDLE_WAVE_SHEEN.travel
    const old = { ...MARK_BOX }
    const oldCovers = (d: number): boolean =>
      old.x + d <= MARK_BOX.x && old.x + d + old.width >= MARK_BOX.x + MARK_BOX.width - BLOCK_SIZE
    expect(oldCovers(-far / 2)).toBe(false)
  })

  it.each(['wave-sheen', 'sheen'] as const)(
    '%s：亮带渐变是 userSpaceOnUse、轴就是 GRADIENT_AXIS，矩形用 SHEEN_BAND_BOX',
    (style) => {
      const svg = markSvg({ idle: style, id: 'z' })
      const a = GRADIENT_AXIS
      expect(svg).toContain(
        `<linearGradient id="z-sheen" gradientUnits="userSpaceOnUse" x1="${a.x1}" y1="${a.y1}" x2="${a.x2}" y2="${a.y2}">`,
      )
      const r = SHEEN_BAND_BOX
      const box = `x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="url(#z-sheen)"`
      expect(svg).toContain(box)
      expect(svg).not.toContain(
        `width="${MARK_BOX.width}" height="${MARK_BOX.height}" fill="url(#z-sheen)"`,
      )
    },
  )
})
