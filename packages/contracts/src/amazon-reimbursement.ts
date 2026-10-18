/**
 * WP397：**FBA 赔偿复核**的算式（`amazon-fba-reimbursement` 技能用）。
 *
 * 口径照 xjli360/sealeap-amazon-skills（MIT，© 2026 SeaLeap）
 * `amazon-skills/public-research/sealeap-amazon-fba-reimbursement-audit/references/input-contract.md`
 * 写的规则，提交 1283764556e61cbe56c600bbe504b8731b2254cb，核对日期 2026-09-23。
 * 上游的 `scripts/reconcile_reimbursements.py` **没拷、没运行**——这里按那份说明用 TypeScript 重写。
 *
 * - 只算「顾客下单前」的损失（入库 / 仓内丢失损坏）：核对基数 = min(凭证单件成本, 当期政策单件上限) × 损失件数；
 *   差额 = 核对基数 − 已赔净额；复核候选额 = max(0, 差额)。
 * - 顾客下单后的事件口径不同（原订单售价减费用），不进这条算式，放人工复核。
 * - 上限、资格、凭证都是人核过才算数：没核过、窗口没开、缺数 → HOLD，不进合计；
 *   币种对不上、重复事件、负数 → INVALID。
 * - 合计只加 PASS 的行；PASS 只代表「能算」，不代表 Amazon 会赔。
 *
 * 纯函数；金额按分（两位小数）四舍五入，避免浮点尾数。
 */

export type ReimbursementStage = 'before_customer_order' | 'after_customer_order'
export type ReimbursementWindow = 'open' | 'closed' | 'unknown'

export interface ReimbursementRecord {
  event_id: string
  sku: string
  currency: string
  event_stage: ReimbursementStage
  /** 这一案真实损失的可售件数（不是在库量）。 */
  affected_units?: number
  /** 同一可售单位的采购 / 制造成本，要有凭证。 */
  documented_unit_cost?: number
  /** 已赔净额（撤销已扣掉）；明确没赔才填 0。 */
  already_reimbursed_net?: number
  /** 当期政策的单件上限，由人在后台核过再填。 */
  policy_unit_cap?: number
  evidence_ids: readonly string[]
  policy_eligibility_verified: boolean
  unit_basis_verified: boolean
  window: ReimbursementWindow
}

export type ReimbursementRowStatus = 'PASS' | 'HOLD' | 'MANUAL' | 'INVALID'

export interface ReimbursementRow {
  event_id: string
  sku: string
  status: ReimbursementRowStatus
  reasons: string[]
  base?: number
  difference?: number
  review_candidate?: number
}

export interface ReimbursementAudit {
  currency: string
  rows: ReimbursementRow[]
  /** 只加 PASS 的行。 */
  review_candidate_total_for_pass_rows: number
  /** 有 HOLD / MANUAL / INVALID 时为 false：合计不能叫「全部可追回」。 */
  complete: boolean
}

const cents = (n: number): number => Math.round(n * 100) / 100
const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

export function auditReimbursements(
  currency: string,
  records: readonly ReimbursementRecord[],
): ReimbursementAudit {
  const seen = new Map<string, number>()
  for (const r of records) seen.set(r.event_id, (seen.get(r.event_id) ?? 0) + 1)
  const rows = records.map((r): ReimbursementRow => {
    const head = { event_id: r.event_id, sku: r.sku }
    const invalid: string[] = []
    if ((seen.get(r.event_id) ?? 0) > 1) invalid.push('duplicate_event')
    if (r.currency !== currency) invalid.push('currency_mismatch')
    for (const k of [
      'affected_units',
      'documented_unit_cost',
      'already_reimbursed_net',
      'policy_unit_cap',
    ] as const) {
      const v = r[k]
      if (v !== undefined && !ok(v)) invalid.push(`bad_${k}`)
    }
    if (r.affected_units !== undefined && !Number.isInteger(r.affected_units)) {
      invalid.push('bad_affected_units')
    }
    if (invalid.length > 0) return { ...head, status: 'INVALID', reasons: [...new Set(invalid)] }
    if (r.event_stage !== 'before_customer_order') {
      return { ...head, status: 'MANUAL', reasons: ['after_customer_order'] }
    }
    const hold: string[] = []
    if (r.affected_units === undefined || r.affected_units === 0)
      hold.push('missing_affected_units')
    if (r.documented_unit_cost === undefined) hold.push('missing_documented_unit_cost')
    if (r.already_reimbursed_net === undefined) hold.push('missing_already_reimbursed_net')
    if (r.policy_unit_cap === undefined) hold.push('missing_policy_unit_cap')
    if (r.evidence_ids.length === 0) hold.push('missing_evidence')
    if (!r.policy_eligibility_verified) hold.push('eligibility_not_verified')
    if (!r.unit_basis_verified) hold.push('unit_basis_not_verified')
    if (r.window !== 'open') hold.push(`window_${r.window}`)
    if (
      hold.length > 0 ||
      r.affected_units === undefined ||
      r.documented_unit_cost === undefined ||
      r.already_reimbursed_net === undefined ||
      r.policy_unit_cap === undefined
    ) {
      return { ...head, status: 'HOLD', reasons: hold }
    }
    const base = cents(Math.min(r.documented_unit_cost, r.policy_unit_cap) * r.affected_units)
    const difference = cents(base - r.already_reimbursed_net)
    return {
      ...head,
      status: 'PASS',
      reasons: [],
      base,
      difference,
      review_candidate: Math.max(0, difference),
    }
  })
  const total = cents(
    rows.filter((r) => r.status === 'PASS').reduce((s, r) => s + (r.review_candidate ?? 0), 0),
  )
  return {
    currency,
    rows,
    review_candidate_total_for_pass_rows: total,
    complete: rows.every((r) => r.status === 'PASS'),
  }
}
