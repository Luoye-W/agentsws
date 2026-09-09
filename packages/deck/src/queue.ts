/**
 * 队列的四条规则：排序、合并、筛选、内容语言（37 §1 末段 + 对照表第 2 / 4 / 10 行）。
 *
 * 全是纯函数，因为它们是**可以直接断言的判断**：一张卡排在哪、跟谁并成一张、
 * 筛不筛得掉、卡面上显示哪种语言——每一条都不该藏在 React 组件里靠截图验收。
 */
import type {
  DeckCard,
  DeckContentMode,
  DeckContentVariants,
  DeckFilterResult,
  DeckFilters,
  DeckWaiting,
  PriorityBand,
} from './types.js'

// ── 排序（KefuAgent `compareInboxQueueCards`） ─────────────────────────

const BAND_ORDER: Record<PriorityBand, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** 14 §2 的三档优先级，数字越大越靠前（与 KefuAgent 的 `priority DESC` 同义）。 */
const PRIORITY_RANK: Record<DeckCard['priority'], number> = {
  immediate: 2,
  queue: 1,
  digest: 0,
}

/**
 * `priority_band → expires_at (nulls last) → priority → created_at → id`。
 *
 * 期限用**比较**而不是相减：两张都没期限时两边都是 `Infinity`，`Infinity - Infinity`
 * 是 `NaN`，`Array.sort` 会当成「没意见」，同一批数据在两次渲染里就能排出两个顺序。
 * 末尾按 id 兜底，保证是全序——队列不许在两帧之间抖。
 */
export function compareCards(a: DeckCard, b: DeckCard): number {
  const band = BAND_ORDER[a.priority_band] - BAND_ORDER[b.priority_band]
  if (band !== 0) return band

  const ea = deadlineRank(a)
  const eb = deadlineRank(b)
  if (ea !== eb) return ea < eb ? -1 : 1

  const pr = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
  if (pr !== 0) return pr

  const ca = Date.parse(a.detail.created_at)
  const cb = Date.parse(b.detail.created_at)
  if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca - cb

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function deadlineRank(card: DeckCard): number {
  if (card.expires_at === undefined) return Number.POSITIVE_INFINITY
  const at = Date.parse(card.expires_at)
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
}

export function sortCards(cards: DeckCard[]): DeckCard[] {
  return [...cards].sort(compareCards)
}

// ── 等待态 ─────────────────────────────────────────────────────────────

/**
 * 「客户在等」= P0。
 *
 * P0 的定义里已经含了「有人正对着屏幕等」（14 §8 的 immediate / 4 小时内到期），
 * 所以这里不另造一个判据——两处判据一旦分家，筛选出来的张数就会跟档位对不上。
 */
export function isCustomerWaiting(card: DeckCard): boolean {
  return card.priority_band === 'P0'
}

export function isNobodyWaiting(card: DeckCard): boolean {
  return card.priority_band === 'P3'
}

export function waitingOf(card: DeckCard): DeckWaiting | undefined {
  if (isCustomerWaiting(card)) return 'customer_waiting'
  if (isNobodyWaiting(card)) return 'nobody_waiting'
  return undefined
}

// ── 合并（KefuAgent `deckCardMergeKey` / `foldInboxQueueGroups`） ───────

/**
 * 合并键 = **去重族 × 卡型 × 渠道**。
 *
 * 去重族取 `dedupe_key` 的第一段（14 §4 的去重键本来就是 `family:scope:…` 这个形状），
 * 不另外从标题哈希出第二个键——那样合出来的组里会混进去重早就判为重复的卡。
 */
export function mergeKeyOf(card: DeckCard): string {
  const family = card.dedupe_key.split(':')[0] ?? card.dedupe_key
  return `${family}|${card.kind}|${card.channel ?? 'none'}`
}

/**
 * P0 永不合并。
 *
 * 把 N 个正在等的客户折成一张，就把 N-1 个倒计时藏了起来——而倒计时正是 P0 存在的
 * 全部理由。P0 以下（知识候选、同族草稿）才是「一次清一摞」想要的那种情况。
 */
export function isMergeable(card: DeckCard): boolean {
  return !isCustomerWaiting(card)
}

/**
 * 同类合并成一张：代表卡带 `merge_count` 与全体成员（各带各的 version）。
 *
 * 代表 = 排序后第一个到达的那张，所以「合并后的顺序」和「不合并的顺序」是同一个
 * 比较器算出来的，不会因为开不开合并而换一套排法。
 */
export function foldCards(cards: DeckCard[]): DeckCard[] {
  const sorted = sortCards(cards)
  const out: DeckCard[] = []
  const byKey = new Map<string, DeckCard>()

  for (const card of sorted) {
    const key = mergeKeyOf(card)
    const rep = isMergeable(card) ? byKey.get(key) : undefined
    if (rep !== undefined) {
      rep.merge_count += 1
      rep.merged = [...(rep.merged ?? []), { id: card.id, version: card.version }]
      continue
    }
    const next: DeckCard = {
      ...card,
      merge_count: 1,
      merged: [{ id: card.id, version: card.version }],
    }
    out.push(next)
    if (isMergeable(card)) byKey.set(key, next)
  }
  return out
}

// ── 筛选（37 §1 末段） ─────────────────────────────────────────────────

function matches(card: DeckCard, f: DeckFilters): boolean {
  if (f.position_id !== undefined && card.position_id !== f.position_id) return false
  if (f.waiting !== undefined && waitingOf(card) !== f.waiting) return false
  if (f.kind !== undefined && card.kind !== f.kind) return false
  if (f.source !== undefined && card.source !== f.source) return false
  return true
}

/**
 * 筛选只改这一副牌的集合，不跳页；计数按**张数**（合并前）。
 *
 * **P0 永不被筛掉**：不匹配当前筛选条件的 P0 不进 `cards`，而是原样回到
 * `pinned_p0` 里，由界面在顶部提示一次。筛掉一个正在等的客户，就是把这套筛选
 * 变成了一个能让人错过 SLA 的开关。
 */
export function filterCards(cards: DeckCard[], filters: DeckFilters = {}): DeckFilterResult {
  const matched: DeckCard[] = []
  const pinned: DeckCard[] = []
  for (const card of cards) {
    if (matches(card, filters)) matched.push(card)
    else if (isCustomerWaiting(card)) pinned.push(card)
  }
  return {
    cards: sortCards(matched),
    pinned_p0: sortCards(pinned),
    counts: {
      total: cards.length,
      customer_waiting: cards.filter(isCustomerWaiting).length,
      nobody_waiting: cards.filter(isNobodyWaiting).length,
      matched: matched.length,
    },
  }
}

// ── 内容语言（37 §1 第 4 行） ──────────────────────────────────────────

export const CONTENT_MODES: readonly DeckContentMode[] = ['zh_summary', 'original', 'en']

export interface PickedContent {
  text: string
  /** 实际显示的那一种（回退后是 `zh_summary`） */
  mode: DeckContentMode
  /** 想看的那种没有，回退了——界面上出一行琥珀小字 */
  fell_back: boolean
}

/**
 * 一次只给一种语言，**禁双语堆叠**。
 *
 * 想看的那种缺席就回退中文摘要并把 `fell_back` 立起来：把两种语言一起印上去，
 * 卡面立刻变两倍高，一次一张的前提就没了。
 */
export function pickContent(variants: DeckContentVariants, mode: DeckContentMode): PickedContent {
  const wanted = mode === 'zh_summary' ? variants.zh_summary : variants[mode]
  if (wanted !== undefined && wanted.trim() !== '') return { text: wanted, mode, fell_back: false }
  return { text: variants.zh_summary, mode: 'zh_summary', fell_back: true }
}
