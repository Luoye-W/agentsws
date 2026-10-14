/**
 * WP322（docs/102 §5.4，决策 670）：把一份表格（xlsx / xls / csv）读成**一格一格的字符串**。
 *
 * 只给 FAQ 导入器用（`faq-import.ts`），所以只读它要的东西：每张工作表的名字与格子里的字。
 * 不读样式、公式、图片、批注；数字按原值转字符串（日期会是 Excel 的序号——FAQ 表里极少有）。
 *
 * 为什么自己读、不加依赖：仓里只有工作台（浏览器）那一份 exceljs，服务端没有任何表格库；
 * xlsx 就是 zip + 几份 XML，xls 是 OLE2 + BIFF8 记录，两样都只要几百行。拉一个重依赖进服务进程
 * 不划算（派工单「不加重依赖」）。
 *
 * 三道闸（这是外来文件，读它的 CPU 与内存不能交给上传的人决定）：
 * - zip 里每个条目解压前先看声明的大小，超了不解；解压本身也带 `maxOutputLength`（防 zip bomb）；
 * - 每张表最多 {@link SHEET_LIMITS} 行 / 列，格子里的字截到上限；
 * - 读不懂就抛 `invalid_input`（一句人话），不猜。
 */
import { Buffer } from 'node:buffer'
import { inflateRawSync } from 'node:zlib'
import { invalidInput } from './errors.js'
import { readXls } from './sheet-xls.js'

/** 一张工作表：`rows[r][c]`，`r` 从 0 起（Excel 行号 = r + 1）。合并格的值已铺满整块。 */
export interface SheetGrid {
  /** 工作表名（csv 没有工作表，是空串）。 */
  name: string
  rows: string[][]
}

export const SHEET_LIMITS = {
  /** 每张表最多读多少行（FAQ 表几百行；再多就不是一张问答表了）。 */
  rows: 5000,
  /** 每行最多读多少列。 */
  cols: 50,
  /** 一格最多多少字。 */
  cellChars: 4000,
  /** 一张工作簿最多读几张表。 */
  sheets: 30,
  /** zip 里单个条目解压后最多多大。 */
  entryBytes: 32 * 1024 * 1024,
} as const

export type SheetFormat = 'xlsx' | 'xls' | 'csv'

/** 按扩展名分派。 */
export function readSpreadsheet(format: SheetFormat, bytes: Uint8Array): SheetGrid[] {
  if (format === 'csv') return [{ name: '', rows: readCsv(decodeText(bytes)) }]
  if (format === 'xls') return readXls(bytes).map(clampGrid)
  return readXlsx(bytes)
}

/** 截格子、截行列：所有读法出口都走一遍。 */
export function clampGrid(grid: SheetGrid): SheetGrid {
  const rows = grid.rows
    .slice(0, SHEET_LIMITS.rows)
    .map((r) => r.slice(0, SHEET_LIMITS.cols).map((c) => c.slice(0, SHEET_LIMITS.cellChars)))
  return { name: grid.name, rows }
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

// ── CSV ────────────────────────────────────────────────────────────

/** 第一行（引号外）里逗号 / 分号 / 制表符哪个多就按哪个分。 */
function sniffDelimiter(text: string): string {
  const counts = new Map<string, number>([
    [',', 0],
    [';', 0],
    ['\t', 0],
  ])
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  let best = ','
  for (const [d, n] of counts) if (n > (counts.get(best) ?? 0)) best = d
  return best
}

/** RFC 4180：引号里可以有分隔符、换行与 `""`。 */
export function readCsv(raw: string): string[][] {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const delimiter = sniffDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (rows.length >= SHEET_LIMITS.rows) break
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return clampGrid({ name: '', rows }).rows
}

// ── XLSX（zip + XML）────────────────────────────────────────────────

/**
 * 只解要的几个条目。条目名在中央目录里是明文，先看名字与**声明的解压大小**，
 * 不要的、超大的一概不碰——一份 64 MB 的上传里塞一个 4 GB 的条目，在这里就停了。
 */
function readZipEntries(buf: Buffer, wanted: (name: string) => boolean): Map<string, string> {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw invalidInput('这份 Excel 打不开（不是完整的 zip 包）。')
  const count = buf.readUInt16LE(eocd + 10)
  let cursor = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, string>()
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50)
      throw invalidInput('这份 Excel 打不开（zip 目录坏了）。')
    const method = buf.readUInt16LE(cursor + 10)
    const compressed = buf.readUInt32LE(cursor + 20)
    const size = buf.readUInt32LE(cursor + 24)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const local = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    cursor += 46 + nameLen + extraLen + commentLen
    if (!wanted(name)) continue
    if (size > SHEET_LIMITS.entryBytes) throw invalidInput(`这份 Excel 里「${name}」太大，读不了。`)
    if (local + 30 > buf.length) throw invalidInput('这份 Excel 打不开（zip 条目坏了）。')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + compressed)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: SHEET_LIMITS.entryBytes })
      } catch {
        throw invalidInput(`这份 Excel 里「${name}」解不开。`)
      }
    } else throw invalidInput('这份 Excel 用了不认识的压缩方式。')
    out.set(name, data.toString('utf8'))
  }
  return out
}

const ENTITY: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** XML 实体还原（含 `&#NN;` / `&#xNN;`）。 */
export function xmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ENTITY[body] ?? whole
  })
}

/** 一个标签里的属性（不管顺序、不管命名空间前缀里有没有冒号）。 */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1] as string] = xmlUnescape(m[3] ?? m[4] ?? '')
  }
  return out
}

/** 一段里所有 `<t>` 的字（富文本是多段 `<r><t>`；注音 `<rPh>` 不算）。 */
function textRuns(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  let out = ''
  for (const m of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g))
    out += xmlUnescape(m[1] ?? '')
  return out
}

/** `B12` → `{ row: 11, col: 1 }`。 */
export function cellAddress(ref: string): { row: number; col: number } | undefined {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref.trim())
  if (m === null) return undefined
  let col = 0
  for (const ch of (m[1] as string).toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]) - 1, col: col - 1 }
}

/** 合并格：左上角的值铺到整块（表头不在第一行、分类列合并，都靠这一步）。 */
export function fillMerged(
  rows: string[][],
  ranges: readonly { r1: number; c1: number; r2: number; c2: number }[],
): void {
  for (const { r1, c1, r2, c2 } of ranges) {
    const value = rows[r1]?.[c1] ?? ''
    if (value === '') continue
    for (let r = r1; r <= Math.min(r2, SHEET_LIMITS.rows - 1); r += 1) {
      const row = rows[r] ?? []
      rows[r] = row
      for (let c = c1; c <= Math.min(c2, SHEET_LIMITS.cols - 1); c += 1) {
        while (row.length < c) row.push('')
        if ((row[c] ?? '') === '') row[c] = value
      }
    }
  }
}

function sheetPath(target: string): string {
  const t = target.replace(/\\/g, '/')
  if (t.startsWith('/')) return t.slice(1)
  return t.startsWith('xl/') ? t : `xl/${t}`
}

/** 读 xlsx：工作簿里的表按顺序；隐藏的表不读（多半是下拉选项的底表，不是内容）。 */
export function readXlsx(bytes: Uint8Array): SheetGrid[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const meta = readZipEntries(
    buf,
    (n) =>
      n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml',
  )
  const workbook = meta.get('xl/workbook.xml')
  if (workbook === undefined) throw invalidInput('这份 Excel 里找不到工作簿。')
  const rels = new Map<string, string>()
  for (const m of (meta.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(
    /<Relationship\b[^>]*>/g,
  )) {
    const a = attrs(m[0])
    if (a.Id !== undefined && a.Target !== undefined) rels.set(a.Id, sheetPath(a.Target))
  }
  const shared: string[] = []
  for (const m of (meta.get('xl/sharedStrings.xml') ?? '').matchAll(
    /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g,
  ))
    shared.push(textRuns(m[1] ?? ''))

  const sheets: { name: string; path: string }[] = []
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0])
    if (a.state === 'hidden' || a.state === 'veryHidden') continue
    const rid = a['r:id'] ?? Object.entries(a).find(([k]) => k.endsWith(':id'))?.[1]
    const path = rid === undefined ? undefined : rels.get(rid)
    if (path !== undefined) sheets.push({ name: a.name ?? '', path })
  }
  const wanted = new Set(sheets.slice(0, SHEET_LIMITS.sheets).map((s) => s.path))
  const files = readZipEntries(buf, (n) => wanted.has(n))
  return sheets
    .filter((s) => files.has(s.path))
    .map((s) => clampGrid({ name: s.name, rows: readXlsxSheet(files.get(s.path) ?? '', shared) }))
}

function readXlsxSheet(xml: string, shared: readonly string[]): string[][] {
  const rows: string[][] = []
  let nextRow = 0
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(`<row ${rm[1] ?? ''}>`)
    const r = ra.r === undefined ? nextRow : Number(ra.r) - 1
    nextRow = r + 1
    if (!(r >= 0 && r < SHEET_LIMITS.rows)) continue
    const row: string[] = []
    let nextCol = 0
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(`<c ${cm[1] ?? ''}>`)
      const at = ca.r === undefined ? undefined : cellAddress(ca.r)
      const c = at?.col ?? nextCol
      nextCol = c + 1
      if (c >= SHEET_LIMITS.cols) continue
      const inner = cm[2] ?? ''
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      let value = ''
      if (ca.t === 's') value = shared[Number(v)] ?? ''
      else if (ca.t === 'inlineStr')
        value = textRuns(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '')
      else if (ca.t === 'b') value = v === '1' ? 'TRUE' : v === undefined ? '' : 'FALSE'
      else if (v !== undefined) value = xmlUnescape(v)
      while (row.length < c) row.push('')
      row[c] = value
    }
    rows[r] = row
  }
  for (let i = 0; i < rows.length; i += 1) rows[i] ??= []
  const merges: { r1: number; c1: number; r2: number; c2: number }[] = []
  for (const m of xml.matchAll(/<mergeCell\b[^>]*>/g)) {
    const [a, b] = (attrs(m[0]).ref ?? '').split(':')
    const p = a === undefined ? undefined : cellAddress(a)
    const q = b === undefined ? p : cellAddress(b)
    if (p !== undefined && q !== undefined)
      merges.push({ r1: p.row, c1: p.col, r2: q.row, c2: q.col })
  }
  fillMerged(rows, merges)
  return rows
}
