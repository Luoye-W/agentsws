/**
 * WP415（自查 R1，决策 1229 / 1236–1240）：**照实说——执行结果与「接没接通」**。
 *
 * 以前的毛病：没有真执行器的卡批了以后落进内存空桩，空桩一律回 ok，卡上写「办好了」，
 * 实际什么都没发、没改。这个文件定三样东西，工作台、服务端、发出记录共用同一份口径：
 *
 * 1. **运行形态**（`ExecutionMode`）：`live` 真用（空桩不许兜底）、`demo` 演示（空桩照走、明标「演示」）、
 *    `memory` 只给测试与一次性任务（老行为）。
 * 2. **执行后回读**（`ExecutionReadback`）：执行器回 ok 时顺带说一句「我读回来核对过了没有」。
 * 3. **统一的执行结果**（`ExecutionOutcome`）：已执行且已回读 / 已执行未能回读 / 没做 + 原因 / 演示。
 *
 * 只加不删：老卡（没有 `readback`）读成「已执行未能回读」，不往好里猜。
 */
import type { ApprovalItem } from './approval.js'

/** 这个进程的执行兜底怎么走。 */
export type ExecutionMode = 'live' | 'demo' | 'memory'

/**
 * 执行器回 ok 时的回读结论。
 * - `verified`：执行完读回来核对上了（或者写的就是本机库，写完即是）；
 * - `unverified`：交出去了 / 发出去了，但没能读回来核对（插件排队、对方不给回读口）；
 * - `demo`：演示里的空桩，什么都没真做。
 */
export type ExecutionReadback = 'verified' | 'unverified' | 'demo'

/** 卡、时间线、发出记录上那一格「到底办没办成」。 */
export type ExecutionOutcome = 'verified' | 'unverified' | 'not_done' | 'demo'

export interface ExecutionOutcomeView {
  outcome: ExecutionOutcome
  /** 没做的原因（执行器的原话）；别的档没有。 */
  reason?: string
  /** 没做的原因是「这一步还没接通」（不是一次失败，是根本没有执行器）。 */
  not_wired?: true
}

/**
 * 卡上那一格「这一步接没接通」（出卡时就算好，跟卡一起下发）。
 *
 * - `not_wired`：生产形态下这类卡没有真执行器——卡上不出「通过」，只有「知道了」；
 * - `demo`：演示里这类卡批了只走空桩——照常能点，但卡上明标「演示」。
 */
export interface ExecutionWiring {
  state: 'not_wired' | 'demo'
  /** 一句人话（中文）：为什么。 */
  reason: string
}

/** 没接通时卡上与执行结果里的那句话（中英各一份；服务端和工作台同一句）。 */
export const NOT_WIRED_TEXT = {
  zh: '这一步还没接通：批了也不会真去做，先记下来你自己去办。',
  en: 'Not connected yet: approving this would not actually do it. Note it and do it yourself.',
} as const

/** 演示里空桩那句。 */
export const DEMO_EXECUTION_TEXT = {
  zh: '演示：这一步只在演示里走一遍，没有真去做。',
  en: 'Demo: this step only runs in the demo; nothing real was done.',
} as const

/** 「知道了」——没接通的卡上唯一的那个按钮，落库时记的原因。 */
export const NOT_WIRED_ACK_REASON = '还没接通，我自己去做'

/** 执行失败原因前缀：看到它就知道是「没接通」而不是「这一次失败」。 */
export const NOT_WIRED_ERROR_PREFIX = 'not_wired：'

export function isNotWiredError(message: string | undefined): boolean {
  return message?.startsWith(NOT_WIRED_ERROR_PREFIX) === true
}

/**
 * 从一张审批项算「到底办没办成」。还没走到执行那一步的卡（等你定、驳回了、过期了）回 `undefined`。
 *
 * 判据只看审批项自己带的执行记录（`apply`），不查库、不猜：
 * - `applied` + 回读 `verified` → 已执行且已回读；`demo` → 演示；别的（含老卡没有这一格）→ 已执行未能回读；
 * - `apply_failed` → 没做，原因取最后一次尝试的原话。
 */
export function executionOutcomeOf(
  item: Pick<ApprovalItem, 'state' | 'apply'>,
): ExecutionOutcomeView | undefined {
  if (item.state === 'applied') {
    // WP232：收件人待定、「我来发」的草稿系统本来就不发——没有「办成没办成」这一说
    if (item.apply?.outcome_ref?.type === 'manual_send') return undefined
    const rb = item.apply?.readback
    if (rb === 'verified') return { outcome: 'verified' }
    if (rb === 'demo') return { outcome: 'demo' }
    return { outcome: 'unverified' }
  }
  if (item.state === 'apply_failed') {
    const attempts = item.apply?.attempts ?? []
    const last = attempts[attempts.length - 1]?.error
    const notWired = item.apply?.not_wired === true || isNotWiredError(last)
    const reason =
      last === undefined
        ? undefined
        : isNotWiredError(last)
          ? last.slice(NOT_WIRED_ERROR_PREFIX.length)
          : last
    return {
      outcome: 'not_done',
      ...(reason === undefined ? {} : { reason }),
      ...(notWired ? { not_wired: true as const } : {}),
    }
  }
  return undefined
}
