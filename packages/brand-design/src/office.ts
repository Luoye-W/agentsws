/**
 * docx / pptx → 文本页（WP122b 交付 ⑥，71 §9 第 5 条）。
 *
 * `extractFileDesign` 留了 `pages` 这个口子（调用方把拆好的页递进来），
 * 这里就是那个"别的链路"：**零依赖**把 Office OOXML（本身就是 zip）里的
 * 正文文字按页拆出来——
 *
 * - **docx**：`word/document.xml` 的段落文字。docx 没有"页"的概念（分页是
 *   排版时才发生的），所以整份文档记一页——出处 locator 少个页码，不伤规范；
 * - **pptx**：`ppt/slides/slideN.xml` 每张幻灯片一页，页码就是幻灯片号——
 *   手册式的 PPT 一页一个主题（"我们的颜色""我们的字体"），页码有用。
 *
 * 与 `pdf.ts` 同一条纪律：只读文字，认不出就空手回，**永不抛**。
 * 加密（带密码）的 OOXML 有独立的加密壳，这里读不到正文，照"空"处理。
 */
import { inflateRawSync } from 'node:zlib'
import type { PdfPage } from './pdf.js'

export interface OfficePagesOptions {
  maxPages?: number
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

/** 扫中央目录（对名字找条目足够了，不做通用解包器）。 */
function entriesOf(raw: Buffer): ZipEntry[] {
  // EOCD 最多带 65535 字节注释；从尾部往前找签名
  const scanFrom = Math.max(0, raw.length - 65_571)
  let eocd = -1
  for (let i = raw.length - 22; i >= scanFrom; i--) {
    if (raw.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []
  const total = raw.readUInt16LE(eocd + 10)
  let at = raw.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  for (let i = 0; i < total; i++) {
    if (at + 46 > raw.length || raw.readUInt32LE(at) !== CENTRAL_SIG) break
    const flags = raw.readUInt16LE(at + 8)
    const method = raw.readUInt16LE(at + 10)
    const compressedSize = raw.readUInt32LE(at + 20)
    const nameLen = raw.readUInt16LE(at + 28)
    const extraLen = raw.readUInt16LE(at + 30)
    const commentLen = raw.readUInt16LE(at + 32)
    const localOffset = raw.readUInt32LE(at + 42)
    const name = raw.toString('utf8', at + 46, at + 46 + nameLen)
    // 加密位（bit 0）置起的条目读不了，照"没有"处理
    if ((flags & 1) === 0) out.push({ name, method, compressedSize, localOffset })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 取一个条目的解压后字节。读不动回 `undefined`。 */
function entryBytes(raw: Buffer, entry: ZipEntry): Buffer | undefined {
  try {
    if (entry.localOffset + 30 > raw.length) return undefined
    if (raw.readUInt32LE(entry.localOffset) !== LOCAL_SIG) return undefined
    const nameLen = raw.readUInt16LE(entry.localOffset + 26)
    const extraLen = raw.readUInt16LE(entry.localOffset + 28)
    const start = entry.localOffset + 30 + nameLen + extraLen
    const data = raw.subarray(start, start + entry.compressedSize)
    if (entry.method === 0) return data
    if (entry.method === 8) return inflateRawSync(data)
    return undefined
  } catch {
    return undefined
  }
}

function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 取出 XML 里 `<w:t>` / `<a:t>` 的文字，段落之间补换行。 */
function textOfRuns(xml: string): string {
  const out: string[] = []
  // 段落边界：docx 的 </w:p> 与 pptx 的 </a:p>
  for (const para of xml.split(/<\/w:p>|<\/a:p>/)) {
    const runs = [...para.matchAll(/<[wa]:t[^>]*>([^<]*)<\/[wa]:t>/g)].map((m) =>
      unescapeXml(m[1] ?? ''),
    )
    const line = runs.join('').trim()
    if (line !== '') out.push(line)
  }
  return out.join('\n')
}

/**
 * 拆 docx / pptx 的文字页。
 *
 * 认不出 zip 结构 / 没有正文条目 → 空数组（调用方说那句人话）。
 * `.doc / .ppt`（老二进制格式）不是 zip，一样空手回。
 */
export function officePages(bytes: Uint8Array, options: OfficePagesOptions = {}): PdfPage[] {
  const max = options.maxPages ?? 64
  try {
    const raw = Buffer.from(bytes)
    const entries = entriesOf(raw)
    if (entries.length === 0) return []

    const out: PdfPage[] = []
    const doc = entries.find((e) => e.name === 'word/document.xml')
    if (doc !== undefined) {
      const data = entryBytes(raw, doc)
      if (data !== undefined) {
        const text = squash(textOfRuns(data.toString('utf8')))
        if (text !== '') out.push({ page: 1, text, colors: [] })
      }
      return out
    }

    const slides = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .map((e) => ({ num: Number(/slide(\d+)\.xml$/.exec(e.name)?.[1] ?? 0), entry: e }))
      .sort((a, b) => a.num - b.num)
    for (const slide of slides) {
      if (out.length >= max) break
      const data = entryBytes(raw, slide.entry)
      if (data === undefined) continue
      const text = squash(textOfRuns(data.toString('utf8')))
      if (text === '') continue
      out.push({ page: slide.num, text, colors: [] })
    }
    return out
  } catch {
    return []
  }
}

function squash(text: string): string {
  return text.replace(/[ \t]+/g, ' ').trim()
}
