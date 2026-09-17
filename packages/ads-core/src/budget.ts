/**
 * 总闸、delta、止损（57 §2 / §6、04 §5）。**纯函数，可解释。**
 *
 * "可解释"在这里是硬要求，不是风格：这三件事每一件都会变成一张要人点的卡，
 * 而卡面上那句话必须说清**为什么**。所以每个判定都回一个带 `reason` 的结构，
 * 不回一个 `boolean`——回 `true` / `false` 的那一版，卡面上只能写"超额了"，
 * 人看完还得自己去后台算一遍。
 *
 * 三条纪律：
 *
 * 1. **总闸是岗位级的**。{@link daySpendGate} 收的是**四个平台加起来**的当日花费，
 *    不是某一个账户的（04 §5 `max_daily_spend_total`）。各判各的等于四条职责
 *    一起把总闸撑爆而谁都没越自己那条线。
 * 2. **减少花钱从宽，增加花钱从严**（04 §5 原文）。调低预算永远不撞总闸；
 *    止损那一档能到 L3；提预算与新建永远要人点。
 * 3. **"不知道"不等于"没越线"**。止损判据缺一格就 {@link stopLossVerdict} 回
 *    `unknown`——不是 `false`（"不是止损"）也不是 `true`。缺数的时候按"它是止损"
 *    自动暂停，等于把 L3 那一档送给了一个没人核对过的数。
 */

import type { AdsCaps } from '@agentsws/contracts'
import { ADS_DEFAULT_CAPS } from '@agentsws/contracts'

/** 把配了一半的 caps 补成整份（缺的用 57 §6 的默认值）。 */
export function resolveAdsCaps(partial: Partial<AdsCaps> = {}): AdsCaps {
  return { ...ADS_DEFAULT_CAPS, ...partial }
}

/** 变动百分比。`before` 是 0 时回 `Infinity`——从 0 提到任何数都是"新开口子"。 */
export function deltaPct(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Number.POSITIVE_INFINITY
  return (Math.abs(after - before) / Math.abs(before)) * 100
}

/* ── 一、delta（预算 / 出价）────────────────────────────────────────── */

export interface DeltaVerdict {
  /** 在额度内吗（`true` = L2 自己走，`false` = 升 L1）。 */
  within: boolean
  /** 提上去还是调下来。调下来的永远 `within`（04 §5：减少花钱从宽）。 */
  direction: 'increase' | 'decrease' | 'unchanged'
  /** 变了百分之多少（四舍五入到整数，卡面上那个数）。 */
  pct: number
  cap: number
  /** 一句人话，原样进卡面。 */
  reason: string
}

/**
 * 一次预算改动在不在额度内。
 *
 * **调低预算永远在额度内**：04 §5 那条纪律的整个重点就是"减少花钱的动作可以到
 * 更高的自主档"。把降预算也按 20% 卡住的后果是——广告烧钱的时候 Agent 反而要
 * 等人点头才能踩刹车。
 */
export function budgetDelta(
  before: number,
  after: number,
  caps: Partial<AdsCaps> = {},
): DeltaVerdict {
  return judgeDelta(before, after, resolveAdsCaps(caps).max_budget_delta_pct, '预算')
}

/** 一次出价改动在不在额度内（同 {@link budgetDelta}，默认 15%）。 */
export function bidDelta(before: number, after: number, caps: Partial<AdsCaps> = {}): DeltaVerdict {
  return judgeDelta(before, after, resolveAdsCaps(caps).max_bid_delta_pct, '出价')
}

function judgeDelta(before: number, after: number, cap: number, what: string): DeltaVerdict {
  const pct = Math.round(deltaPct(before, after) * 10) / 10
  const direction = after > before ? 'increase' : after < before ? 'decrease' : 'unchanged'
  if (direction !== 'increase')
    return {
      within: true,
      direction,
      pct,
      cap,
      reason:
        direction === 'unchanged'
          ? `${what}没变（${before}）。`
          : `${what}从 ${before} 调到 ${after}（降 ${pct}%）。花得更少，额度不卡这一边。`,
    }
  const within = pct <= cap
  return {
    within,
    direction,
    pct,
    cap,
    reason: within
      ? `${what}从 ${before} 提到 ${after}（+${pct}%），在 ${cap}% 的额度里。`
      : `${what}从 ${before} 提到 ${after}（+${pct}%），超过 ${cap}% 的额度——要人点一下。`,
  }
}

/* ── 二、日花费总闸（岗位级）─────────────────────────────────────────── */

export interface SpendGateVerdict {
  /** 还开着吗（`false` = 满了）。 */
  open: boolean
  /** 岗位级总闸那个数。 */
  cap: number
  /** 四个平台加起来今天已经花掉的。 */
  spent: number
  /** 这一下会再占掉多少（提预算就是提上去那一截；新建就是它的日预算）。 */
  adding: number
  /** 还剩多少（已经负了就是负数——面板上那一格要显示真实差额）。 */
  remaining: number
  reason: string
  /** 各平台今天各花了多少（面板上"总闸剩余"那一格点开看的就是它）。 */
  by_platform: { platform: string; spend: number }[]
}

/**
 * 岗位级日花费总闸：**四个平台加起来**够不够再花 `adding` 这么多。
 *
 * `spend_by_platform` 里缺哪个平台就是那个平台今天还没拉过数——**按 0 算，
 * 但在 `reason` 里说出来**。不说的话，面板上"还剩 800"会让人以为总闸很宽裕，
 * 而真相是有两个平台压根没数。
 */
export function daySpendGate(input: {
  spend_by_platform: Readonly<Record<string, number | undefined>>
  adding?: number
  caps?: Partial<AdsCaps>
  /** 应该有数的那几个平台（= 这个岗位勾了哪几条职责）。不给就按拿到的算。 */
  expected_platforms?: readonly string[]
}): SpendGateVerdict {
  const cap = resolveAdsCaps(input.caps).max_daily_spend
  const adding = input.adding ?? 0
  const platforms = input.expected_platforms ?? Object.keys(input.spend_by_platform)
  const by_platform = platforms.map((platform) => ({
    platform,
    spend: input.spend_by_platform[platform] ?? 0,
  }))
  const missing = platforms.filter((p) => input.spend_by_platform[p] === undefined)
  const spent = by_platform.reduce((sum, r) => sum + r.spend, 0)
  const remaining = cap - spent
  const open = spent + adding <= cap
  const missingNote =
    missing.length === 0 ? '' : `（${missing.join(' / ')} 今天还没拉到数，按 0 算了）`
  return {
    open,
    cap,
    spent,
    adding,
    remaining,
    by_platform,
    reason: open
      ? `今天四个平台一共花了 ${spent}，总闸 ${cap}，还剩 ${remaining}${missingNote}。`
      : `今天四个平台一共花了 ${spent}，再加 ${adding} 就是 ${spent + adding}，超过总闸 ${cap}${missingNote}。`,
  }
}

/* ── 三、止损 ───────────────────────────────────────────────────────── */

/**
 * 止损判定的三种结论。
 *
 * `unknown` 单列是这个模块最要紧的一格（文件头第 3 条）：ROAS 或花费缺一个，
 * 就不该有人替它决定"算不算止损"。缺数的时候按"是"办，等于把 L3 那一档
 * 送给一个没人核对过的数；按"否"办，又会把一条真在烧钱的广告留在线上。
 * 所以它回 `unknown`，由调用方出一张"这条数据没拉到"的卡。
 */
export type StopLossOutcome = 'trigger' | 'hold' | 'unknown'

export interface StopLossVerdict {
  outcome: StopLossOutcome
  /** 两条判据各自成立没有（卡面上要分开写：是 ROAS 不行还是还没花够）。 */
  roas_below: boolean | undefined
  spend_over: boolean | undefined
  roas?: number
  spend?: number
  daily_budget?: number
  /** 花费占日预算的百分比（卡面上那个数）。 */
  spend_pct?: number
  caps: Pick<AdsCaps, 'stop_loss_roas_below' | 'stop_loss_spend_pct'>
  reason: string
}

/**
 * 止损判定（57 §6：**ROAS < 1 且 当日花费 > 日预算 30%**）。
 *
 * 两条判据是"且"不是"或"，两边各有各的道理：只看 ROAS，一条刚上线花了三十块的
 * 广告会被当场关掉（样本还没够）；只看花费，一条 ROAS 5 的爆款花到日预算一半也会
 * 被关掉（那正是该加预算的时候）。
 */
export function stopLossVerdict(input: {
  roas?: number
  spend?: number
  daily_budget?: number
  caps?: Partial<AdsCaps>
}): StopLossVerdict {
  const caps = resolveAdsCaps(input.caps)
  const line = {
    stop_loss_roas_below: caps.stop_loss_roas_below,
    stop_loss_spend_pct: caps.stop_loss_spend_pct,
  }
  const { roas, spend, daily_budget } = input
  const known =
    roas !== undefined && spend !== undefined && daily_budget !== undefined && daily_budget > 0
  if (!known) {
    const missing = [
      roas === undefined ? 'ROAS' : undefined,
      spend === undefined ? '当日花费' : undefined,
      daily_budget === undefined || daily_budget <= 0 ? '日预算' : undefined,
    ].filter((x): x is string => x !== undefined)
    return {
      outcome: 'unknown',
      roas_below: undefined,
      spend_over: undefined,
      ...(roas === undefined ? {} : { roas }),
      ...(spend === undefined ? {} : { spend }),
      ...(daily_budget === undefined ? {} : { daily_budget }),
      caps: line,
      reason: `判不了止损：${missing.join(' / ')} 没拿到。缺数的时候按"是止损"自动暂停，等于把自动那一档送给一个没人核对过的数。`,
    }
  }
  const spendPct = Math.round(((spend / daily_budget) * 100 + Number.EPSILON) * 10) / 10
  const roasBelow = roas < caps.stop_loss_roas_below
  const spendOver = spendPct > caps.stop_loss_spend_pct
  const trigger = roasBelow && spendOver
  const detail = `ROAS ${roas}（线是 ${caps.stop_loss_roas_below}），今天花了 ${spend}，占日预算 ${daily_budget} 的 ${spendPct}%（线是 ${caps.stop_loss_spend_pct}%）`
  return {
    outcome: trigger ? 'trigger' : 'hold',
    roas_below: roasBelow,
    spend_over: spendOver,
    roas,
    spend,
    daily_budget,
    spend_pct: spendPct,
    caps: line,
    reason: trigger
      ? `两条判据都成立，止损：${detail}。`
      : roasBelow
        ? `ROAS 确实低，但还没花到该止损的量：${detail}。样本还不够，先让它跑。`
        : `花得不少，但 ROAS 还在线上：${detail}。这时候该考虑的是加预算不是关掉。`,
  }
}
