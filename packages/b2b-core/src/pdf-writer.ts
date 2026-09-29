/**
 * WP182：**零依赖的小 PDF 写手**（报价单用）。
 *
 * ## 为什么自己写，不装一个 PDF 库 / 不用浏览器打印
 *
 * 照「不打包重型本机方案」：本机出一张报价单不值得带一个无头浏览器（上百 MB），
 * 也不值得为第一个 PDF 运行时依赖走一整轮 `docs/42` 上游评估（`brand-design/pdf.ts` 读 PDF 时
 * 是同一个理由，那边也是自己写的）。报价单要的东西很浅：几行字、一张表、几块色——
 * PDF 1.4 的文本与矩形算子加内置的 14 种标准字体就够，几 KB 一份，同输入同字节。
 *
 * ## 做不到什么，说清楚
 *
 * - **不嵌字体**：品牌字体映射到最接近的内置字体（无衬线 → Helvetica，衬线 → Times，
 *   等宽 → Courier），卡上与文件里写明。颜色照品牌设计原样。
 * - **只认 WinAnsi**（西文）：报价单是发给海外买家的英文文件；中文等字符换成 `?` 并由调用方提示。
 */

export type PdfFontFamily = 'Helvetica' | 'Times' | 'Courier'

/** Helvetica 字宽（AFM，1/1000 em），字符 32–126。 */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
/** Helvetica-Bold 字宽，字符 32–126。 */
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]

/** 品牌字体名 → 最接近的内置字体族。 */
export function pdfFamilyOf(fontFamily: string | undefined): PdfFontFamily {
  const f = (fontFamily ?? '').toLowerCase()
  if (/mono|courier|code|consolas|menlo/.test(f)) return 'Courier'
  if (/sans/.test(f)) return 'Helvetica'
  if (
    /serif|georgia|times|garamond|playfair|merriweather|lora|baskerville|didot|bodoni|caslon|cormorant|crimson|minion|cambria/.test(
      f,
    )
  )
    return 'Times'
  return 'Helvetica'
}

const BASE_FONT: Readonly<Record<PdfFontFamily, { regular: string; bold: string }>> = {
  Helvetica: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
  Times: { regular: 'Times-Roman', bold: 'Times-Bold' },
  Courier: { regular: 'Courier', bold: 'Courier-Bold' },
}

/** WinAnsi 里 128–159 那一段常见字符（其余 160–255 与 Latin-1 同码）。 */
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '™': 0x99,
}

/** 一串字 → WinAnsi 字节；编不进去的字符换成 `?`，并回报有没有换过。 */
export function winAnsi(text: string): { bytes: number[]; lossy: boolean } {
  const bytes: number[] = []
  let lossy = false
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63
    if (code >= 32 && code <= 126) bytes.push(code)
    else if (code >= 160 && code <= 255) bytes.push(code)
    else if (WIN_ANSI_EXTRA[ch] !== undefined) bytes.push(WIN_ANSI_EXTRA[ch])
    else if (ch === '\t') bytes.push(32)
    else {
      bytes.push(63)
      lossy = true
    }
  }
  return { bytes, lossy }
}

/** 量一串字多宽（点）。Times 按 Helvetica 的九成五估，Courier 等宽 600。 */
export function textWidth(text: string, size: number, family: PdfFontFamily, bold = false): number {
  if (family === 'Courier') return (winAnsi(text).bytes.length * 600 * size) / 1000
  const table = bold ? HELV_BOLD : HELV
  let w = 0
  for (const b of winAnsi(text).bytes) w += b >= 32 && b <= 126 ? (table[b - 32] ?? 556) : 556
  return ((family === 'Times' ? w * 0.95 : w) * size) / 1000
}

/** 按宽度截断（放不下尾巴换成 `...`）。 */
export function fitText(
  text: string,
  size: number,
  maxWidth: number,
  family: PdfFontFamily,
  bold = false,
): string {
  if (textWidth(text, size, family, bold) <= maxWidth) return text
  let out = text
  while (out.length > 1 && textWidth(`${out}...`, size, family, bold) > maxWidth)
    out = out.slice(0, -1)
  return `${out.trimEnd()}...`
}

export type Rgb = readonly [number, number, number]

/** `#rrggbb` → 0–1 的三个数（认不出按深灰）。 */
export function rgbOf(hex: string | undefined): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim())
  if (m?.[1] === undefined) return [0.2, 0.2, 0.2]
  const n = Number.parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const f3 = (n: number): string => (Math.round(n * 1000) / 1000).toString()
const colorOp = (c: Rgb, stroke = false): string =>
  `${f3(c[0])} ${f3(c[1])} ${f3(c[2])} ${stroke ? 'RG' : 'rg'}`

/** A4（点）。 */
export const A4 = { width: 595.28, height: 841.89 } as const

/** 一份 PDF：一页一个内容流；只有文字、矩形、线三种东西。 */
export class PdfDoc {
  private readonly pages: string[][] = []
  private lossyText = false
  constructor(readonly family: PdfFontFamily = 'Helvetica') {}

  /** 开新一页，之后画的都落在这一页。 */
  page(): this {
    this.pages.push([])
    return this
  }

  get pageCount(): number {
    return this.pages.length
  }

  /** 有没有字符因为编不进 WinAnsi 被换成了 `?`。 */
  get lossy(): boolean {
    return this.lossyText
  }

  private get ops(): string[] {
    const cur = this.pages[this.pages.length - 1]
    if (cur === undefined) throw new Error('PdfDoc: 先调 page()')
    return cur
  }

  text(
    x: number,
    y: number,
    size: number,
    str: string,
    opts: { bold?: boolean; color?: Rgb; align?: 'left' | 'right' } = {},
  ): this {
    const { bytes, lossy } = winAnsi(str)
    if (lossy) this.lossyText = true
    const escaped = bytes
      .map((b) =>
        b === 40 || b === 41 || b === 92
          ? `\\${String.fromCharCode(b)}`
          : b < 32 || b > 126
            ? `\\${b.toString(8).padStart(3, '0')}`
            : String.fromCharCode(b),
      )
      .join('')
    const at =
      opts.align === 'right' ? x - textWidth(str, size, this.family, opts.bold === true) : x
    this.ops.push(
      `BT ${colorOp(opts.color ?? [0.13, 0.13, 0.13])} /${opts.bold === true ? 'F2' : 'F1'} ${f3(size)} Tf ${f3(at)} ${f3(y)} Td (${escaped}) Tj ET`,
    )
    return this
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb): this {
    this.ops.push(`${colorOp(color)} ${f3(x)} ${f3(y)} ${f3(w)} ${f3(h)} re f`)
    return this
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.5): this {
    this.ops.push(
      `${colorOp(color, true)} ${f3(width)} w ${f3(x1)} ${f3(y1)} m ${f3(x2)} ${f3(y2)} l S`,
    )
    return this
  }

  /** 拼成 PDF 字节（交叉引用表的偏移按字节算）。`info` 进文件属性（标题 / 作者）。 */
  toBytes(info: { title?: string; author?: string; producer?: string } = {}): Uint8Array {
    const objects: string[] = []
    const add = (body: string): number => {
      objects.push(body)
      return objects.length
    }
    const fonts = BASE_FONT[this.family]
    const catalog = add('') // 1：占位，最后填
    const pagesObj = add('') // 2：占位
    const f1 = add(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${fonts.regular} /Encoding /WinAnsiEncoding >>`,
    )
    const f2 = add(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${fonts.bold} /Encoding /WinAnsiEncoding >>`,
    )
    const kids: number[] = []
    for (const ops of this.pages) {
      const stream = ops.join('\n')
      const content = add(
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
      )
      kids.push(
        add(
          `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`,
        ),
      )
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
    objects[pagesObj - 1] =
      `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
    const str = (s: string): string =>
      `(${winAnsi(s)
        .bytes.map((b) =>
          b === 40 || b === 41 || b === 92
            ? `\\${String.fromCharCode(b)}`
            : b > 126
              ? `\\${b.toString(8).padStart(3, '0')}`
              : String.fromCharCode(b),
        )
        .join('')})`
    const infoObj = add(
      `<< ${info.title === undefined ? '' : `/Title ${str(info.title)} `}${info.author === undefined ? '' : `/Author ${str(info.author)} `}/Producer ${str(info.producer ?? 'Agents Workshop')} >>`,
    )
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
    const offsets: number[] = []
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'))
      out += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = Buffer.byteLength(out, 'latin1')
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return new Uint8Array(Buffer.from(out, 'latin1'))
  }
}
