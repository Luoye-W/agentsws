/**
 * 插件在 `chrome.storage.local` 里存的**全部**东西（WP119 定论 2 / 3）。
 *
 * 只有三样：本机服务端口、配对得来的插件令牌、桌面应用没开时排队的观测。
 * 三样都在设置页看得见、清得掉，而且**一样都不出这台电脑**——
 * 令牌只发给 `127.0.0.1`，队列只往 `127.0.0.1` 补传。
 *
 * 为什么不用 `chrome.storage.sync`：sync 会把内容同步到用户的 Google 账号，
 * 那等于把一把能写本地红人库的令牌抄一份到别人的服务器上。
 *
 * 存储口抽象成 {@link KeyValueStore} 一个接口，是为了测试里能塞一个内存实现——
 * 而不是为了将来换个后端。
 */

import type { ExtensionObservationInput } from './wire.js'

export interface KeyValueStore {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string[]): Promise<void>
}

/** 本机服务默认端口（与工作台的 `AGENTSWS_API` 同一个数）。 */
export const DEFAULT_PORT = 4317

export const SETTINGS_KEY = 'agentsws.settings'
export const QUEUE_KEY = 'agentsws.queue'

/** 队列最多存这么多条。满了丢**最旧**的——新看到的人比上周那条更值钱。 */
export const QUEUE_LIMIT = 500

/** 排了这么久还没补上去的就扔掉（旧快照补上去也是错的数）。 */
export const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ExtensionSettings {
  /** 本机服务端口。用户改得了（有人把 4317 占了）。 */
  port: number
  /** 配对得来的插件令牌。**只发给 `127.0.0.1`**。 */
  token?: string | undefined
  /** 这把令牌是什么时候配上的（设置页上显示）。 */
  paired_at?: string | undefined
  /** 上一次 `hello` 问到的品牌名，用来在页面卡片上说"收进哪儿"。 */
  workspace_name?: string | undefined
  /** 上一次 `hello` 问到的：这个工作区关联云账号了没有。 */
  cloud_linked?: boolean | undefined
}

export const DEFAULT_SETTINGS: ExtensionSettings = { port: DEFAULT_PORT }

export async function readSettings(store: KeyValueStore): Promise<ExtensionSettings> {
  const raw = (await store.get([SETTINGS_KEY]))[SETTINGS_KEY]
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const row = raw as Partial<ExtensionSettings>
  const port =
    typeof row.port === 'number' && Number.isInteger(row.port) && row.port > 0 && row.port < 65_536
      ? row.port
      : DEFAULT_PORT
  return {
    port,
    ...(typeof row.token === 'string' && row.token !== '' ? { token: row.token } : {}),
    ...(typeof row.paired_at === 'string' ? { paired_at: row.paired_at } : {}),
    ...(typeof row.workspace_name === 'string' ? { workspace_name: row.workspace_name } : {}),
    ...(typeof row.cloud_linked === 'boolean' ? { cloud_linked: row.cloud_linked } : {}),
  }
}

export async function writeSettings(
  store: KeyValueStore,
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const next = { ...(await readSettings(store)), ...patch }
  await store.set({ [SETTINGS_KEY]: next })
  return next
}

/** 解除配对：令牌从这台机器上抹掉（工作台那一侧另撤一次）。 */
export async function forgetToken(store: KeyValueStore): Promise<void> {
  const current = await readSettings(store)
  const { token: _dropped, paired_at: _also, ...rest } = current
  await store.set({ [SETTINGS_KEY]: rest })
}

/** 排在队里的一条。 */
export interface QueuedObservation {
  observation: ExtensionObservationInput
  queued_at: string
}

export async function readQueue(store: KeyValueStore): Promise<QueuedObservation[]> {
  const raw = (await store.get([QUEUE_KEY]))[QUEUE_KEY]
  return Array.isArray(raw) ? (raw as QueuedObservation[]) : []
}

/**
 * 把几条塞进队列。
 *
 * 过期的先扔，然后如果还超上限就**从头砍**（丢最旧的）。
 * 返回真正留下来的队列——调用方要靠它在卡片上如实说「已排队 N 条」。
 */
export async function enqueue(
  store: KeyValueStore,
  rows: readonly ExtensionObservationInput[],
  now: string,
): Promise<QueuedObservation[]> {
  const nowMs = Date.parse(now)
  const kept = (await readQueue(store)).filter(
    (q) =>
      Number.isFinite(Date.parse(q.queued_at)) && nowMs - Date.parse(q.queued_at) < QUEUE_TTL_MS,
  )
  for (const observation of rows) kept.push({ observation, queued_at: now })
  const trimmed = kept.length > QUEUE_LIMIT ? kept.slice(kept.length - QUEUE_LIMIT) : kept
  await store.set({ [QUEUE_KEY]: trimmed })
  return trimmed
}

/** 补传成功之后把前 n 条摘掉（补传是按顺序整批发的）。 */
export async function dropFromQueue(
  store: KeyValueStore,
  count: number,
): Promise<QueuedObservation[]> {
  const rest = (await readQueue(store)).slice(count)
  await store.set({ [QUEUE_KEY]: rest })
  return rest
}

export async function clearQueue(store: KeyValueStore): Promise<void> {
  await store.remove([QUEUE_KEY])
}

/** 真的那一个（`chrome.storage.local`）。 */
export function chromeStore(): KeyValueStore {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  }
}

/** 测试用的那一个。 */
export function memoryStore(seed: Record<string, unknown> = {}): KeyValueStore {
  const data = new Map<string, unknown>(Object.entries(seed))
  return {
    get: async (keys) => {
      const out: Record<string, unknown> = {}
      for (const k of keys) if (data.has(k)) out[k] = data.get(k)
      return out
    },
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v)
    },
    remove: async (keys) => {
      for (const k of keys) data.delete(k)
    },
  }
}
