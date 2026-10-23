/**
 * WP413：侧边栏在后台（service worker）那一半——**还是只有后台能打本机**（WP119 定论 2）：
 * 侧边栏页面发消息过来，这里带着令牌去问 / 去做，回一句侧边栏能直接画的话。
 *
 * - 没配对 → `unpaired`（侧边栏就地给配对码框）；
 * - 工坊没开 → `offline`；令牌不认 → `unauthorized`（去重新配对）；
 * - WP432：**插件不自己开页面**——批过的那一条只在人点「打开这一条」（或在这里批卡时点「打开填好」）时，
 *   才从本机拿到那一件活、在侧边栏所在的窗口新开标签页、填好、等人点发送。同一时刻只开一条。
 */
import type {
  ActionJob,
  PanelFillInput,
  PanelOpenInput,
  PanelSnapshot,
  PanelWrite,
} from '@agentsws/browser-action'
import type { PermissionsLike } from '../ads/permissions'
import { actionsHeld } from '../idle-gate'
import {
  panelDrop,
  panelFill,
  panelFollowUndo,
  panelOpen,
  panelPostAnswer,
  panelRefill,
  panelSkip,
  panelSnapshot,
} from '../local-client'
import { redditConnected } from '../reddit/permissions'
import type { KeyValueStore } from '../storage'
import { readSettings } from '../storage'

export type PanelState =
  | { kind: 'unpaired' }
  | { kind: 'offline'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'ok'
      snapshot: PanelSnapshot
      /** 这个 Chrome 里给了 Reddit 的站点权限没有（没给，填不进页面）。 */
      reddit_here: boolean
    }

/** 卡上一个动作的结局（侧边栏照实印出来）。 */
export interface PanelActOutcome {
  ok: boolean
  message?: string
  write?: PanelWrite
  /** WP445：「不发 + 理由」时同类的也一并不发了的那几张（能撤回）。 */
  followed?: { leader_id: string; ids: string[]; titles: string[] }
}

export interface PanelBrokerDeps {
  store: KeyValueStore
  perms: PermissionsLike
  fetch?: typeof globalThis.fetch | undefined
  /** 让动作通道马上去领一次（广告那边；Reddit 的写不走它）。 */
  pollNow(): void
  /**
   * WP432：人点了「打开这一条」、本机交出了那一件——在这个窗口新开标签页、填好、等人点发送（不等它做完就回）。
   * 不给 = 这个插件开不了（只在测试里）。
   */
  runJob?(job: ActionJob, windowId: number | undefined): Promise<{ ok: boolean; message?: string }>
  /** WP432：正在开着的那一条还没完（同一时刻只开一条）。 */
  busy?(): boolean
}

export const ONE_AT_A_TIME = '上一条还开着：在那个标签页里发出去（或点横条上的停止）再开这一条。'
export const UPDATING = '插件正在更新，过几秒再点。'

async function client(deps: PanelBrokerDeps) {
  const s = await readSettings(deps.store)
  if (s.token === undefined) return undefined
  return {
    port: s.port,
    token: s.token,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  }
}

export async function panelState(deps: PanelBrokerDeps): Promise<PanelState> {
  const c = await client(deps)
  if (c === undefined) return { kind: 'unpaired' }
  const [got, here] = await Promise.all([
    panelSnapshot(c),
    redditConnected(deps.perms).catch(() => false),
  ])
  if (got.ok) return { kind: 'ok', snapshot: got.data, reddit_here: here }
  return { kind: got.kind, message: got.message }
}

const NOT_PAIRED = '还没配对。'

export async function panelFillCard(
  deps: PanelBrokerDeps,
  id: string,
  input: PanelFillInput,
  windowId?: number,
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  // 批了马上就开：开不了的先说（不然批了却开不了）
  if (deps.busy?.() === true) return { ok: false, message: ONE_AT_A_TIME }
  const got = await panelFill(c, id, input)
  if (!got.ok) return { ok: false, message: got.message }
  if (!got.data.ok) return { ok: false, message: got.data.message }
  const write = got.data.write
  // WP432：在这里批 + 点「打开填好」是人这一下点的——批完就开（不等取消窗口、不等定时）
  if (write?.state === 'awaiting') return panelOpenWrite(deps, write.job_id, {}, windowId)
  return {
    ok: true,
    ...(write === undefined ? {} : { write }),
    ...(got.data.message === undefined ? {} : { message: got.data.message }),
  }
}

/**
 * WP432：「打开这一条」——人点的这一下，从本机拿那一件活（改过就带改过的字），在这个窗口新开标签页填好。
 */
export async function panelOpenWrite(
  deps: PanelBrokerDeps,
  job: string,
  input: PanelOpenInput,
  windowId: number | undefined,
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  if (deps.runJob === undefined)
    return { ok: false, message: '这个插件版本开不了，重新加载一下插件。' }
  if (actionsHeld()) return { ok: false, message: UPDATING }
  if (deps.busy?.() === true) return { ok: false, message: ONE_AT_A_TIME }
  const got = await panelOpen(c, job, input)
  if (!got.ok) return { ok: false, message: got.message }
  if (!got.data.ok) return { ok: false, message: got.data.message }
  const ran = await deps.runJob(got.data.job, windowId)
  if (!ran.ok) return { ok: false, message: ran.message ?? '没能打开那个标签页。' }
  return { ok: true, ...(got.data.write === undefined ? {} : { write: got.data.write }) }
}

/** WP432：「不发了」。 */
export async function panelDropWrite(
  deps: PanelBrokerDeps,
  job: string,
  reason?: string,
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  const got = await panelDrop(c, job, reason)
  return got.ok ? { ok: true } : { ok: false, message: got.message }
}

/** 「不发」：理由可选；WP445：写了理由，同类的可能一并不发了（回执里带回来，能撤回）。 */
export async function panelSkipCard(
  deps: PanelBrokerDeps,
  id: string,
  version: number | undefined,
  reason?: string,
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  const r = reason?.trim()
  const got = await panelSkip(c, id, {
    ...(version === undefined ? {} : { version }),
    ...(r === undefined || r === '' ? {} : { reason: r }),
  })
  if (!got.ok) return { ok: false, message: got.message }
  return { ok: true, ...(got.data.followed === undefined ? {} : { followed: got.data.followed }) }
}

/** WP445：撤回「同类的也一并不发了」那几张。 */
export async function panelUndoFollow(
  deps: PanelBrokerDeps,
  leader: string,
  ids: readonly string[],
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  const got = await panelFollowUndo(c, leader, ids)
  return got.ok ? { ok: true } : { ok: false, message: got.message }
}

/** WP419：交给你发的社媒帖子：发好了（带链接 = 读回确认）/ 不发了。 */
export async function panelAnswerPost(
  deps: PanelBrokerDeps,
  id: string,
  answer: 'done' | 'skip',
  input: { link?: string; reason?: string },
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  const got = await panelPostAnswer(c, id, answer, input)
  return got.ok ? { ok: true } : { ok: false, message: got.message }
}

export async function panelRefillWrite(
  deps: PanelBrokerDeps,
  job: string,
  /** WP478：改过字再填。 */
  text?: string,
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  const got = await panelRefill(c, job, text)
  if (!got.ok) return { ok: false, message: got.message }
  if (!got.data.ok) return { ok: false, message: got.data.message }
  // WP432：再填一次也只是回到「等你打开」（不自己开页面）
  return { ok: true, ...(got.data.write === undefined ? {} : { write: got.data.write }) }
}
