/**
 * WP493（决策 1708）：**在 ego 里读在线表格**——给 WP489 的「贴一条在线表格链接导入」留的可插拔读取口。
 *
 * 为什么要 ego：用户选了 ego 时，飞书 / Google 的登录态在 ego 里，内置浏览器多半没登录。
 *
 * 三家三种读法（每一种都是「开空间 → 读 → 收空间」一趟，只读）：
 *
 * | 哪家 | 先 | 再 | 最后 |
 * |---|---|---|---|
 * | Google 表格 | 打开表格页（认登录 / 没权限）+ 借登录态 GET 导出 CSV（`/export?format=csv&gid=`） | 打开导出地址等它下载 | GET `gviz/tq?tqx=out:csv` |
 * | 飞书（多维表格 / 表格） | 读页面上的格子（`<table>` / `role=grid`；飞书是画布渲染，多半读不到） | **截住复制**：点画布里一格 → 全选 → 复制，读页面写出的 `text/bitable`（表头 + 记录）/ `text/plain`（TSV），不改用户剪贴板 | 点「更多 → 下载为 → Excel」等它下载，读 xlsx（`@agentsws/knowledge` 的表格读法） |
 * | 别的网站 | 读页面上的表格 | — | — |
 *
 * **接口**（{@link OnlineSheetReader}）：`read(url)` → 成了给格子（第一张表 / 当前这一页），没成给原因：
 * `off`（ego 用不了，宿主照常退到插件 / 内置浏览器）、`login` / `no_access`（照实说，宿主不必再试别的浏览器）、
 * `unreadable`（页面上读不出、也没导出来）、`failed`（ego 那一趟没跑完）。
 *
 * 只读：唯一的点击是导出菜单，字样过白名单（`script.ts` 的 `EGO_READ_SAFE_CLICK`）；不改表、不分享、不改权限。
 */
import { readSpreadsheet, type SheetGrid } from '@agentsws/knowledge'
import type { EgoReadCall, EgoReadResult, EgoReadStepResult } from './runner.js'
import type { EgoReadTarget } from './script.js'

export type OnlineSheetKind = 'google' | 'feishu' | 'other'

export type OnlineSheetVia = 'google_csv' | 'page_cells' | 'copy' | 'export_file'

export type OnlineSheetRead =
  | {
      ok: true
      kind: OnlineSheetKind
      via: OnlineSheetVia
      rows: string[][]
      /** 导出文件里的全部工作表（只有 `export_file` / CSV 才有）。 */
      sheets?: SheetGrid[]
      final_url?: string
    }
  | {
      ok: false
      kind: OnlineSheetKind
      reason: 'off' | 'login' | 'no_access' | 'unreadable' | 'failed'
      message: string
    }

/** WP489 接的那一口：给一条链接，回格子或原因。 */
export interface OnlineSheetReader {
  /** ego 这会儿能不能用（用不了宿主直接走老路，不必等一趟）。 */
  available(): boolean
  read(url: string, options?: { kind?: OnlineSheetKind }): Promise<OnlineSheetRead>
}

/** 认链接是哪一家（不是 http(s) 的回 `undefined`）。 */
export function onlineSheetKindOf(raw: string): OnlineSheetKind | undefined {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  const host = u.hostname.toLowerCase()
  if (host === 'docs.google.com' && /\/spreadsheets\/d\/[\w-]+/u.test(u.pathname)) return 'google'
  if (/(^|\.)(feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com)$/u.test(host)) return 'feishu'
  return 'other'
}

/** Google 表格链接 → 导出 CSV 的两个地址（同源相对路径）。 */
export function googleCsvPaths(raw: string): { exportPath: string; gvizPath: string } | undefined {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return undefined
  }
  const id = /\/spreadsheets\/d\/([\w-]+)/u.exec(u.pathname)?.[1]
  if (id === undefined) return undefined
  const gid = /gid=(\d+)/u.exec(`${u.search}${u.hash}`)?.[1]
  return {
    exportPath: `/spreadsheets/d/${id}/export?format=csv${gid === undefined ? '' : `&gid=${gid}`}`,
    gvizPath: `/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${gid === undefined ? '' : `&gid=${gid}`}`,
  }
}

/**
 * 飞书「导出 Excel」那几下（中英文界面都认）：右上角「更多」→「下载为」→「Excel」。
 * 每一下都还要过脚本里的白名单（`EGO_READ_SAFE_CLICK`）。真飞书界面以主会话实测为准（WP493 只在假页面上验过）。
 */
export const FEISHU_EXPORT_CLICKS: readonly EgoReadTarget[] = [
  {
    text: '^(更多|More|更多操作|More actions)$',
    attr: '^(更多|More|更多操作|More actions)$',
    either: true,
  },
  { text: '^(下载为|Download as|导出为|Export as)$' },
  { text: '^(Excel|Microsoft Excel)( ?[(（]\\.xlsx[)）])?$|\\.xlsx' },
]

const LOGIN_HOSTS =
  /(^|\.)(accounts\.google\.com|passport\.feishu\.cn|accounts\.feishu\.cn|passport\.larksuite\.com|accounts\.larksuite\.com|login\.microsoftonline\.com)$/iu

/** 读回来的那一页是不是登录页 / 没权限页。 */
export function sheetPageBlock(page: {
  final_url: string
  text: string
  password_inputs: number
}): 'login' | 'no_access' | undefined {
  let host = ''
  let path = ''
  try {
    const u = new URL(page.final_url)
    host = u.hostname
    path = u.pathname
  } catch {
    // 只看内容
  }
  if (LOGIN_HOSTS.test(host) || /\/(login|signin|sign-in|accounts\/login)\b/iu.test(path))
    return 'login'
  if (page.password_inputs > 0) return 'login'
  if (
    /you need (access|permission)|request access|ask for access|没有权限|无权限|需要权限|申请权限|无访问权限|暂无权限/iu.test(
      page.text.slice(0, 20_000),
    )
  )
    return 'no_access'
  return undefined
}

/** 读不了时给人的那一句（短；卡面上就这一句）。 */
export function onlineSheetWhy(
  reason: 'login' | 'no_access' | 'unreadable' | 'failed' | 'off',
  kind: OnlineSheetKind,
): string {
  const where = kind === 'google' ? 'Google' : kind === 'feishu' ? '飞书' : '这个网站'
  switch (reason) {
    case 'login':
      return `ego 里还没登录${where}——在 ego 里登录一下，再贴一次链接。`
    case 'no_access':
      return `ego 里登录的${where}账号打不开这张表——换有权限的账号登录，或者在表格里「下载为 Excel」拖进来。`
    case 'off':
      return 'ego 这会儿用不了。'
    case 'failed':
      return 'ego 这一趟没读完。在表格里「下载为 Excel」，拖进来就行。'
    default:
      return '这张表从页面上读不出来。在表格里「下载为 Excel」，拖进来就行。'
  }
}

/** 一趟要做的那几步。 */
export function onlineSheetCall(url: string, kind: OnlineSheetKind): EgoReadCall {
  if (kind === 'google') {
    const p = googleCsvPaths(url)
    const csv = '^(text/csv|text/plain|application/csv)'
    return {
      url,
      settle_ms: 3000,
      steps: [
        { op: 'read', id: 'page' },
        ...(p === undefined
          ? []
          : [
              { op: 'fetch' as const, id: 'csv', urls: [p.exportPath], expect: csv },
              {
                op: 'download_url' as const,
                id: 'csv_dl',
                url: new URL(p.exportPath, url).href,
                timeout_ms: 30_000,
                unless: ['csv'],
              },
              {
                op: 'fetch' as const,
                id: 'gviz',
                urls: [p.gvizPath],
                expect: csv,
                unless: ['csv', 'csv_dl'],
              },
            ]),
      ],
    }
  }
  if (kind === 'feishu')
    return {
      url,
      // 飞书表格页很重（画布 + 一堆脚本）
      settle_ms: 6000,
      steps: [
        { op: 'read', id: 'page', need_grid: true },
        // 主会话 10-23 真机：多维表格是画布，页面字与无障碍快照里都没有格子；截住复制读得到
        { op: 'copy', id: 'copy', unless: ['page'] },
        {
          op: 'export',
          id: 'export',
          clicks: [...FEISHU_EXPORT_CLICKS],
          timeout_ms: 90_000,
          unless: ['page', 'copy'],
        },
      ],
    }
  return { url, steps: [{ op: 'read', id: 'page', need_grid: true }] }
}

const decoder = new TextDecoder('utf-8')

const ENT: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}
/** `&quot;` / `&#39;` / `&#x27;` → 原字。 */
export function unescapeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENT[e.toLowerCase()] ?? m
  })
}

/** 复制出来的 TSV → 格子（Excel 同款引号：格子里有换行 / 制表符时整格加引号、引号写两遍）。 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const t = text.replace(/\r\n?/gu, '\n')
  while (i < t.length) {
    const c = t[i] as string
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (c === '"') {
        quoted = false
        i += 1
        continue
      }
      cell += c
      i += 1
      continue
    }
    if (c === '"' && cell === '') {
      quoted = true
      i += 1
      continue
    }
    if (c === '\t') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
    i += 1
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''))
}

/** 多维表格里一格的值 → 字（选项 / 人员 / 链接这类是对象或数组）。 */
function cellText(v: unknown, options?: Map<string, string>): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return options?.get(v) ?? v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v))
    return v
      .map((x) => cellText(x, options))
      .filter((x) => x !== '')
      .join(', ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['text', 'name', 'value', 'title', 'en_name', 'link', 'url'])
      if (o[k] !== undefined && typeof o[k] !== 'object') return cellText(o[k], options)
    if (Array.isArray(o.value) || Array.isArray(o.text)) return cellText(o.value ?? o.text, options)
  }
  return ''
}

interface BitableField {
  id?: string
  name?: string
  property?: { options?: { id?: string; name?: string }[] }
}

/**
 * `text/bitable`（飞书多维表格复制出来的那一份：HTML 转义过的 JSON）→ 表头 + 记录。
 * 表头一定有（`header[].name`）；记录的形状没有公开文档，认几种常见的（数组 / `fields` / `cells` 按字段 id），
 * 认不出就只给表头（调用方拿 TSV 的值配上它）。
 */
export function bitableGrid(raw: string): { header: string[]; rows?: string[][] } | undefined {
  let j: unknown
  try {
    j = JSON.parse(unescapeEntities(raw))
  } catch {
    return undefined
  }
  if (j === null || typeof j !== 'object') return undefined
  const o = j as Record<string, unknown>
  const fields = (
    Array.isArray(o.header) ? o.header : Array.isArray(o.fields) ? o.fields : []
  ) as BitableField[]
  const header = fields.map((f, i) => (typeof f?.name === 'string' ? f.name : `列${i + 1}`))
  if (header.length === 0) return undefined
  const ids = fields.map((f) => f?.id)
  const options = new Map<string, string>()
  for (const f of fields)
    for (const opt of f?.property?.options ?? [])
      if (typeof opt.id === 'string' && typeof opt.name === 'string') options.set(opt.id, opt.name)
  const list = ['records', 'rows', 'data', 'body', 'recordList', 'record_list']
    .map((k) => o[k])
    .find((x) => Array.isArray(x)) as unknown[] | undefined
  if (list === undefined) return { header }
  const rows: string[][] = []
  for (const rec of list) {
    if (Array.isArray(rec)) {
      rows.push(rec.map((x) => cellText(x, options)))
      continue
    }
    if (rec === null || typeof rec !== 'object') return { header }
    const r = rec as Record<string, unknown>
    const bag = (r.fields ?? r.cells ?? r.data ?? r.values) as unknown
    if (Array.isArray(bag)) rows.push(bag.map((x) => cellText(x, options)))
    else if (bag !== null && typeof bag === 'object') {
      const b = bag as Record<string, unknown>
      rows.push(
        ids.map((id, i) =>
          cellText(id === undefined ? undefined : (b[id] ?? b[header[i] ?? '']), options),
        ),
      )
    } else return { header }
  }
  return { header, rows }
}

/** 截住的复制内容 → 格子：`text/bitable` 给表头（记录认得出就用它），值不行就用 TSV。 */
export function copiedGrid(copied: readonly [string, string][]): string[][] | undefined {
  const of = (re: RegExp) =>
    [...copied].reverse().find(([type, v]) => re.test(type) && v.trim() !== '')?.[1]
  const bit = of(/^text\/bitable/iu)
  const tsvText = of(/^text\/plain/iu)
  const tsv = tsvText === undefined ? undefined : parseTsv(tsvText)
  const b = bit === undefined ? undefined : bitableGrid(bit)
  if (
    b?.rows !== undefined &&
    b.rows.length > 0 &&
    b.rows.every((r) => r.length === b.header.length)
  )
    return [b.header, ...b.rows]
  if (tsv !== undefined && tsv.length > 0) {
    // 多维表格复制出来的 TSV 不带表头：表头从 text/bitable 来（列数对得上才配）
    if (
      b !== undefined &&
      tsv[0]?.length === b.header.length &&
      tsv[0]?.join('\t') !== b.header.join('\t')
    )
      return [b.header, ...tsv]
    return tsv
  }
  return b === undefined ? undefined : [b.header]
}

/** 页面上读到的最大那张表（≥2 行）。 */
function bestTable(step: EgoReadStepResult | undefined): string[][] | undefined {
  let best: string[][] | undefined
  for (const t of step?.page?.tables ?? []) {
    const size = t.rows.length * Math.max(...t.rows.map((r) => r.length), 0)
    if (t.rows.length < 2) continue
    if (best === undefined || size > best.length * Math.max(...best.map((r) => r.length), 0))
      best = t.rows
  }
  return best
}

const csvOf = (text: string): SheetGrid[] =>
  readSpreadsheet('csv', new Uint8Array(Buffer.from(text, 'utf8')))

/** 一趟 ego 的结果 → 格子 / 原因（纯函数，测试直接喂）。 */
export function onlineSheetResult(
  kind: OnlineSheetKind,
  res: Pick<EgoReadResult, 'state' | 'why' | 'steps'>,
): OnlineSheetRead {
  if (res.state !== 'ok')
    return {
      ok: false,
      kind,
      reason: res.state === 'unavailable' ? 'off' : 'failed',
      message: onlineSheetWhy(res.state === 'unavailable' ? 'off' : 'failed', kind),
    }
  const by = (id: string) => res.steps.find((s) => s.id === id)
  const page = by('page')
  const block = page?.page === undefined ? undefined : sheetPageBlock(page.page)
  if (block !== undefined)
    return { ok: false, kind, reason: block, message: onlineSheetWhy(block, kind) }
  const final_url = page?.page?.final_url
  const at = final_url === undefined ? {} : { final_url }
  for (const id of ['csv', 'gviz']) {
    const r = by(id)?.responses?.[0]
    if (by(id)?.ok === true && r?.body !== undefined && r.body.trim() !== '') {
      const sheets = csvOf(r.body)
      const rows = sheets[0]?.rows ?? []
      if (rows.length > 0) return { ok: true, kind, via: 'google_csv', rows, sheets, ...at }
    }
  }
  const dl = by('csv_dl')
  if (dl?.ok === true && dl.file !== undefined) {
    const sheets = csvOf(decoder.decode(dl.file.bytes))
    const rows = sheets[0]?.rows ?? []
    if (rows.length > 0) return { ok: true, kind, via: 'google_csv', rows, sheets, ...at }
  }
  const cp = by('copy')
  if (cp?.ok === true && cp.copied !== undefined) {
    const rows = copiedGrid(cp.copied)
    if (rows !== undefined && rows.length > 0) return { ok: true, kind, via: 'copy', rows, ...at }
  }
  const ex = by('export')
  if (ex?.ok === true && ex.file !== undefined) {
    const name = ex.file.name.toLowerCase()
    const format = name.endsWith('.csv') ? 'csv' : name.endsWith('.xls') ? 'xls' : 'xlsx'
    try {
      const sheets = readSpreadsheet(format, ex.file.bytes)
      const first = sheets.find((s) => s.rows.length > 0)
      if (first !== undefined)
        return { ok: true, kind, via: 'export_file', rows: first.rows, sheets, ...at }
    } catch {
      // 落到「读不出」
    }
  }
  const cells = bestTable(page)
  if (cells !== undefined) return { ok: true, kind, via: 'page_cells', rows: cells, ...at }
  return { ok: false, kind, reason: 'unreadable', message: onlineSheetWhy('unreadable', kind) }
}

export interface EgoSheetReaderOptions {
  /** ego 读页口（`reader.ts`）。 */
  ego: {
    available(): boolean
    run(call: EgoReadCall): Promise<EgoReadResult | { state: 'off'; why: string; steps: [] }>
  }
}

/** ego 版的在线表格读取口。 */
export function createEgoSheetReader(options: EgoSheetReaderOptions): OnlineSheetReader {
  return {
    available: () => options.ego.available(),
    async read(url, opts = {}) {
      const kind = opts.kind ?? onlineSheetKindOf(url)
      if (kind === undefined)
        return { ok: false, kind: 'other', reason: 'unreadable', message: '这不是一条网页链接。' }
      if (!options.ego.available())
        return { ok: false, kind, reason: 'off', message: onlineSheetWhy('off', kind) }
      const res = await options.ego.run(onlineSheetCall(url, kind))
      if (res.state === 'off')
        return { ok: false, kind, reason: 'off', message: onlineSheetWhy('off', kind) }
      return onlineSheetResult(kind, res)
    },
  }
}
