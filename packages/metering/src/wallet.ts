/**
 * 钱包（49 §3 M4）：两类积分、先扣有期限的、预扣 → 结算、只拒这一次不冻结。
 *
 * 语义照 `model-gateway` 的 `BudgetLedger`（22 §3），一条一条对：
 *
 * | BudgetLedger | Wallet | 为什么一样 |
 * |---|---|---|
 * | `reserve(estimate)` | {@link Wallet.reserve} | 调用前按估算占住额度 |
 * | `settle(actual)` | {@link Wallet.settle} | 按实际结算，差额当场释放 |
 * | `release()` | {@link Wallet.release} | 调用失败整笔退回，不计花费 |
 * | 越线**只拒这一次，不冻结** | 余额不足只拒这一次 | 并发保护：前面那几笔结算后差额会回来 |
 *
 * 一条差别：预算是"上限"，余额是"钱"。上限越线要冻结（那是策略），余额不足不冻结
 * （那是钱不够——充了就能用，不需要谁来解冻）。
 *
 * **纯逻辑，无 IO**：存储经 {@link WalletStore} 注入（内存一份、sqlite 一份），
 * 时间与 id 经 `now` / `newId` 注入——这个文件里没有一处 `Date.now()` / `Math.random()`。
 */
import type {
  CreditKind,
  Iso8601,
  MeteringEvent,
  UsageGroup,
  UsageReport,
  UsageRow,
  WalletBalance,
  WalletLot,
} from '@agentsws/contracts'
import { METERING_EVENT_FIELDS, METERING_EVENT_REQUIRED_FIELDS } from '@agentsws/contracts'
import { roundCredits } from './pricing.js'

/** 余额低于它出一个 `wallet.low_balance` 事件（只事件，不弹窗——49 §3）。 */
export const DEFAULT_LOW_BALANCE_THRESHOLD = 50

/** 一笔预扣。`id` 是它自己的号，`request_id` 是这次调用的号。 */
export interface WalletReservation {
  id: string
  org_id: string
  workspace_id: string
  capability: string
  unit: string
  /** 估算数量（token / 次 / 页…）。 */
  quantity: number
  /** 占住多少积分。 */
  credits: number
  request_id: string
  at: Iso8601
}

/** 查用量的过滤条件。 */
export interface UsageFilter {
  org_id: string
  group: UsageGroup
  from?: Iso8601 | undefined
  to?: Iso8601 | undefined
  /** 成员只看自己那个工作区（owner 不带它，看整体）。 */
  workspace_id?: string | undefined
}

/**
 * 存储口。两份实现：{@link MemoryWalletStore}（测试与 `bin/dev.mjs`）与
 * `sqlite-store.ts` 的 sqlite 档。**全同步**——钱的读写要么成要么不成，
 * 中间不该有一个 await 让别的请求插进来。
 */
export interface WalletStore {
  /** 这个组织的全部 lot（含已用完、已过期的；过滤在 Wallet 里做）。 */
  lots(org_id: string): WalletLot[]
  addLot(lot: WalletLot): void
  /** 从这个 lot 扣掉 `credits`（调用方保证不扣成负数）。 */
  consume(lot_id: string, credits: number): void
  /** 幂等：这个支付订单号入过账没有。 */
  lotBySourceRef(org_id: string, source_ref: string): WalletLot | undefined
  reservations(org_id: string): WalletReservation[]
  putReservation(r: WalletReservation): void
  dropReservation(id: string): void
  appendEvent(e: MeteringEvent): void
  events(filter: {
    org_id: string
    from?: string | undefined
    to?: string | undefined
  }): MeteringEvent[]
}

/** 钱包发出去的事件（只有这一种；14 那张卡由调用方照它出）。 */
export interface WalletEvent {
  type: 'wallet.low_balance'
  org_id: string
  available: number
  threshold: number
  at: Iso8601
}

export type WalletErrorCode = 'insufficient_credits' | 'unknown_capability' | 'invalid_input'

export class WalletError extends Error {
  readonly code: WalletErrorCode
  readonly details: Record<string, unknown>
  constructor(code: WalletErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'WalletError'
    this.code = code
    this.details = details
  }
}

/**
 * 计量事件的字段白名单断言（49 M6）。
 *
 * 这是"入口不存正文"这条纪律**唯一可执行的形式**：多一个键就抛。类型上挡住笔误，
 * 运行时挡住"从上游响应里 spread 一把过来"这种事故。
 */
export function assertMeteringEvent(e: MeteringEvent): MeteringEvent {
  const allowed = new Set<string>(METERING_EVENT_FIELDS as readonly string[])
  for (const key of Object.keys(e)) {
    if (!allowed.has(key)) {
      throw new WalletError('invalid_input', `计量事件不许有 ${key} 这个字段（49 M6：只记计量）`)
    }
  }
  /*
   * WP115 之后白名单分两段：前八个必填（49 M6 原本那八列），后八个是成本会计的
   * 扩列，可以不给。**"多一个键就抛"那条一个字没改**——挡住"从上游响应里 spread
   * 一把过来"靠的是它，不是靠必填。
   */
  for (const key of METERING_EVENT_REQUIRED_FIELDS) {
    if (e[key] === undefined) throw new WalletError('invalid_input', `计量事件缺字段 ${key}`)
  }
  return e
}

/**
 * 结算时可以顺手填的成本会计字段（WP115）。全可选——不填就是旧行为。
 *
 * 之所以让调用方填而不是钱包自己算：钱包不知道这一次打的是哪家的哪个模型，
 * 也不该知道（它连 `pricing.json` 都不读）。算成本的是 `cost.ts`，填进来的是
 * 入口（`cloud-entry` / `kol-public`）——它们本来就握着上游返回的 usage。
 */
export interface SettleMeta {
  provider?: string | undefined
  model?: string | undefined
  input_tokens?: number | undefined
  output_tokens?: number | undefined
  cost_micros?: number | undefined
  cost_currency?: string | undefined
  charge_status?: string | undefined
  account_id?: string | undefined
}

/** `SettleMeta` → 可以 spread 进 `MeteringEvent` 的那几格（`undefined` 的一律不出现）。 */
export function settleMetaFields(meta: SettleMeta | undefined): Partial<MeteringEvent> {
  if (meta === undefined) return {}
  const out: Partial<MeteringEvent> = {}
  if (meta.provider !== undefined) out.provider = meta.provider
  if (meta.model !== undefined) out.model = meta.model
  if (meta.input_tokens !== undefined) out.input_tokens = meta.input_tokens
  if (meta.output_tokens !== undefined) out.output_tokens = meta.output_tokens
  if (meta.cost_micros !== undefined) out.cost_micros = meta.cost_micros
  if (meta.cost_currency !== undefined) out.cost_currency = meta.cost_currency
  if (meta.charge_status !== undefined) out.charge_status = meta.charge_status
  if (meta.account_id !== undefined) out.account_id = meta.account_id
  return out
}

export interface WalletOptions {
  store: WalletStore
  now: () => Iso8601
  newId: (prefix: string) => string
  lowBalanceThreshold?: number
  onEvent?: (e: WalletEvent) => void
}

/** 一个 lot 现在还能不能用（有期限的过了点就不能，不是负债，是清零）。 */
function usable(lot: WalletLot, at: Iso8601): boolean {
  if (lot.remaining <= 0) return false
  return lot.expires_at === undefined || lot.expires_at > at
}

/**
 * 扣费顺序：**先扣有期限的**（到期日近的在前），再扣永不过期的（先入先出）。
 *
 * 旧 SaaS 已经验证过的规则：反过来的话送的那些到期清零，用户会觉得被坑了一次。
 */
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

export class Wallet {
  private readonly store: WalletStore
  private readonly now: () => Iso8601
  private readonly newId: (prefix: string) => string
  private readonly threshold: number
  private readonly onEvent: ((e: WalletEvent) => void) | undefined
  /** 已经为这个组织报过一次"余额低"了；回到阈值以上就清掉，免得每笔都报。 */
  private readonly lowReported = new Set<string>()

  constructor(options: WalletOptions) {
    this.store = options.store
    this.now = options.now
    this.newId = options.newId
    this.threshold = options.lowBalanceThreshold ?? DEFAULT_LOW_BALANCE_THRESHOLD
    this.onEvent = options.onEvent
  }

  balance(org_id: string): WalletBalance {
    const at = this.now()
    const lots = this.store.lots(org_id).filter((l) => usable(l, at))
    const purchased = roundCredits(
      lots.filter((l) => l.kind === 'purchased').reduce((s, l) => s + l.remaining, 0),
    )
    const granted = roundCredits(
      lots.filter((l) => l.kind === 'granted').reduce((s, l) => s + l.remaining, 0),
    )
    const reserved = roundCredits(
      this.store.reservations(org_id).reduce((s, r) => s + r.credits, 0),
    )
    const available = roundCredits(purchased + granted - reserved)
    const expiring = lots
      .filter((l): l is WalletLot & { expires_at: Iso8601 } => l.expires_at !== undefined)
      .sort((a, b) => (a.expires_at < b.expires_at ? -1 : 1))
      .map((l) => ({ credits: roundCredits(l.remaining), expires_at: l.expires_at }))
    return {
      org_id,
      purchased,
      granted,
      available,
      reserved,
      expiring,
      low_balance_threshold: this.threshold,
      low_balance: available < this.threshold,
      at,
    }
  }

  /**
   * 调用前预扣。余额不够**只拒这一次**（抛 `insufficient_credits`），不冻结、不拉黑——
   * 前面那几笔结算之后差额会回来，下一次自然就过了。
   */
  reserve(args: {
    org_id: string
    workspace_id: string
    capability: string
    unit: string
    quantity: number
    credits: number
    request_id: string
  }): WalletReservation {
    if (args.credits < 0) throw new WalletError('invalid_input', '预扣积分不能是负数')
    const available = this.balance(args.org_id).available
    if (available < args.credits) {
      throw new WalletError(
        'insufficient_credits',
        `积分不够了：这一次要 ${args.credits} 积分，可用 ${available}。去"账号与积分"里充值后再试。`,
        { required: args.credits, available },
      )
    }
    const reservation: WalletReservation = {
      id: this.newId('rsv'),
      org_id: args.org_id,
      workspace_id: args.workspace_id,
      capability: args.capability,
      unit: args.unit,
      quantity: args.quantity,
      credits: args.credits,
      request_id: args.request_id,
      at: this.now(),
    }
    this.store.putReservation(reservation)
    return reservation
  }

  /**
   * 按实际结算：从 lot 里真扣掉，差额释放，记一条计量事件。
   *
   * 实际比预扣多也照扣（模型回得比估的长是常事）——余额可能因此短暂为负，
   * 这比"扣一半"或"把成功的调用当失败"都好；下一次 `reserve` 会拦住。
   */
  settle(
    reservation: WalletReservation,
    actual: { quantity: number; credits: number } & SettleMeta,
  ): MeteringEvent {
    this.store.dropReservation(reservation.id)
    const at = this.now()
    let left = roundCredits(Math.max(0, actual.credits))
    for (const lot of deductionOrder(this.store.lots(reservation.org_id), at)) {
      if (left <= 0) break
      const take = Math.min(lot.remaining, left)
      this.store.consume(lot.id, take)
      left = roundCredits(left - take)
    }
    const event = assertMeteringEvent({
      capability: reservation.capability,
      unit: reservation.unit,
      quantity: actual.quantity,
      credits: roundCredits(actual.credits),
      at,
      org_id: reservation.org_id,
      workspace_id: reservation.workspace_id,
      request_id: reservation.request_id,
      ...settleMetaFields(actual),
    })
    this.store.appendEvent(event)
    this.checkLowBalance(reservation.org_id)
    return event
  }

  /** 调用失败（上游 5xx、超时、被拒）：整笔释放，不计花费、不记计量事件。 */
  release(reservation: WalletReservation): void {
    this.store.dropReservation(reservation.id)
  }

  /**
   * 入一笔积分。
   *
   * `source_ref`（支付订单号）给了就**幂等**：同一个号只入一次。Stripe 的 webhook
   * 会重投，重投不该变成重复充值。
   */
  topup(args: {
    org_id: string
    credits: number
    kind: CreditKind
    expires_at?: Iso8601 | undefined
    source_ref?: string | undefined
  }): WalletLot {
    if (args.credits <= 0) throw new WalletError('invalid_input', '充值积分必须大于 0')
    if (args.source_ref !== undefined) {
      const existing = this.store.lotBySourceRef(args.org_id, args.source_ref)
      if (existing !== undefined) return existing
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
    this.store.addLot(lot)
    this.lowReported.delete(args.org_id)
    return lot
  }

  /** 只聚合计量事件——它本来就只有八个字段，聚合不出正文来。 */
  usage(filter: UsageFilter): UsageReport {
    const to = filter.to ?? this.now()
    const from = filter.from ?? '0000-01-01T00:00:00.000Z'
    const events = this.store
      .events({ org_id: filter.org_id, from, to })
      .filter((e) => filter.workspace_id === undefined || e.workspace_id === filter.workspace_id)
    const buckets = new Map<string, UsageRow>()
    for (const e of events) {
      const key =
        filter.group === 'capability'
          ? e.capability
          : filter.group === 'workspace'
            ? e.workspace_id
            : e.at.slice(0, 10)
      const row = buckets.get(key) ?? { key, credits: 0, quantity: 0, calls: 0 }
      row.credits = roundCredits(row.credits + e.credits)
      row.quantity += e.quantity
      row.calls += 1
      buckets.set(key, row)
    }
    const rows = [...buckets.values()].sort((a, b) =>
      filter.group === 'day' ? a.key.localeCompare(b.key) : b.credits - a.credits,
    )
    return {
      group: filter.group,
      from,
      to,
      rows,
      total_credits: roundCredits(rows.reduce((s, r) => s + r.credits, 0)),
    }
  }

  private checkLowBalance(org_id: string): void {
    const b = this.balance(org_id)
    if (!b.low_balance) {
      this.lowReported.delete(org_id)
      return
    }
    if (this.lowReported.has(org_id)) return
    this.lowReported.add(org_id)
    this.onEvent?.({
      type: 'wallet.low_balance',
      org_id,
      available: b.available,
      threshold: this.threshold,
      at: b.at,
    })
  }
}

/** 内存档（测试与 `bin/dev.mjs`）。同一份接口，sqlite 档在 `sqlite-store.ts`。 */
export class MemoryWalletStore implements WalletStore {
  private readonly lotRows: WalletLot[] = []
  private readonly reservationRows = new Map<string, WalletReservation>()
  private readonly eventRows: MeteringEvent[] = []

  lots(org_id: string): WalletLot[] {
    return this.lotRows.filter((l) => l.org_id === org_id).map((l) => ({ ...l }))
  }

  addLot(lot: WalletLot): void {
    this.lotRows.push({ ...lot })
  }

  consume(lot_id: string, credits: number): void {
    const lot = this.lotRows.find((l) => l.id === lot_id)
    if (lot === undefined) return
    lot.remaining = roundCredits(lot.remaining - credits)
  }

  lotBySourceRef(org_id: string, source_ref: string): WalletLot | undefined {
    const found = this.lotRows.find((l) => l.org_id === org_id && l.source_ref === source_ref)
    return found === undefined ? undefined : { ...found }
  }

  reservations(org_id: string): WalletReservation[] {
    return [...this.reservationRows.values()].filter((r) => r.org_id === org_id)
  }

  putReservation(r: WalletReservation): void {
    this.reservationRows.set(r.id, { ...r })
  }

  dropReservation(id: string): void {
    this.reservationRows.delete(id)
  }

  appendEvent(e: MeteringEvent): void {
    this.eventRows.push({ ...e })
  }

  events(filter: {
    org_id: string
    from?: string | undefined
    to?: string | undefined
  }): MeteringEvent[] {
    return this.eventRows.filter(
      (e) =>
        e.org_id === filter.org_id &&
        (filter.from === undefined || e.at >= filter.from) &&
        (filter.to === undefined || e.at <= filter.to),
    )
  }
}
