/**
 * WP459（决策 1497–1505）：收件箱的数据与几样小算法——一份请求（`GET /v1/inbox`）给列表、一张一张、
 * 第三栏、左栏徽标、首页那一行共用；批 / 改 / 不要走岗位卡片流同一条决定（`decide`），批完把
 * 收件箱、岗位牌堆、首页、左栏的数一起刷新（「批了两边一起消失」）。
 */
import {
  INBOX_PRESENCE_BEAT_MS,
  type InboxViewer,
  isFollowUpNudgePayload,
} from '@agentsws/contracts'
import type { DeckCard, InboxItem, InboxPosition, InboxScope, InboxView } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { type DecideInput, decide, getInbox, inboxPresence } from '@/lib/api'

export const INBOX_QUERY = ['inbox'] as const

/** 一个小的内存仓（同一时间一个值；收件箱页、第三栏、一张一张共用）。 */
function memoryStore<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  const subscribe = (l: () => void): (() => void) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
  return {
    get: (): T => state,
    set(next: T): void {
      if (Object.is(next, state)) return
      state = next
      for (const l of listeners) l()
    },
    use: (): T =>
      useSyncExternalStore(
        subscribe,
        () => state,
        () => state,
      ),
  }
}

/* ── WP510（决策 1515）：「给我的 / 全部」（只在 ② / ③；跟着地址 `?scope=all`，收件箱页写进来） ── */

const scopeStore = memoryStore<InboxScope>('mine')

export function setInboxScope(next: InboxScope): void {
  scopeStore.set(next)
}

export function useInboxScope(): InboxScope {
  return scopeStore.use()
}

/**
 * 收件箱那一份（左栏徽标、首页那一行也读它；一分钟内不重复取）。
 * WP510：`scope` 不给 = 收件箱页现在选的那一格；左栏、首页一律传 `'mine'`（数的是给我的）。
 * ① 个人里永远是 `mine`，请求与以前一字不差。
 */
export function useInbox(enabled = true, scope?: InboxScope) {
  const current = useInboxScope()
  const s = scope ?? current
  return useQuery<InboxView>({
    queryKey: s === 'all' ? [...INBOX_QUERY, 'all'] : INBOX_QUERY,
    queryFn: () => (s === 'all' ? getInbox({ scope: 'all' }) : getInbox()),
    enabled,
    retry: false,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })
}

/* ── WP510：「谁在看」——我现在看着哪一件（第三栏开着的 / 一张一张当前那张），别人看着哪几件 ── */

const lookingStore = memoryStore<string | null>(null)
const viewersStore = memoryStore<Record<string, InboxViewer[]>>({})

/** 我现在看着哪一件（`null` = 哪件都没看）。 */
export function setInboxLooking(id: string | null): void {
  lookingStore.set(id)
}

/** 这一件有哪几位同事正看着（不含自己；① 永远是空的）。 */
export function useInboxViewers(id: string | undefined): InboxViewer[] {
  const all = viewersStore.use()
  return id === undefined ? NONE : (all[id] ?? NONE)
}
const NONE: InboxViewer[] = []

/**
 * 心跳：开着就 5 秒一跳（「我看着哪一件」），回来的别人那几件放进仓里；换一件立刻跳一下；
 * 关掉（离开收件箱页、或不是 ② / ③）跳一下 `null`，别人那边马上消失。
 */
export function useInboxPresence(enabled: boolean): void {
  const looking = lookingStore.use()
  const ref = useRef(looking)
  ref.current = looking
  useEffect(() => {
    if (!enabled) return
    let live = true
    const beat = (): void => {
      inboxPresence(ref.current)
        .then((v) => {
          if (live) viewersStore.set(v.viewers)
        })
        .catch(() => undefined)
    }
    beat()
    const timer = setInterval(beat, INBOX_PRESENCE_BEAT_MS)
    return () => {
      live = false
      clearInterval(timer)
      viewersStore.set({})
      void inboxPresence(null).catch(() => undefined)
    }
  }, [enabled])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!enabled) return
    inboxPresence(looking)
      .then((v) => {
        viewersStore.set(v.viewers)
      })
      .catch(() => undefined)
  }, [enabled, looking])
}

/** 只给测试用。 */
export function resetInboxTeamState(): void {
  scopeStore.set('mine')
  lookingStore.set(null)
  viewersStore.set({})
}

/** 批了 / 改判了之后：收件箱、岗位牌堆、首页、左栏岗位数、消息页一起刷新。 */
export function useInboxRefresh(): () => void {
  const client = useQueryClient()
  return () => {
    for (const key of [INBOX_QUERY, ['deck'], ['home'], ['positions'], ['messages'], ['approval']])
      void client.invalidateQueries({ queryKey: key })
  }
}

/** 一张卡的决定（同岗位卡片流那一条：`POST /v1/approvals/:id/decide`）。 */
export function useDecideCard(onDone?: (card: DeckCard, body: DecideInput) => void) {
  const refresh = useInboxRefresh()
  return useMutation({
    mutationFn: (input: { card: DeckCard; body: DecideInput }) =>
      decide(input.card.id, input.body, input.card.position_id),
    onSuccess: (_out, input) => {
      onDone?.(input.card, input.body)
    },
    onSettled: refresh,
  })
}

/** 岗位的名字（下拉、行尾「客服 · 08:12」）。 */
export function positionLabel(
  positions: readonly InboxPosition[] | undefined,
  id: string | undefined,
  lang: string,
): string | undefined {
  if (id === undefined) return undefined
  const p = positions?.find((x) => x.id === id)
  if (p === undefined) return id
  return lang === 'en' ? p.name_en : p.name_zh
}

/** 一行的标题（卡 = 卡的标题；信 = 发件人）。 */
export function itemTitle(item: InboxItem): string {
  if (item.card !== undefined) return item.card.title
  const m = item.mail
  if (m === undefined) return ''
  return m.from.name ?? m.from.email
}

/** 一行的第二行（卡 = AI 写的一句；信 = AI 摘要，没有就主题）。 */
export function itemLine(item: InboxItem): string {
  if (item.card !== undefined) return item.card.summary
  const m = item.mail
  if (m === undefined) return ''
  return m.summary ?? m.subject
}

/** 「08:12」「昨天」「10-19」（行尾那一格；今天的写钟点）。 */
export function shortTime(iso: string, now = Date.now(), lang = 'zh'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date(now)
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const y = new Date(now - 86_400_000)
  if (d.toDateString() === y.toDateString()) return lang === 'en' ? 'Yesterday' : '昨天'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 卡上那句可以直接改的草稿（`payload.body.text`：客服回信、催一下、规则起草的回信）。 */
export function draftOf(card: DeckCard): { text: string; subject?: string } | undefined {
  const p = card.detail.payload
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return undefined
  const body = (p as Record<string, unknown>).body
  if (typeof body !== 'object' || body === null) return undefined
  const text = (body as Record<string, unknown>).text
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const subject = (body as Record<string, unknown>).subject
  return typeof subject === 'string' ? { text, subject } : { text }
}

/** 草稿改过之后批的那一份（`approve` + `edited_payload`，和催促卡就地改同一个口径）。 */
export function editedPayload(card: DeckCard, text: string): unknown {
  const p = card.detail.payload as Record<string, unknown>
  const body = p.body as Record<string, unknown>
  return { ...p, body: { ...body, text } }
}

/** 原信（回信卡上客户写的那一封）：投影层给的原文，退回载荷里的引用。 */
export function originalOf(card: DeckCard): string | undefined {
  // 催一下：「原信」是我们上一封（对方没回的那封），不是草稿本身
  if (isFollowUpNudgePayload(card.detail.payload)) return card.detail.payload.quote
  const o = card.content_variants.original
  if (o !== undefined && o.trim() !== '') return o
  const p = card.detail.payload as Record<string, unknown> | undefined
  const q = p?.quote ?? p?.original
  return typeof q === 'string' && q.trim() !== '' ? q : undefined
}

/** 「去发」：插件「等你发」那一条在网页上的地址（插件靠它找到回复框）。 */
export function postLinkOf(card: DeckCard): string | undefined {
  const p = card.detail.payload as Record<string, unknown> | undefined
  const r = p?.reddit as Record<string, unknown> | undefined
  if (r === undefined) return undefined
  const link = r.permalink
  if (typeof link === 'string' && link !== '')
    return link.startsWith('http') ? link : `https://www.reddit.com${link}`
  const sub = r.subreddit
  return typeof sub === 'string' && sub !== '' ? `https://www.reddit.com/r/${sub}/` : undefined
}

/** 卡等了多久（要紧那一组的药丸「等了 5 小时」）。 */
export function waitedHours(card: DeckCard, now = Date.now()): number {
  const at = Date.parse(card.detail.created_at)
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 3_600_000)) : 0
}

/* ── 第三栏开的是哪一件（只在内存里；同一时间一件） ─────────────────────── */

export type InboxOpen =
  | { kind: 'item'; id: string; edit?: boolean }
  | { kind: 'guessed'; message_id?: string | undefined }
  | null

let openState: InboxOpen = null
const listeners = new Set<() => void>()

export function setInboxOpen(next: InboxOpen): void {
  openState = next
  for (const l of listeners) l()
}

export function useInboxOpen(): InboxOpen {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => openState,
    () => openState,
  )
}

/** 只给测试用。 */
export function resetInboxOpen(): void {
  openState = null
}

/* ── 底下那一句话（第三栏开在外壳里时，那一句也回到收件箱页的提示条） ─────────── */

export interface InboxNoticeMsg {
  tone: 'ok' | 'warn' | 'error'
  text: string
  undo?: (() => void) | undefined
}

let noticeState: InboxNoticeMsg | undefined
const noticeListeners = new Set<() => void>()

export function pushInboxNotice(next: InboxNoticeMsg | undefined): void {
  noticeState = next
  for (const l of noticeListeners) l()
}

export function useInboxNotice(): InboxNoticeMsg | undefined {
  return useSyncExternalStore(
    (l) => {
      noticeListeners.add(l)
      return () => {
        noticeListeners.delete(l)
      }
    },
    () => noticeState,
    () => noticeState,
  )
}
