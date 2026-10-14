/**
 * WP323：记录去处的**飞书适配器**——多维表格与电子表格（docs/102 §5.3 方案 A）。
 *
 * - 用的是用户在「消息渠道」里已经接上的那个飞书应用（应用身份 `tenant_access_token`，凭据照旧在本机加密库，
 *   这里每次现取、不留）；表格由用户在飞书里「添加文档应用」共享给它。
 * - 只认链接里的 token：`/base/<app_token>?table=<table_id>`（多维表格）、`/sheets/<token>?sheet=<id>`
 *   （电子表格）、`/wiki/<node_token>`（知识库里的表，先问一次知识库认出是哪种）。
 * - 接口（飞书开放平台公开文档）：
 *   - 取令牌 `POST /open-apis/auth/v3/tenant_access_token/internal`
 *   - 多维表格：`GET …/bitable/v1/apps/:app/tables`、`GET …/tables/:tbl/fields`、`GET …/tables/:tbl/records`、
 *     `POST …/tables/:tbl/records?client_token=`（带幂等键：同一条不会写两次）
 *   - 电子表格：`GET …/sheets/v3/spreadsheets/:t/sheets/query`、`GET …/sheets/v2/spreadsheets/:t/values/:range`、
 *     `POST …/sheets/v2/spreadsheets/:t/values_append?insertDataOption=INSERT_ROWS`
 *   - 知识库：`GET …/wiki/v2/spaces/get_node?token=`
 * - 失败分两种：临时的（网络、限流、飞书 5xx、令牌过期）交给发出记录退避重试；没权限、表没了、
 *   列对不上就照实说，并给出飞书那边要做的那一步（{@link FEISHU_SETUP_HINT}）。
 * - 测试一律用替身 `fetch`，不连真实飞书。
 */
import { createHash } from 'node:crypto'
import type { SinkColumnType, SinkErrorCode, WorkspaceId } from '@agentsws/contracts'
import type { SinkAdapter, SinkResult, SinkTargetInfo } from './adapters.js'
import type { RenderedCell, TargetColumn } from './mapping.js'

/** 飞书应用凭据（与「消息渠道」里飞书机器人同一份；值只在这一跳的内存里活一瞬）。 */
export interface FeishuAppCredentials {
  app_id: string
  app_secret: string
  domain?: string
}

/** 最小的 HTTP 口子（生产传全局 `fetch`，测试传替身）。 */
export type FeishuFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>

export interface FeishuSinkOptions {
  /** 这个品牌接上的飞书应用（没接 = undefined）。 */
  credentials(workspace_id: WorkspaceId): FeishuAppCredentials | undefined
  fetch: FeishuFetch
  /** 现在几点（毫秒；令牌过期判断用）。 */
  nowMs?: () => number
}

/** 飞书要用户做的那一步（按需由 AI 转述；帮助文章只写通用的）。 */
export const FEISHU_SCOPES = ['bitable:app', 'sheets:spreadsheet', 'wiki:wiki:readonly'] as const

export const FEISHU_SETUP_HINT =
  '飞书这边要做两步：① 打开飞书开放平台里你接在「消息渠道」的那个应用 → 权限管理，开通 ' +
  '`bitable:app`（多维表格）和 `sheets:spreadsheet`（电子表格）；表在知识库里的再开 `wiki:wiki:readonly`；' +
  '开完发布一个新版本。② 打开那张表，右上角「…」→「添加文档应用」，选这个应用，给「可编辑」。'

const NOT_CONFIGURED_HINT =
  '还没接上飞书应用：先在「消息渠道」接上飞书机器人（教程「飞书机器人」），再回来说一次。'

const HOST = /(^|\.)(feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com)$/i

interface ParsedUrl {
  kind: 'bitable' | 'sheet' | 'wiki'
  token: string
  sub?: string
}

/** 链接 → 是哪种表、token、子表 / 页签 id（认不出 = undefined）。 */
export function parseFeishuUrl(raw: string): ParsedUrl | undefined {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (!HOST.test(u.host)) return undefined
  const m = /\/(base|sheets|wiki)\/([A-Za-z0-9_-]{6,})/.exec(u.pathname)
  if (m === null) return undefined
  const kind = m[1] === 'base' ? 'bitable' : m[1] === 'sheets' ? 'sheet' : 'wiki'
  const sub = u.searchParams.get(kind === 'sheet' ? 'sheet' : 'table') ?? undefined
  return { kind, token: m[2] as string, ...(sub === undefined || sub === '' ? {} : { sub }) }
}

/** 飞书多维表格字段类型 → 我们的列类型。 */
function columnTypeOf(t: number): SinkColumnType {
  switch (t) {
    case 1:
      return 'text'
    case 2:
      return 'number'
    case 3:
      return 'select'
    case 4:
      return 'multi_select'
    case 5:
      return 'date'
    case 7:
      return 'checkbox'
    case 15:
      return 'url'
    default:
      return 'other'
  }
}

/** 同一把去重键 → 一个 uuid v4 形状的幂等键（多维表格的 `client_token` 只收这个形状）。 */
export function clientTokenOf(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((Number.parseInt(h.slice(16, 17), 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** 列号 → 字母（0 → A，26 → AA）。 */
export function colLetter(i: number): string {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** 一格多维表格的值 → 字（给 AI 看已有几行的格式）。 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(cellText).join('、')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return cellText(o.text ?? o.link ?? o.name ?? '')
  }
  return ''
}

/** 多维表格一格要写的值（按列类型转）。 */
export function bitableValue(cell: RenderedCell): unknown {
  switch (cell.type) {
    case 'number':
      return cell.num ?? (Number.isFinite(Number(cell.text)) ? Number(cell.text) : undefined)
    case 'date':
      return cell.ms ?? (Number.isFinite(Date.parse(cell.text)) ? Date.parse(cell.text) : undefined)
    case 'multi_select':
      return cell.text === '' ? undefined : [cell.text]
    case 'checkbox':
      return cell.text !== '' && cell.text !== '0' && cell.text.toLowerCase() !== 'false'
    case 'url':
      return cell.text === '' ? undefined : { text: cell.text, link: cell.text }
    default:
      return cell.text === '' ? undefined : cell.text
  }
}

/** 飞书回的错 → 我们的错误种类。 */
export function classifyFeishuError(status: number, code: number, msg: string): SinkErrorCode {
  if (status === 429 || status >= 500) return 'transient'
  // 限流 / 写冲突 / 服务忙
  if ([99991400, 1254290, 1254291, 1254607, 90217].includes(code)) return 'transient'
  if ([99991672, 99991679, 1254302, 91403, 131006, 1254301].includes(code)) return 'no_permission'
  if ([1254045, 1254044].includes(code) || /field ?name ?not ?found|FieldNameNotFound/i.test(msg))
    return 'columns_changed'
  if ([1254003, 1254004, 1254040, 1254041, 91402, 131005].includes(code)) return 'not_found'
  if (/permission|forbidden|denied|scope|权限|无权/i.test(msg)) return 'no_permission'
  if (/not ?found|不存在|deleted/i.test(msg)) return 'not_found'
  if (/conv|convert|invalid value|格式/i.test(msg)) return 'bad_value'
  if (status === 403) return 'no_permission'
  if (status === 404) return 'not_found'
  return 'transient'
}

const ERROR_ZH: Readonly<Record<SinkErrorCode, string>> = {
  transient: '飞书暂时没回应，过一会儿自动再试。',
  no_permission: '飞书说没有权限写这张表。',
  not_found: '飞书说找不到这张表（可能被删了或链接不对）。',
  columns_changed: '这张表的列变了，和记下的对照对不上。',
  not_configured: '还没接上飞书应用。',
  not_supported: '这种飞书文档写不进去（只支持多维表格和电子表格）。',
  bad_value: '有一格的值飞书不收（列类型和要写的值对不上）。',
}

export function createFeishuSinkAdapter(options: FeishuSinkOptions): SinkAdapter {
  const now = options.nowMs ?? (() => Date.now())
  const tokens = new Map<string, { token: string; until: number }>()

  const fail = <T>(code: SinkErrorCode, detail?: string): SinkResult<T> => ({
    ok: false,
    code,
    message: detail === undefined ? ERROR_ZH[code] : `${ERROR_ZH[code]}（${detail}）`,
  })

  const baseOf = (c: FeishuAppCredentials): string =>
    c.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'

  /** 取（或复用）应用令牌。 */
  const tenantToken = async (
    c: FeishuAppCredentials,
    fresh = false,
  ): Promise<SinkResult<string>> => {
    const cached = tokens.get(c.app_id)
    if (!fresh && cached !== undefined && cached.until > now())
      return { ok: true, data: cached.token }
    let res: { status: number; json(): Promise<unknown> }
    try {
      res = await options.fetch(`${baseOf(c)}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: c.app_id, app_secret: c.app_secret }),
      })
    } catch {
      return fail('transient')
    }
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    const code = typeof body.code === 'number' ? body.code : -1
    if (code !== 0 || typeof body.tenant_access_token !== 'string') {
      // 凭据不对（App Secret 换了）也算没接好
      if (code === 10014 || code === 10003) return fail('not_configured', '应用凭据不对')
      return fail(classifyFeishuError(res.status, code, String(body.msg ?? '')))
    }
    const expire = typeof body.expire === 'number' ? body.expire : 3600
    tokens.set(c.app_id, { token: body.tenant_access_token, until: now() + (expire - 300) * 1000 })
    return { ok: true, data: body.tenant_access_token }
  }

  /** 带令牌调一次接口；令牌失效重取一次。 */
  const call = async (
    ws: WorkspaceId,
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<SinkResult<Record<string, unknown>>> => {
    const c = options.credentials(ws)
    if (c === undefined) return fail('not_configured')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const t = await tenantToken(c, attempt > 0)
      if (!t.ok) return t
      let res: { status: number; json(): Promise<unknown> }
      try {
        res = await options.fetch(`${baseOf(c)}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${t.data}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        })
      } catch {
        return fail('transient')
      }
      const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
      const code = typeof body.code === 'number' ? body.code : res.status === 200 ? 0 : -1
      if (code === 0 && res.status < 400)
        return { ok: true, data: (body.data ?? {}) as Record<string, unknown> }
      // 令牌过期 / 失效：重取一次再试
      if ([99991663, 99991664, 99991661, 99991668].includes(code) && attempt === 0) continue
      const kind = classifyFeishuError(res.status, code, String(body.msg ?? ''))
      return fail(kind, `飞书 ${code}`)
    }
    return fail('transient')
  }

  /* 后半段（认表、读表头、写一行）接在下面。 */
  return createAdapterBody({ call, fail })
}

/** 后半段要的两样（前半段闭包里的）。 */
interface AdapterCore {
  call(
    ws: WorkspaceId,
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<SinkResult<Record<string, unknown>>>
  fail<T>(code: SinkErrorCode, detail?: string): SinkResult<T>
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const enc = encodeURIComponent

function createAdapterBody(core: AdapterCore): SinkAdapter {
  const { call, fail } = core

  /** 链接 → 多维表格 / 电子表格的 token（知识库里的先问一次知识库）。 */
  const resolve = async (
    ws: WorkspaceId,
    url: string,
  ): Promise<SinkResult<{ kind: 'bitable' | 'sheet'; token: string; sub?: string }>> => {
    const p = parseFeishuUrl(url)
    if (p === undefined) return fail('not_supported')
    if (p.kind !== 'wiki')
      return {
        ok: true,
        data: { kind: p.kind, token: p.token, ...(p.sub === undefined ? {} : { sub: p.sub }) },
      }
    const node = await call(ws, 'GET', `/open-apis/wiki/v2/spaces/get_node?token=${enc(p.token)}`)
    if (!node.ok) return node
    const n = asRecord(node.data.node)
    const objType = String(n.obj_type ?? '')
    const objToken = String(n.obj_token ?? '')
    if (objToken === '' || (objType !== 'bitable' && objType !== 'sheet'))
      return fail('not_supported')
    return {
      ok: true,
      data: {
        kind: objType as 'bitable' | 'sheet',
        token: objToken,
        ...(p.sub === undefined ? {} : { sub: p.sub }),
      },
    }
  }

  const inspectBitable = async (
    ws: WorkspaceId,
    app: string,
    sub: string | undefined,
  ): Promise<SinkResult<SinkTargetInfo>> => {
    let table = sub
    let title: string | undefined
    if (table === undefined) {
      const tables = await call(
        ws,
        'GET',
        `/open-apis/bitable/v1/apps/${enc(app)}/tables?page_size=20`,
      )
      if (!tables.ok) return tables
      const first = asRecord(asArray(tables.data.items)[0])
      if (typeof first.table_id !== 'string') return fail('not_found', '这个多维表格里没有数据表')
      table = first.table_id
      if (typeof first.name === 'string') title = first.name
    }
    const base = `/open-apis/bitable/v1/apps/${enc(app)}/tables/${enc(table)}`
    const fields = await call(ws, 'GET', `${base}/fields?page_size=100`)
    if (!fields.ok) return fields
    const columns: TargetColumn[] = asArray(fields.data.items).flatMap((raw) => {
      const f = asRecord(raw)
      if (typeof f.field_name !== 'string') return []
      const type = columnTypeOf(typeof f.type === 'number' ? f.type : 0)
      const options = asArray(asRecord(f.property).options)
        .map((o) => asRecord(o).name)
        .filter((n): n is string => typeof n === 'string')
      return [{ name: f.field_name, type, ...(options.length === 0 ? {} : { options }) }]
    })
    const rows = await call(ws, 'GET', `${base}/records?page_size=3`)
    const samples = rows.ok
      ? asArray(rows.data.items).map((r) => {
          const fs = asRecord(asRecord(r).fields)
          return columns.map((c) => cellText(fs[c.name]))
        })
      : []
    return {
      ok: true,
      data: {
        adapter: 'feishu_bitable',
        ref: { app_token: app, table_id: table },
        ...(title === undefined ? {} : { title }),
        columns,
        samples,
      },
    }
  }

  const inspectSheet = async (
    ws: WorkspaceId,
    token: string,
    sub: string | undefined,
  ): Promise<SinkResult<SinkTargetInfo>> => {
    let sheet = sub
    let title: string | undefined
    if (sheet === undefined) {
      const q = await call(
        ws,
        'GET',
        `/open-apis/sheets/v3/spreadsheets/${enc(token)}/sheets/query`,
      )
      if (!q.ok) return q
      const first = asRecord(asArray(q.data.sheets)[0])
      if (typeof first.sheet_id !== 'string') return fail('not_found', '这个表格里没有工作表')
      sheet = first.sheet_id
      if (typeof first.title === 'string') title = first.title
    }
    const range = `${sheet}!A1:Z4`
    const v = await call(
      ws,
      'GET',
      `/open-apis/sheets/v2/spreadsheets/${enc(token)}/values/${enc(range)}`,
    )
    if (!v.ok) return v
    const values = asArray(asRecord(v.data.valueRange).values).map((row) =>
      asArray(row).map(cellText),
    )
    const head = values[0] ?? []
    let last = head.length
    while (last > 0 && (head[last - 1] ?? '').trim() === '') last -= 1
    const columns: TargetColumn[] = head
      .slice(0, last)
      .map((name, i) => ({ name: name.trim() === '' ? colLetter(i) : name.trim(), type: 'text' }))
    const samples = values
      .slice(1)
      .filter((r) => r.some((x) => x.trim() !== ''))
      .map((r) => columns.map((_, i) => r[i] ?? ''))
    return {
      ok: true,
      data: {
        adapter: 'feishu_sheet',
        ref: {
          spreadsheet_token: token,
          sheet_id: sheet,
          ...(columns.length === 0 ? { header_missing: '1' } : {}),
        },
        ...(title === undefined ? {} : { title }),
        columns,
        samples,
      },
    }
  }

  return {
    id: 'feishu',
    matches: (url) => parseFeishuUrl(url) !== undefined,
    async inspect(ws, url) {
      const r = await resolve(ws, url)
      if (!r.ok) return r
      return r.data.kind === 'bitable'
        ? inspectBitable(ws, r.data.token, r.data.sub)
        : inspectSheet(ws, r.data.token, r.data.sub)
    },
    async append(input) {
      const { ref, cells } = input
      if (ref.app_token !== undefined && ref.table_id !== undefined) {
        const fields: Record<string, unknown> = {}
        for (const c of cells) {
          const v = bitableValue(c)
          if (v !== undefined) fields[c.column] = v
        }
        const res = await call(
          input.workspace_id,
          'POST',
          `/open-apis/bitable/v1/apps/${enc(ref.app_token)}/tables/${enc(ref.table_id)}/records?client_token=${clientTokenOf(input.key)}`,
          { fields },
        )
        if (!res.ok) return res
        const id = asRecord(res.data.record).record_id
        return { ok: true, data: typeof id === 'string' ? { row_ref: id } : {} }
      }
      if (ref.spreadsheet_token !== undefined && ref.sheet_id !== undefined) {
        const row = cells.map((c) => (c.type === 'number' && c.num !== undefined ? c.num : c.text))
        const header = ref.header_missing === '1'
        const values = header ? [cells.map((c) => c.column), row] : [row]
        const width = Math.max(1, cells.length)
        const res = await call(
          input.workspace_id,
          'POST',
          `/open-apis/sheets/v2/spreadsheets/${enc(ref.spreadsheet_token)}/values_append?insertDataOption=INSERT_ROWS`,
          {
            valueRange: {
              range: `${ref.sheet_id}!A1:${colLetter(width - 1)}${values.length}`,
              values,
            },
          },
        )
        if (!res.ok) return res
        const updated = asRecord(res.data.updates).updatedRange
        return {
          ok: true,
          data: {
            ...(typeof updated === 'string' ? { row_ref: updated } : {}),
            ...(header ? { ref_patch: { header_missing: '' } } : {}),
          },
        }
      }
      return fail('not_supported')
    },
    setupHint: (code) => (code === 'not_configured' ? NOT_CONFIGURED_HINT : FEISHU_SETUP_HINT),
  }
}
