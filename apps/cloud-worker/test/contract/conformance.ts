/**
 * WP164：契约 ↔ 真云服务的一致性检查（给 `wp164-contract.test.ts` 与值守那一份用）。
 *
 * 读 `packages/contracts/cloud-openapi.json`（开源仓里由 TS 类型生成的那份），
 * 对每一个真打出来的响应：
 *
 * 1. 这条路由在契约里有没有（方法 + 路径模板）；
 * 2. 这个状态码契约里写了没有（成功与错误都算）；
 * 3. 正文过不过契约里那个 schema——**严格档**：契约里没写的字段多出来也算不过
 *    （契约本身不写 `additionalProperties: false`，给客户端留余地；但对照真实现时
 *    多一个没登记的字段就是类型落后于行为，要补类型）。
 *
 * 校验器是自己写的一小段：契约里的 schema 是生成器出的，只会用到
 * `$ref / type / const / enum / anyOf / properties / required /
 * additionalProperties / items / prefixItems` 这几样。不引 ajv——
 * 不加依赖，也不让"校验器自己的宽松默认"替我们放水。
 *
 * 这个文件随云端代码搬进私有仓，在那边继续跑（docs/83 §8 第 3 步）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Schema = Record<string, unknown>

interface Operation {
  responses: Record<
    string,
    { content?: Record<string, { schema?: Schema; 'x-sse-data'?: Schema }> }
  >
  tags: string[]
}

export interface CloudContract {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, Schema> }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** 开源仓里签进去的那份契约。 */
export function loadCloudContract(): CloudContract {
  return JSON.parse(
    readFileSync(join(ROOT, 'packages/contracts/cloud-openapi.json'), 'utf8'),
  ) as CloudContract
}

/** 按 JSON Schema 校验一个值；返回不过的原因（空 = 过）。 */
export function validate(
  contract: CloudContract,
  schema: Schema,
  value: unknown,
  at = '$',
): string[] {
  const ref = schema.$ref
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '')
    const target = contract.components.schemas[name]
    if (target === undefined) return [`${at}: 契约里没有 ${name}`]
    return validate(contract, target, value, at)
  }
  if (Array.isArray(schema.anyOf)) {
    const tries = (schema.anyOf as Schema[]).map((s) => validate(contract, s, value, at))
    if (tries.some((t) => t.length === 0)) return []
    const best = tries.reduce((a, b) => (b.length < a.length ? b : a))
    return [`${at}: anyOf 一个都不过（最接近的那个：${best.join('；')}）`]
  }
  if ('const' in schema && value !== schema.const)
    return [`${at}: 应为 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}`]
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return [`${at}: ${JSON.stringify(value)} 不在 ${JSON.stringify(schema.enum)} 里`]
  const type = schema.type
  if (type === undefined) return []
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : (typeof value as string)
  if (type !== actual) return [`${at}: 应为 ${String(type)}，实际 ${actual}`]
  if (type === 'array') {
    const items = value as unknown[]
    if (Array.isArray(schema.prefixItems)) {
      return (schema.prefixItems as Schema[]).flatMap((s, i) =>
        validate(contract, s, items[i], `${at}[${String(i)}]`),
      )
    }
    const item = (schema.items ?? {}) as Schema
    return items.flatMap((v, i) => validate(contract, item, v, `${at}[${String(i)}]`))
  }
  if (type === 'object') {
    const obj = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, Schema>
    const required = (schema.required ?? []) as string[]
    const errors: string[] = []
    for (const key of required) if (!(key in obj)) errors.push(`${at}.${key}: 契约说必有，实际没有`)
    for (const [key, v] of Object.entries(obj)) {
      const prop = props[key]
      if (prop !== undefined) errors.push(...validate(contract, prop, v, `${at}.${key}`))
      else if (schema.additionalProperties !== undefined)
        errors.push(...validate(contract, schema.additionalProperties as Schema, v, `${at}.${key}`))
      else errors.push(`${at}.${key}: 契约里没有这个字段（类型落后于实际行为）`)
    }
    return errors
  }
  return []
}

/** `/v1/cloud/links/abc/renew` → 契约里的 `/v1/cloud/links/{id}/renew`。 */
export function matchPath(
  contract: CloudContract,
  method: string,
  path: string,
): string | undefined {
  const m = method.toLowerCase()
  const exact = contract.paths[path]?.[m]
  if (exact !== undefined) return path
  const segs = path.split('/')
  return Object.keys(contract.paths).find((template) => {
    if (contract.paths[template]?.[m] === undefined) return false
    const t = template.split('/')
    return t.length === segs.length && t.every((s, i) => s.startsWith('{') || s === segs[i])
  })
}

/**
 * 读 SSE 的 `data:` 块（不含 `[DONE]`）。给了 `limit` 就读够这么多块即停——
 * 访客流是长连接，不会自己结束。**读的是这个响应本身**（流只能读一次）。
 */
export async function readSse(res: Response, limit?: number): Promise<string[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const events: string[] = []
  let buffer = ''
  while (limit === undefined || events.length < limit) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut = buffer.indexOf('\n\n')
    while (cut !== -1) {
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice('data: '.length).trim()
        if (payload !== '[DONE]') events.push(payload)
      }
      cut = buffer.indexOf('\n\n')
    }
  }
  await reader.cancel().catch(() => undefined)
  return limit === undefined ? events : events.slice(0, limit)
}

/** 一趟下来打到了哪些（`METHOD template` → 见过的状态码）。 */
export class ContractRecorder {
  readonly seen = new Map<string, Set<number>>()
  constructor(readonly contract: CloudContract) {}

  /**
   * 核一个真响应；不过就抛（带着原因）。正文按媒体类型读：JSON 校验 schema，
   * SSE 逐个 `data:` 校验 `x-sse-data`，其余只核状态码与媒体类型。
   */
  async check(
    method: string,
    path: string,
    res: Response,
    options: { sseEvents?: number } = {},
  ): Promise<void> {
    const pathname = new URL(path, 'https://x').pathname
    const template = matchPath(this.contract, method, pathname)
    if (template === undefined) throw new Error(`契约里没有 ${method} ${pathname}`)
    const op = this.contract.paths[template]?.[method.toLowerCase()] as Operation
    const key = `${method.toUpperCase()} ${template}`
    const response = op.responses[String(res.status)]
    if (response === undefined)
      throw new Error(
        `${key}：契约里没写状态码 ${String(res.status)}（${await res.clone().text()}）`,
      )
    const statuses = this.seen.get(key) ?? new Set<number>()
    statuses.add(res.status)
    this.seen.set(key, statuses)
    if (response.content === undefined) return
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
    const media = response.content[type]
    if (media === undefined)
      throw new Error(
        `${key} ${String(res.status)}：媒体类型 ${type} 不在契约里（${Object.keys(response.content).join(', ')}）`,
      )
    if (type === 'application/json' && media.schema !== undefined) {
      const body = JSON.parse(await res.clone().text()) as unknown
      const errors = validate(this.contract, media.schema, body)
      if (errors.length > 0)
        throw new Error(`${key} ${String(res.status)} 不过契约：\n${errors.join('\n')}`)
    }
    if (type === 'text/event-stream' && media['x-sse-data'] !== undefined) {
      const events = await readSse(res, options.sseEvents)
      if (events.length === 0) throw new Error(`${key}：SSE 一块都没有`)
      for (const payload of events) {
        const errors = validate(this.contract, media['x-sse-data'], JSON.parse(payload))
        if (errors.length > 0) throw new Error(`${key} SSE 块不过契约：\n${errors.join('\n')}`)
      }
    }
  }

  /**
   * 记一笔"打到过"，给普通 Node 的 `Response` 表达不了的那种（WebSocket 的 101：
   * Node 不收 101，转发器替身回 200，见 `chat-relay-do.ts` 的 `#connect`）。
   */
  mark(method: string, template: string, status: number): void {
    const key = `${method.toUpperCase()} ${template}`
    const op = this.contract.paths[template]?.[method.toLowerCase()]
    if (op === undefined) throw new Error(`契约里没有 ${key}`)
    if (op.responses[String(status)] === undefined)
      throw new Error(`${key}：契约里没写状态码 ${String(status)}`)
    const statuses = this.seen.get(key) ?? new Set<number>()
    statuses.add(status)
    this.seen.set(key, statuses)
  }

  /** WebSocket 的一帧过不过契约（`x-websocket.client` / `.server`）。 */
  checkWsFrame(template: string, direction: 'client' | 'server', frame: unknown): void {
    const op = this.contract.paths[template]?.get as
      | (Operation & { 'x-websocket'?: { client: Schema; server: Schema } })
      | undefined
    const schema = op?.['x-websocket']?.[direction]
    if (schema === undefined) throw new Error(`契约里 ${template} 没有 x-websocket.${direction}`)
    const errors = validate(this.contract, schema, frame)
    if (errors.length > 0)
      throw new Error(`${template} ${direction} 帧不过契约：\n${errors.join('\n')}`)
  }

  /** 这几个 tag 下，哪些路由一次成功（2xx / 101）都没打到。 */
  missingSuccess(tags: readonly string[]): string[] {
    const missing: string[] = []
    for (const [template, item] of Object.entries(this.contract.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!op.tags.some((t) => tags.includes(t))) continue
        const key = `${method.toUpperCase()} ${template}`
        const statuses = [...(this.seen.get(key) ?? [])]
        if (!statuses.some((s) => s >= 200 && s < 300) && !statuses.includes(101)) missing.push(key)
      }
    }
    return missing
  }
}
