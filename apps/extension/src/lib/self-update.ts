/**
 * WP345（决策 871）：**插件跟着工坊一起更新**——插件这一半。
 *
 * 工坊每次启动把安装包里的插件放到固定文件夹（就是用户「加载已解压」选的那一个）。插件每分钟问一次本机
 * （`POST /v1/extension/version`：报自己正在跑的版本，回文件夹里是哪一版）：
 *
 * - 一样：什么都不做；
 * - 不一样：先关闸（{@link holdActions}：广告 / Reddit 不再领新活），等手上那一件做完、挂着的长轮询回来，
 *   再 `chrome.runtime.reload()`——Chrome 从同一个文件夹读新文件；id 固定（manifest `key`），
 *   配对令牌、`chrome.storage`、已授的可选权限都在；
 * - 重载后第一次问的时候带上「从哪版换来」，本机记一条事件；
 * - 重载了还是旧版（多半是从别的文件夹加载的）：带上「放弃了」，**这一版不再重试**（不然每分钟重载一次），
 *   工作台的连接卡照实说一句。
 *
 * WP432：**没配对也问**（`POST /v1/extension/version/probe`，不带令牌、只回版本号）——10-20 Windows 上那个
 * 插件一直是旧版、点了没反应，没配上的插件以前从不来问，就一直不换。没配对时只是不报「从哪版换来」。
 * 本机没开 / 老版本本机服务（没有这条路由）：什么都不做。
 */

import { actionsBusy, holdActions } from './idle-gate'
import { probeVersion, reportVersion } from './local-client'
import type { KeyValueStore } from './storage'
import { readSettings } from './storage'

export const UPDATE_KEY = 'agentsws.update'

interface UpdateState {
  /** 重载前写下：从哪一版、要换成哪一版。 */
  reloading?: { from: string; to: string; at: string }
  /** 为这一版重载过、没换成，不再重试。 */
  gave_up?: string
}

async function readState(store: KeyValueStore): Promise<UpdateState> {
  const raw = (await store.get([UPDATE_KEY]))[UPDATE_KEY]
  return typeof raw === 'object' && raw !== null ? (raw as UpdateState) : {}
}

export interface SelfUpdateDeps {
  store: KeyValueStore
  fetch?: typeof globalThis.fetch | undefined
  /** 正在跑的版本（`version_name` 优先）。 */
  running: string
  reload(): void
  now(): string
  sleep(ms: number): Promise<void>
  /** 等空闲最多等多久（默认 40 秒：长轮询最多挂 25 秒）。等不到就下一分钟再试。 */
  maxWaitMs?: number
}

export type SelfUpdateOutcome =
  | 'unpaired'
  | 'offline'
  | 'same'
  | 'gave_up'
  | 'waiting'
  | 'reloading'

/** 正在跑的版本：`version_name`（带 beta 号的完整那串）优先。 */
export function runningVersion(manifest: {
  version: string
  version_name?: string | undefined
}): string {
  return manifest.version_name !== undefined && manifest.version_name !== ''
    ? manifest.version_name
    : manifest.version
}

let checking = false

/** 问一次（定时器每分钟、service worker 起来时各叫一次）。同一时刻只跑一个。 */
export async function checkForUpdate(deps: SelfUpdateDeps): Promise<SelfUpdateOutcome> {
  if (checking) return 'waiting'
  checking = true
  try {
    return await check(deps)
  } finally {
    checking = false
  }
}

async function check(deps: SelfUpdateDeps): Promise<SelfUpdateOutcome> {
  const settings = await readSettings(deps.store)
  const state = await readState(deps.store)
  if (settings.token === undefined) return checkUnpaired(deps, settings.port, state)
  const input: { version: string; reloaded_from?: string; gave_up?: string } = {
    version: deps.running,
  }
  if (state.reloading !== undefined) {
    if (state.reloading.from !== deps.running) input.reloaded_from = state.reloading.from
    else input.gave_up = state.reloading.to
  } else if (state.gave_up !== undefined) input.gave_up = state.gave_up

  const got = await reportVersion(
    {
      port: settings.port,
      token: settings.token,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    },
    input,
  )
  // 连不上 / 不认：记录留着（重载前写的那一笔下次再报）
  if (!got.ok) return 'offline'

  const next: UpdateState = {}
  const gaveUp = input.gave_up
  if (gaveUp !== undefined) next.gave_up = gaveUp
  const folder = got.data.folder_version
  if (folder === undefined || folder === deps.running) {
    holdActions(false)
    await deps.store.set({ [UPDATE_KEY]: {} })
    return 'same'
  }
  if (gaveUp === folder) {
    holdActions(false)
    await deps.store.set({ [UPDATE_KEY]: next })
    return 'gave_up'
  }

  // 要换：先关闸，等手上的做完（等的时候碰一下扩展接口：service worker 别被当成闲着回收）
  return reloadInto(deps, folder, next)
}

/** 关闸、等手上的做完，写下「从哪版换到哪版」，重载。等不到就下一分钟再试。 */
async function reloadInto(
  deps: SelfUpdateDeps,
  folder: string,
  next: UpdateState,
): Promise<SelfUpdateOutcome> {
  holdActions(true)
  const max = deps.maxWaitMs ?? 40_000
  for (let waited = 0; actionsBusy(); waited += 1000) {
    if (waited >= max) {
      await deps.store.set({ [UPDATE_KEY]: next })
      return 'waiting'
    }
    await deps.sleep(1000)
    await deps.store.get([UPDATE_KEY])
  }
  await deps.store.set({
    [UPDATE_KEY]: { reloading: { from: deps.running, to: folder, at: deps.now() } },
  })
  deps.reload()
  return 'reloading'
}

/**
 * WP432：没配对的插件也跟着工坊换新版（只问版本号，不报别的）。一样 / 本机没开 → `unpaired`；
 * 重载过一次还是旧版（多半从别的文件夹加载）→ 这一版不再重试。
 */
async function checkUnpaired(
  deps: SelfUpdateDeps,
  port: number,
  state: UpdateState,
): Promise<SelfUpdateOutcome> {
  let gaveUp = state.gave_up
  if (state.reloading !== undefined && state.reloading.from === deps.running)
    gaveUp = state.reloading.to
  const got = await probeVersion(
    { port, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) },
    deps.running,
  )
  const folder = got.ok ? got.data.folder_version : undefined
  const next: UpdateState = gaveUp === undefined ? {} : { gave_up: gaveUp }
  if (folder === undefined || folder === deps.running) {
    holdActions(false)
    if (got.ok) await deps.store.set({ [UPDATE_KEY]: {} })
    return 'unpaired'
  }
  if (gaveUp === folder) {
    await deps.store.set({ [UPDATE_KEY]: next })
    return 'gave_up'
  }
  return reloadInto(deps, folder, next)
}
