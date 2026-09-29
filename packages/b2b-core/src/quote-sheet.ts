/**
 * WP182（docs/84 §3.2）：**报价单**——`quotation` 技能「报价单结构」「发之前自查」两段落成的纯函数，
 * 加一张本机生成的 PDF（`pdf-writer.ts`，零依赖）。
 *
 * 条款从哪来（技能原话：报价单上的每一个数都只从事实卡来）：
 * - 行、金额、折扣、账期、贸易术语与地点、有效期、阶梯价 ← 报价卡那一版（只读版本）；
 * - MOQ、交期 ← 事实卡（价格与 MOQ、交付能力），取不到就写「待确认」并进自查问题；
 * - 信头：公司名与地址取公司档案，颜色与字体取品牌设计（字体映射到最接近的内置字体）。
 */
import type { B2bQuoteVersion } from '@agentsws/contracts'
import { A4, fitText, PdfDoc, pdfFamilyOf, type Rgb, rgbOf } from './pdf-writer.js'

export interface QuoteLetterhead {
  company: string
  address?: string
  contact?: string
  website?: string
  /** 品牌主色（`#rrggbb`）。 */
  color?: string
  /** 品牌字体（DESIGN.md 里那一个）。 */
  font_family?: string
}

export interface QuoteSheetInput {
  letterhead: QuoteLetterhead
  number: string
  version: B2bQuoteVersion
  customer: { name: string; contact?: string; country?: string }
  /** 取自事实卡的 MOQ 那一句（英文）。 */
  moq?: string
  /** 取自事实卡的交期那一句（英文）。 */
  lead_time?: string
  /** 备注（含什么不含什么）。 */
  notes?: readonly string[]
  issued_at: string
}

export interface QuoteSheet {
  input: QuoteSheetInput
  lines: {
    sku: string
    description: string
    qty: number
    unit_price_usd: number
    amount_usd: number
  }[]
  subtotal_usd: number
  discount_usd: number
  total_usd: number
  incoterm_text: string
  payment_text: string
  valid_until: string
  /** 自查问题（中文，卡上列出来）：没写地点、阶梯倒挂、有效期已过、MOQ / 交期没取到事实卡。 */
  issues: string[]
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const usd = (n: number): string =>
  `USD ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const day = (iso: string): string => iso.slice(0, 10)

/** 一版报价的金额：按行算、折扣之后，两位小数（服务进程与模拟世界同一个算法）。 */
export function quoteAmount(
  lines: readonly { qty: number; unit_price_usd: number }[],
  discount_pct: number,
): number {
  const gross = lines.reduce((n, l) => n + l.qty * l.unit_price_usd, 0)
  return Math.round(gross * (1 - discount_pct / 100) * 100) / 100
}

/** 阶梯价有没有倒挂（量越大单价越高）。回倒挂的那一档（没有回 `undefined`）。 */
export function invertedTier(
  tiers: readonly { min_qty: number; unit_price_usd: number }[],
): { min_qty: number; unit_price_usd: number } | undefined {
  const sorted = [...tiers].sort((a, b) => a.min_qty - b.min_qty)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (prev !== undefined && cur !== undefined && cur.unit_price_usd > prev.unit_price_usd)
      return cur
  }
  return undefined
}

/** 付款方式那一句：版本里写了就用；没写按账期天数说。 */
export function paymentTextOf(
  v: Pick<B2bQuoteVersion, 'payment_method' | 'payment_terms_days'>,
): string {
  if (v.payment_method !== undefined && v.payment_method.trim() !== '')
    return v.payment_method.trim()
  return v.payment_terms_days > 0
    ? `Balance due ${v.payment_terms_days} days after B/L date`
    : 'T/T, full payment before shipment'
}

export function buildQuoteSheet(input: QuoteSheetInput): QuoteSheet {
  const v = input.version
  const lines = v.lines.map((l) => ({
    sku: l.sku,
    description: l.description,
    qty: l.qty,
    unit_price_usd: l.unit_price_usd,
    amount_usd: round2(l.qty * l.unit_price_usd),
  }))
  const subtotal = round2(lines.reduce((n, l) => n + l.amount_usd, 0))
  const discount = round2(subtotal * (v.discount_pct / 100))
  const issues: string[] = []
  const place = v.incoterm_place?.trim() ?? ''
  if (place === '') issues.push(`贸易术语 ${v.incoterm} 没写地点（只写 ${v.incoterm} 等于没写）`)
  const bad = v.tiers === undefined ? undefined : invertedTier(v.tiers)
  if (bad !== undefined) issues.push(`阶梯价倒挂：${bad.min_qty} 件那一档比少量的还贵`)
  if (Date.parse(v.valid_until) < Date.parse(input.issued_at)) issues.push('有效期已经过了')
  if (input.moq === undefined) issues.push('MOQ 没从事实卡里取到（报价单上写「待确认」）')
  if (input.lead_time === undefined) issues.push('交期没从事实卡里取到（报价单上写「待确认」）')
  return {
    input,
    lines,
    subtotal_usd: subtotal,
    discount_usd: discount,
    total_usd: round2(subtotal - discount),
    incoterm_text: `${v.incoterm}${place === '' ? '' : ` ${place}`}, Incoterms® 2020`,
    payment_text: paymentTextOf(v),
    valid_until: day(v.valid_until),
    issues,
  }
}

const GREY: Rgb = [0.45, 0.45, 0.45]
const LIGHT: Rgb = [0.94, 0.94, 0.95]
const WHITE: Rgb = [1, 1, 1]

/** 主色太浅（白字看不清）时，信头改成深色字压在浅底上。 */
const isLight = (c: Rgb): boolean => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.7

/**
 * 画成 PDF（A4）。回字节与两句说明：用了哪个内置字体（品牌字体没嵌）、有没有字符编不进去。
 */
export function renderQuotePdf(sheet: QuoteSheet): {
  bytes: Uint8Array
  font: string
  lossy: boolean
} {
  const { input } = sheet
  const lh = input.letterhead
  const family = pdfFamilyOf(lh.font_family)
  const brand = rgbOf(lh.color)
  const onBrand: Rgb = isLight(brand) ? [0.1, 0.1, 0.1] : WHITE
  const doc = new PdfDoc(family).page()
  const L = 40
  const R = A4.width - 40
  let y = A4.height

  // 信头：品牌色一条
  doc.rect(0, y - 86, A4.width, 86, brand)
  doc.text(L, y - 40, 20, fitText(lh.company, 20, 330, family, true), {
    bold: true,
    color: onBrand,
  })
  const sub = [lh.address, [lh.contact, lh.website].filter(Boolean).join('  ·  ')].filter(
    (s): s is string => s !== undefined && s !== '',
  )
  sub.forEach((s, i) => {
    doc.text(L, y - 58 - i * 11, 8.5, fitText(s, 8.5, 360, family), { color: onBrand })
  })
  doc.text(R, y - 40, 16, 'QUOTATION', { bold: true, color: onBrand, align: 'right' })
  doc.text(R, y - 58, 9, `${input.number} · V${input.version.version}`, {
    color: onBrand,
    align: 'right',
  })
  y -= 116

  // 客户与单据信息
  doc.text(L, y, 8, 'TO', { bold: true, color: GREY })
  doc.text(L, y - 14, 11, fitText(input.customer.name, 11, 250, family, true), { bold: true })
  const who = [input.customer.contact, input.customer.country].filter(Boolean).join(', ')
  if (who !== '') doc.text(L, y - 28, 9, fitText(who, 9, 250, family), { color: GREY })
  const meta: [string, string][] = [
    ['Date', day(input.issued_at)],
    ['Valid until', sheet.valid_until],
    ['Currency', 'USD'],
    ['Price term', sheet.incoterm_text],
  ]
  meta.forEach(([k, val], i) => {
    doc.text(340, y - i * 14, 8.5, k, { color: GREY })
    doc.text(R, y - i * 14, 9, fitText(val, 9, 170, family), { align: 'right' })
  })
  y -= 76

  // 明细表
  const cols = { sku: L + 6, desc: L + 96, qty: 390, unit: 470, amount: R - 6 }
  const header = (): void => {
    doc.rect(L, y - 6, R - L, 20, LIGHT)
    doc.text(cols.sku, y, 8.5, 'MODEL', { bold: true, color: brand })
    doc.text(cols.desc, y, 8.5, 'DESCRIPTION', { bold: true, color: brand })
    doc.text(cols.qty, y, 8.5, 'QTY', { bold: true, color: brand, align: 'right' })
    doc.text(cols.unit, y, 8.5, 'UNIT PRICE', { bold: true, color: brand, align: 'right' })
    doc.text(cols.amount, y, 8.5, 'AMOUNT', { bold: true, color: brand, align: 'right' })
    y -= 22
  }
  header()
  for (const l of sheet.lines) {
    if (y < 150) {
      doc.page()
      y = A4.height - 60
      header()
    }
    doc.text(cols.sku, y, 9, fitText(l.sku, 9, 84, family, true), { bold: true })
    doc.text(cols.desc, y, 9, fitText(l.description, 9, 220, family))
    doc.text(cols.qty, y, 9, l.qty.toLocaleString('en-US'), { align: 'right' })
    doc.text(cols.unit, y, 9, l.unit_price_usd.toFixed(2), { align: 'right' })
    doc.text(cols.amount, y, 9, usd(l.amount_usd), { align: 'right' })
    doc.line(L, y - 7, R, y - 7, LIGHT)
    y -= 18
  }
  y -= 4
  const totalRow = (k: string, val: string, bold = false): void => {
    doc.text(cols.unit, y, 9, k, { align: 'right', color: GREY, bold })
    doc.text(cols.amount, y, bold ? 11 : 9, val, { align: 'right', bold })
    y -= bold ? 18 : 14
  }
  if (sheet.discount_usd > 0) {
    totalRow('Subtotal', usd(sheet.subtotal_usd))
    totalRow(`Discount ${input.version.discount_pct}%`, `- ${usd(sheet.discount_usd)}`)
  }
  totalRow('Total', usd(sheet.total_usd), true)
  y -= 10

  // 条款
  const terms: [string, string][] = [
    ['Price term', sheet.incoterm_text],
    ['MOQ', input.moq ?? 'To be confirmed'],
    ['Lead time', input.lead_time ?? 'To be confirmed'],
    ['Payment', sheet.payment_text],
    ['Validity', `This quotation is valid until ${sheet.valid_until}.`],
  ]
  const ensure = (need: number): void => {
    if (y - need < 60) {
      doc.page()
      y = A4.height - 60
    }
  }
  ensure(20 + terms.length * 14)
  doc.text(L, y, 10, 'TERMS', { bold: true, color: brand })
  y -= 16
  for (const [k, val] of terms) {
    doc.text(L, y, 9, k, { bold: true })
    doc.text(L + 90, y, 9, fitText(val, 9, R - L - 90, family))
    y -= 14
  }
  const tiers = [...(input.version.tiers ?? [])].sort((a, b) => a.min_qty - b.min_qty)
  if (tiers.length > 0) {
    ensure(28 + tiers.length * 13)
    y -= 6
    doc.text(L, y, 10, 'PRICE TIERS', { bold: true, color: brand })
    y -= 15
    for (const t of tiers) {
      doc.text(L, y, 9, `${t.min_qty.toLocaleString('en-US')}+ pcs`)
      doc.text(L + 160, y, 9, `USD ${t.unit_price_usd.toFixed(2)} / pc`, { align: 'right' })
      y -= 13
    }
  }
  const notes = input.notes ?? []
  if (notes.length > 0) {
    ensure(24 + notes.length * 13)
    y -= 6
    doc.text(L, y, 10, 'NOTES', { bold: true, color: brand })
    y -= 15
    for (const n of notes) {
      doc.text(L, y, 8.5, fitText(`• ${n}`, 8.5, R - L, family), { color: GREY })
      y -= 13
    }
  }

  const bytes = doc.toBytes({
    title: `Quotation ${input.number} V${input.version.version}`,
    author: lh.company,
  })
  return { bytes, font: family, lossy: doc.lossy }
}
