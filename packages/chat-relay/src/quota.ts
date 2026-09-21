/**
 * 对话计数与「一个对话」的口径（修订第 4 条）。
 *
 * - **访客发出第一条消息才算一个对话**：挂件加载、开会话都不算；
 * - **同一访客 30 分钟内刷新 / 重开算同一个**：按 `(workspace, visitor)` 记
 *   最近一次计数的时刻，窗口内不重复计；
 * - **商家设置页试聊不计**，但 AI 费用照算（费用在本机那一侧的模型网关里，
 *   转发器看不见）；
 * - **到顶后已在进行的会话放行到结束，只拦新会话**：30 分钟窗口同时是
 *   「在途」的定义——窗口内再来的消息不算新对话，照常转发；
 * - **已订阅客服增值服务的不受限**：`subscribed` 为真时计数照记（报表要看），
 *   但判定恒放行。
 *
 * 全部纯判定 + 一个可替换的存储口（`CounterStore`）：内存档给 Node / 测试，
 * DO 的 storage 给官方托管。
 */
import type { Iso8601 } from '@agentsws/contracts'

/** 同一访客多少分钟内算同一个对话（修订第 4 条）。 */
export const CONVERSATION_WINDOW_MS = 30 * 60 * 1000

/** 到多少比例提醒（80%，修订第 4 条）。只在跨越时发一次。 */
export const QUOTA_WARN_RATIO = 0.8

/** 计数存储口：按月桶记数，按访客记最近一次计数的时刻。 */
export interface CounterStore {
  /** 这个工作区这个月已经计了几个对话。 */
  count(workspace: string, month: string): number
  bump(workspace: string, month: string, by: number): void
  /** 这个访客最近一次被计数的时刻；没有就是 `undefined`。 */
  lastCountedAt(workspace: string, visitor: string): Iso8601 | undefined
  noteCounted(workspace: string, visitor: string, at: Iso8601): void
}

/** 内存档：Node 宿主与测试用。 */
export class MemoryCounterStore implements CounterStore {
  private readonly counts = new Map<string, number>()
  private readonly lastAt = new Map<string, Iso8601>()

  count(workspace: string, month: string): number {
    return this.counts.get(`${workspace}|${month}`) ?? 0
  }

  bump(workspace: string, month: string, by: number): void {
    const key = `${workspace}|${month}`
    this.counts.set(key, (this.counts.get(key) ?? 0) + by)
  }

  lastCountedAt(workspace: string, visitor: string): Iso8601 | undefined {
    return this.lastAt.get(`${workspace}|${visitor}`)
  }

  noteCounted(workspace: string, visitor: string, at: Iso8601): void {
    this.lastAt.set(`${workspace}|${visitor}`, at)
  }
}

/** 月份桶键：按 UTC 月切（对账与报表都按月，不需要按商家时区）。 */
export function monthKeyOf(now: Iso8601): string {
  return now.slice(0, 7)
}

export interface QuotaInput {
  workspace: string
  visitor: string
  now: Iso8601
  /** 每月对话上限；`undefined` = 无上限（自建、订阅生效）。 */
  limit?: number
  /** 已订阅客服增值服务：不受限，但仍计数（报表要看）。 */
  subscribed?: boolean
  /** 试聊（商家自己在设置页试）：不计对话数。 */
  trial?: boolean
}

export type QuotaVerdict =
  | { admit: true; counted: boolean }
  | { admit: false; reason: 'quota_exhausted' }

/**
 * 这条访客消息放不放行、计不计一个对话。
 *
 * 顺序是有讲究的：**先判在途，再判额度**——已在进行的会话（30 分钟窗口内）
 * 即使到顶也放行；放行到「结束」由窗口自然定义，不额外维护会话状态，
 * 转发器也就不用存任何会话正文。
 */
export function judgeQuota(store: CounterStore, input: QuotaInput): QuotaVerdict {
  const countedThisMonth = store.count(input.workspace, monthKeyOf(input.now))
  const inFlight =
    (store.lastCountedAt(input.workspace, input.visitor) ?? '') !== '' &&
    Date.parse(input.now) -
      Date.parse(store.lastCountedAt(input.workspace, input.visitor) as string) <
      CONVERSATION_WINDOW_MS

  // 在途：窗口内再来，不算新对话、不占新额度
  if (inFlight) return { admit: true, counted: false }

  const limit = input.limit
  const unlimited = limit === undefined || input.subscribed === true
  if (!unlimited && countedThisMonth >= (limit as number))
    return { admit: false, reason: 'quota_exhausted' }

  if (input.trial !== true) {
    store.bump(input.workspace, monthKeyOf(input.now), 1)
    store.noteCounted(input.workspace, input.visitor, input.now)
  }
  return { admit: true, counted: input.trial !== true }
}

/** 跨越 80% 那一刻才为真（提醒的幂等锚：只在跨的时候发一次）。 */
export function crossedWarnThreshold(before: number, after: number, limit: number): boolean {
  if (limit <= 0) return false
  return (
    before < Math.ceil(limit * QUOTA_WARN_RATIO) && after >= Math.ceil(limit * QUOTA_WARN_RATIO)
  )
}
