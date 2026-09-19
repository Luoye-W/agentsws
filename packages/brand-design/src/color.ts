/**
 * 颜色：认出来、归一化、算对比度（71 §4）。
 *
 * **为什么要自己写而不是装一个颜色库**：我们只需要四件事——把站上写的那串字
 * 认成 RGB、判它是不是中性色、算两个色的对比度、判两个色是不是"同一个色"。
 * 这四件都是几行数学，而一个通用颜色库带来的是一整套色彩空间转换与它自己的
 * 依赖树。
 *
 * **认不出来的一律回 `undefined`，不猜**。站上写 `var(--x)`、`currentColor`、
 * `inherit` 的时候，一个猜出来的值比没有值更糟：它会被当成品牌色写进 DESIGN.md，
 * 然后被四个岗位当成真的用一整年。
 */

export interface Rgb {
  r: number
  g: number
  b: number
  /** 0–1。CSS 里没写就是 1。 */
  a: number
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  transparent: '#00000000',
}

/**
 * 把 CSS 里的一串颜色认成 RGB。
 *
 * 认得的：`#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`、`rgb()` / `rgba()`、
 * `hsl()` / `hsla()`、几个常用名字。认不得的（`oklch()`、`color-mix()`、
 * `var(--x)`、`currentColor`）回 `undefined`——**规范允许那些写法，我们只是
 * 算不了它们的对比度**，所以原样留在令牌里，但不参与主次判定。
 */
export function parseColor(input: string): Rgb | undefined {
  const s = input.trim().toLowerCase()
  const named = NAMED[s]
  if (named !== undefined) return parseColor(named)

  if (s.startsWith('#')) {
    const hex = s.slice(1)
    const expand = (h: string): number => Number.parseInt(h.length === 1 ? h + h : h, 16)
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [hex[0], hex[1], hex[2], hex[3]]
      if (r === undefined || g === undefined || b === undefined) return undefined
      return {
        r: expand(r),
        g: expand(g),
        b: expand(b),
        a: a === undefined ? 1 : expand(a) / 255,
      }
    }
    if (hex.length === 6 || hex.length === 8) {
      if (!/^[0-9a-f]+$/.test(hex)) return undefined
      return {
        r: expand(hex.slice(0, 2)),
        g: expand(hex.slice(2, 4)),
        b: expand(hex.slice(4, 6)),
        a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
      }
    }
    return undefined
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(s)
  if (rgb?.[1] !== undefined) {
    const parts = rgb[1].split(/[\s,/]+/).filter((x) => x !== '')
    const nums = parts.map((p) =>
      p.endsWith('%') ? (Number(p.slice(0, -1)) * 255) / 100 : Number(p),
    )
    const [r, g, b, a] = nums
    if (r === undefined || g === undefined || b === undefined) return undefined
    if (![r, g, b].every(Number.isFinite)) return undefined
    // 第四个数是 alpha，它不该按 255 缩放；上面那一行只对前三个成立
    const alphaRaw = parts[3]
    const alpha =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith('%')
          ? Number(alphaRaw.slice(0, -1)) / 100
          : Number(alphaRaw)
    void a
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: Number.isFinite(alpha) ? alpha : 1 }
  }

  const hsl = /^hsla?\(([^)]+)\)$/.exec(s)
  if (hsl?.[1] !== undefined) {
    const parts = hsl[1].split(/[\s,/]+/).filter((x) => x !== '')
    const h = Number((parts[0] ?? '').replace(/deg$/, ''))
    const sat = Number((parts[1] ?? '').replace('%', '')) / 100
    const light = Number((parts[2] ?? '').replace('%', '')) / 100
    if (![h, sat, light].every(Number.isFinite)) return undefined
    const alphaRaw = parts[3]
    const alpha =
      alphaRaw === undefined
        ? 1
        : Number(alphaRaw.replace('%', '')) / (alphaRaw.endsWith('%') ? 100 : 1)
    return { ...hslToRgb(h, sat, light), a: Number.isFinite(alpha) ? alpha : 1 }
  }

  return undefined
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  return { r: clamp255((r + m) * 255), g: clamp255((g + m) * 255), b: clamp255((b + m) * 255) }
}

/** 归一化成 `#rrggbb`（有透明度时 `#rrggbbaa`）。令牌里存的是这个。 */
export function toHex(c: Rgb): string {
  const h = (n: number): string => n.toString(16).padStart(2, '0')
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`
  return c.a >= 1 ? base : `${base}${h(Math.round(c.a * 255))}`
}

/** 站上那串字 → `#rrggbb`。认不出来回 `undefined`。 */
export function normalizeColor(input: string): string | undefined {
  const c = parseColor(input)
  return c === undefined ? undefined : toHex(c)
}

/** 相对亮度（WCAG 的定义）。 */
export function luminance(c: Rgb): number {
  const ch = (v: number): number => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

/**
 * 对比度（WCAG）。**先把半透明的前景压到背景上**再算——`rgba(0,0,0,.4)`
 * 的文字压在白底上是灰的，直接拿纯黑去算会得出 21:1 这种漂亮但假的数。
 */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const flat = fg.a >= 1 ? fg : composite(fg, bg)
  const a = luminance(flat)
  const b = luminance({ ...bg, a: 1 })
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

function composite(fg: Rgb, bg: Rgb): Rgb {
  const mix = (f: number, b: number): number => Math.round(f * fg.a + b * (1 - fg.a))
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 }
}

/** 饱和度（HSL 的 S）。判中性色用的。 */
export function saturation(c: Rgb): number {
  const max = Math.max(c.r, c.g, c.b) / 255
  const min = Math.min(c.r, c.g, c.b) / 255
  const l = (max + min) / 2
  if (max === min) return 0
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)
}

/** 彩度：RGB 三个通道的极差（0–1）。 */
export function chroma(c: Rgb): number {
  return (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255
}

/** 低于这个彩度算中性色。 */
export const NEUTRAL_CHROMA = 0.1

/**
 * 中性色吗（白 / 黑 / 各种灰 / 微微带点色温的米白）。
 *
 * **用彩度判，不用 HSL 的饱和度。** 饱和度在极亮与极暗处会炸：`#f7f5f2`
 * 是一张纸的颜色，人一眼就知道它是"白"，但它的 HSL 饱和度是 0.24——比
 * 很多真正的品牌色还高。原因是饱和度的分母在 L→1 时趋近于 0。彩度没有这个
 * 毛病：它就是三个通道差多少。
 *
 * 0.1 这个阈值：`#f7f5f2` 是 0.02，`#e3e0da` 是 0.035，`#6c7278` 是 0.047；
 * 而一个真的要当辅色用的低饱和莫兰迪绿（`#6b8e7b`）是 0.14。
 */
export function isNeutral(c: Rgb): boolean {
  return chroma(c) < NEUTRAL_CHROMA
}

/** 两个色差多远（简单的 RGB 欧氏距离，够用来去重与找"最接近的那个"）。 */
export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

/** 去重时认为"同一个色"的距离上限（`#1a1c1e` 与 `#1b1d1f` 是同一个）。 */
export const SAME_COLOR_DISTANCE = 12

/** 色板里离它最近的那个（超过 `maxDistance` 就没有）。 */
export function nearestColor(
  target: string,
  palette: readonly string[],
  maxDistance = 96,
): string | undefined {
  const t = parseColor(target)
  if (t === undefined) return undefined
  let best: { hex: string; d: number } | undefined
  for (const hex of palette) {
    const c = parseColor(hex)
    if (c === undefined) continue
    const d = colorDistance(t, c)
    if (best === undefined || d < best.d) best = { hex, d }
  }
  return best !== undefined && best.d <= maxDistance ? best.hex : undefined
}

/** 这个色在色板里吗（按 {@link SAME_COLOR_DISTANCE} 算"同一个"）。 */
export function inPalette(target: string, palette: readonly string[]): boolean {
  const near = nearestColor(target, palette, SAME_COLOR_DISTANCE)
  return near !== undefined
}
