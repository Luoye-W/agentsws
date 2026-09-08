import { createHash } from 'node:crypto'
import type { FetchLike } from './http.js'

/**
 * HTTP 录制 / 回放。本机有 docker 时对真 runtime 录一遍（`test/record-fixtures.test.ts`，`RECORD_FIXTURES=1`），
 * CI / 无 docker 时把同一份磁带注入 `fetch` 回放——同一套契约用例两种模式都能跑。
 *
 * **磁带里不含任何凭据**：admin token 与 `oct_…` runtime token 在录制过程中就被替换成
 * 确定性占位串（`SecretRegistry`），回放时适配器拿到的也是占位串，所以请求键仍然对齐。
 */
export interface Exchange {
  key: string
  method: string
  path: string
  status: number
  /** 响应体原文（已脱敏）。 */
  body: string
}

export interface Cassette {
  version: 1
  recorded_at: string
  /** 占位串表：`admin` = admin token 的占位值，回放时测试把它塞进环境变量。 */
  placeholders: Record<string, string>
  exchanges: Exchange[]
}

const OCT_TOKEN = /oct_[A-Za-z0-9_-]{16,}/g

/** 秘密 → 确定性占位串。录制期即时替换，原文永不落盘。 */
export class SecretRegistry {
  private readonly map = new Map<string, string>()
  private readonly labels = new Map<string, string>()
  private seq = 0

  register(secret: string, label: string): string {
    const existing = this.map.get(secret)
    if (existing !== undefined) return existing
    const placeholder = `${label}_fixture_${++this.seq}`
    this.map.set(secret, placeholder)
    if (!this.labels.has(label)) this.labels.set(label, placeholder)
    return placeholder
  }

  /** 认领文本里所有 `oct_…` 形态的 runtime token。 */
  autoRegister(text: string): void {
    for (const m of text.matchAll(OCT_TOKEN)) this.register(m[0], 'oct')
  }

  redact(text: string): string {
    let out = text
    for (const [secret, placeholder] of this.map) out = out.split(secret).join(placeholder)
    return out
  }

  /** `label → 占位串`（每个 label 取首次注册的那个），回放时测试据此还原环境变量。 */
  placeholders(): Record<string, string> {
    return Object.fromEntries(this.labels)
  }

  /** 已登记的秘密条数——用于断言"录制期确实认领了 token"。 */
  size(): number {
    return this.map.size
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers
  if (h === undefined) return undefined
  if (h instanceof Headers) return h.get(name) ?? undefined
  if (Array.isArray(h)) {
    const hit = h.find(([k]) => k.toLowerCase() === name)
    return hit?.[1]
  }
  const rec = h as Record<string, string>
  for (const [k, v] of Object.entries(rec)) if (k.toLowerCase() === name) return v
  return undefined
}

function bodyOf(init: RequestInit | undefined): string {
  const b = init?.body
  return typeof b === 'string' ? b : b === undefined || b === null ? '' : String(b)
}

/**
 * 请求键：方法 + 路径与查询 + 连接 alias + 幂等键 + bearer 占位串 + 请求体哈希。
 * bearer 进键是必须的——"未授权的连接被拒"只在 header 上与成功用例不同。
 */
export function requestKey(
  url: string,
  init: RequestInit | undefined,
  redactSecret: (s: string) => string,
): { key: string; path: string; method: string } {
  const u = new URL(url)
  const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const qs = params.map(([k, v]) => `${k}=${v}`).join('&')
  const path = qs.length === 0 ? u.pathname : `${u.pathname}?${qs}`
  const method = (init?.method ?? 'GET').toUpperCase()
  const auth = headerOf(init, 'authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? redactSecret(auth.slice(7)) : ''
  const alias = headerOf(init, 'x-oo-connector-alias') ?? ''
  const idem = headerOf(init, 'idempotency-key') ?? ''
  const body = bodyOf(init)
  const key = [
    method,
    path,
    `auth=${bearer}`,
    `alias=${alias}`,
    `idem=${idem}`,
    `body=${hash(body)}`,
  ].join(' | ')
  return { key, path, method }
}

export interface RecorderOptions {
  base: FetchLike
  secrets: SecretRegistry
  now: () => string
}

export interface Recorder {
  fetch: FetchLike
  cassette(): Cassette
}

/** 包一层真 fetch：边打真 runtime 边把交互（脱敏后）攒成磁带。 */
export function createRecordingFetch(opts: RecorderOptions): Recorder {
  const exchanges: Exchange[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const res = await opts.base(url, init)
    const text = await res.clone().text()
    opts.secrets.autoRegister(text)
    const { key, path, method } = requestKey(url, init, (s) => opts.secrets.redact(s))
    exchanges.push({
      key: opts.secrets.redact(key),
      method,
      path: opts.secrets.redact(path),
      status: res.status,
      body: opts.secrets.redact(text),
    })
    return res
  }
  return {
    fetch: fetchImpl,
    cassette: () => ({
      version: 1,
      recorded_at: opts.now(),
      placeholders: opts.secrets.placeholders(),
      exchanges,
    }),
  }
}

export class CassetteMissError extends Error {
  constructor(
    readonly key: string,
    readonly known: string[],
  ) {
    super(`磁带里没有这条请求：${key}`)
    this.name = 'CassetteMissError'
  }
}

/** 用磁带回放。同一个键的多次调用按录制顺序推进，用完后重复最后一条。 */
export function createReplayFetch(cassette: Cassette): FetchLike {
  const byKey = new Map<string, Exchange[]>()
  for (const ex of cassette.exchanges) {
    const list = byKey.get(ex.key)
    if (list === undefined) byKey.set(ex.key, [ex])
    else list.push(ex)
  }
  const cursor = new Map<string, number>()
  return async (url, init) => {
    const { key } = requestKey(url, init, (s) => s)
    const list = byKey.get(key)
    if (list === undefined || list.length === 0) {
      throw new CassetteMissError(key, [...byKey.keys()])
    }
    const i = cursor.get(key) ?? 0
    const ex = list[Math.min(i, list.length - 1)] as Exchange
    cursor.set(key, i + 1)
    return new Response(ex.body, {
      status: ex.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}
