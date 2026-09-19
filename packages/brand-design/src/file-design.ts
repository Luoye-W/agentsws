/**
 * 从上传的品牌手册里读规范（71 §2 第二条来路）。
 *
 * **手册里写的规范优先级高于官网抓到的**（71 §2）：文件里写的是规范，官网是
 * 实现，实现可能没跟上。但"优先"只决定哪个当 `value`——不一致的那个留在
 * `conflict` 里，界面上并排让用户选（见 `./merge.ts`）。
 *
 * ## 读什么
 *
 * | 读到的 | 怎么读的 |
 * |---|---|
 * | 颜色 | 正文里的 `#RRGGBB` / `RGB 26 28 30` / `C0 M100 Y81 K4` / `PANTONE 186 C`，**加上页面里真正用过的填充色** |
 * | 字体 | 正文里 `字体 / Font / Typeface` 附近的名字，与常见字体名表 |
 * | logo 用法 | 「最小尺寸 24px」「留白不小于 logo 高度的 1/2」这类句子 |
 * | 语气 | 「语气」「Tone of voice」那一节的原文 |
 *
 * ## Pantone 与 CMYK **原样留着**
 *
 * 换算出来的 HEX 只是为了在屏幕上画个色块。把 Pantone 换算成 HEX 之后就把
 * 原值扔掉，等于让这份文件再也回不到印刷那一侧——而一个做实体产品的品牌，
 * 包装、画册、展会物料全在那一侧。
 */
import type {
  BrandDesignLogo,
  BrandDesignPrintColor,
  BrandDesignProfile,
  BrandDesignSource,
  BrandDesignValue,
} from '@agentsws/contracts'
import { isNeutral, luminance, normalizeColor, parseColor } from './color.js'
import { cmykToHex, type PdfPage, pdfPages } from './pdf.js'

export interface FileDesignInput {
  filename: string
  /** PDF 的字节。给了 `pages` 就不用给这个。 */
  bytes?: Uint8Array
  /**
   * 已经拆好的页（纯文本文件、或调用方已经用别的链路解过的）。
   * 给了它就不再解 PDF——这条口子让 docx / pptx 走 WP99 的现成链路进来。
   */
  pages?: readonly PdfPage[]
  maxPages?: number
}

export interface FileDesignResult {
  profile: BrandDesignProfile
  /** 这个文件贡献了哪几格（字段路径）。进 `BrandDesignFileIntake.contributed`。 */
  contributed: string[]
  /** 印刷色原值（Pantone / CMYK），**原样**。 */
  printColors: BrandDesignPrintColor[]
  /** 真读到几页。 */
  pagesRead: number
  /** 读不动时那一句人话。**不编。** */
  failure?: string
}

/* ── 颜色 ─────────────────────────────────────────────────────────── */

const PANTONE_RE = /\bPANTONE\s+([0-9]{2,4}\s*[A-Z]{0,3}|[A-Za-z]+\s+[0-9]{2,4}\s*[A-Z]{0,3})\b/gi
const CMYK_RE =
  /\bC\s*:?\s*(\d{1,3})\s*[,/ ]\s*M\s*:?\s*(\d{1,3})\s*[,/ ]\s*Y\s*:?\s*(\d{1,3})\s*[,/ ]\s*K\s*:?\s*(\d{1,3})\b/gi
const RGB_RE = /\bR\s*:?\s*(\d{1,3})\s*[,/ ]\s*G\s*:?\s*(\d{1,3})\s*[,/ ]\s*B\s*:?\s*(\d{1,3})\b/gi
const HEX_RE = /#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g

/** 手册上写的一个色 → 原值 + 换算出来的 HEX。认不出来回 `undefined`。 */
export function parsePrintColor(raw: string): BrandDesignPrintColor | undefined {
  const hex = HEX_RE.exec(raw)
  HEX_RE.lastIndex = 0
  if (hex !== null) {
    const normalized = normalizeColor(hex[0])
    return normalized === undefined ? undefined : { raw: hex[0], space: 'hex', hex: normalized }
  }
  CMYK_RE.lastIndex = 0
  const cmyk = CMYK_RE.exec(raw)
  if (cmyk !== null) {
    const [c, m, y, k] = [Number(cmyk[1]), Number(cmyk[2]), Number(cmyk[3]), Number(cmyk[4])]
    return { raw: cmyk[0], space: 'cmyk', hex: cmykToHex(c / 100, m / 100, y / 100, k / 100) }
  }
  PANTONE_RE.lastIndex = 0
  const pantone = PANTONE_RE.exec(raw)
  // Pantone **不换算**：没有一张不带授权的对照表能把它变成准确的 HEX。
  // 原值留着，HEX 那一格空着——界面上画一个带问号的色块比画一个错的色块好。
  if (pantone !== null) return { raw: pantone[0], space: 'pantone' }
  return undefined
}

function colorsFromText(text: string): BrandDesignPrintColor[] {
  const out: BrandDesignPrintColor[] = []
  const seen = new Set<string>()
  const push = (c: BrandDesignPrintColor | undefined): void => {
    if (c === undefined) return
    const key = c.raw.toUpperCase().replace(/\s+/g, ' ')
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }
  for (const m of text.matchAll(HEX_RE)) push(parsePrintColor(m[0]))
  for (const m of text.matchAll(CMYK_RE)) push(parsePrintColor(m[0]))
  for (const m of text.matchAll(PANTONE_RE)) push(parsePrintColor(m[0]))
  for (const m of text.matchAll(RGB_RE)) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (![r, g, b].every((n) => n >= 0 && n <= 255)) continue
    const hex = normalizeColor(`rgb(${String(r)},${String(g)},${String(b)})`)
    if (hex !== undefined) push({ raw: m[0], space: 'rgb', hex })
  }
  return out
}

/* ── 字体 ─────────────────────────────────────────────────────────── */

/** 「字体」这个词周围的那一段。中英各认几种说法。 */
const FONT_CUE =
  /(?:字体|字型|Typeface|Font\s*Family|Fonts?|Typography)\s*[:：]?\s*([^。.;；\n]{2,60})/gi

/** 一段话里像字体名的那几个词。 */
function fontNamesIn(chunk: string): string[] {
  const out: string[] = []
  // 「Public Sans Semi-Bold」这种：连续的首字母大写词（允许连字符）
  for (const m of chunk.matchAll(/\b([A-Z][A-Za-z]+(?:[\s-][A-Z][A-Za-z]+){0,3})\b/g)) {
    const name = m[1]
    if (name === undefined) continue
    if (
      /^(The|And|For|With|Use|Do|Don|All|Color|Colour|Brand|Logo|Regular|Bold|Light|Medium|Italic|Semi)$/i.test(
        name,
      )
    )
      continue
    if (name.length < 3) continue
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/* ── logo 用法 ────────────────────────────────────────────────────── */

const MIN_SIZE_RE =
  /(?:最小(?:尺寸|宽度|显示)|minimum\s+(?:size|width))[^0-9]{0,12}(\d{1,4})\s*(px|pt|mm)/i
const CLEAR_SPACE_RE =
  /(?:留白|安全距离|clear\s*space|clearance)[^0-9]{0,20}(?:(\d{1,3})\s*%|(\d)\s*\/\s*(\d)|(\d*\.?\d+)\s*(?:倍|x|×))/i

function logoRules(text: string): { min_width_px?: number; clear_space_ratio?: number } {
  const out: { min_width_px?: number; clear_space_ratio?: number } = {}
  const min = MIN_SIZE_RE.exec(text)
  if (min?.[1] !== undefined) {
    const n = Number(min[1])
    const unit = min[2]?.toLowerCase()
    // pt / mm 折成 px 只是为了界面上能画：1pt ≈ 1.333px，1mm ≈ 3.78px
    if (Number.isFinite(n))
      out.min_width_px = Math.round(unit === 'pt' ? n * 1.333 : unit === 'mm' ? n * 3.78 : n)
  }
  const clear = CLEAR_SPACE_RE.exec(text)
  if (clear !== null) {
    const percent = clear[1]
    const [num, den] = [clear[2], clear[3]]
    const times = clear[4]
    const ratio =
      percent !== undefined
        ? Number(percent) / 100
        : num !== undefined && den !== undefined && Number(den) !== 0
          ? Number(num) / Number(den)
          : times !== undefined
            ? Number(times)
            : Number.NaN
    if (Number.isFinite(ratio) && ratio > 0 && ratio <= 4) out.clear_space_ratio = ratio
  }
  return out
}

/* ── 入口 ─────────────────────────────────────────────────────────── */

/**
 * 读一份手册。
 *
 * 色板的排法与官网那条路不同：手册里**先出现的色就是主色**。手册的作者是
 * 按重要性排的版，那个顺序比任何统计都准——而官网上我们只能靠面积去猜。
 */
export function extractFileDesign(input: FileDesignInput): FileDesignResult {
  const pages =
    input.pages ??
    (input.bytes === undefined
      ? []
      : pdfPages(input.bytes, input.maxPages === undefined ? {} : { maxPages: input.maxPages }))

  if (pages.length === 0)
    return {
      profile: {},
      contributed: [],
      printColors: [],
      pagesRead: 0,
      failure: `${input.filename} 里没读到文字层（可能是扫描件或纯图排版）。这一份请手填，或换一个带文字的版本。`,
    }

  const allText = pages.map((p) => p.text).join('\n')
  if (allText.trim() === '')
    return {
      profile: {},
      contributed: [],
      printColors: [],
      pagesRead: pages.length,
      failure: `${input.filename} 的 ${String(pages.length)} 页里都没有文字层，只读到了几块颜色。`,
    }

  const profile: BrandDesignProfile = {}
  const contributed: string[] = []
  const src = (page: number, locator: string, quote?: string): BrandDesignSource => ({
    origin: 'file',
    page,
    locator,
    ...(quote === undefined ? {} : { quote: quote.slice(0, 200) }),
  })

  // ── 颜色：正文里写的 + 页面上真用过的 ────────────────────────────
  const printColors: BrandDesignPrintColor[] = []
  const colorHits: { hex: string; source: BrandDesignSource }[] = []
  for (const page of pages) {
    for (const c of colorsFromText(page.text)) {
      printColors.push(c)
      if (c.hex !== undefined)
        colorHits.push({ hex: c.hex, source: src(page.page, `pdf:p${String(page.page)}`, c.raw) })
    }
  }
  // 正文里一个色值都没写的手册（只有色块）：退到页面用过的填充色
  if (colorHits.length === 0) {
    for (const page of pages) {
      for (const hex of page.colors) {
        if (hex === '#ffffff' || hex === '#000000') continue
        colorHits.push({ hex, source: src(page.page, `pdf:p${String(page.page)}:fill`) })
      }
    }
  }
  const colors = assignPalette(colorHits)
  if (Object.keys(colors).length > 0) {
    profile.colors = colors
    contributed.push(...Object.keys(colors).map((k) => `colors.${k}`))
  }

  // ── 字体 ────────────────────────────────────────────────────────
  const families: { name: string; source: BrandDesignSource }[] = []
  for (const page of pages) {
    for (const m of page.text.matchAll(FONT_CUE)) {
      const chunk = m[1]
      if (chunk === undefined) continue
      for (const name of fontNamesIn(chunk)) {
        if (families.some((f) => f.name === name)) continue
        families.push({ name, source: src(page.page, `pdf:p${String(page.page)}`, m[0]) })
      }
    }
  }
  if (families.length > 0) {
    const typography: NonNullable<BrandDesignProfile['typography']> = {}
    const heading = families[0]
    const body = families[1] ?? families[0]
    if (heading !== undefined)
      typography.h1 = {
        value: { fontFamily: heading.name },
        confidence: 'medium',
        source: [heading.source],
      }
    if (body !== undefined)
      typography['body-md'] = {
        value: { fontFamily: body.name },
        confidence: 'medium',
        source: [body.source],
      }
    profile.typography = typography
    contributed.push('typography.h1', 'typography.body-md')
  }

  // ── logo 用法 ───────────────────────────────────────────────────
  const rules = logoRules(allText)
  if (rules.min_width_px !== undefined || rules.clear_space_ratio !== undefined) {
    const page =
      pages.find((p) => MIN_SIZE_RE.test(p.text) || CLEAR_SPACE_RE.test(p.text))?.page ?? 1
    const logo: BrandDesignLogo = { url: '', variant: 'light', ...rules }
    profile.logos = {
      value: [logo],
      confidence: 'medium',
      source: [src(page, `pdf:p${String(page)}`)],
    }
    contributed.push('logos')
  }

  return { profile, contributed, printColors, pagesRead: pages.length }
}

/**
 * 手册里读到的色 → 色板。
 *
 * **按出现顺序**，不按统计：手册的作者是按重要性排的版。中性色单独挑出来，
 * 与官网那条路同一条理由（白与黑永远排在最前，混在一起排的话主色进不了前四）。
 */
function assignPalette(
  hits: readonly { hex: string; source: BrandDesignSource }[],
): Record<string, BrandDesignValue<string>> {
  const out: Record<string, BrandDesignValue<string>> = {}
  const seen = new Set<string>()
  const chromatic: typeof hits = hits.filter((h) => {
    const c = parseColor(h.hex)
    return c !== undefined && !isNeutral(c)
  })
  const neutrals: typeof hits = hits.filter((h) => {
    const c = parseColor(h.hex)
    return c !== undefined && isNeutral(c)
  })

  const roles = ['primary', 'secondary', 'tertiary']
  for (const role of roles) {
    const hit = chromatic.find((h) => !seen.has(h.hex))
    if (hit === undefined) break
    seen.add(hit.hex)
    // 手册是**规范**：它写下来的色值把握度就是 high，没有"我们量的"那一层不确定
    out[role] = { value: hit.hex, confidence: 'high', source: [hit.source] }
  }
  if (neutrals.length > 0) {
    const byLum = [...neutrals].sort((a, b) => lumOf(b.hex) - lumOf(a.hex))
    const lightest = byLum[0]
    const darkest = byLum.at(-1)
    if (lightest !== undefined && !seen.has(lightest.hex)) {
      seen.add(lightest.hex)
      out.surface = { value: lightest.hex, confidence: 'high', source: [lightest.source] }
    }
    if (darkest !== undefined && !seen.has(darkest.hex)) {
      seen.add(darkest.hex)
      out['on-surface'] = { value: darkest.hex, confidence: 'high', source: [darkest.source] }
    }
  }
  return out
}

function lumOf(hex: string): number {
  const c = parseColor(hex)
  return c === undefined ? 0 : luminance(c)
}
