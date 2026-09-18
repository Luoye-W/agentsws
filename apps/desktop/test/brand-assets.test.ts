/**
 * WP112：桌面壳的图标是不是母品牌那一套，而且**两份没走散**。
 *
 * 托盘图标在两个地方各存了一份——`build/trayTemplate.png`（打包用）与
 * `src/tray-icon.ts` 里的 base64（壳启动第一件事就要用它，不该依赖打包后的资源路径）。
 * 两份同源是靠 `scripts/gen-brand-assets.py` 一次出的；这里钉住"真的还是同一份"，
 * 因为只重跑一半的代价是托盘上挂着上一版的图标，而没有人会发现。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TRAY_ICON_2X_PNG_BASE64, TRAY_ICON_PNG_BASE64 } from '../src/tray-icon.js'

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const png = (name: string): Buffer => readFileSync(join(BUILD, name))

/** IHDR：宽、高、位深、颜色类型。 */
function header(buf: Buffer): {
  width: number
  height: number
  depth: number
  colorType: number
} {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    depth: buf[24] as number,
    colorType: buf[25] as number,
  }
}

/** 把 8 位 RGBA 的 PNG 解成像素（够用就行：只认这个脚本自己出的那一种）。 */
function pixels(buf: Buffer): { r: number; g: number; b: number; a: number }[] {
  const { width, height, depth, colorType } = header(buf)
  expect([depth, colorType]).toEqual([8, 6])
  const chunks: Buffer[] = []
  let at = 8
  while (at < buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.subarray(at + 4, at + 8).toString('ascii')
    if (type === 'IDAT') chunks.push(buf.subarray(at + 8, at + 8 + len))
    at += len + 12
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const bpp = 4
  const stride = width * bpp
  const out: { r: number; g: number; b: number; a: number }[] = []
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? (line[i - bpp] as number) : 0
      const b = prev[i] as number
      const c = i >= bpp ? (prev[i - bpp] as number) : 0
      const x = line[i] as number
      let value = x
      if (filter === 1) value = x + a
      if (filter === 2) value = x + b
      if (filter === 3) value = x + ((a + b) >> 1)
      if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      line[i] = value & 0xff
    }
    line.copy(prev)
    for (let x = 0; x < width; x += 1) {
      out.push({
        r: line[x * bpp] as number,
        g: line[x * bpp + 1] as number,
        b: line[x * bpp + 2] as number,
        a: line[x * bpp + 3] as number,
      })
    }
  }
  return out
}

describe('WP112 桌面壳图标', () => {
  it('应用图标是 1024 见方（electron-builder 由它出各档）', () => {
    const { width, height } = header(png('icon.png'))
    expect([width, height]).toEqual([1024, 1024])
  })

  it('托盘两档是 22 / 44（macOS 菜单栏那一档）', () => {
    expect(header(png('trayTemplate.png')).width).toBe(22)
    expect(header(png('trayTemplate@2x.png')).width).toBe(44)
  })

  it('托盘是 macOS 的 template image：只有纯黑与 alpha，一点颜色都没有', () => {
    for (const name of ['trayTemplate.png', 'trayTemplate@2x.png']) {
      for (const p of pixels(png(name))) {
        // 系统按明暗自己反色，靠的就是"颜色只在 alpha 里"
        if (p.a === 0) continue
        expect([p.r, p.g, p.b], `${name} 里有非黑像素`).toEqual([0, 0, 0])
      }
      // 而且真画了东西（不是一张全透明的图）
      expect(pixels(png(name)).some((p) => p.a > 0)).toBe(true)
    }
  })

  it('`tray-icon.ts` 里那两串 base64 与 `build/` 下那两张**逐字节相同**', () => {
    expect(TRAY_ICON_PNG_BASE64).toBe(png('trayTemplate.png').toString('base64'))
    expect(TRAY_ICON_2X_PNG_BASE64).toBe(png('trayTemplate@2x.png').toString('base64'))
  })

  it('应用图标不是单色：走的是母品牌的整体渐变（六块颜色各不相同）', () => {
    const all = pixels(png('icon.png'))
    const solid = all.filter((p) => p.a > 250)
    const hues = new Set(solid.map((p) => `${p.r >> 4}-${p.g >> 4}-${p.b >> 4}`))
    // 深底一档 + 六块各自那一段颜色，粗粒度下也远不止几种
    expect(hues.size).toBeGreaterThan(8)
  })
})
