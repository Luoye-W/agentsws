/**
 * 云上钱包的**契约替身**（WP165，docs/83 §2 第 5 条）。
 *
 * 真钱包在云端那一侧（将来进私有仓）。开源这一侧的模拟与测试要一个「按契约记账」的东西：
 * 两类积分（`purchased` 永不过期 / `granted` 到点清零）、先扣有期限的、预扣 → 结算 / 释放、
 * 余额不够**只拒这一次**——口径照 docs/49 §3，形状照 `@agentsws/contracts` 的
 * `WalletBalance` / `WalletLot`。
 *
 * 纯内存、不落盘、不碰网络。**不是**真钱包的第二份实现：没有计量事件白名单、没有低余额事件、
 * 没有 sqlite；那些行为的测试留在云端那一侧。
 */
import type { CreditKind, Iso8601, WalletBalance, WalletLot } from '@agentsws/contracts'

/** 一笔预扣（与云上钱包的预扣同形）。 */
export interface StandInReservation {
  id: string
  org_id: string
  workspace_id: string
  capability: string
  unit: string
  quantity: number
  credits: number
  request_id: string
  at: Iso8601
}

/** 与云上同一条：积分保留四位小数。 */
export const roundStandInCredits = (n: number): number => Math.round(n * 10_000) / 10_000

/** 低于它算「余额低」（与云上默认值一致）。 */
export const STAND_IN_LOW_BALANCE_THRESHOLD = 50

/** 余额不够那一跳抛的错（码与云上同一张表里的 `insufficient_credits`）。 */
export class StandInWalletError extends Error {
  readonly code: 'insufficient_credits' | 'invalid_input'
  readonly details: Record<string, unknown>
  constructor(
    code: 'insufficient_credits' | 'invalid_input',
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'StandInWalletError'
    this.code = code
    this.details = details
  }
}

/**
 * 注册赠送的样例规则（10 积分、`granted`、90 天到期）。真规则在云上；这一份只给合成世界演
 * 「接上官方接口就到账」那一步，和 {@link SAMPLE_PRICING_CATALOG} 同一个取法（09-27 快照）。
 */
export const SAMPLE_SIGNUP_BONUS = { credits: 10, kind: 'granted', expires_days: 90 } as const

/** 注册赠送的幂等键（与云上同形：不含时间、邮箱、金额）。 */
export const signupBonusSourceRefOf = (account_id: string): string => `signup_bonus:${account_id}`

/** 到期日：`now + expires_days`。 */
export function bonusExpiresAtOf(
  rule: { expires_days?: number },
  at: Iso8601,
): Iso8601 | undefined {
  if (rule.expires_days === undefined) return undefined
  return new Date(Date.parse(at) + rule.expires_days * 24 * 60 * 60 * 1000).toISOString()
}

const usable = (lot: WalletLot, at: Iso8601): boolean =>
  lot.remaining > 0 && (lot.expires_at === undefined || lot.expires_at > at)

/** 先扣有期限的（到期日近的在前），再扣永不过期的（先入先出）。 */
function deductionOrder(lots: WalletLot[], at: Iso8601): WalletLot[] {
  return lots
    .filter((l) => usable(l, at))
    .sort((a, b) => {
      const ae = a.expires_at
      const be = b.expires_at
      if (ae !== undefined && be === undefined) return -1
      if (ae === undefined && be !== undefined) return 1
      if (ae !== undefined && be !== undefined && ae !== be) return ae < be ? -1 : 1
      return a.granted_at < b.granted_at ? -1 : a.granted_at > b.granted_at ? 1 : 0
    })
}

export class StandInWallet {
  private readonly lots: WalletLot[] = []
  private readonly reservations = new Map<string, StandInReservation>()
  private readonly now: () => Iso8601
  private readonly newId: (prefix: string) => string

  constructor(options: { now: () => Iso8601; newId: (prefix: string) => string }) {
    this.now = options.now
    this.newId = options.newId
  }

  balance(org_id: string): WalletBalance {
    const at = this.now()
    const lots = this.lots.filter((l) => l.org_id === org_id && usable(l, at))
    const sum = (kind: CreditKind): number =>
      roundStandInCredits(lots.filter((l) => l.kind === kind).reduce((s, l) => s + l.remaining, 0))
    const purchased = sum('purchased')
    const granted = sum('granted')
    const reserved = roundStandInCredits(
      [...this.reservations.values()]
        .filter((r) => r.org_id === org_id)
        .reduce((s, r) => s + r.credits, 0),
    )
    const available = roundStandInCredits(purchased + granted - reserved)
    const expiring = lots
      .filter((l): l is WalletLot & { expires_at: Iso8601 } => l.expires_at !== undefined)
      .sort((a, b) => (a.expires_at < b.expires_at ? -1 : 1))
      .map((l) => ({ credits: roundStandInCredits(l.remaining), expires_at: l.expires_at }))
    return {
      org_id,
      purchased,
      granted,
      available,
      reserved,
      expiring,
      low_balance_threshold: STAND_IN_LOW_BALANCE_THRESHOLD,
      low_balance: available < STAND_IN_LOW_BALANCE_THRESHOLD,
      at,
    }
  }

  /** 入一笔积分；`source_ref` 给了就幂等（同一个号只入一次）。 */
  topup(args: {
    org_id: string
    credits: number
    kind: CreditKind
    expires_at?: Iso8601 | undefined
    source_ref?: string | undefined
  }): WalletLot {
    if (args.credits <= 0) throw new StandInWalletError('invalid_input', '充值积分必须大于 0')
    if (args.source_ref !== undefined) {
      const existing = this.lots.find(
        (l) => l.org_id === args.org_id && l.source_ref === args.source_ref,
      )
      if (existing !== undefined) return { ...existing }
    }
    const lot: WalletLot = {
      id: this.newId('lot'),
      org_id: args.org_id,
      kind: args.kind,
      credits: args.credits,
      remaining: args.credits,
      granted_at: this.now(),
      ...(args.expires_at === undefined ? {} : { expires_at: args.expires_at }),
      ...(args.source_ref === undefined ? {} : { source_ref: args.source_ref }),
    }
    this.lots.push(lot)
    return { ...lot }
  }

  /** 调用前预扣。余额不够**只拒这一次**（话术与云上同一句）。 */
  reserve(args: {
    org_id: string
    workspace_id: string
    capability: string
    unit: string
    quantity: number
    credits: number
    request_id: string
  }): StandInReservation {
    if (args.credits < 0) throw new StandInWalletError('invalid_input', '预扣积分不能是负数')
    const available = this.balance(args.org_id).available
    if (available < args.credits)
      throw new StandInWalletError(
        'insufficient_credits',
        `积分不够了：这一次要 ${args.credits} 积分，可用 ${available}。去"账号与积分"里充值后再试。`,
        { required: args.credits, available },
      )
    const reservation: StandInReservation = { id: this.newId('rsv'), ...args, at: this.now() }
    this.reservations.set(reservation.id, reservation)
    return reservation
  }

  /** 按实际结算：从 lot 里真扣掉，差额释放。回扣掉了多少。 */
  settle(reservation: StandInReservation, actual: { quantity: number; credits: number }): number {
    this.reservations.delete(reservation.id)
    const charged = roundStandInCredits(Math.max(0, actual.credits))
    let left = charged
    for (const lot of deductionOrder(
      this.lots.filter((l) => l.org_id === reservation.org_id),
      this.now(),
    )) {
      if (left <= 0) break
      const take = Math.min(lot.remaining, left)
      lot.remaining = roundStandInCredits(lot.remaining - take)
      left = roundStandInCredits(left - take)
    }
    return charged
  }

  /** 调用失败：整笔释放，不计花费。 */
  release(reservation: StandInReservation): void {
    this.reservations.delete(reservation.id)
  }
}
