/**
 * 从 PDF 里把文字与用过的颜色读出来（71 §6）。
 *
 * ## 为什么是自己写的，而不是装一个 PDF 库
 *
 * 开工时仓库里**一个 PDF 解析器都没有**（`packages/knowledge` 的 `parser` 那一格
 * 留了 `anydoc` 的位置，但注释明写"本包不安装 anydoc"；`dsh-office-to-pdf`
 * 在 WP93 被当成 259 MB 的下载型可选依赖挡掉了）。为了读一份品牌手册引入第一个
 * PDF 运行时依赖，要走 `docs/42` 一整轮上游评估——那该是一个单独的决定，不该
 * 夹在这个派工单里顺手做掉。
 *
 * 而品牌手册需要的东西恰好很浅：**页面上的文字**（颜色值、字体名、留白规则
 * 通常就写在那儿）与**页面用过的填充色**（色卡那几块）。这两样用 `node:zlib`
 * 加一个内容流扫描器就够，零依赖。
 *
 * ## 读不动什么，说清楚
 *
 * - **扫描件 / 纯图排版的手册**：没有文字层，这里回空。那种手册要逐页转图给
 *   视觉模型看——那条路需要契约里有"图进模型"这一格，现在**没有**
 *   （`ChatMessage.content` 是个纯 `string`）。所以这一版如实标「未找到」，
 *   不假装读到了。
 * - **子集嵌入字体的自定义编码**：文字取出来可能是乱码。取出来的串里
 *   非可打印字符过半时整页丢掉，宁可少读一页，不往规范里写一页乱码。
 * - 加密的 PDF：不解密，回空并说一句。
 */
import { inflateSync } from 'node:zlib'

export interface PdfPage {
  /** 从 1 数。 */
  page: number
  /** 这一页的文字（已经压过空白）。 */
  text: string
  /** 这一页里出现过的填充色，`#rrggbb`，按出现顺序去重。 */
  colors: string[]
}

/** 一份 PDF 最多读几页（与契约里的 `BRAND_DESIGN_MAX_FILE_PAGES` 同一个数由调用方传）。 */
export interface PdfReadOptions {
  maxPages?: number
}

/**
 * 读一份 PDF。**永不抛**——读不动就回空数组，由调用方说那句人话。
 */
export function pdfPages(bytes: Uint8Array, options: PdfReadOptions = {}): PdfPage[] {
  const max = options.maxPages ?? 64
  try {
    const raw = Buffer.from(bytes)
    if (!raw.subarray(0, 8).toString('latin1').startsWith('%PDF-')) return []
    // 加密的不碰
    if (/\/Encrypt\b/.test(raw.toString('latin1', 0, Math.min(raw.length, 4096)))) {
      const trailerTail = raw.toString('latin1', Math.max(0, raw.length - 4096))
      if (/\/Encrypt\b/.test(trailerTail)) return []
    }

    const objects = parseObjects(raw)
    const pages = pageContentObjects(raw, objects)
    const out: PdfPage[] = []
    for (const [i, refs] of pages.entries()) {
      if (out.length >= max) break
      const content = refs
        .map((n) => objects.get(n))
        .filter((o): o is PdfObject => o !== undefined)
        .map((o) => decodeStream(o))
        .join('\n')
      if (content === '') continue
      const text = squash(textOf(content))
      out.push({ page: i + 1, text: looksReadable(text) ? text : '', colors: colorsOf(content) })
    }
    return out
  } catch {
    // 一份写坏了的 PDF 不该让整次分析炸掉
    return []
  }
}

/* ── 对象表 ───────────────────────────────────────────────────────── */

interface PdfObject {
  dict: string
  stream?: Buffer
}

/**
 * 扫一遍 `N 0 obj … endobj`。
 *
 * **不建交叉引用表**：一份被增量更新过的 PDF 里同一个对象号会出现好几次，
 * 正规做法是按 xref 找最后那一版。这里的做法是"后来的覆盖先前的"——对增量
 * 更新过的文件结果一样，对线性化过的文件也一样，只有在极少见的对象流
 * （`/ObjStm`）里会漏。漏了就是少读几页，不会读错。
 */
function parseObjects(raw: Buffer): Map<number, PdfObject> {
  const out = new Map<number, PdfObject>()
  const text = raw.toString('latin1')
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  for (const m of text.matchAll(re)) {
    const num = Number(m[1])
    if (!Number.isFinite(num)) continue
    const start = (m.index ?? 0) + m[0].length
    const end = text.indexOf('endobj', start)
    if (end < 0) continue
    const body = text.slice(start, end)
    const streamAt = body.indexOf('stream')
    if (streamAt < 0) {
      out.set(num, { dict: body })
      continue
    }
    const dict = body.slice(0, streamAt)
    // `stream` 之后是 CRLF 或 LF，然后才是字节
    let dataStart = start + streamAt + 'stream'.length
    if (text[dataStart] === '\r') dataStart++
    if (text[dataStart] === '\n') dataStart++
    const endStream = text.indexOf('endstream', dataStart)
    if (endStream < 0) {
      out.set(num, { dict })
      continue
    }
    out.set(num, { dict, stream: raw.subarray(dataStart, endStream) })
  }
  return out
}

/** 每一页的内容流对象号，按页序。 */
function pageContentObjects(raw: Buffer, objects: Map<number, PdfObject>): number[][] {
  const text = raw.toString('latin1')
  const pages: number[][] = []
  // `/Type /Page`（不是 `/Pages`）。页序按对象在文件里出现的次序——线性化
  // 之外的情况都成立，而线性化的文件页序也基本按对象序排。
  for (const m of text.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    const num = Number(m[1])
    const obj = objects.get(num)
    if (obj === undefined) continue
    if (!/\/Type\s*\/Page(?![s])/.test(obj.dict)) continue
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(obj.dict)?.[1]
    if (contents === undefined) {
      pages.push([])
      continue
    }
    const refs = [...contents.matchAll(/(\d+)\s+\d+\s+R/g)]
      .map((r) => Number(r[1]))
      .filter((n) => Number.isFinite(n))
    pages.push(refs)
  }
  return pages
}

/** 解一个流（`FlateDecode` 或裸的）。解不开回空串。 */
function decodeStream(obj: PdfObject): string {
  if (obj.stream === undefined) return ''
  if (!/\/Filter/.test(obj.dict)) return obj.stream.toString('latin1')
  if (/\/FlateDecode/.test(obj.dict)) {
    try {
      return inflateSync(obj.stream).toString('latin1')
    } catch {
      return ''
    }
  }
  // 别的过滤器（DCT / CCITT）是图，不是文字
  return ''
}

/* ── 内容流 → 文字 ────────────────────────────────────────────────── */

/** 认得 `(…) Tj`、`[…] TJ`、`(…) '`、`(…) "`。 */
function textOf(content: string): string {
  const out: string[] = []
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b/g
  let pending: string[] = []
  for (const m of content.matchAll(re)) {
    const tok = m[0]
    if (tok === 'TJ' || tok === 'Tj') {
      out.push(pending.join(''))
      pending = []
      continue
    }
    if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'ET') {
      // 换行 / 段落：把待定的吐出来并补一个空格
      if (pending.length > 0) {
        out.push(pending.join(''))
        pending = []
      }
      out.push(' ')
      continue
    }
    pending.push(tok.startsWith('<') ? fromHexString(tok) : unescapePdfString(tok))
  }
  if (pending.length > 0) out.push(pending.join(''))
  return out.join(' ')
}

function unescapePdfString(token: string): string {
  const inner = token.slice(1, -1)
  return inner.replace(/\\(\d{1,3}|.)/g, (_whole, esc: string) => {
    if (/^\d+$/.test(esc)) return String.fromCharCode(Number.parseInt(esc, 8))
    switch (esc) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      default:
        return esc
    }
  })
}

function fromHexString(token: string): string {
  const hex = token.slice(1, -1).replace(/\s+/g, '')
  let out = ''
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = Number.parseInt(hex.slice(i, i + 2), 16)
    if (Number.isFinite(code) && code >= 32) out += String.fromCharCode(code)
  }
  return out
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 取出来的串像人话吗（子集嵌入字体会给出一串乱码）。 */
function looksReadable(text: string): boolean {
  if (text.length < 4) return text.length > 0
  let printable = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 32 || (c >= 33 && c <= 126) || c > 0x2000) printable++
  }
  return printable / [...text].length >= 0.6
}

/* ── 内容流 → 颜色 ────────────────────────────────────────────────── */

/**
 * 这一页用过的填充色。
 *
 * 只收**填充**（`rg` / `k` / `g` 小写），不收描边（大写）：色卡上那几个方块是
 * 填出来的，描边多半只是那几条分隔线。
 */
function colorsOf(content: string): string[] {
  const out: string[] = []
  const push = (hex: string): void => {
    if (!out.includes(hex)) out.push(hex)
  }
  const num = String.raw`(-?\d*\.?\d+)`
  const sp = String.raw`\s+`
  for (const m of content.matchAll(new RegExp(`${num}${sp}${num}${sp}${num}${sp}rg\\b`, 'g'))) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if ([r, g, b].every((n) => Number.isFinite(n))) push(hexOf(r * 255, g * 255, b * 255))
  }
  for (const m of content.matchAll(
    new RegExp(`${num}${sp}${num}${sp}${num}${sp}${num}${sp}k\\b`, 'g'),
  )) {
    const [c, mm, y, kk] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if ([c, mm, y, kk].every((n) => Number.isFinite(n))) push(cmykToHex(c, mm, y, kk))
  }
  for (const m of content.matchAll(new RegExp(`${num}${sp}g\\b`, 'g'))) {
    const v = Number(m[1])
    if (Number.isFinite(v)) push(hexOf(v * 255, v * 255, v * 255))
  }
  return out
}

function hexOf(r: number, g: number, b: number): string {
  const c = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/**
 * CMYK → HEX。
 *
 * 用的是最朴素的那条公式（不走 ICC 特性文件）。**这不是印刷级的换算**，
 * 所以原值一定要留着（契约里的 `BrandDesignPrintColor.raw`）：屏幕上画个
 * 大概的色块够用，真要去印刷厂的时候人看的是那串 CMYK / Pantone。
 */
export function cmykToHex(c: number, m: number, y: number, k: number): string {
  const f = (x: number): number =>
    255 * (1 - Math.min(1, Math.max(0, x))) * (1 - Math.min(1, Math.max(0, k)))
  return hexOf(f(c), f(m), f(y))
}

/* ── 手册里的图 → 视觉档（WP122b 交付 ⑤）─────────────────────────── */

export interface PdfImage {
  /** 图所在的那一页（从 1 数；归不到某一页时是 0）。 */
  page: number
  mime: 'image/jpeg'
  /** 原始 JPEG 字节（DCTDecode 流原样，不解码不重压）。 */
  bytes: Uint8Array
}

export interface PdfImageOptions {
  /** 最多取几张（视觉调用按张计积分，见契约 `CREDITS_PER_VISION_CALL`）。 */
  maxImages?: number
  /** 小于这个字节数的图当图标跳过（默认 1 KB）。 */
  minBytes?: number
}

/** 按出现顺序取页对象（`/Type /Page`，不是 `/Pages`）。 */
function pageDicts(raw: Buffer, objects: Map<number, PdfObject>): PdfObject[] {
  const text = raw.toString('latin1')
  const out: PdfObject[] = []
  for (const m of text.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    const obj = objects.get(Number(m[1]))
    if (obj !== undefined && /\/Type\s*\/Page(?![s])/.test(obj.dict)) out.push(obj)
  }
  return out
}

/**
 * 手册里的图取出来，交给视觉模型看（WP122b 交付 ⑤）。
 *
 * **为什么是"抽嵌图"而不是"逐页渲染"**：我们零依赖读 PDF（见文件头），
 * 没有一个渲染器能把页面画成像素。但品牌手册的版面本来就是拿图片排的——
 * 色卡、产品照、场景图都是嵌进去的 JPEG（`/Filter /DCTDecode`，字节原样
 * 就是 JPEG）。把它们抽出来给视觉模型，看的正是手册作者想让人看的那些图。
 * 纯文字页没有嵌图，自然跳过；扫描件（整页是一张图）反而最适合这条路。
 *
 * 页码是**尽力归**：页对象的 `/Resources /XObject` 里认得出就记那一页，
 * 认不出（继承的资源、内联资源字典）记 0。页码只进出处的 locator，
 * 错了不伤规范本身。
 */
export function pdfPageImages(bytes: Uint8Array, options: PdfImageOptions = {}): PdfImage[] {
  const max = options.maxImages ?? 8
  const minBytes = options.minBytes ?? 1024
  try {
    const raw = Buffer.from(bytes)
    if (!raw.subarray(0, 8).toString('latin1').startsWith('%PDF-')) return []
    const objects = parseObjects(raw)
    const pages = pageDicts(raw, objects)

    /** 每一页的资源字典里引用了哪些对象号（尽力归，解析不出的页空着）。 */
    const pageOf = new Map<number, number>()
    for (const [i, page] of pages.entries()) {
      const xobj = /\/XObject\s*<<(.*?)>>/s.exec(page.dict)?.[1]
      if (xobj === undefined) continue
      for (const r of xobj.matchAll(/(\d+)\s+\d+\s+R/g)) {
        const num = Number(r[1])
        if (!pageOf.has(num)) pageOf.set(num, i + 1)
      }
    }

    const out: PdfImage[] = []
    for (const [num, obj] of objects) {
      if (out.length >= max) break
      if (obj.stream === undefined) continue
      if (!/\/Subtype\s*\/Image\b/.test(obj.dict)) continue
      if (!/\/DCTDecode/.test(obj.dict)) continue
      if (obj.stream.length < minBytes) continue
      // 声明的 /Length 是流的真实字节数；解析器给的可能带一个尾随换行
      const declared = /\/Length\s+(\d+)\b/.exec(obj.dict)?.[1]
      const streamBytes =
        declared !== undefined && Number(declared) <= obj.stream.length
          ? obj.stream.subarray(0, Number(declared))
          : obj.stream
      if (streamBytes.length < minBytes) continue
      out.push({
        page: pageOf.get(num) ?? 0,
        mime: 'image/jpeg',
        bytes: new Uint8Array(streamBytes),
      })
    }
    return out
  } catch {
    // 与 pdfPages 同一条纪律：读不动就空手回，由调用方说那句人话
    return []
  }
}
