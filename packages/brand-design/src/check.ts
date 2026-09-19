/**
 * 产出物合不合这份规范（71 §5 第二条）。
 *
 * **只提示，不拦人。** 这道检查出来的每一条都贴在卡片上当一行字，没有一条
 * 会挡住 publish。理由：品牌规范是给人省事的，不是用来管住人的。一张广告图
 * 用了色板外的一个橙，很可能是设计师故意的；而一个会拦住你的检查，人只会
 * 想办法关掉它。
 *
 * 所以 {@link BrandDesignCheckFinding} 里**没有 severity 这一格**——
 * 它只有一档，就是"提一句"。
 *
 * 另一条克制：**没有规范就不检查**。一个刚建的工作区还没抓过设计规范，
 * 这时候每张图都报"不在色板里"，等于把一个还没启用的功能做成了噪声源。
 */
import {
  type BrandDesignCheckFinding,
  type BrandDesignProfile,
  WCAG_AA_CONTRAST,
  WCAG_AA_LARGE_CONTRAST,
} from '@agentsws/contracts'
import { contrastRatio, inPalette, nearestColor, normalizeColor, parseColor } from './color.js'
import { fontsOf, paletteOf } from './serialize.js'

export interface DesignCheckInput {
  /** 产出物里用到的颜色（`#rrggbb` / `rgb()` 都行）。 */
  colors?: readonly string[]
  /** 用到的字体名。 */
  fonts?: readonly string[]
  /** 要算对比度的前景 / 背景对。 */
  pairs?: readonly { fg: string; bg: string; large?: boolean; where?: string }[]
  /** logo 实际画多大、四周留了多少（px）。 */
  logo?: { width_px?: number; clear_space_px?: number }
  /**
   * 一段文本（提示词 / HTML / CSS），从里面把颜色抽出来一起检查。
   * 出图那条路上我们手里只有提示词，没有像素。
   */
  text?: string
}

/** 一段文本里所有认得出来的颜色（去重，保序）。 */
export function extractColorsFromText(text: string): string[] {
  const out: string[] = []
  const push = (raw: string): void => {
    const hex = normalizeColor(raw)
    if (hex !== undefined && !out.includes(hex)) out.push(hex)
  }
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) push(m[0])
  for (const m of text.matchAll(/\b(?:rgba?|hsla?)\([^)]*\)/g)) push(m[0])
  return out
}

/**
 * 查一遍。
 *
 * 没有规范（色板与字体表都空）时回空数组——见文件头注释。
 */
export function checkAgainstDesign(
  profile: BrandDesignProfile,
  input: DesignCheckInput,
): BrandDesignCheckFinding[] {
  const palette = paletteOf(profile)
  const fonts = fontsOf(profile)
  const out: BrandDesignCheckFinding[] = []

  const colors = [
    ...(input.colors ?? []),
    ...(input.text === undefined ? [] : extractColorsFromText(input.text)),
  ]

  // ① 色板外的颜色
  if (palette.length > 0) {
    const reported = new Set<string>()
    for (const raw of colors) {
      const hex = normalizeColor(raw)
      if (hex === undefined || reported.has(hex)) continue
      if (inPalette(hex, palette)) continue
      reported.add(hex)
      const suggestion = nearestColor(hex, palette)
      out.push({
        kind: 'color_off_palette',
        message_zh: `${hex} 不在品牌色板里`,
        message_en: `${hex} is not in the brand palette`,
        found: hex,
        ...(suggestion === undefined ? {} : { suggestion }),
      })
    }
  }

  // ② 字体表外的字体
  if (fonts.length > 0) {
    const lower = fonts.map((f) => f.toLowerCase())
    for (const font of input.fonts ?? []) {
      if (lower.includes(font.trim().toLowerCase())) continue
      out.push({
        kind: 'font_off_list',
        message_zh: `字体「${font}」不在品牌字体表里`,
        message_en: `Font "${font}" is not in the brand type list`,
        found: font,
        ...(fonts[0] === undefined ? {} : { suggestion: fonts[0] }),
      })
    }
  }

  // ③ 对比度
  for (const pair of input.pairs ?? []) {
    const fg = parseColor(pair.fg)
    const bg = parseColor(pair.bg)
    if (fg === undefined || bg === undefined) continue
    const ratio = contrastRatio(fg, bg)
    const need = pair.large === true ? WCAG_AA_LARGE_CONTRAST : WCAG_AA_CONTRAST
    if (ratio >= need) continue
    const where = pair.where === undefined ? '' : `（${pair.where}）`
    out.push({
      kind: 'contrast',
      message_zh: `${pair.fg} 压在 ${pair.bg} 上只有 ${String(ratio)}:1，看不清${where}；要 ${String(need)}:1`,
      message_en: `${pair.fg} on ${pair.bg} is only ${String(ratio)}:1, below the ${String(need)}:1 minimum`,
      found: `${String(ratio)}:1`,
      suggestion: `${String(need)}:1`,
    })
  }

  // ④ logo 最小尺寸与留白
  const rule = profile.logos?.value[0]
  if (rule !== undefined && input.logo !== undefined) {
    const min = rule.min_width_px
    const width = input.logo.width_px
    if (min !== undefined && width !== undefined && width < min) {
      out.push({
        kind: 'logo_min_size',
        message_zh: `logo 只画了 ${String(width)}px 宽，手册写的最小是 ${String(min)}px`,
        message_en: `Logo is ${String(width)}px wide; the brand book's minimum is ${String(min)}px`,
        found: `${String(width)}px`,
        suggestion: `${String(min)}px`,
      })
    }
    const ratio = rule.clear_space_ratio
    const clear = input.logo.clear_space_px
    if (ratio !== undefined && clear !== undefined && width !== undefined) {
      const need = Math.round(width * ratio)
      if (clear < need)
        out.push({
          kind: 'logo_clear_space',
          message_zh: `logo 四周只留了 ${String(clear)}px，手册要求不少于 ${String(need)}px`,
          message_en: `Only ${String(clear)}px of clear space around the logo; the brand book asks for ${String(need)}px`,
          found: `${String(clear)}px`,
          suggestion: `${String(need)}px`,
        })
    }
  }

  return out
}
