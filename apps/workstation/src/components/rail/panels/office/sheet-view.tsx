/**
 * WP97 起：**表格**（`.xlsx` / `.csv`）——读成二维数组，表由我们自己画。
 *
 * ## WP99：库从 `xlsx@0.18.5`（SheetJS 社区版）换成 `exceljs@4.4.0`
 *
 * 换的理由不在功能，在**这个库还有没有人管**：SheetJS 社区版 0.18.5 是 2022 年
 * 发在 npm 上的最后一版，`CVE-2023-30533`（原型污染）与后来的 ReDoS 都只在作者
 * 自己的站点上发新版，npm 上那一份**永远停在有洞的那一版**。`exceljs` 是 MIT、
 * 还在 npm 上发版、只解 OOXML（没有 SheetJS 那一大片老格式的解析面）。
 *
 * 代价写在明处：
 *
 * | 丢了什么 | 怎么办 |
 * |---|---|
 * | `.xls`（2003 之前的 OLE 复合文档）exceljs 不支持 | `address.ts` 的 `canOpen` 里把 `.xls` 去了：**不接、交给下载**，知识库页那一行写着"这是老格式，下载下来用 Excel 打开" |
 * | 它自带的 csv 读要 Node 流（`fast-csv`） | `.csv` 自己按 RFC 4180 解（`office/csv.ts`，零依赖）——理由写在那个文件顶上 |
 *
 * 没变的三件：多 sheet、一页 200 行的分页、20 MB / 5 秒两道闸。
 *
 * ## 为什么仍然是"读成数组、自己画"
 *
 * 1. 每一格都是 React 的文本节点，插不进标签——外来文件的内容不经过 `innerHTML`，
 *    这一整个面板里唯一一处真正的 XSS 面就此不存在；
 * 2. 壳的 CSP 里 `style-src` 虽然在 WP99 开了 `'unsafe-inline'`（为 Word 排版），
 *    但表格的样式我们本来就不要——一张只读的预览表，画得像 Excel 没有意义；
 * 3. 分页要我们自己控（一页 200 行）。
 *
 * ## CSP（`apps/desktop/src/csp.ts`）
 *
 * exceljs 的浏览器包（`dist/exceljs.min.js`，`browser` 字段指的就是它）逐个核实过：
 * `eval(` **0 处**；`new Function` **1 处**，在 `setimmediate` 垫片的
 * `setImmediate(字符串)` 那一支里——exceljs 自己只用函数调它，那一支是死代码，
 * 而 CSP 拦的是**执行**不是定义，所以不触发；外链 0 处（`http://schemas.…`
 * 那些是 XML 命名空间字符串，不是取数地址）。
 */
import type { Cell, Row, Workbook, Worksheet } from 'exceljs'
import { type ReactNode, useEffect, useState } from 'react'
import { StatusPill, WsTag } from '@/components/design'
import { readBlobBytes } from '@/components/rail/panels/office/bytes'
import { parseCsvBytes } from '@/components/rail/panels/office/csv'
import { isRenderTimeout, withDeadline } from '@/components/rail/panels/office/deadline'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 一页多少行（派工书定的数）。 */
export const ROWS_PER_PAGE = 200

/** 一张表最多读多少列——再宽的表在 380 的抽屉里也只是横着滚不到头。 */
const MAX_COLUMNS = 64

/** `ValueType.Date`。不 import 那个 enum：它是**运行时值**，会把类型 import 变成真依赖。 */
const VALUE_TYPE_DATE = 4

/**
 * 解析时直接丢掉的 XML 节点（`XlsxReadOptions.ignoreNodes`）。
 *
 * 全是**画不出来也用不上**的东西：图形、图片、条件格式、数据校验、打印设置、
 * 页眉页脚、工作表保护、扩展节点。少解一样就少一段跑在外来字节上的代码——
 * 与换库之前那几个 `cellStyles: false` / `cellFormula: false` 是同一个意思。
 */
const IGNORE_NODES = [
  'drawing',
  'picture',
  'conditionalFormatting',
  'dataValidations',
  'printOptions',
  'headerFooter',
  'pageSetup',
  'pageMargins',
  'sheetProtection',
  'rowBreaks',
  'extLst',
]

interface SheetData {
  name: string
  rows: string[][]
}

/**
 * exceljs 的浏览器包是 UMD（`browser` 字段指向 `dist/exceljs.min.js`），测试里
 * 解到的是 CJS——两档下 `Workbook` 一个在命名空间上、一个在 `default` 上。
 * 两边都试一次，比在构建配置里写一条 alias 稳（那条 alias 只有构建那一档生效）。
 */
async function loadWorkbookClass(): Promise<new () => Workbook> {
  const mod = (await import('exceljs')) as unknown as {
    Workbook?: new () => Workbook
    default?: { Workbook?: new () => Workbook }
  }
  const ctor = mod.Workbook ?? mod.default?.Workbook
  if (ctor === undefined) throw new Error('exceljs: 找不到 Workbook')
  return ctor
}

/** 两位数补零（日期格式化用）。 */
const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * 日期怎么显示。
 *
 * 换库之前是 SheetJS 的 `raw: false`——按单元格自己的显示格式给串（于是看见的
 * 与 Excel 里一样）。exceljs 不做这一步：`cell.text` 对日期给的是 JS 的
 * `Date.toString()`（`Fri Jan 02 2026 08:00:00 GMT+0800 (…)`），一格塞不下也没人读。
 *
 * 所以这一栏统一写成 `YYYY-MM-DD`（带时分的再补 `HH:mm`）。**这是一处有意的偏离**：
 * 预览要的是"这一格是哪天"，不是"这份表的作者把它排成了什么样"。
 */
function formatDate(value: Date): string {
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const h = value.getHours()
  const m = value.getMinutes()
  const s = value.getSeconds()
  if (h === 0 && m === 0 && s === 0) return date
  return `${date} ${pad(h)}:${pad(m)}`
}

/**
 * 一格 → 一个字符串。**永远不抛**：一个坏单元格不该把整张表干掉。
 *
 * `cell.text` 已经处理了公式（给结果）、富文本（拼起来）、超链接（给显示文字）、
 * 错误值（`#REF!` 之类）。只有日期要接管，见上。
 */
function textOf(cell: Cell): string {
  try {
    const value = cell.value
    if (value === null || value === undefined) return ''
    if (value instanceof Date) return formatDate(value)
    if (cell.type === VALUE_TYPE_DATE) {
      const d = new Date(String(value))
      if (!Number.isNaN(d.getTime())) return formatDate(d)
    }
    const text = cell.text
    return typeof text === 'string' ? text : String(text ?? '')
  } catch {
    return ''
  }
}

/** 一张 worksheet → 二维字符串（空行不进来，空格进来是空串）。 */
function rowsOf(sheet: Worksheet): string[][] {
  const width = Math.min(Math.max(sheet.columnCount, 0), MAX_COLUMNS)
  const rows: string[][] = []
  sheet.eachRow({ includeEmpty: true }, (row: Row) => {
    const cells: string[] = []
    for (let c = 1; c <= width; c += 1) cells.push(textOf(row.getCell(c)))
    // 空行不进来（换库之前 SheetJS 的 `blankrows: false` 就是这个意思）；
    // 空格留成空串而不是塌掉——塌掉的话后面几列会整体左移，看着像数据错位
    if (cells.some((v) => v !== '')) rows.push(cells)
  })
  return rows
}

/**
 * 读成 `{ 表名, 二维字符串 }`。
 *
 * 动态 `import('exceljs')`：浏览器包近 1 MB（gzip 约 252 KB），不能让一个开着
 * Word 预览的人也把它下下来。
 */
async function readWorkbook(blob: Blob, csv: boolean): Promise<SheetData[]> {
  const bytes = await readBlobBytes(blob)
  if (csv) {
    const rows = parseCsvBytes(bytes).map((row) => row.slice(0, MAX_COLUMNS))
    return [{ name: 'CSV', rows: rows.filter((row) => row.some((v) => v !== '')) }]
  }
  const WorkbookClass = await loadWorkbookClass()
  const book = new WorkbookClass()
  // `load` 的入参在 exceljs 的 d.ts 里写成 `Buffer`（它自己 `declare interface
  // Buffer extends ArrayBuffer`），实际吃的就是一个 ArrayBuffer
  await book.xlsx.load(bytes.buffer as never, { ignoreNodes: IGNORE_NODES })
  const sheets: SheetData[] = []
  book.eachSheet((sheet: Worksheet) => {
    sheets.push({ name: sheet.name, rows: rowsOf(sheet) })
  })
  return sheets
}

export function SheetView({
  blob,
  filename,
  onFail,
}: {
  blob: Blob
  /** 只用来分 csv 与 xlsx 两条路；为空按 xlsx 读。 */
  filename?: string
  onFail(): void
}): ReactNode {
  const { t } = useApp()
  const [sheets, setSheets] = useState<SheetData[] | null>(null)
  const [error, setError] = useState<'timeout' | 'broken' | null>(null)
  const [active, setActive] = useState(0)
  const [page, setPage] = useState(0)
  const csv = (filename ?? '').toLowerCase().endsWith('.csv')

  useEffect(() => {
    let alive = true
    setSheets(null)
    setError(null)
    setActive(0)
    setPage(0)
    withDeadline(readWorkbook(blob, csv)).then(
      (data) => {
        if (alive) setSheets(data)
      },
      (e: unknown) => {
        if (!alive) return
        setError(isRenderTimeout(e) ? 'timeout' : 'broken')
        onFail()
      },
    )
    return () => {
      alive = false
    }
  }, [blob, csv, onFail])

  if (error !== null)
    return (
      <StatusPill tone="warn" data-testid={`rail-office-${error}`}>
        {t(error === 'timeout' ? 'rail.office.timeout' : 'rail.office.broken')}
      </StatusPill>
    )
  if (sheets === null) return <Skeleton className="h-32 w-full" />
  if (sheets.length === 0 || sheets.every((s) => s.rows.length === 0))
    return (
      <StatusPill tone="neutral" data-testid="rail-office-empty">
        {t('rail.office.empty')}
      </StatusPill>
    )

  const sheet = sheets[Math.min(active, sheets.length - 1)] as SheetData
  const total = sheet.rows.length
  const pages = Math.max(1, Math.ceil(total / ROWS_PER_PAGE))
  const current = Math.min(page, pages - 1)
  const slice = sheet.rows.slice(current * ROWS_PER_PAGE, (current + 1) * ROWS_PER_PAGE)

  return (
    <div className="space-y-2" data-testid="rail-office-sheet" data-sheets={sheets.length}>
      {sheets.length > 1 ? (
        <div className="flex flex-wrap gap-1" data-testid="rail-office-sheet-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              aria-pressed={i === active}
              data-testid={`rail-office-sheet-tab-${s.name}`}
              className={cn(
                'inline-flex h-[22px] items-center rounded-md px-2 text-xs',
                i === active
                  ? 'bg-ws-tint font-medium text-ws-brand-ink'
                  : 'bg-ws-surface text-ws-muted-fg',
              )}
              onClick={() => {
                setActive(i)
                setPage(0)
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="overflow-auto rounded-ws-card bg-ws-card shadow-ws">
        <table className="w-max border-collapse text-[11px]">
          <tbody>
            {slice.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 表格的行号**就是**它的身份——这张表只读、不排序、不增删
              <tr key={`${current}-${r}`} className="even:bg-ws-surface">
                {row.map((cell, ci) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同上，列号就是身份
                    key={`${r}-${ci}`}
                    className="ws-num max-w-48 truncate border border-ws-line px-1.5 py-1 text-ws-body"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs text-ws-muted-fg">
        <WsTag data-testid="rail-office-sheet-rows">{t('rail.office.rows', { rows: total })}</WsTag>
        {pages > 1 ? (
          <span className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={current === 0}
              data-testid="rail-office-page-prev"
              onClick={() => {
                setPage(current - 1)
              }}
            >
              {t('rail.office.prev')}
            </Button>
            <span data-testid="rail-office-page">
              {t('rail.office.page', { page: current + 1, pages })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={current >= pages - 1}
              data-testid="rail-office-page-next"
              onClick={() => {
                setPage(current + 1)
              }}
            >
              {t('rail.office.next')}
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  )
}
