/**
 * WP323 测试用的**飞书开放平台替身**（只在内存里；不连真实飞书）。
 *
 * 认的接口：取应用令牌、知识库节点、多维表格（数据表 / 字段 / 记录列表 / 新建记录，带 `client_token` 幂等）、
 * 电子表格（工作表列表 / 读范围 / 追加）。可以注入失败：下一次某类请求回什么错。
 */
import type { FeishuFetch } from '../src/outbound/feishu.js'

export interface FakeBitableField {
  field_name: string
  type: number
  options?: string[]
}

export interface FakeFeishu {
  fetch: FeishuFetch
  /** 多维表格：app_token → table_id → { fields, records }。 */
  bitables: Map<
    string,
    Map<string, { name: string; fields: FakeBitableField[]; records: Record<string, unknown>[] }>
  >
  /** 电子表格：token → sheet_id → 二维数组。 */
  sheets: Map<string, Map<string, unknown[][]>>
  /** 知识库节点 → { obj_type, obj_token }。 */
  wiki: Map<string, { obj_type: string; obj_token: string }>
  /** 共享给应用了的表（token）。不在里面 = 回没权限。 */
  shared: Set<string>
  /** 下一次命中 `match` 的请求回这个（用一次就清）。 */
  failNext(match: RegExp, reply: { status?: number; code: number; msg?: string } | 'throw'): void
  calls: { method: string; path: string; body?: unknown }[]
  /** 已发出的令牌数（测试看重取）。 */
  tokensIssued: number
  /** 让现有令牌全部失效。 */
  expireTokens(): void
}

export function createFakeFeishu(): FakeFeishu {
  const bitables: FakeFeishu['bitables'] = new Map()
  const sheets: FakeFeishu['sheets'] = new Map()
  const wiki: FakeFeishu['wiki'] = new Map()
  const shared = new Set<string>()
  const failures: {
    match: RegExp
    reply: { status?: number; code: number; msg?: string } | 'throw'
  }[] = []
  const calls: FakeFeishu['calls'] = []
  const clientTokens = new Map<string, string>()
  let valid = new Set<string>()
  let issued = 0
  let seq = 0

  const reply = (status: number, body: unknown) => ({
    status,
    json: async () => body,
  })
  const ok = (data: unknown) => reply(200, { code: 0, msg: 'success', data })
  const err = (code: number, msg: string, status = 400) => reply(status, { code, msg })

  const fetch: FeishuFetch = async (url, init) => {
    const u = new URL(url)
    const path = u.pathname
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({
      method: init.method,
      path: `${path}${u.search}`,
      ...(body === undefined ? {} : { body }),
    })
    const f = failures.findIndex((x) => x.match.test(`${init.method} ${path}`))
    if (f >= 0) {
      const [hit] = failures.splice(f, 1)
      if (hit?.reply === 'throw') throw new Error('network down')
      if (hit !== undefined)
        return err(hit.reply.code, hit.reply.msg ?? 'error', hit.reply.status ?? 400)
    }
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      if (body?.app_secret !== 'test-secret') return err(10014, 'app secret invalid')
      issued += 1
      const token = `t-${issued}`
      valid.add(token)
      return reply(200, { code: 0, tenant_access_token: token, expire: 7200 })
    }
    const auth = init.headers.Authorization?.replace('Bearer ', '') ?? ''
    if (!valid.has(auth)) return err(99991663, 'token invalid', 400)

    if (path === '/open-apis/wiki/v2/spaces/get_node') {
      const node = wiki.get(u.searchParams.get('token') ?? '')
      return node === undefined ? err(131005, 'not found') : ok({ node })
    }
    let m =
      /^\/open-apis\/bitable\/v1\/apps\/([^/]+)\/tables(?:\/([^/]+)\/(fields|records))?$/.exec(path)
    if (m !== null) {
      const app = decodeURIComponent(m[1] as string)
      const tables = bitables.get(app)
      if (tables === undefined) return err(1254003, 'AppTokenNotFound')
      if (!shared.has(app)) return err(1254302, 'Permission denied', 403)
      if (m[2] === undefined)
        return ok({
          items: [...tables.entries()].map(([table_id, t]) => ({ table_id, name: t.name })),
        })
      const table = tables.get(decodeURIComponent(m[2]))
      if (table === undefined) return err(1254004, 'TableIdNotFound')
      if (m[3] === 'fields')
        return ok({
          items: table.fields.map((x) => ({
            field_name: x.field_name,
            type: x.type,
            ...(x.options === undefined
              ? {}
              : { property: { options: x.options.map((name) => ({ name })) } }),
          })),
        })
      if (init.method === 'GET')
        return ok({ items: table.records.slice(0, 3).map((fields) => ({ fields })) })
      const ct = u.searchParams.get('client_token') ?? ''
      const seen = clientTokens.get(ct)
      if (seen !== undefined) return ok({ record: { record_id: seen } })
      const fields = (body?.fields ?? {}) as Record<string, unknown>
      for (const k of Object.keys(fields))
        if (!table.fields.some((x) => x.field_name === k)) return err(1254045, 'FieldNameNotFound')
      seq += 1
      const id = `rec${seq}`
      table.records.push(fields)
      if (ct !== '') clientTokens.set(ct, id)
      return ok({ record: { record_id: id, fields } })
    }
    m = /^\/open-apis\/sheets\/v3\/spreadsheets\/([^/]+)\/sheets\/query$/.exec(path)
    if (m !== null) {
      const book = sheets.get(decodeURIComponent(m[1] as string))
      if (book === undefined) return err(91402, 'not found')
      if (!shared.has(decodeURIComponent(m[1] as string))) return err(91403, 'forbidden', 403)
      return ok({
        sheets: [...book.keys()].map((sheet_id, index) => ({
          sheet_id,
          title: `Sheet${index + 1}`,
          index,
        })),
      })
    }
    m = /^\/open-apis\/sheets\/v2\/spreadsheets\/([^/]+)\/(values\/(.+)|values_append)$/.exec(path)
    if (m !== null) {
      const token = decodeURIComponent(m[1] as string)
      const book = sheets.get(token)
      if (book === undefined) return err(91402, 'not found')
      if (!shared.has(token)) return err(91403, 'forbidden', 403)
      if (m[2] === 'values_append') {
        const range = String(body?.valueRange?.range ?? '')
        const sheetId = range.split('!')[0] ?? ''
        const grid = book.get(sheetId)
        if (grid === undefined) return err(91402, 'sheet not found')
        const values = (body?.valueRange?.values ?? []) as unknown[][]
        const start = grid.length + 1
        grid.push(...values)
        return ok({ updates: { updatedRange: `${sheetId}!A${start}:Z${grid.length}` } })
      }
      const range = decodeURIComponent(m[3] as string)
      const grid = book.get(range.split('!')[0] ?? '')
      if (grid === undefined) return err(91402, 'sheet not found')
      return ok({ valueRange: { range, values: grid.slice(0, 4) } })
    }
    return err(404, 'no such api', 404)
  }

  return {
    fetch,
    bitables,
    sheets,
    wiki,
    shared,
    calls,
    failNext: (match, r) => {
      failures.push({ match, reply: r })
    },
    get tokensIssued() {
      return issued
    },
    expireTokens: () => {
      valid = new Set()
    },
  }
}
