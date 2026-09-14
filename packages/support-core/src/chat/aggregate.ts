/**
 * Extracted from KefuAgent src/lib/support/chat.ts (evaluateChatTurnAggregation),
 * rewritten for agentsws contracts.
 *
 * 轮次聚合：聊天里一个人说三句话是一轮，不是三轮。
 *
 * 两个窗口（KefuAgent `liveChatTurnParameters` 的冻结值）：
 * - **2s 静默**：访客停手 2 秒，这一轮就算说完了；
 * - **20s 爆发**：从第一条消息起 20 秒，无论还在不在打字都先答——
 *   一个人连打两分钟，让他等两分钟才看到第一句回复是最糟的。
 *
 * 时间一律经参数传进来（毫秒或 ISO-8601），本文件里没有 `Date.now()`。
 */
import type { Iso8601 } from '@agentsws/contracts'
import { sanitizeExternal } from '../text.js'
import type { ChatTurnMessage } from './types.js'

export interface ChatTurnWindows {
  /** 静默多久算这一轮说完（默认 2000ms）。 */
  idle_ms: number
  /** 从第一条消息起的硬上限（默认 20000ms）。 */
  burst_cap_ms: number
}

export const DEFAULT_CHAT_TURN_WINDOWS: ChatTurnWindows = {
  idle_ms: 2_000,
  burst_cap_ms: 20_000,
}

export type ChatTurnState =
  | 'idle'
  | 'collecting'
  | 'ready'
  /** AI 正在生成时访客又补了一句：旧回复作废，重新理解。 */
  | 'superseded'

/** 哪条规则结束了这一轮。机器可读——断言不该去匹配中文。 */
export type ChatTurnTrigger = 'idle_pause' | 'burst_cap'

export interface ChatTurnAggregation {
  state: ChatTurnState
  /** 这一轮合起来的文本（多条按时间序换行拼接，已清洗）。 */
  turn_text: string
  message_ids: string[]
  first_at?: Iso8601
  last_at?: Iso8601
  /** 早于这个时刻不该回复（`ready` 时等于 now）。 */
  reply_not_before_ms?: number
  trigger?: ChatTurnTrigger
  /** 中文原因，进沙盒页。 */
  reason: string
}

export interface ChatTurnInput {
  messages: readonly ChatTurnMessage[]
  /** 现在几点（ISO-8601；时间经注入）。 */
  now: Iso8601
  /** AI 这一轮的生成起始时刻；给了就参与 `superseded` 判定。 */
  agent_started_at?: Iso8601
  windows?: Partial<ChatTurnWindows>
}

const ms = (at: Iso8601): number => Date.parse(at)

/** 最后一条非访客消息之后的所有访客消息 = 这一轮。 */
function currentTurn(messages: readonly ChatTurnMessage[]): ChatTurnMessage[] {
  const sorted = [...messages].sort((a, b) => ms(a.at) - ms(b.at))
  let lastNonVisitor = -1
  for (const [i, m] of sorted.entries()) if (m.role !== 'visitor') lastNonVisitor = i
  return sorted
    .slice(lastNonVisitor + 1)
    .filter((m) => m.role === 'visitor' && sanitizeExternal(m.text).trim().length > 0)
}

/**
 * 这一轮说完了没有。
 *
 * 返回 `ready` 就是"可以去分类与生成了"；`collecting` 的话调用方按
 * `reply_not_before_ms` 排一次重算（服务进程里就是一个定时器）。
 */
export function evaluateChatTurn(input: ChatTurnInput): ChatTurnAggregation {
  const windows = { ...DEFAULT_CHAT_TURN_WINDOWS, ...input.windows }
  const turn = currentTurn(input.messages)
  const now_ms = ms(input.now)

  if (turn.length === 0) {
    return {
      state: input.agent_started_at === undefined ? 'idle' : 'collecting',
      turn_text: '',
      message_ids: [],
      reason:
        input.agent_started_at === undefined
          ? '现在没有等待处理的访客输入。'
          : 'AI 正在基于上一轮内容生成回复。',
    }
  }

  const first = turn[0] as ChatTurnMessage
  const last = turn[turn.length - 1] as ChatTurnMessage
  const base = {
    turn_text: turn.map((m) => sanitizeExternal(m.text).trim()).join('\n'),
    message_ids: turn.map((m) => m.id),
    first_at: first.at,
    last_at: last.at,
  }

  // AI 生成期间访客又说话了 → 旧回复必须废弃
  if (input.agent_started_at !== undefined && ms(last.at) > ms(input.agent_started_at)) {
    return {
      ...base,
      state: 'superseded',
      reply_not_before_ms: ms(last.at) + windows.idle_ms,
      reason: '访客在 AI 生成过程中补充了新消息，旧回复作废，重新理解这一轮。',
    }
  }

  // 爆发上限：从第一条消息起算，到点就先答
  if (now_ms - ms(first.at) >= windows.burst_cap_ms) {
    return {
      ...base,
      state: 'ready',
      reply_not_before_ms: now_ms,
      trigger: 'burst_cap',
      reason: '已到最大等待时间，即使访客可能还在打字，也先按现有上下文回应。',
    }
  }

  // 静默窗口：还没停手，继续收
  if (now_ms - ms(last.at) < windows.idle_ms) {
    return {
      ...base,
      state: 'collecting',
      reply_not_before_ms: ms(last.at) + windows.idle_ms,
      reason: '访客刚发完消息，等一个短停顿，把连着的几条并成一轮再答。',
    }
  }

  return {
    ...base,
    state: 'ready',
    reply_not_before_ms: ms(last.at) + windows.idle_ms,
    trigger: 'idle_pause',
    reason: '访客已经停顿，可以基于完整这一轮生成回复。',
  }
}
