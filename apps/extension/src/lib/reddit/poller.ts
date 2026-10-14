/**
 * WP328：Reddit 只读的领活（每日巡查）。**只在电脑与 Chrome 开着时读**——插件定时去问本机「有没有要读的」。
 *
 * - 没配对 → 不问；
 * - 没连 Reddit（没给站点权限）→ 半小时告诉本机一次「我在，但没连 Reddit」（本机据此出连接卡），不读；
 * - 问到了 → 用公共执行器读（只读、mark=false、固定间隔、被拦就停）→ 交回。
 *
 * 状态写一份在 `chrome.storage.local`（设置页上看得见：上次问是什么时候、上次读的结局）。
 */
import { type RedditReadOutcome, runRedditRead } from '@agentsws/browser-action'
import type { PermissionsLike } from '../ads/permissions'
import { redditNext, redditResult } from '../local-client'
import type { KeyValueStore } from '../storage'
import { readSettings } from '../storage'
import type { RedditFetch } from './fetcher'
import { redditConnected } from './permissions'

export const REDDIT_STATUS_KEY = 'agentsws.reddit.status'
/** 没连 Reddit 时多久告诉本机一次。 */
export const REDDIT_IDLE_PING_MS = 30 * 60_000

export interface RedditStatus {
  last_poll_at?: string
  note?: string
  /** 读到的登录用户名。 */
  user?: string
  last_result?: { outcome: RedditReadOutcome; message: string; items: number; at: string }
}

export async function readRedditStatus(store: KeyValueStore): Promise<RedditStatus> {
  const raw = (await store.get([REDDIT_STATUS_KEY]))[REDDIT_STATUS_KEY]
  return typeof raw === 'object' && raw !== null ? (raw as RedditStatus) : {}
}

async function patchStatus(store: KeyValueStore, patch: RedditStatus): Promise<void> {
  const next: Record<string, unknown> = { ...(await readRedditStatus(store)), ...patch }
  if (patch.note === '') delete next.note
  await store.set({ [REDDIT_STATUS_KEY]: next })
}

export interface RedditPollerDeps {
  store: KeyValueStore
  perms: PermissionsLike
  fetch?: typeof globalThis.fetch | undefined
  /** 取 Reddit 的那一个（后台 → 标签页兜底）。每件活新建一个。 */
  readFetch(): RedditFetch
  now(): string
  sleep(ms: number): Promise<void>
  control: { stop: boolean }
  gapMs?: number
}

export type RedditPollOutcome =
  | 'busy'
  | 'unpaired'
  | 'not_connected'
  | 'offline'
  | 'refused'
  | 'idle'
  | 'ran'

let running = false

export async function pollRedditOnce(deps: RedditPollerDeps): Promise<RedditPollOutcome> {
  if (running) return 'busy'
  running = true
  try {
    return await pollOnce(deps)
  } finally {
    running = false
  }
}

async function pollOnce(deps: RedditPollerDeps): Promise<RedditPollOutcome> {
  const settings = await readSettings(deps.store)
  if (settings.token === undefined) return 'unpaired'
  const client = {
    port: settings.port,
    token: settings.token,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  }
  const connected = await redditConnected(deps.perms)
  const status = await readRedditStatus(deps.store)
  if (!connected) {
    const last = status.last_poll_at === undefined ? 0 : Date.parse(status.last_poll_at)
    if (Date.parse(deps.now()) - last < REDDIT_IDLE_PING_MS) return 'not_connected'
    await redditNext(client, false)
    await patchStatus(deps.store, { last_poll_at: deps.now() })
    return 'not_connected'
  }
  const got = await redditNext(client, true)
  if (!got.ok) {
    await patchStatus(deps.store, { last_poll_at: deps.now(), note: got.message })
    return got.kind === 'offline' ? 'offline' : 'refused'
  }
  await patchStatus(deps.store, { last_poll_at: deps.now(), note: '' })
  const job = got.data.job
  if (job === undefined) return 'idle'
  deps.control.stop = false
  const result = await runRedditRead(job, {
    fetch: deps.readFetch(),
    sleep: deps.sleep,
    stopped: () => deps.control.stop,
    ...(deps.gapMs === undefined ? {} : { gapMs: deps.gapMs }),
  })
  await redditResult(client, job.id, result)
  await patchStatus(deps.store, {
    ...(result.user === undefined ? {} : { user: result.user }),
    last_result: {
      outcome: result.outcome,
      message: result.message,
      items: result.parts.reduce((n, p) => n + p.items.length, 0),
      at: deps.now(),
    },
  })
  return 'ran'
}
