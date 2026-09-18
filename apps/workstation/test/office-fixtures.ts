/**
 * WP97：三种格式各一份**自己造**的小样本。
 *
 * 不从网上下载样本文件（派工书那条），也不把二进制签进仓库：`.docx` / `.pptx`
 * 就是一个 zip 加几份 XML，用已经在树里的 JSZip 现造；`.xlsx` 用 exceljs 自己写
 * （WP99 换库之前这一份是 SheetJS 写的——**造样本与读样本用同一个库**，
 * 否则"读得出来"这件事里就掺了另一个库的实现细节）。
 * 好处是样本的**内容是这个文件里写着的**——用例断言"渲染出这句话"时，
 * 那句话的出处就在上面几行，不用去翻一个谁也打不开的二进制。
 */
import JSZip from 'jszip'

const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** 一份只有两段文字的 .docx。 */
export async function docxFixture(
  paragraphs: readonly string[] = ['退货窗口是 30 天', '超过 30 天走人工审批'],
): Promise<Blob> {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES_DOCX)
  zip.file('_rels/.rels', ROOT_RELS_DOCX)
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'blob' })
}

/** 一行里能出现的几种值（日期那一档专门用来钉"日期怎么显示"）。 */
export type CellValue = string | number | Date

/**
 * 一份有两张表的 .xlsx（第二张用来测"多 sheet 切换"）。
 *
 * exceljs 的浏览器包是 UMD、Node 里解到的是 CJS——`Workbook` 一边在命名空间上、
 * 一边在 `default` 上，与 `sheet-view.tsx` 里那个 `loadWorkbookClass` 同一个道理。
 */
export async function xlsxFixture(
  sheets: Readonly<Record<string, readonly (readonly CellValue[])[]>> = {
    订单: [
      ['订单号', '金额'],
      ['SO-1', 128],
      ['SO-2', 256],
    ],
    退款: [['原因'], ['尺码不合']],
  },
): Promise<Blob> {
  const mod = (await import('exceljs')) as unknown as {
    Workbook?: new () => ExcelWorkbook
    default?: { Workbook?: new () => ExcelWorkbook }
  }
  const Workbook = mod.Workbook ?? mod.default?.Workbook
  if (Workbook === undefined) throw new Error('exceljs: 找不到 Workbook')
  const book = new Workbook()
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = book.addWorksheet(name)
    for (const row of rows) sheet.addRow([...row])
  }
  const bytes = await book.xlsx.writeBuffer()
  return new Blob([bytes as unknown as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

/** 只用到这三件事，不把 exceljs 的整份型别拖进来。 */
interface ExcelWorkbook {
  addWorksheet(name: string): { addRow(values: CellValue[]): unknown }
  xlsx: { writeBuffer(): Promise<unknown> }
}

/** 一份 N 行 × 2 列的大表（测"每页 200 行"的分页）。 */
export async function bigXlsxFixture(rows: number): Promise<Blob> {
  const data: CellValue[][] = [['行号', '值']]
  for (let i = 1; i <= rows; i += 1) data.push([i, `第${i}行`])
  return xlsxFixture({ 大表: data })
}

/** 一份 .csv（WP99：csv 走我们自己那个 RFC 4180 解析器，不过 exceljs）。 */
export function csvFixture(text: string): Blob {
  return new Blob([new TextEncoder().encode(text)], { type: 'text/csv' })
}

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'

/** 一份每页一句话的 .pptx（我们自己解 `ppt/slides/slide<N>.xml`）。 */
export async function pptxFixture(
  slides: readonly (readonly string[])[] = [['第一页标题', '第一页正文'], ['第二页标题']],
): Promise<Blob> {
  const zip = new JSZip()
  slides.forEach((lines, i) => {
    const shapes = lines
      .map((line) => `<p:sp><p:txBody><a:p><a:r><a:t>${line}</a:t></a:r></a:p></p:txBody></p:sp>`)
      .join('')
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`,
    )
  })
  return zip.generateAsync({ type: 'blob' })
}
