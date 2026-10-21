/**
 * WP432（Luoye 10-20 反馈 9）：**等你发**——批过的 Reddit 回复 / 帖子（和交给你发的社媒帖子）在插件图标上出数字，
 * 新来的弹一句系统通知（工坊设置 → 通知「等你发」那一类的「系统」开关关了就不弹）。
 *
 * 还是插件主动问本机（每分钟一次、侧边栏开着时每次刷新）：本机服务永远不伸手进浏览器。
 * 第一次看到时不一口气弹一串（只记下来）；同一条只弹一次。
 */
import type { PanelSnapshot } from '@agentsws/browser-action'
import { type ActionBadgePort, newWaiting, syncBadge } from './badge'
import { panelSnapshot } from './local-client'
import type { KeyValueStore } from './storage'
import { readSettings } from './storage'

export const WAITING_SEEN_KEY = 'agentsws.waiting.seen'

/** 一条等你发的（图标数字、通知用）。 */
export interface WaitingItem {
  id: string
  label: string
}

/**
 * 快照里等你发的那几条：WP445 起 AI 起草的 Reddit 回帖 / 发帖直接进插件（还没批的卡，`c:`）+ 主管批过、
 * 等你打开的（`w:`）+ 交给你发的社媒帖子（`p:`）。同一张卡只算一条。
 */
export function waitingOf(snap: PanelSnapshot): WaitingItem[] {
  const cards = snap.cards.map((c) => ({ id: `c:${c.id}`, label: c.title }))
  const cardIds = new Set(snap.cards.map((c) => c.id))
  const writes = snap.writes
    .filter((w) => w.state === 'awaiting' && !cardIds.has(w.approval_item_id))
    .map((w) => ({ id: `w:${w.job_id}`, label: w.label ?? `r/${w.subreddit}` }))
  const posts = (snap.posts ?? []).map((p) => ({
    id: `p:${p.id}`,
    label: `${p.channel_label}：${p.body.slice(0, 40)}`,
  }))
  return [...cards, ...writes, ...posts]
}

export interface WaitingDeps {
  store: KeyValueStore
  fetch?: typeof globalThis.fetch | undefined
  action: ActionBadgePort
  /** 弹一句系统通知（`chrome.notifications`；测试里记下来）。 */
  notify(item: WaitingItem, total: number): void
}

/** 一次刷新：数字跟着走，新来的弹一句。回现在等你发的那几条（没配对 / 本机没开回 `undefined`）。 */
export async function refreshWaiting(
  deps: WaitingDeps,
  snap?: PanelSnapshot,
): Promise<WaitingItem[] | undefined> {
  const s = await readSettings(deps.store)
  if (s.token === undefined) {
    await syncBadge(deps.action, { paired: false, waiting: 0 })
    return undefined
  }
  let got = snap
  if (got === undefined) {
    const res = await panelSnapshot({
      port: s.port,
      token: s.token,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    })
    // 本机没开：数字留着上次的（图标不闪），不弹
    if (!res.ok) return undefined
    got = res.data
  }
  const items = waitingOf(got)
  await syncBadge(deps.action, { paired: true, waiting: items.length })
  const raw = (await deps.store.get([WAITING_SEEN_KEY]))[WAITING_SEEN_KEY]
  const seen = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string')
    : undefined
  const { fresh, remember } = newWaiting(seen, items)
  await deps.store.set({ [WAITING_SEEN_KEY]: remember })
  if (got.notify_system !== false)
    for (const item of fresh.slice(0, 3)) deps.notify(item, items.length)
  return items
}
