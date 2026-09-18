/**
 * WP99：**CSV 自己解**（RFC 4180），不走 exceljs 的 `workbook.csv.read`。
 *
 * 换库那一步（`xlsx@0.18.5` → `exceljs@4.4.0`）留了一道二选一：`.csv` 用 exceljs 的
 * csv 读，还是自己按 RFC 4180 解析。**选自己解**，三条理由：
 *
 * 1. **exceljs 的 csv 读要 Node 流**：`workbook.csv.read(stream)` 吃的是一个
 *    `stream.Readable`，底下是 `fast-csv`。浏览器那一侧只有 `Blob` 与字节，要么
 *    自己造一层流的垫片，要么把 `readable-stream` 的浏览器垫片也拖进 bundle——
 *    为一个 300 字节就写得完的格式，这笔不划算；
 * 2. **CSV 不是 Excel**：一份 csv 里没有 sheet、没有格式、没有公式，读它本来就
 *    不需要一个工作簿模型。绕一圈 exceljs 只是为了"用同一个库"这句话好听；
 * 3. **解析面积**：这个文件 60 行、没有依赖、纯函数，读得完也测得全。
 *
 * **不做的事**（写在明处，免得下一个人以为是漏了）：不猜分隔符（只认逗号——
 * 分号档的欧洲 csv 这一栏会连成一列，那时人去下载原件）、不猜编码（只当 UTF-8，
 * 带 BOM 的去掉 BOM）、不认 `sep=` 那一行 Excel 私货。
 */

/** 一份 csv 最多解多少行——再长的表在 380 的抽屉里也只是滚不到头（与表格那一档同口径）。 */
const MAX_ROWS = 20_000

/**
 * 把一段 UTF-8 字节解成二维字符串。
 *
 * RFC 4180 的四条：字段用逗号隔开；字段可以用双引号包起来；包起来的字段里
 * 双引号写两遍表示一个双引号；包起来的字段里可以有逗号与换行。
 * 行尾 `\r\n` / `\n` / `\r` 三种都认（Excel 导出的是前者，Mac 老程序是后者）。
 */
export function parseCsv(text: string): string[][] {
  // BOM：Excel 导出的 UTF-8 csv 前面有三个字节，不去掉的话第一格会多一个看不见的字符
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < src.length) {
    const ch = src[i] as string
    if (quoted) {
      if (ch === '"') {
        // `""` 是一个字面双引号；单个 `"` 是引号段结束
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      quoted = true
      i += 1
      continue
    }
    if (ch === ',') {
      endField()
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      endRow()
      if (rows.length >= MAX_ROWS) return rows
      // `\r\n` 只算一个行尾
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i += 1
  }
  // 最后一行没有行尾时也要收进去；整份空文件不产生一行空的
  if (field !== '' || row.length > 0) endRow()
  return rows
}

/** 字节 → 二维字符串（只当 UTF-8；坏字节由 `TextDecoder` 替成 U+FFFD，不抛）。 */
export function parseCsvBytes(bytes: Uint8Array): string[][] {
  return parseCsv(new TextDecoder('utf-8').decode(bytes))
}
