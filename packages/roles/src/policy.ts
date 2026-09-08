/**
 * 05 §1.1 + 31 §3.1：把一个 Assignment 的 scopes 编译成 Casbin 策略行，并按完整元组判定。
 * 策略行形状：`[assignment_id, domain, op, range, max_sensitivity]`。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  Assignment,
  AssignmentId,
  DataDomain,
  Operation,
  Range,
  Sensitivity,
} from '@agentsws/contracts'
import { SENSITIVITY_ORDER } from '@agentsws/contracts'
import { Enforcer, newModelFromString } from 'casbin'
import type { AccessRequest, PolicyRow, RoleDefinitionFull } from './types.js'

const MODEL_PATH = fileURLToPath(new URL('../casbin/model.conf', import.meta.url))

const RANGE_ORDER: Record<Range, number> = { own: 0, assigned: 1, workspace: 2 }

/** 授予的范围是否覆盖请求的范围。 */
export function rangeCovers(granted: Range, requested: Range): boolean {
  return (RANGE_ORDER[granted] ?? -1) >= (RANGE_ORDER[requested] ?? Number.POSITIVE_INFINITY)
}

/** 请求字段的敏感级是否在职责上限之内。 */
export function sensAtMost(requested: Sensitivity, cap: Sensitivity): boolean {
  const a = SENSITIVITY_ORDER.indexOf(requested)
  const b = SENSITIVITY_ORDER.indexOf(cap)
  return a >= 0 && b >= 0 && a <= b
}

/**
 * 05 §1.1 / 31 §3.1：
 * - 已撤销的 Assignment 不产生任何策略行（撤销后立即不可用）；
 * - `range: assigned` 的 scope 在 Assignment 没有 ranges 时不产生策略行（空范围拒）。
 */
export function compilePolicies(assignment: Assignment, role: RoleDefinitionFull): PolicyRow[] {
  if (assignment.role_id !== role.id) return []
  if (assignment.revoked_at) return []
  const hasRanges = assignment.ranges.length > 0
  const rows: PolicyRow[] = []
  for (const scope of role.scopes) {
    if (scope.range === 'assigned' && !hasRanges) continue
    for (const op of scope.ops)
      rows.push([assignment.id, scope.domain, op, scope.range, scope.max_sensitivity])
  }
  return rows
}

export interface PolicyEngine {
  /** 用一个 Assignment 的策略行替换该 assignment 名下的全部行。 */
  set(assignmentId: AssignmentId, rows: readonly PolicyRow[]): void
  remove(assignmentId: AssignmentId): void
  rows(assignmentId: AssignmentId): PolicyRow[]
  can(
    assignmentId: AssignmentId,
    domain: DataDomain,
    op: Operation,
    request: AccessRequest,
  ): boolean
}

/** 同步构建 Casbin enforcer（model 在包内 `casbin/model.conf`），没有 adapter 因此无需 await。 */
export function createPolicyEngine(): PolicyEngine {
  const model = newModelFromString(readFileSync(MODEL_PATH, 'utf8'))
  const enforcer = new Enforcer()
  enforcer.setModel(model)
  enforcer.addFunction('rangeCovers', (granted: string, requested: string) =>
    rangeCovers(granted as Range, requested as Range),
  )
  enforcer.addFunction('sensAtMost', (requested: string, cap: string) =>
    sensAtMost(requested as Sensitivity, cap as Sensitivity),
  )
  const byAssignment = new Map<AssignmentId, PolicyRow[]>()

  const rebuild = () => {
    model.clearPolicy()
    for (const rows of byAssignment.values())
      for (const row of rows) model.addPolicy('p', 'p', [...row])
  }

  return {
    set(assignmentId, rows) {
      byAssignment.set(assignmentId, [...rows])
      rebuild()
    },
    remove(assignmentId) {
      byAssignment.delete(assignmentId)
      rebuild()
    },
    rows(assignmentId) {
      return [...(byAssignment.get(assignmentId) ?? [])]
    },
    can(assignmentId, domain, op, request) {
      return enforcer.enforceSync(assignmentId, domain, op, request.range, request.sensitivity)
    },
  }
}
