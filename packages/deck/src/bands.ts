/**
 * WP125（72 §1.E / §P0-3 ⑤）：**卡片优先级带的四个名字与分组计数**。
 *
 * `priority_band` 本身早就有了（`project.ts` 的 `priorityBandOf`，由 `priority` +
 * `expires_at` / `due_at` + 风险等级**派生**，`types.ts` 里也只有这一个字段）。
 * 这里补的是它在界面上的那一面：
 *
 * | 带 | 界面上的话 | 什么东西会落在这里 |
 * |---|---|---|
 * | P0 | 客户在等 | 聊天紧急求助、4 小时内到期、`priority: 'immediate'` |
 * | P1 | 待你确认 | 高风险、涉钱、24 小时内到期的回复审批 |
 * | P2 | 需要处理 | 排队的同步异常、额度、需要补素材 |
 * | P3 | 无人等待 | 知识确认、边界选择题——没有任何人对着屏幕等 |
 *
 * **派生不存列**（72 §1.E 原话）。这个文件里没有任何写操作，也没有第二份 band：
 * 分组数与排序键读的是同一个 `card.priority_band`，于是"客户在等 3"与列表里
 * 真的排在最前的那三张，永远是同一批。两处各算一遍就会出现"数字是 3、点开只有 2"。
 */
import type { DeckCard, PriorityBand } from './types.js'

/** 四个带的显示名。**唯一真源**——界面、IM 推送、报告都从这里取。 */
export const BAND_LABELS: Readonly<Record<PriorityBand, string>> = {
  P0: '客户在等',
  P1: '待你确认',
  P2: '需要处理',
  P3: '无人等待',
}

/** 从前到后的顺序（与 `compareCards` 的 `BAND_ORDER` 同一个序）。 */
export const BAND_ORDER: readonly PriorityBand[] = ['P0', 'P1', 'P2', 'P3']

export interface BandGroup {
  band: PriorityBand
  /** 界面上那句话（`BAND_LABELS[band]`）。 */
  label: string
  count: number
  /** 这一带里的卡，已按队列序排好。 */
  cards: DeckCard[]
}

/**
 * 按带分组。**空带也回**（count 0）——岗位页上"客户在等 0"是一句有用的话，
 * 把它整条抽掉会让人以为这一栏坏了。调用方要隐藏空带自己 filter。
 *
 * 组内顺序保持传入顺序：调用方应当先 `sortCards` 再进来，这样分组这一步
 * 不引入第二套排序规则（两套排序 = 两种顺序）。
 */
export function groupByBand(cards: readonly DeckCard[]): BandGroup[] {
  const buckets = new Map<PriorityBand, DeckCard[]>(BAND_ORDER.map((b) => [b, []]))
  for (const card of cards) buckets.get(card.priority_band)?.push(card)
  return BAND_ORDER.map((band) => {
    const rows = buckets.get(band) ?? []
    return { band, label: BAND_LABELS[band], count: rows.length, cards: rows }
  })
}

/** 只要数字那一份（岗位页的分组计数：「客户在等 3 · 待你确认 5 · …」）。 */
export function bandCounts(cards: readonly DeckCard[]): Record<PriorityBand, number> {
  const out: Record<PriorityBand, number> = { P0: 0, P1: 0, P2: 0, P3: 0 }
  for (const card of cards) out[card.priority_band] += 1
  return out
}

/** 一行给人看的话：「客户在等 3 · 待你确认 5」。**零的那几带不出现**（减字）。 */
export function bandSummaryLine(cards: readonly DeckCard[]): string {
  const counts = bandCounts(cards)
  return BAND_ORDER.filter((b) => counts[b] > 0)
    .map((b) => `${BAND_LABELS[b]} ${counts[b]}`)
    .join(' · ')
}
