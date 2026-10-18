/**
 * WP413：侧边栏在后台（service worker）那一半——**还是只有后台能打本机**（WP119 定论 2）：
 * 侧边栏页面发消息过来，这里带着令牌去问 / 去做，回一句侧边栏能直接画的话。
 *
 * - 没配对 → `unpaired`（侧边栏就地给配对码框）；
 * - 工坊没开 → `offline`；令牌不认 → `unauthorized`（去重新配对）；
 * - 「填进页面」成功 → 马上让动作通道去领（不等每分钟那一拍），新开的 Reddit 标签页里填好草稿、等人点。
 */
import type { PanelFillInput, PanelSnapshot, PanelWrite } from '@agentsws/browser-action'
import type { PermissionsLike } from '../ads/permissions'
import { panelFill, panelRefill, panelSkip, panelSnapshot } from '../local-client'
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
}

export interface PanelBrokerDeps {
  store: KeyValueStore
  perms: PermissionsLike
  fetch?: typeof globalThis.fetch | undefined
  /** 让动作通道马上去领一次（填进页面 / 再填一次之后）。 */
  pollNow(): void
}

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
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  const got = await panelFill(c, id, input)
  if (!got.ok) return { ok: false, message: got.message }
  if (!got.data.ok) return { ok: false, message: got.data.message }
  deps.pollNow()
  return {
    ok: true,
    ...(got.data.write === undefined ? {} : { write: got.data.write }),
    ...(got.data.message === undefined ? {} : { message: got.data.message }),
  }
}

export async function panelSkipCard(
  deps: PanelBrokerDeps,
  id: string,
  version: number | undefined,
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  const got = await panelSkip(c, id, version === undefined ? {} : { version })
  return got.ok ? { ok: true } : { ok: false, message: got.message }
}

export async function panelRefillWrite(
  deps: PanelBrokerDeps,
  job: string,
): Promise<PanelActOutcome> {
  const c = await client(deps)
  if (c === undefined) return { ok: false, message: NOT_PAIRED }
  const got = await panelRefill(c, job)
  if (!got.ok) return { ok: false, message: got.message }
  if (!got.data.ok) return { ok: false, message: got.data.message }
  deps.pollNow()
  return { ok: true, ...(got.data.write === undefined ? {} : { write: got.data.write }) }
}
