/**
 * WP125（72 §1.C 第 037 条 / §P0-3）：知识缺口的**「有多少客户在等」**。
 *
 * 移植自 KefuAgent spec 037 的等待队列语义，rewritten for agentsws contracts。
 *
 * 这条闭环补的是一个今天有头没尾的路径：
 *
 * ```text
 * AI 答不上来 ──▶ 落一条缺口 ──▶ （以前到这里就断了）
 *                     │
 *                     ├─▶ 记一个等待者（按线程去重）
 *                     ├─▶ 对客先回一句**不承诺**的预期（AI 用客户语言现写）
 *                     ├─▶ 待补区按**等待人数**排序（不是更新时间）
 *                     └─▶ 商家补完 ──▶ 给每个等待者各出一张 pending_review 草稿卡
 * ```
 *
 * 最后那一步是整条路上最要紧的纪律：**零直发**。商家补一条知识不等于他读过
 * 这五个人各自的问法；每个人的那一封仍然要他点一次头。
 *
 * 本文件是纯函数（去重、排序、预期措辞的 preset id）；落库在 `intake.ts`。
 */
import type { KnowledgeGap, KnowledgeGapWaiter } from '@agentsws/contracts'

/**
 * 对客预期的三个 **preset id**。
 *
 * 只有 id 是枚举，**对客那句话由 AI 用客户的语言现写**——商家不填文案框
 * （72 §4.2 原则 16：内容与运营归数据，后台只允许开关 / 预设单选 / 预览）。
 *
 * 三条的共同纪律写在 `EXPECTATION_DISCIPLINE` 里：除了"多久"，什么都不承诺。
 */
export const GAP_EXPECTATIONS = [
  'compiling_details',
  'checking_with_team',
  'sending_guide',
] as const
export type GapExpectation = (typeof GAP_EXPECTATIONS)[number]

/** 每个 preset 给模型的口径（不是给客户看的文案）。 */
export const EXPECTATION_BRIEF: Readonly<Record<GapExpectation, string>> = {
  compiling_details: '告诉客户我们正在把这件事的细节整理清楚，随后回他。',
  checking_with_team: '告诉客户我们要和同事确认一下，确认完就回他。',
  sending_guide: '告诉客户我们会把对应的说明 / 步骤发给他。',
}

/**
 * 三条预期共用的硬边界。**除了"多久"之外不承诺任何事**——
 * 不承诺结果、不承诺金额、不承诺我们会同意。
 */
export const EXPECTATION_DISCIPLINE =
  '用客户自己的语言写 1–2 句。只说"我们在处理、随后回你"这一层意思：' +
  '不要承诺任何结果、金额、责任归属，也不要说"一定可以"。除了时间，什么都不要承诺。'

export function isGapExpectation(value: unknown): value is GapExpectation {
  return typeof value === 'string' && (GAP_EXPECTATIONS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ */
/* 去重与排序                                                           */
/* ------------------------------------------------------------------ */

/**
 * 加一个等待者。**按 `thread_id` 去重**：同一条线程里客户追问三次，
 * 待补区上仍然是"1 个人在等"——否则最吵的那个客户会把排序完全带偏。
 *
 * 已经在等的那一条：只补 `expectation` 与 `language`（第一次记下的 `since` 不动，
 * "等了多久"要从他第一次问起算）。
 */
export function addWaiter(
  waiting: readonly KnowledgeGapWaiter[],
  next: KnowledgeGapWaiter,
): KnowledgeGapWaiter[] {
  const out = [...waiting]
  const at = out.findIndex((w) => w.thread_id === next.thread_id)
  if (at < 0) {
    out.push(next)
    return out
  }
  const prior = out[at] as KnowledgeGapWaiter
  out[at] = {
    ...prior,
    channel: next.channel,
    ...(next.language === undefined ? {} : { language: next.language }),
    ...(next.expectation === undefined ? {} : { expectation: next.expectation }),
  }
  return out
}

/** 有多少人在等（待补区的排序键）。 */
export function waitingCount(gap: Pick<KnowledgeGap, 'waiting'>): number {
  return gap.waiting?.length ?? 0
}

/**
 * 待补区的顺序：**等的人多的在前**；人数相同时**等得久的在前**；
 * 再相同按 id 兜底（保证全序，列表不在两帧之间抖）。
 *
 * 不按更新时间排是这条设计的要点（72 §1.C）：最近被碰过的那条不等于最该先补的那条。
 */
export function compareGapsByWaiting(a: KnowledgeGap, b: KnowledgeGap): number {
  const byCount = waitingCount(b) - waitingCount(a)
  if (byCount !== 0) return byCount
  const oldest = (g: KnowledgeGap): number => {
    const times = (g.waiting ?? []).map((w) => Date.parse(w.since)).filter(Number.isFinite)
    return times.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...times)
  }
  const oa = oldest(a)
  const ob = oldest(b)
  if (oa !== ob) return oa < ob ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 待补区：只看还开着的，按上面的顺序排。 */
export function sortGapsByWaiting(gaps: readonly KnowledgeGap[]): KnowledgeGap[] {
  return [...gaps].sort(compareGapsByWaiting)
}
