/**
 * WP322 测试用：手写的假表格（xlsx / xls）。**不放任何真实客户数据**——内容全是测试里现编的。
 *
 * xlsx = 几份 XML 打成 zip（借本包的 `zipFiles`）；xls = 手拼的 BIFF8 记录装进一个最小的
 * OLE2 复合文档（可选放进迷你流，覆盖小文件那条路）。
 */
import { Buffer } from 'node:buffer'
import { zipFiles } from '../src/zip.js'

export interface FakeSheet {
  name: string
  rows: (string | number | null)[][]
  /** `A1:B2` 这种。 */
  merges?: string[]
  hidden?: boolean
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const colName = (c: number): string => {
  let n = c + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** 第一张表的字串用共享字串表；其余表用行内字串（两条路都走到）。 */
export function buildXlsx(sheets: readonly FakeSheet[]): Buffer {
  const shared: string[] = []
  const sharedIndex = (s: string): number => {
    const i = shared.indexOf(s)
    if (i >= 0) return i
    shared.push(s)
    return shared.length - 1
  }
  const sheetXml = sheets.map((sheet, si) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((v, c) => {
            const ref = `${colName(c)}${r + 1}`
            if (v === null) return ''
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
            if (si === 0) return `<c r="${ref}" t="s"><v>${sharedIndex(v)}</v></c>`
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
          })
          .join('')
        return `<row r="${r + 1}">${cells}</row>`
      })
      .join('')
    const merges =
      sheet.merges === undefined || sheet.merges.length === 0
        ? ''
        : `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${merges}</worksheet>`
  })
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map(
      (s, i) =>
        `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden === true ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`,
    )
    .join('')}</sheets></workbook>`
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('')}</Relationships>`
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
    .join('')}</sst>`
  return zipFiles([
    { path: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    { path: 'xl/workbook.xml', content: workbook },
    { path: 'xl/_rels/workbook.xml.rels', content: rels },
    { path: 'xl/sharedStrings.xml', content: sst },
    ...sheetXml.map((content, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, content })),
  ])
}

// ── xls（BIFF8 + OLE2）─────────────────────────────────────────────

const rec = (type: number, data: Buffer): Buffer => {
  const head = Buffer.alloc(4)
  head.writeUInt16LE(type, 0)
  head.writeUInt16LE(data.length, 2)
  return Buffer.concat([head, data])
}
const u16b = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}
const u32b = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}
const bof = (dt: number): Buffer =>
  rec(0x0809, Buffer.concat([u16b(0x0600), u16b(dt), u16b(0), u16b(1997), u32b(0), u32b(0x0206)]))
const EOF = rec(0x000a, Buffer.alloc(0))
const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le')
const ascii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s)

/**
 * 共享字串表：故意把**第二个**字串从中间切进一条 CONTINUE——前半截按单字节写，
 * CONTINUE 开头的标志字节改成双字节（Excel 真会这么切），读法得两头都认。
 */
function sstRecords(strings: readonly string[]): Buffer {
  const parts: Buffer[] = [u32b(strings.length), u32b(strings.length)]
  let cont: Buffer[] | undefined
  strings.forEach((s, i) => {
    if (i === 1 && ascii(s) && s.length >= 4) {
      parts.push(u16b(s.length), Buffer.from([0]), Buffer.from(s.slice(0, 2), 'latin1'))
      cont = [Buffer.from([1]), utf16(s.slice(2))]
      return
    }
    const target = cont ?? parts
    target.push(u16b(s.length), Buffer.from([1]), utf16(s))
  })
  const first = rec(0x00fc, Buffer.concat(parts))
  return cont === undefined ? first : Buffer.concat([first, rec(0x003c, Buffer.concat(cont))])
}

function range(ref: string): number[] {
  const [a, b] = ref.split(':') as [string, string]
  const at = (x: string) => {
    const m = /^([A-Z]+)(\d+)$/.exec(x) as RegExpExecArray
    let c = 0
    for (const ch of m[1] as string) c = c * 26 + ch.charCodeAt(0) - 64
    return { r: Number(m[2]) - 1, c: c - 1 }
  }
  const p = at(a)
  const q = at(b)
  return [p.r, q.r, p.c, q.c]
}

function workbookBiff(sheets: readonly FakeSheet[]): Buffer {
  const strings: string[] = []
  const idx = (s: string) => {
    const i = strings.indexOf(s)
    if (i >= 0) return i
    strings.push(s)
    return strings.length - 1
  }
  const bodies = sheets.map((sheet) => {
    const cells: Buffer[] = []
    sheet.rows.forEach((row, r) => {
      row.forEach((v, c) => {
        if (v === null) return
        const head = Buffer.concat([u16b(r), u16b(c), u16b(0)])
        if (typeof v === 'number') {
          const d = Buffer.alloc(8)
          d.writeDoubleLE(v, 0)
          cells.push(rec(0x0203, Buffer.concat([head, d])))
        } else if (v.startsWith('label:')) {
          const s = v.slice(6)
          cells.push(rec(0x0204, Buffer.concat([head, u16b(s.length), Buffer.from([1]), utf16(s)])))
        } else cells.push(rec(0x00fd, Buffer.concat([head, u32b(idx(v))])))
      })
    })
    const merges = sheet.merges ?? []
    const merged =
      merges.length === 0
        ? Buffer.alloc(0)
        : rec(
            0x00e5,
            Buffer.concat([u16b(merges.length), ...merges.flatMap((m) => range(m).map(u16b))]),
          )
    return Buffer.concat([bof(0x0010), ...cells, merged, EOF])
  })
  const sheetRecs = sheets.map((s) =>
    rec(
      0x0085,
      Buffer.concat([
        u32b(0),
        Buffer.from([s.hidden === true ? 1 : 0, 0, s.name.length, 1]),
        utf16(s.name),
      ]),
    ),
  )
  const globals = Buffer.concat([bof(0x0005), ...sheetRecs, sstRecords(strings), EOF])
  // 回填每张表 BOF 在流里的位置
  let offset = globals.length
  let cursor = bof(0x0005).length
  for (const [i, r] of sheetRecs.entries()) {
    globals.writeUInt32LE(offset, cursor + 4)
    cursor += r.length
    offset += (bodies[i] as Buffer).length
  }
  return Buffer.concat([globals, ...bodies])
}

const END = 0xfffffffe
const FREE = 0xffffffff

function dirEntry(name: string, type: number, start: number, size: number, child = FREE): Buffer {
  const e = Buffer.alloc(128)
  const n = utf16(name)
  n.copy(e, 0)
  e.writeUInt16LE(n.length + 2, 0x40)
  e[0x42] = type
  e[0x43] = 1
  e.writeUInt32LE(FREE, 0x44)
  e.writeUInt32LE(FREE, 0x48)
  e.writeUInt32LE(child, 0x4c)
  e.writeUInt32LE(start, 0x74)
  e.writeUInt32LE(size, 0x78)
  return e
}

/** 把 BIFF8 装进 OLE2。`mini: true` 时工作簿流放进迷你流（< 4096 字节那条路）。 */
export function buildXls(sheets: readonly FakeSheet[], opts: { mini?: boolean } = {}): Buffer {
  let stream = workbookBiff(sheets)
  const mini = opts.mini === true
  if (mini && stream.length >= 4096) throw new Error('迷你流要小于 4096 字节')
  if (!mini && stream.length < 4096)
    stream = Buffer.concat([stream, Buffer.alloc(4096 - stream.length)])
  const pad = (b: Buffer, n: number) => Buffer.concat([b, Buffer.alloc((n - (b.length % n)) % n)])
  const fat = new Array<number>(128).fill(FREE)
  fat[0] = 0xfffffffd
  fat[1] = END
  const sectors: Buffer[] = []
  let root: Buffer
  let book: Buffer
  let firstMiniFat = END
  let numMiniFat = 0
  if (mini) {
    const ministream = pad(stream, 64)
    const count = ministream.length / 64
    const minifat = Buffer.alloc(512, 0xff)
    for (let i = 0; i < count; i += 1) minifat.writeUInt32LE(i === count - 1 ? END : i + 1, i * 4)
    fat[2] = END
    firstMiniFat = 2
    numMiniFat = 1
    const container = pad(ministream, 512)
    const n = container.length / 512
    for (let i = 0; i < n; i += 1) fat[3 + i] = i === n - 1 ? END : 4 + i
    sectors.push(minifat, container)
    root = dirEntry('Root Entry', 5, 3, ministream.length, 1)
    book = dirEntry('Workbook', 2, 0, stream.length)
  } else {
    const body = pad(stream, 512)
    const n = body.length / 512
    for (let i = 0; i < n; i += 1) fat[2 + i] = i === n - 1 ? END : 3 + i
    sectors.push(body)
    root = dirEntry('Root Entry', 5, END, 0, 1)
    book = dirEntry('Workbook', 2, 2, stream.length)
  }
  const header = Buffer.alloc(512, 0)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
  header.writeUInt16LE(0x3e, 0x18)
  header.writeUInt16LE(3, 0x1a)
  header.writeUInt16LE(0xfffe, 0x1c)
  header.writeUInt16LE(9, 0x1e)
  header.writeUInt16LE(6, 0x20)
  header.writeUInt32LE(1, 0x2c)
  header.writeUInt32LE(1, 0x30)
  header.writeUInt32LE(4096, 0x38)
  header.writeUInt32LE(firstMiniFat, 0x3c)
  header.writeUInt32LE(numMiniFat, 0x40)
  header.writeUInt32LE(END, 0x44)
  header.writeUInt32LE(0, 0x48)
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i === 0 ? 0 : FREE, 0x4c + i * 4)
  const fatSector = Buffer.alloc(512)
  fat.forEach((v, i) => {
    fatSector.writeUInt32LE(v >>> 0, i * 4)
  })
  const dir = Buffer.concat([root, book, dirEntry('', 0, 0, 0), dirEntry('', 0, 0, 0)])
  return Buffer.concat([header, fatSector, dir, ...sectors])
}
