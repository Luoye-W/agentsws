/**
 * WP173：**开发序列与日配额**——和渠道无关的那几个函数（docs/84 §2.1）。
 *
 * 原来住在 `@agentsws/kol-core` 的 `outreach.ts`（48 §5.2「建联」），红人与 B2B 开发信
 * 现在都用它：**一份，不复制**。`kol-core` 原样 re-export，红人那一侧一个字节不变。
 *
 * 三条纪律（从红人那边搬过来，没改）：
 *
 * 1. **序列是三封，不是无限跟进**：首封 → 3 天跟进 → 7 天收尾。收尾那封写明
 *    "不回我就不再打扰"，然后**真的不再发**——序列里没有第四封这个选项。
 * 2. **日配额只算，不拦**：真正的拦在 guardrail 的 `max_outreach_per_day`；这里算出来的数
 *    是给面板与卡面用的。
 * 3. **没有 `Date.now()`**：时间一律由调用方按注入的 Clock 传进来。
 *
 * 另加一样 B2B 先用上的（红人没有）：**预热**（{@link warmupCap}）——一个发信邮箱开始发开发信的
 * 头两周每天 20 封，之后最多 50 封（docs/84 §11.1 第 5 条）。它也和渠道无关，所以放在这里。
 */
import { withoutSuppressed } from './suppression.js'

/** 序列里的第几封。 */
export type OutreachStep = 'first' | 'follow_up' | 'final'

/** 序列的节奏（天）。首封是第 0 天。 */
export const SEQUENCE_DAYS: Readonly<Record<OutreachStep, number>> = {
  first: 0,
  follow_up: 3,
  final: 7,
}

export const SEQUENCE_ORDER: readonly OutreachStep[] = ['first', 'follow_up', 'final']

/** 今天还能发几封（日配额）。 */
export interface OutreachQuota {
  /** 上限（职责 yml 的 `max_outreach_per_day`）。 */
  cap: number
  /** 今天已经发出去几封。 */
  sent_today: number
  /** 还剩几封。 */
  remaining: number
  /** 还能不能发。 */
  allowed: boolean
}

/**
 * 算日配额。
 *
 * **只算，不拦**：真正的拦在 guardrail（`max_outreach_per_day`）。这里算出来的数
 * 是给面板与卡面用的——"今天还能发 12 封"这句话要在人点批准之前就看得见。
 */
export function outreachQuota(input: {
  cap: number
  /** 今天发出去那几封的时间戳（ISO）。 */
  sent_at: readonly string[]
  /** 现在（注入）。 */
  now: string
}): OutreachQuota {
  const t = Date.parse(input.now)
  const dayAgo = t - 86_400_000
  const sent = input.sent_at.filter((s) => {
    const at = Date.parse(s)
    return !Number.isNaN(at) && at > dayAgo && at <= t
  }).length
  const remaining = Math.max(0, input.cap - sent)
  return { cap: input.cap, sent_today: sent, remaining, allowed: remaining > 0 }
}

/** 序列里下一封该是哪一封、什么时候发。 */
export interface NextInSequence {
  step: OutreachStep
  /** 该发的时间（ISO）。 */
  due_at: string
  /** 为什么是它（卡面上那一句）。 */
  why: string
}

/**
 * 算序列的下一封。
 *
 * 三种情况没有下一封（回 `undefined`），每一种都是**故意**的：
 * - 对方回过信了：序列的目的达到了，接下来是人在谈，不是机器在跟；
 * - 收尾那封已经发了：序列里没有第四封；
 * - 这个人在抑制名单上：他说过别来找我。
 */
export function nextInSequence(input: {
  /** 已经发过的那几封（按发送顺序）。 */
  sent: readonly { step: OutreachStep; at: string }[]
  /** 对方回过信没有。 */
  replied: boolean
  /** 联系方式（比抑制名单用）。 */
  contact: string
  /** 抑制 / 退订名单。 */
  suppressed: readonly string[]
}): NextInSequence | undefined {
  if (input.replied) return undefined
  if (withoutSuppressed([input.contact], input.suppressed).length === 0) return undefined
  const done = new Set(input.sent.map((s) => s.step))
  if (done.has('final')) return undefined
  const first = input.sent.find((s) => s.step === 'first')
  if (first === undefined) return { step: 'first', due_at: '', why: '这个人还没发过第一封。' }
  const base = Date.parse(first.at)
  if (Number.isNaN(base)) return undefined
  const step: OutreachStep = done.has('follow_up') ? 'final' : 'follow_up'
  const due = new Date(base + SEQUENCE_DAYS[step] * 86_400_000).toISOString()
  return {
    step,
    due_at: due,
    why:
      step === 'follow_up'
        ? `首封发出去 ${SEQUENCE_DAYS.follow_up} 天了还没回音，跟进一封。`
        : `第二封也没回音，发收尾那封——写明不再打扰，然后真的不再发。`,
  }
}

/** 预热三个数（职责 yml `stage_b2b_outreach` 的 `mandate.caps`）。 */
export interface WarmupPolicy {
  /** 预热期每天最多几封（`max_outreach_per_day`）。 */
  cap_new: number
  /** 预热之后每天最多几封（`max_outreach_per_day_warmed`）。 */
  cap_warmed: number
  /** 预热几天（`warmup_days`）。 */
  warmup_days: number
}

/** docs/84 §11.1 第 5 条：新域名前两周每邮箱每天 20 封，之后最多 50 封。 */
export const DEFAULT_WARMUP: Readonly<WarmupPolicy> = {
  cap_new: 20,
  cap_warmed: 50,
  warmup_days: 14,
}

/**
 * 一个发信邮箱**今天**的上限（预热）。
 *
 * 预热从这个邮箱**第一次发开发信**那天算起（`first_sent_at`），还没发过 = 第一天。
 * 宁可慢：一个邮箱前两周就发满 50 封，比多等一周更伤域名信誉。
 */
export function warmupCap(input: {
  policy?: Partial<WarmupPolicy>
  /** 这个邮箱第一次发开发信的时间（没发过不给）。 */
  first_sent_at?: string
  now: string
}): { cap: number; warming: boolean; warm_from?: string } {
  const p = { ...DEFAULT_WARMUP, ...input.policy }
  const start = input.first_sent_at === undefined ? Number.NaN : Date.parse(input.first_sent_at)
  const now = Date.parse(input.now)
  const from = (Number.isNaN(start) ? now : start) + p.warmup_days * 86_400_000
  if (now >= from) return { cap: p.cap_warmed, warming: false }
  return { cap: p.cap_new, warming: true, warm_from: new Date(from).toISOString() }
}
