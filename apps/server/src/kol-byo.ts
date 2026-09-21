/**
 * WP126：**自带数据接口的适配器**（跑在本机，走用户自己的额度，不扣积分）。
 *
 * 用户在连接卡上填了「服务地址 + 密钥 + 返回格式」之后，这一层负责把那个服务
 * 真的接进来：四种动作各打一个端点（形状见 `@agentsws/contracts` 的
 * `byo-data-source.ts`），把归一化的红人 / 指标 / 联系方式翻译成本仓的行。
 *
 * 四条纪律（沿用渠道适配器的现有纪律）：
 *
 * 1. **超时**：打自带接口最多等 `BYO_TIMEOUT_MS`；挂了不是"搜到 0 个"。
 * 2. **错误人话化**：非 2xx 的 `message`（服务自己给的那句）原样带回去；
 *    连不上 / 超时 / 回得不对，各有一句固定的人话——不吞、不编。
 * 3. **密钥只在一行里出现**：从本机加密库取出来直接进 `Authorization`，
 *    函数返回之后没人再引用它；不进日志、不进错误信息。
 * 4. **不做任何平台预设**：这里只认 `byo/v1` 那一份通用格式，
 *    对面是什么服务这一层不知道也不想知道。
 */

import type {
  ByoCreator,
  ByoDataSourceAction,
  ByoSearchRequest,
  ByoSearchResponse,
  KolChannel,
} from '@agentsws/contracts'
import { BYO_DATA_SOURCE_PATHS, BYO_DATA_SOURCE_PREFIX } from '@agentsws/contracts'
import type { KolSearchHit } from '@agentsws/api'

/** 打自带接口最多等多久。 */
export const BYO_TIMEOUT_MS = 10_000

/** 用户在连接卡上填的那三样（密钥另存加密库，这里只见引用）。 */
export interface ByoEndpointConfig {
  /** 服务地址（含 scheme；适配器会在后面拼 `/byo/v1/...`）。 */
  service_url: string
  /** 密钥在本机加密库里的 key 名。 */
  secret_ref: string
  /** 返回格式。这一版只有一种：`byo/v1`（契约那份通用格式）。 */
  format: 'byo/v1'
}

/** 取密钥的口（实现是本机加密库；测试用替身）。 */
export type ByoSecretReader = (secret_ref: string) => string | undefined

export interface ByoCallResult<T> {
  ok: boolean
  /** 失败时的一句人话（服务自己的 message 优先）。 */
  message?: string
  /** 机器可读的原因（`timeout` / `unauthorized` / `bad_response` / `network` / 服务给的 code）。 */
  reason?: string
  data?: T
}

export type ByoFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

interface ByoEnvelopeError {
  code?: string
  message?: string
}

/** 连接卡的「测试连接」打的那一下：一次最小的 profile 请求。 */
export const BYO_TEST_HANDLE = 'agentsws-self-check'

function trimUrl(raw: string): string {
  return raw.trim().replace(/\/+$/u, '')
}

/** 拼一个动作端点的完整地址。 */
export function byoEndpointOf(config: ByoEndpointConfig, action: ByoDataSourceAction): string {
  return `${trimUrl(config.service_url)}${BYO_DATA_SOURCE_PREFIX}${BYO_DATA_SOURCE_PATHS[action]}`
}

/**
 * 打一次自带接口。POST + Bearer + 10 秒超时；错误翻成人话。
 * **不重试**：第一版只重试读起来无害的 network 抖动会拖慢搜索；限流类错误
 * （`rate_limited`）重试只会更糟——照实说，让人决定。
 */
async function call<T>(
  config: ByoEndpointConfig,
  secrets: ByoSecretReader,
  action: ByoDataSourceAction,
  body: unknown,
  doFetch: ByoFetch,
): Promise<ByoCallResult<T>> {
  const key = secrets(config.secret_ref)
  if (key === undefined || key === '')
    return { ok: false, reason: 'no_secret', message: '这把数据接口的密钥读不出来了（本机加密库换了钥匙？）。去连接页重新填一次密钥。' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BYO_TIMEOUT_MS)
  try {
    const res = await doFetch(byoEndpointOf(config, action), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text.trim() === '' ? {} : JSON.parse(text)
    } catch {
      return { ok: false, reason: 'bad_response', message: '你的数据接口回的不是 JSON。检查一下服务地址填对没有。' }
    }
    if (!res.ok) {
      const body2 = parsed as ByoEnvelopeError
      const reason = body2.code ?? (res.status === 401 ? 'unauthorized' : 'upstream_error')
      return {
        ok: false,
        reason,
        message:
          body2.message ??
          (res.status === 401
            ? '你的数据接口说密钥不对。去连接页核对一下密钥。'
            : `你的数据接口没答上来（HTTP ${res.status}）。`),
      }
    }
    if (typeof parsed !== 'object' || parsed === null)
      return { ok: false, reason: 'bad_response', message: '你的数据接口回的形状不对（要是一个 JSON 对象）。' }
    return { ok: true, data: parsed as T }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'network',
      message: aborted
        ? `你的数据接口 ${BYO_TIMEOUT_MS / 1000} 秒没应答，这次先停了。检查一下服务是不是开着。`
        : '连不上你的数据接口（网络不通，或者地址填错了）。',
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 归一化的红人 → 搜索结果的一行（两个形状的字段名不一样，只有这一处翻译）。 */
export function hitOf(creator: ByoCreator, known: Set<string>): KolSearchHit {
  return {
    channel: creator.channel,
    handle: creator.handle,
    url: creator.url,
    display_name: creator.display_name,
    ...(creator.followers === undefined ? {} : { followers: creator.followers }),
    ...(creator.engagement_rate === undefined ? {} : { engagement_rate: creator.engagement_rate }),
    ...(creator.category === undefined ? {} : { category: creator.category }),
    ...(creator.language === undefined ? {} : { language: creator.language }),
    ...(creator.region === undefined ? {} : { region: creator.region }),
    in_library: known.has(creator.handle.toLowerCase()),
  }
}

/** 自带接口的搜索（路由第②级用的那一个）。 */
export async function byoSearch(
  config: ByoEndpointConfig,
  secrets: ByoSecretReader,
  input: ByoSearchRequest,
  known: Set<string>,
  doFetch: ByoFetch = (url, init) =>
    globalThis.fetch(url, init as RequestInit) as unknown as ReturnType<ByoFetch>,
): Promise<ByoCallResult<{ rows: KolSearchHit[]; observed_at?: string }>> {
  const out = await call<ByoSearchResponse>(config, secrets, 'search', input, doFetch)
  if (!out.ok)
    return {
      ok: false,
      ...(out.message === undefined ? {} : { message: out.message }),
      ...(out.reason === undefined ? {} : { reason: out.reason }),
    }
  const creators = Array.isArray(out.data?.creators) ? (out.data?.creators ?? []) : []
  const rows = creators
    .filter((c) => c.channel === input.channel)
    .map((c) => hitOf(c, known))
  return {
    ok: true,
    data: { rows, ...(creators[0]?.observed_at === undefined ? {} : { observed_at: creators[0]?.observed_at }) },
  }
}

/** 连接卡的「测试连接」：打一次最小的 profile 请求（假账号名，服务回 404 也算通）。 */
export async function byoTestConnection(
  config: Omit<ByoEndpointConfig, 'format'> & { format?: ByoEndpointConfig['format'] },
  secrets: ByoSecretReader,
  channel: KolChannel,
  doFetch?: ByoFetch,
): Promise<{ ok: boolean; message: string }> {
  const full: ByoEndpointConfig = { format: 'byo/v1', ...config }
  const out = await call<unknown>(
    full,
    secrets,
    'profile',
    { channel, handle: BYO_TEST_HANDLE },
    doFetch ?? ((url, init) => globalThis.fetch(url, init as RequestInit) as unknown as ReturnType<ByoFetch>),
  )
  // 通 = 服务听懂了：200（真有这个账号）或 404（查无此人是正常回答）都算
  if (out.ok) return { ok: true, message: '通了。你的数据接口听懂了我们的请求。' }
  if (out.reason === 'not_found') return { ok: true, message: '通了。服务回了"查无此人"——这正是我们要的应答。' }
  return { ok: false, message: out.message ?? '没通。' }
}

/* ── 配置的存取（连接卡「自带数据接口（高级）」那一半）───────────────────── */

import { readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Iso8601 } from '@agentsws/contracts'
import type { SecretStore } from './secret-store.js'

/** 一个渠道挂的自带数据接口（加密库里那一行的**非密**部分 + 密钥引用）。 */
export interface ByoSourceRecord {
  channel: KolChannel
  service_url: string
  /** 密钥在本机加密库里的 key 名（`kol.byo.<channel>`）。 */
  secret_ref: string
  format: 'byo/v1'
  updated_at: Iso8601
}

interface ByoStateFile {
  version: 1
  sources: Record<string, Omit<ByoSourceRecord, 'channel'>>
}

/** 密钥在加密库里的 key 名。**全仓只有这一处拼它**。 */
export const byoSecretId = (channel: KolChannel): string => `kol.byo.${channel}`

/** 自带数据接口配置仓的口（`createByoSourceStore` 的返回类型）。 */
export interface ByoSourceStore {
  get(channel: KolChannel): ByoEndpointConfig | undefined
  record(channel: KolChannel): ByoSourceRecord | undefined
  set(channel: KolChannel, input: { service_url: string; api_key?: string }): ByoSourceRecord
  clear(channel: KolChannel): boolean
  reader: ByoSecretReader
}

/**
 * 自带数据接口的配置仓：每渠道最多一个，落 `byo-data-sources.json`；
 * 密钥**只**进本机加密库，文件里只有引用。
 */
export function createByoSourceStore(options: {
  secrets: SecretStore
  dbDir?: string
  now: () => Iso8601
}): ByoSourceStore {
  const stateFile =
    options.dbDir === undefined ? undefined : join(options.dbDir, 'byo-data-sources.json')
  let state: ByoStateFile = { version: 1, sources: {} }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as ByoStateFile
      state = { version: 1, sources: parsed.sources ?? {} }
    } catch {
      // 第一次跑或文件坏了：从空开始
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const recordOf = (channel: KolChannel): ByoSourceRecord | undefined => {
    const found = state.sources[channel]
    return found === undefined ? undefined : { channel, ...found }
  }

  return {
    record: recordOf,
    get(channel) {
      const rec = recordOf(channel)
      return rec === undefined ? undefined : { service_url: rec.service_url, secret_ref: rec.secret_ref, format: rec.format }
    },
    set(channel, input) {
      const secret_ref = byoSecretId(channel)
      if (input.api_key !== undefined && input.api_key.trim() !== '')
        options.secrets.put(secret_ref, { key: input.api_key.trim() })
      const rec: Omit<ByoSourceRecord, 'channel'> = {
        service_url: input.service_url.trim(),
        secret_ref,
        format: 'byo/v1',
        updated_at: options.now(),
      }
      state = { version: 1, sources: { ...state.sources, [channel]: rec } }
      flush()
      return { channel, ...rec }
    },
    clear(channel) {
      if (state.sources[channel] === undefined) return false
      const next = { ...state.sources }
      delete next[channel]
      state = { version: 1, sources: next }
      flush()
      return true
    },
    reader: (secret_ref) => {
      try {
        return options.secrets.get(secret_ref)?.key
      } catch {
        return undefined
      }
    },
  }
}
