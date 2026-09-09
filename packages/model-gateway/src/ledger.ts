import type { AssignmentId, Iso8601, WorkspaceId } from '@agentsws/contracts'
import type { BudgetFrozenPayload, BudgetPolicy } from './types.js'
import { GatewayError } from './types.js'

export interface CapSpec {
  key: string
  cap: number
  scope: BudgetFrozenPayload['scope']
  period: string
  assignment_id?: AssignmentId
}

export interface BudgetCtx {
  workspace_id: WorkspaceId
  assignment_id: AssignmentId
  run_id: string
}

export interface Reservation {
  keys: string[]
  amount: number
  caps: CapSpec[]
  run_key: string
  ctx: BudgetCtx
}

export interface BudgetScopeState {
  used_base: number
  cap_base: number
  frozen: boolean
}

export interface LedgerHooks {
  onFrozen(cap: CapSpec, used: number, ctx: BudgetCtx): void
  onRunExhausted(used: number, cap: number, ctx: BudgetCtx): void
}

const day = (at: Iso8601): string => at.slice(0, 10)
const month = (at: Iso8601): string => at.slice(0, 7)

/**
 * 22 §3 三级预算 + 并发预留。
 * 已结算的 spent 越线 → 冻结（事件 model.budget_frozen），此后新调用一律拒；
 * spent + reserved + 本次估算越线 → 只拒这次（并发保护），不冻结，前面的调用结算后差额会释放。
 */
export class BudgetLedger {
  private readonly spent = new Map<string, number>()
  private readonly reserved = new Map<string, number>()
  private readonly frozenEmitted = new Set<string>()

  constructor(
    private policy: BudgetPolicy,
    private readonly hooks: LedgerHooks,
  ) {}

  /**
   * 换一套上限（WP25：设置页改完预算立刻生效，不重启进程）。
   *
   * **只换上限，不动已花的与已预留的**——那是账，不是配置。上限调高之后
   * 已经冻结的 scope 会自己解冻（`freezeIfCrossed` 每次都重新比一遍），
   * 但"冻结过"的记号要清掉，否则再次越线不会再发事件。
   */
  setPolicy(policy: BudgetPolicy): void {
    this.policy = policy
    this.frozenEmitted.clear()
  }

  private get(map: Map<string, number>, key: string): number {
    return map.get(key) ?? 0
  }

  private add(map: Map<string, number>, key: string, delta: number): void {
    map.set(key, this.get(map, key) + delta)
  }

  capsFor(workspace_id: WorkspaceId, assignment_id: AssignmentId, at: Iso8601): CapSpec[] {
    const d = day(at)
    const m = month(at)
    const caps: CapSpec[] = []
    const wsDaily = this.policy.workspace_daily_base
    if (wsDaily !== undefined) {
      caps.push({
        key: `ws:${workspace_id}:day:${d}`,
        cap: wsDaily,
        scope: 'workspace_daily',
        period: d,
      })
    }
    const wsMonthly = this.policy.workspace_monthly_base
    if (wsMonthly !== undefined) {
      caps.push({
        key: `ws:${workspace_id}:month:${m}`,
        cap: wsMonthly,
        scope: 'workspace_monthly',
        period: m,
      })
    }
    const asgCap =
      this.policy.assignment_daily_base_by_id?.[assignment_id] ?? this.policy.assignment_daily_base
    if (asgCap !== undefined) {
      caps.push({
        key: `asg:${assignment_id}:day:${d}`,
        cap: asgCap,
        scope: 'assignment_daily',
        period: d,
        assignment_id,
      })
    }
    return caps
  }

  private freezeIfCrossed(caps: CapSpec[], ctx: BudgetCtx): CapSpec | undefined {
    for (const c of caps) {
      const used = this.get(this.spent, c.key)
      if (used >= c.cap) {
        if (!this.frozenEmitted.has(c.key)) {
          this.frozenEmitted.add(c.key)
          this.hooks.onFrozen(c, used, ctx)
        }
        return c
      }
    }
    return undefined
  }

  /** 调用前预留；越线抛 budget_exhausted。 */
  reserve(args: { ctx: BudgetCtx; at: Iso8601; amount: number; run_cap?: number }): Reservation {
    const { ctx } = args
    const caps = this.capsFor(ctx.workspace_id, ctx.assignment_id, args.at)
    const frozen = this.freezeIfCrossed(caps, ctx)
    if (frozen !== undefined) {
      throw new GatewayError('budget_exhausted', `budget frozen: ${frozen.scope}`, {
        scope: frozen.scope,
        period: frozen.period,
        used_base: this.get(this.spent, frozen.key),
        cap_base: frozen.cap,
        frozen: true,
      })
    }
    const run_key = `run:${ctx.run_id}`
    if (args.run_cap !== undefined) {
      const used = this.get(this.spent, run_key) + this.get(this.reserved, run_key)
      if (used + args.amount > args.run_cap) {
        this.hooks.onRunExhausted(used, args.run_cap, ctx)
        throw new GatewayError('budget_exhausted', 'run budget exhausted', {
          scope: 'run',
          used_base: used,
          cap_base: args.run_cap,
          estimate_base: args.amount,
        })
      }
    }
    for (const c of caps) {
      const used = this.get(this.spent, c.key) + this.get(this.reserved, c.key)
      if (used + args.amount > c.cap) {
        throw new GatewayError('budget_exhausted', `budget reservation exceeds ${c.scope}`, {
          scope: c.scope,
          period: c.period,
          used_base: used,
          cap_base: c.cap,
          estimate_base: args.amount,
          frozen: false,
        })
      }
    }
    const keys = [...caps.map((c) => c.key), run_key]
    for (const k of keys) this.add(this.reserved, k, args.amount)
    return { keys, amount: args.amount, caps, run_key, ctx }
  }

  /** 返回后按实际结算并释放差额。 */
  settle(r: Reservation, actual: number): void {
    for (const k of r.keys) {
      this.add(this.reserved, k, -r.amount)
      this.add(this.spent, k, actual)
    }
    this.freezeIfCrossed(r.caps, r.ctx)
  }

  /** 调用失败：整笔释放，不计花费。 */
  release(r: Reservation): void {
    for (const k of r.keys) this.add(this.reserved, k, -r.amount)
  }

  state(
    scope: { workspace_id: WorkspaceId; assignment_id?: AssignmentId },
    at: Iso8601,
  ): BudgetScopeState {
    const caps = this.capsFor(scope.workspace_id, scope.assignment_id ?? '', at)
    const relevant =
      scope.assignment_id === undefined ? caps.filter((c) => c.assignment_id === undefined) : caps
    const picked =
      scope.assignment_id === undefined
        ? relevant[0]
        : (relevant.find((c) => c.assignment_id !== undefined) ?? relevant[0])
    const frozen = relevant.some((c) => this.get(this.spent, c.key) >= c.cap)
    if (picked === undefined) {
      return { used_base: 0, cap_base: Number.POSITIVE_INFINITY, frozen: false }
    }
    return { used_base: this.get(this.spent, picked.key), cap_base: picked.cap, frozen }
  }

  spentOf(key: string): number {
    return this.get(this.spent, key)
  }

  reservedOf(key: string): number {
    return this.get(this.reserved, key)
  }
}
