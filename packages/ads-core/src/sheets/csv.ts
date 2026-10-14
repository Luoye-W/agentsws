/**
 * 最小的 CSV / 制表符文本编解码（RFC 4180 的引号规则）。
 *
 * 自己写而不拉依赖：本包要在插件、桌面端、云端三处都能跑（无 `node:*`），
 * 而这里只要两件事——把格子拼成一行、把一份导出拆回格子。
 */

/** 一格要不要加引号：含分隔符、引号、换行，或首尾有空格。 */
function needsQuote(cell: string, delimiter: string): boolean {
  return (
    cell.includes(delimiter) ||
    cell.includes('"') ||
    cell.includes('\n') ||
    cell.includes('\r') ||
    cell !== cell.trim()
  )
}

/** 把一张表拼成文本。行尾用 `\r\n`（Excel 与两家后台都认）。 */
export function encodeDelimited(
  rows: readonly (readonly string[])[],
  delimiter: ',' | '\t' = ',',
): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (needsQuote(cell, delimiter) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join(delimiter),
    )
    .join('\r\n')
}

/** 去掉 UTF-8 BOM（U+FEFF）。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 猜分隔符：看前几行里制表符多还是逗号多。
 * Meta「导出为文字」与 Google「Excel CSV」常是制表符；普通 CSV 是逗号。
 */
export function detectDelimiter(text: string): ',' | '\t' {
  const head = text.split(/\r?\n/, 8).join('\n')
  const tabs = head.split('\t').length - 1
  const commas = head.split(',').length - 1
  return tabs > 0 && tabs >= commas / 2 ? '\t' : ','
}

/** 把文本拆回格子。认引号、引号里的换行、`""` 转义；空行丢掉。 */
export function parseDelimited(text: string, delimiter?: ',' | '\t'): string[][] {
  const src = stripBom(text)
  const d = delimiter ?? detectDelimiter(src)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i += 1
        } else inQuotes = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell === '') inQuotes = true
    else if (ch === d) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/**
 * 把导出文件的字节解成文字：认 UTF-16LE / UTF-16BE / UTF-8 的 BOM，没有 BOM 按 UTF-8。
 * Google「Excel CSV」常是带 BOM 的 UTF-16（没核实到官方说明，按 BOM 判，不按扩展名猜）。
 */
export function decodeExportBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  return stripBom(new TextDecoder('utf-8').decode(bytes))
}
