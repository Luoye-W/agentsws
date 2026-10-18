/**
 * WP404（docs/107 §3 / §12 一期 A）：**外置规则表的读取口**——判法代码从这里拿表，不再自己写死。
 *
 * 违规宣称、GEO 问题模板、红人打法词表、客服话术规则、Amazon 词库的停用词……这些「给模型 / 给判法读的表」
 * 挪成了数据文件（`*.content.json`，每一行带稳定 id，契约 `ContentTableFile`）。判法代码留在原处，
 * 改成调 `readContentTable(表)` 拿行。
 *
 * **按品牌可覆盖**：宿主可以登记一个覆盖源（`registerContentTableProvider`）——给它表名和品牌，
 * 它回这个品牌这张表现在该用的行（官方新版、用户改过的，合并好了的；合并本身是 WP406 的事）。
 * 没登记 / 它回 `undefined` → 用随软件带的那一份。所以今天没有任何宿主登记时，**行为与外置前一字不差**。
 *
 * 覆盖源回来的行不合格（不是数组、缺 id、id 重名、过不了调用方给的 `accepts`）→ **整张不用**，
 * 回落随软件带的那一份：内容出错顶多是没用上新版，不能让判法读到半张坏表。
 */
import type { ContentTableFile, ContentTableRow } from '@agentsws/contracts'

/** 覆盖源：表名 + 品牌（不给 = 不分品牌的那次调用）→ 这张表该用的行；不管这张表就回 `undefined`。 */
export type ContentTableProvider = (
  table: string,
  brand: string | undefined,
) => readonly ContentTableRow[] | undefined

const providers: ContentTableProvider[] = []

/** 登记一个覆盖源（后登记的先问）。回一个撤销函数（测试与宿主关停时用）。 */
export function registerContentTableProvider(provider: ContentTableProvider): () => void {
  providers.unshift(provider)
  return () => {
    const at = providers.indexOf(provider)
    if (at >= 0) providers.splice(at, 1)
  }
}

/** 一张表的行合不合格：是数组、每行有非空字符串 id、id 不重名。回第一处毛病，`undefined` = 没问题。 */
export function contentTableProblem(rows: unknown): string | undefined {
  if (!Array.isArray(rows)) return 'rows 不是数组'
  const seen = new Set<string>()
  for (const [i, row] of rows.entries()) {
    const id = typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || id.trim() === '') return `第 ${i + 1} 行没有 id`
    if (seen.has(id)) return `id 重名：${id}`
    seen.add(id)
  }
  return undefined
}

/**
 * 随软件带的那一份表（模块加载时调一次）：表名、行都得合格，不合格直接抛——那是打包打错了，
 * 不是用户数据，越早红越好。
 */
export function builtinContentTable<Row extends ContentTableRow>(
  file: ContentTableFile<Row> | { table: string; rows: unknown },
): ContentTableFile<Row> {
  if (typeof file.table !== 'string' || file.table.trim() === '')
    throw new Error('内容表缺 table 名')
  const bad = contentTableProblem(file.rows)
  if (bad !== undefined) throw new Error(`内容表 ${file.table}：${bad}`)
  return file as ContentTableFile<Row>
}

export interface ReadContentTableOptions<Row> {
  /** 这次判在哪个品牌里（覆盖按品牌）。不给 = 不分品牌。 */
  brand?: string | undefined
  /** 覆盖来的每一行还得过这一关（调用方知道一行该长什么样）；有一行不过就整张不用。 */
  accepts?: (row: unknown) => row is Row
}

/** 读一张表：先问覆盖源，没有 / 不合格就用随软件带的那一份。 */
export function readContentTable<Row extends ContentTableRow>(
  file: ContentTableFile<Row>,
  options: ReadContentTableOptions<Row> = {},
): readonly Row[] {
  for (const provider of providers) {
    let rows: readonly ContentTableRow[] | undefined
    try {
      rows = provider(file.table, options.brand)
    } catch {
      rows = undefined
    }
    if (rows === undefined) continue
    if (contentTableProblem(rows) !== undefined) continue
    if (options.accepts !== undefined && !rows.every((r) => options.accepts?.(r) === true)) continue
    return rows as readonly Row[]
  }
  return file.rows
}

/** 现在有没有登记任何覆盖源（判法代码据此决定要不要每次重算派生的查表结构）。 */
export function hasContentTableProviders(): boolean {
  return providers.length > 0
}
