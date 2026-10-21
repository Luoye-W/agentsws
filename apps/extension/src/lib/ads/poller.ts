/**
 * 领活（决策 558）：**只在电脑与 Chrome 开着时执行**——插件定时去问本机「有没有批好的活」。
 *
 * - 没配对 / 一家后台都没连 → 不问；
 * - 一次只跑一件（整个插件一件；同一账户一次一件在本机服务那边另有一道）；
 * - 问到了就找（或开）一个看得见的广告后台标签页去做；做完接着问，问空了就等下一次定时。
 *
 * 状态写一份在 `chrome.storage.local`（设置页上看得见：上次问是什么时候、哪家还没同意、在做什么）。
 */

import type { ActionJob, ActionPlatform, AdsAccountHint } from '@agentsws/browser-action'
import { actionsHeld, registerBusy } from '../idle-gate'
import { actionResult, actionsNext } from '../local-client'
import type { KeyValueStore } from '../storage'
import { readSettings } from '../storage'
import { executeJob, type RunControl } from './executor'
import { connectedPlatforms, type PermissionsLike } from './permissions'
import type { TabDriver } from './tab-page'

export const ADS_STATUS_KEY = 'agentsws.ads.status'

export interface AdsStatus {
  last_poll_at?: string
  /** 一句人话（连不上 / 要重新配对 / 哪家还没同意）。 */
  note?: string
  needs_consent?: ActionPlatform[]
  running?: { title: string }
  last_result?: { title: string; outcome: string; message: string; at: string }
}

export async function readAdsStatus(store: KeyValueStore): Promise<AdsStatus> {
  const raw = (await store.get([ADS_STATUS_KEY]))[ADS_STATUS_KEY]
  return typeof raw === 'object' && raw !== null ? (raw as AdsStatus) : {}
}

/** 给 `undefined` 的那一格是「删掉」。 */
type StatusPatch = { [K in keyof AdsStatus]?: AdsStatus[K] | undefined }

async function writeAdsStatus(store: KeyValueStore, patch: StatusPatch): Promise<void> {
  const current = await readAdsStatus(store)
  const next = { ...current, ...patch } as StatusPatch
  for (const k of Object.keys(patch) as (keyof AdsStatus)[])
    if (patch[k] === undefined) delete next[k]
  await store.set({ [ADS_STATUS_KEY]: next as AdsStatus })
}

export interface PollerDeps {
  store: KeyValueStore
  perms: PermissionsLike
  fetch?: typeof globalThis.fetch | undefined
  /** WP348：开着的广告后台里认出的账户（领活时顺手报上去；不给就不报）。 */
  seenAccounts?(): Promise<AdsAccountHint[]>
  /** 找（或开）一个看得见的广告后台标签页。找不到回一句人话。 */
  openTab(job: ActionJob): Promise<TabDriver | { why: string }>
  control: RunControl
  now(): string
  sleep(ms: number): Promise<void>
  /** 长轮询挂几秒（测试给 0）。 */
  waitSeconds?: number
  /** 一轮最多连着做几件（防止一直占着）。 */
  maxJobs?: number
  gapMs?: number
}

export type PollOutcome =
  | 'busy'
  | 'unpaired'
  | 'no_platform'
  | 'offline'
  | 'refused'
  | 'idle'
  | 'ran'
  /** WP345：要重载了，这一轮不领新活。 */
  | 'held'

/** WP432：定时领活领到了 Reddit 的写（老本机服务）——不开页面，交回去这一句。 */
export const REDDIT_NOT_AUTO =
  '插件不自己开 Reddit 页面：在插件侧边栏里点「打开这一条」，填好后由你自己点发送。'

let running = false
// WP345：重载前等它空下来（正在挂着的长轮询、正在做的那一件）
registerBusy('ads', () => running)

/** 问一轮（定时器每分钟叫一次；正在做就直接回 busy）。 */
export async function pollAdsOnce(deps: PollerDeps): Promise<PollOutcome> {
  if (running) return 'busy'
  if (actionsHeld()) return 'held'
  running = true
  try {
    return await pollLoop(deps)
  } finally {
    running = false
  }
}

async function pollLoop(deps: PollerDeps): Promise<PollOutcome> {
  const settings = await readSettings(deps.store)
  if (settings.token === undefined) return 'unpaired'
  const platforms = await connectedPlatforms(deps.perms)
  if (platforms.length === 0) return 'no_platform'
  const client = {
    port: settings.port,
    token: settings.token,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  }
  let ran = 0
  // WP348：只报连上了的那几家后台里认出的账户
  const seen = ((await deps.seenAccounts?.().catch(() => [])) ?? []).filter((h) =>
    platforms.includes(h.platform),
  )
  for (;;) {
    // WP345：要重载了——做完的这件算数，不再领下一件
    if (actionsHeld()) return ran > 0 ? 'ran' : 'held'
    const got = await actionsNext(client, platforms, deps.waitSeconds, seen)
    if (!got.ok) {
      await writeAdsStatus(deps.store, { last_poll_at: deps.now(), note: got.message })
      return got.kind === 'offline' ? 'offline' : 'refused'
    }
    await writeAdsStatus(deps.store, {
      last_poll_at: deps.now(),
      note: undefined,
      needs_consent: got.data.needs_consent,
    })
    const job = got.data.job
    if (job === undefined) return ran > 0 ? 'ran' : 'idle'
    /*
     * WP432（Luoye 10-20 反馈 9）：Reddit 的写**插件绝不自己开页面**——只在人点侧边栏「打开这一条」时开。
     * 本机服务本来就不会从这条路交出来（排队里那一道底）；万一交出来了（老的本机服务），不开、照实交回去。
     */
    if (job.plan.platform === 'reddit') {
      await actionResult(client, job.id, {
        outcome: 'handover',
        message: REDDIT_NOT_AUTO,
        step: 0,
        reads: {},
      })
      ran += 1
      continue
    }

    deps.control.stop = false
    deps.control.answer = undefined
    await writeAdsStatus(deps.store, { running: { title: job.title } })
    const tab = await deps.openTab(job)
    const result =
      'why' in tab
        ? { outcome: 'handover' as const, message: tab.why, step: 0, reads: {} }
        : await executeJob(job, {
            client,
            driver: tab,
            control: deps.control,
            now: deps.now,
            sleep: deps.sleep,
            ...(deps.gapMs === undefined ? {} : { gapMs: deps.gapMs }),
          })
    if ('why' in tab) await actionResult(client, job.id, result)
    await writeAdsStatus(deps.store, {
      running: undefined,
      last_result: {
        title: job.title,
        outcome: result.outcome,
        message: result.message,
        at: deps.now(),
      },
    })
    ran += 1
    if (ran >= (deps.maxJobs ?? 5)) return 'ran'
  }
}
