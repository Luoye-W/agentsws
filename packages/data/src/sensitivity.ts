import { SENSITIVITY_ORDER, type Sensitivity } from '@agentsws/contracts'

/** public < internal < confidential < restricted（21 §2 / 05 §1.1）。 */
export function sensitivityRank(s: Sensitivity): number {
  const i = SENSITIVITY_ORDER.indexOf(s)
  if (i < 0) throw new RangeError(`unknown sensitivity: ${String(s)}`)
  return i
}

/** a 的密级是否不高于 b。 */
export function sensitivityLte(a: Sensitivity, b: Sensitivity): boolean {
  return sensitivityRank(a) <= sensitivityRank(b)
}

/** max 以下（含）的全部密级；用于 SQL `sensitivity IN (...)`。 */
export function sensitivitiesUpTo(max: Sensitivity): Sensitivity[] {
  return SENSITIVITY_ORDER.slice(0, sensitivityRank(max) + 1) as Sensitivity[]
}

/** 取更高者；空数组返回 undefined（= 没有任何授权）。 */
export function maxSensitivity(list: readonly Sensitivity[]): Sensitivity | undefined {
  let best: Sensitivity | undefined
  for (const s of list)
    if (best === undefined || sensitivityRank(s) > sensitivityRank(best)) best = s
  return best
}
