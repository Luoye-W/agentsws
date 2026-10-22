/**
 * WP441：「修改」把一条规则的原话带回规则面板顶上的输入框（卡片流里点的「修改」、清单里点的「改」）。
 * 只在内存里、只留一句、取一次就没了。
 */
export interface PendingRuleText {
  text: string
  /** 改哪一条（不给 = 新建）。 */
  rule_id?: string
  revision?: number
}

let pending: PendingRuleText | undefined

export function setPendingRuleText(p: PendingRuleText): void {
  pending = p
}

/** 取走（取一次就没了）。 */
export function takePendingRuleText(): PendingRuleText | undefined {
  const out = pending
  pending = undefined
  return out
}
