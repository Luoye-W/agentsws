/**
 * WP322：读 2003 之前那种 `.xls`（OLE2 复合文档里的 BIFF8 `Workbook` 流）。
 *
 * 只认 FAQ 导入要的那几种记录：工作表清单、共享字串表、文字 / 数字格、公式的结果、合并格。
 * BIFF5（Excel 95 的 `Book` 流）不认——那一档请人另存为 xlsx（一句人话，不猜）。
 *
 * 外来字节，每条链都设了上限：扇区链最多走多少步、记录最多读多少条，读坏了抛 `invalid_input`。
 */
import { invalidInput } from './errors.js'
import { fillMerged, type SheetGrid } from './sheet.js'

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const END_OF_CHAIN = 0xfffffffe
const FREE = 0xffffffff
/** 链再长也不会超过文件里的扇区数；再加一道死上限防环。 */
const MAX_CHAIN = 1 << 20

const bad = (why: string) =>
  invalidInput(`这份 .xls 读不了（${why}）。可以在 Excel 里另存为 .xlsx 再传。`)

interface Cfb {
  view: DataView
  bytes: Uint8Array
  sectorSize: number
  fat: number[]
}

function sectorOffset(cfb: Cfb, n: number): number {
  return (n + 1) * cfb.sectorSize
}

function chain(fat: readonly number[], start: number): number[] {
  const out: number[] = []
  let n = start
  const seen = new Set<number>()
  while (n !== END_OF_CHAIN && n !== FREE) {
    if (seen.has(n) || out.length > MAX_CHAIN || n >= fat.length) throw bad('扇区链坏了')
    seen.add(n)
    out.push(n)
    n = fat[n] ?? END_OF_CHAIN
  }
  return out
}

function readChain(cfb: Cfb, start: number, size?: number): Uint8Array {
  const sectors = chain(cfb.fat, start)
  const out = new Uint8Array(sectors.length * cfb.sectorSize)
  sectors.forEach((s, i) => {
    const off = sectorOffset(cfb, s)
    out.set(cfb.bytes.subarray(off, off + cfb.sectorSize), i * cfb.sectorSize)
  })
  return size === undefined ? out : out.subarray(0, size)
}

/** 从复合文档里取出 `Workbook` 流的字节。 */
export function workbookStream(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 512 || !OLE2.every((b, i) => bytes[i] === b)) throw bad('不是 OLE2 文件')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sectorSize = 1 << view.getUint16(0x1e, true)
  const miniSize = 1 << view.getUint16(0x20, true)
  if (sectorSize !== 512 && sectorSize !== 4096) throw bad('扇区大小不对')
  const firstDir = view.getUint32(0x30, true)
  const cutoff = view.getUint32(0x38, true)
  const firstMiniFat = view.getUint32(0x3c, true)
  let difatSector = view.getUint32(0x44, true)
  const cfb: Cfb = { view, bytes, sectorSize, fat: [] }

  // DIFAT：头里 109 个，之后挂在 DIFAT 扇区链上（每个扇区最后 4 字节指向下一个）
  const fatSectors: number[] = []
  for (let i = 0; i < 109; i += 1) {
    const s = view.getUint32(0x4c + i * 4, true)
    if (s !== FREE) fatSectors.push(s)
  }
  let hops = 0
  while (difatSector !== END_OF_CHAIN && difatSector !== FREE) {
    hops += 1
    if (hops > 1 << 14) throw bad('DIFAT 链坏了')
    const off = sectorOffset(cfb, difatSector)
    if (off + sectorSize > bytes.length) throw bad('DIFAT 越界')
    const per = sectorSize / 4 - 1
    for (let i = 0; i < per; i += 1) {
      const s = view.getUint32(off + i * 4, true)
      if (s !== FREE) fatSectors.push(s)
    }
    difatSector = view.getUint32(off + per * 4, true)
  }
  for (const s of fatSectors) {
    const off = sectorOffset(cfb, s)
    if (off + sectorSize > bytes.length) throw bad('FAT 越界')
    for (let i = 0; i < sectorSize / 4; i += 1) cfb.fat.push(view.getUint32(off + i * 4, true))
  }

  const dir = readChain(cfb, firstDir)
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  let root: { start: number; size: number } | undefined
  let book: { start: number; size: number } | undefined
  let biff5 = false
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dv.getUint16(off + 0x40, true)
    const type = dir[off + 0x42]
    let name = ''
    for (let i = 0; i + 2 <= Math.min(nameLen, 64) - 2; i += 2)
      name += String.fromCharCode(dv.getUint16(off + i, true))
    const entry = { start: dv.getUint32(off + 0x74, true), size: dv.getUint32(off + 0x78, true) }
    if (type === 5) root = entry
    else if (type === 2 && name === 'Workbook') book = entry
    else if (type === 2 && name === 'Book') biff5 = true
  }
  if (book === undefined) throw bad(biff5 ? '是 Excel 95 的老格式' : '里面没有工作簿')
  if (book.size >= cutoff) return readChain(cfb, book.start, book.size)

  // 小于 4096 字节的流放在迷你流里：迷你扇区挂在根条目那条链上，链表在迷你 FAT 里
  if (root === undefined) throw bad('没有根条目')
  const ministream = readChain(cfb, root.start, root.size)
  const minifatBytes =
    firstMiniFat === END_OF_CHAIN ? new Uint8Array() : readChain(cfb, firstMiniFat)
  const mv = new DataView(minifatBytes.buffer, minifatBytes.byteOffset, minifatBytes.byteLength)
  const minifat: number[] = []
  for (let i = 0; i + 4 <= minifatBytes.length; i += 4) minifat.push(mv.getUint32(i, true))
  const sectors = chain(minifat, book.start)
  const out = new Uint8Array(sectors.length * miniSize)
  sectors.forEach((s, i) => {
    out.set(ministream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize)
  })
  return out.subarray(0, book.size)
}

// ── BIFF8 记录 ─────────────────────────────────────────────────────

interface Record8 {
  type: number
  data: Uint8Array
}

function records(stream: Uint8Array, from: number): Record8[] {
  const out: Record8[] = []
  let off = from
  while (off + 4 <= stream.length) {
    const type = (stream[off] as number) | ((stream[off + 1] as number) << 8)
    const len = (stream[off + 2] as number) | ((stream[off + 3] as number) << 8)
    if (off + 4 + len > stream.length) break
    out.push({ type, data: stream.subarray(off + 4, off + 4 + len) })
    off += 4 + len
    if (type === 0x000a) break // EOF：这一段（全局 / 一张表）读完
    if (out.length > 2_000_000) throw bad('记录太多')
  }
  return out
}

const u16 = (d: Uint8Array, o: number): number => (d[o] ?? 0) | ((d[o + 1] ?? 0) << 8)
const u32 = (d: Uint8Array, o: number): number => (u16(d, o) | (u16(d, o + 2) << 16)) >>> 0
const f64 = (d: Uint8Array, o: number): number =>
  new DataView(d.buffer, d.byteOffset + o, 8).getFloat64(0, true)

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15)))
}

function rk(v: number): number {
  let n: number
  if (v & 2) n = v >> 2
  else {
    const buf = new DataView(new ArrayBuffer(8))
    buf.setUint32(4, v & 0xfffffffc, true)
    n = buf.getFloat64(0, true)
  }
  return v & 1 ? n / 100 : n
}

/** 字符：压缩的（每字 1 字节，Latin-1）或 UTF-16LE。 */
function chars(d: Uint8Array, o: number, n: number, high: boolean): string {
  let s = ''
  for (let i = 0; i < n; i += 1)
    s += String.fromCharCode(high ? u16(d, o + i * 2) : (d[o + i] ?? 0))
  return s
}

/** `XLUnicodeString`（u16 长度 + 一字节标志），LABEL / STRING 记录用。 */
function unicodeString(d: Uint8Array, o: number): string {
  const n = u16(d, o)
  return chars(d, o + 3, n, ((d[o + 2] ?? 0) & 1) === 1)
}

/**
 * 共享字串表（SST）。难点在 CONTINUE：一个字串的字可能被切到下一条记录里，
 * 而那条记录开头会再给一个标志字节（这一截是不是双字节）。富文本 / 东亚注音块
 * 也可能跨记录，只跳过不读。
 */
function readSst(segments: readonly Uint8Array[]): string[] {
  let seg = 0
  let pos = 8 // 跳过 cstTotal / cstUnique
  const cur = (): Uint8Array => segments[seg] ?? new Uint8Array()
  const ensure = (): void => {
    while (seg < segments.length && pos >= cur().length) {
      seg += 1
      pos = 0
    }
  }
  const byte = (): number => {
    ensure()
    const b = cur()[pos] ?? 0
    pos += 1
    return b
  }
  const word = (): number => byte() | (byte() << 8)
  const skip = (n: number): void => {
    let left = n
    while (left > 0 && seg < segments.length) {
      ensure()
      const take = Math.min(left, cur().length - pos)
      pos += take
      left -= take
    }
  }
  const unique = u32(segments[0] ?? new Uint8Array(), 4)
  const out: string[] = []
  for (let i = 0; i < unique && seg < segments.length; i += 1) {
    ensure()
    const n = word()
    const flags = byte()
    let high = (flags & 1) === 1
    const runs = flags & 8 ? word() : 0
    const ext = flags & 4 ? word() | (word() << 16) : 0
    let s = ''
    let left = n
    while (left > 0 && seg < segments.length) {
      if (pos >= cur().length) {
        seg += 1
        pos = 0
        if (seg >= segments.length) break
        high = (byte() & 1) === 1 // CONTINUE 开头那个标志字节
      }
      const room = Math.floor((cur().length - pos) / (high ? 2 : 1))
      const take = Math.min(left, room)
      s += chars(cur(), pos, take, high)
      pos += take * (high ? 2 : 1)
      left -= take
    }
    skip(runs * 4 + ext)
    out.push(s)
  }
  return out
}

/** 读 BIFF8 工作簿：每张（看得见的）工作表一张格子。 */
export function readXls(bytes: Uint8Array): SheetGrid[] {
  const stream = workbookStream(bytes)
  const globals = records(stream, 0)
  if (globals[0]?.type !== 0x0809) throw bad('开头不是 BOF')
  if (u16(globals[0].data, 0) !== 0x0600) throw bad('不是 BIFF8')
  const sheets: { name: string; offset: number }[] = []
  const sst: Uint8Array[] = []
  let inSst = false
  for (const r of globals) {
    if (r.type === 0x0085) {
      const visible = (r.data[4] ?? 0) === 0
      const isWorksheet = (r.data[5] ?? 0) === 0
      const n = r.data[6] ?? 0
      const name = chars(r.data, 8, n, ((r.data[7] ?? 0) & 1) === 1)
      if (visible && isWorksheet) sheets.push({ name, offset: u32(r.data, 0) })
    }
    if (r.type === 0x00fc) {
      sst.push(r.data)
      inSst = true
    } else if (r.type === 0x003c && inSst) sst.push(r.data)
    else inSst = false
  }
  const shared = sst.length === 0 ? [] : readSst(sst)
  return sheets
    .slice(0, 30)
    .map((s) => ({ name: s.name, rows: readXlsSheet(stream, s.offset, shared) }))
}

function readXlsSheet(stream: Uint8Array, offset: number, shared: readonly string[]): string[][] {
  const rows: string[][] = []
  const put = (r: number, c: number, v: string): void => {
    if (r >= 5000 || c >= 50) return
    const row = rows[r] ?? []
    rows[r] = row
    while (row.length < c) row.push('')
    row[c] = v
  }
  const merges: { r1: number; c1: number; r2: number; c2: number }[] = []
  let pendingString: { r: number; c: number } | undefined
  for (const { type, data: d } of records(stream, offset)) {
    if (type === 0x00fd) put(u16(d, 0), u16(d, 2), shared[u32(d, 6)] ?? '')
    else if (type === 0x0204) put(u16(d, 0), u16(d, 2), unicodeString(d, 6))
    else if (type === 0x0203) put(u16(d, 0), u16(d, 2), num(f64(d, 6)))
    else if (type === 0x027e) put(u16(d, 0), u16(d, 2), num(rk(u32(d, 6))))
    else if (type === 0x00bd) {
      const r = u16(d, 0)
      const first = u16(d, 2)
      const count = (d.length - 6) / 6
      for (let i = 0; i < count; i += 1) put(r, first + i, num(rk(u32(d, 4 + i * 6 + 2))))
    } else if (type === 0x0205) {
      if ((d[7] ?? 0) === 0) put(u16(d, 0), u16(d, 2), d[6] === 1 ? 'TRUE' : 'FALSE')
    } else if (type === 0x0006) {
      const r = u16(d, 0)
      const c = u16(d, 2)
      if (u16(d, 12) === 0xffff) {
        // 结果不是数：0 = 字串（在紧跟的 STRING 记录里），1 = 布尔，3 = 空串
        if (d[6] === 0) pendingString = { r, c }
        else if (d[6] === 1) put(r, c, d[8] === 1 ? 'TRUE' : 'FALSE')
      } else put(r, c, num(f64(d, 6)))
    } else if (type === 0x0207 && pendingString !== undefined) {
      put(pendingString.r, pendingString.c, unicodeString(d, 0))
      pendingString = undefined
    } else if (type === 0x00e5) {
      const n = u16(d, 0)
      for (let i = 0; i < n; i += 1) {
        const o = 2 + i * 8
        merges.push({ r1: u16(d, o), r2: u16(d, o + 2), c1: u16(d, o + 4), c2: u16(d, o + 6) })
      }
    }
  }
  for (let i = 0; i < rows.length; i += 1) rows[i] ??= []
  fillMerged(rows, merges)
  return rows
}
