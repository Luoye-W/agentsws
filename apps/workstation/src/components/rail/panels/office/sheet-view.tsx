/**
 * WP97：**表格**（`.xlsx` / `.xls` / `.csv`）——SheetJS 社区版读成二维数组，我们自己画表。
 *
 * 为什么是"读成数组、自己画"而不是用它的 `sheet_to_html`：
 *
 * 1. `sheet_to_html` 出的是一大段 HTML 字符串，塞进 DOM 只能走 `innerHTML`——
 *    把一个外来文件的内容当 HTML 插进同源页面，是这一整个面板里唯一一处
 *    真正的 XSS 面。读成数组之后每一格都是 React 的文本节点，插不进标签；
 * 2. 它那段 HTML 自带 `<style>` 与内联 `style=`，而壳的 CSP 两样都挡
 *    （见 `office-preview-panel.tsx` 顶上那张表）——画出来也是一张没样式的表；
 * 3. 分页要我们自己控（一页 200 行），HTML 那条路给的是"整张表"。
 *
 * **`header: 1`**（回二维数组而不是"表头 → 值"的对象）还顺手避开了 0.18.5 那条
 * 原型污染（CVE-2023-30533）最好用的入口：对象档下表头里的 `__proto__` 会变成键。
 * 数组档没有键这回事。
 */
import { type ReactNode, useEffect, useState } from 'react'
import { StatusPill, WsTag } from '@/components/design'
import { readBlobBytes } from '@/components/rail/panels/office/bytes'
import { isRenderTimeout, withDeadline } from '@/components/rail/panels/office/deadline'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 一页多少行（派工书定的数）。 */
export const ROWS_PER_PAGE = 200

/** 一张表最多读多少列——再宽的表在 380 的抽屉里也只是横着滚不到头。 */
const MAX_COLUMNS = 64

interface SheetData {
  name: string
  rows: string[][]
}

/**
 * 读成 `{ 表名, 二维字符串 }`。
 *
 * 动态 `import('xlsx')`：这个库一个人就 896 KB（未压缩），不能让一个开着
 * Word 预览的人也把它下下来。
 */
async function readWorkbook(blob: Blob): Promise<SheetData[]> {
  const xlsx = await import('xlsx')
  const book = xlsx.read(await readBlobBytes(blob), {
    type: 'array',
    // 日期读成 Date 再按本地格式化，省得看见 45123 这种序列号
    cellDates: true,
    // 下面三个都是**关掉功能**：不要它算公式、不要它带样式、不要它给我们 HTML。
    // 少一样功能就少一段解析外来字节的代码在跑。
    cellFormula: false,
    cellStyles: false,
    cellHTML: false,
    bookVBA: false,
  })
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name]
    if (sheet === undefined) return { name, rows: [] }
    const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      // 空格回空串而不是塌掉：塌掉的话后面几列会整体左移，看着像数据错位
      defval: '',
      // 按单元格的显示格式取（`raw: false`），人看见的与 Excel 里一样
      raw: false,
      blankrows: false,
    })
    return {
      name,
      rows: rows.map((row) =>
        row.slice(0, MAX_COLUMNS).map((cell) => (cell === null ? '' : String(cell))),
      ),
    }
  })
}

export function SheetView({ blob, onFail }: { blob: Blob; onFail(): void }): ReactNode {
  const { t } = useApp()
  const [sheets, setSheets] = useState<SheetData[] | null>(null)
  const [error, setError] = useState<'timeout' | 'broken' | null>(null)
  const [active, setActive] = useState(0)
  const [page, setPage] = useState(0)

  useEffect(() => {
    let alive = true
    setSheets(null)
    setError(null)
    setActive(0)
    setPage(0)
    withDeadline(readWorkbook(blob)).then(
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
  }, [blob, onFail])

  if (error !== null)
    return (
      <StatusPill tone="warn" data-testid={`rail-office-${error}`}>
        {t(error === 'timeout' ? 'rail.office.timeout' : 'rail.office.broken')}
      </StatusPill>
    )
  if (sheets === null) return <Skeleton className="h-32 w-full" />
  if (sheets.length === 0)
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
