import type { Mandate } from '@agentsws/contracts'
import { canonicalJson, sha256 } from './snapshot.js'

type Cap = number | string | boolean | string[]

/** 15 §3.1：Role 默认 → WorkspacePolicy 覆盖（可松可紧） → Assignment 只能更紧。 */
export function resolveMandate(role: Mandate, policy?: Partial<Mandate>, assignment?: Partial<Mandate>): Mandate {
  const merged: Mandate = {
    caps: { ...role.caps, ...(policy?.caps ?? {}) },
    ...(role.per_change_limits || policy?.per_change_limits ? { per_change_limits: { ...role.per_change_limits, ...policy?.per_change_limits } } : {}),
    ...(policy?.window ?? role.window ? { window: (policy?.window ?? role.window)! } : {}),
  }
  if (assignment) {
    for (const [k, v] of Object.entries(assignment.caps ?? {})) {
      const cur = merged.caps[k]
      merged.caps[k] = tighter(cur, v as Cap)
    }
    if (assignment.window) {
      const cur = merged.window
      if (!cur || assignment.window.max_count < cur.max_count) merged.window = assignment.window
    }
    if (assignment.per_change_limits) {
      const cur = merged.per_change_limits ?? {}
      merged.per_change_limits = {
        ...cur,
        ...(assignment.per_change_limits.max_items !== undefined ? { max_items: Math.min(cur.max_items ?? Number.POSITIVE_INFINITY, assignment.per_change_limits.max_items) } : {}),
        ...(assignment.per_change_limits.no_repeat_target_field ? { no_repeat_target_field: true } : {}),
      }
    }
  }
  return merged
}

/** 数值取更小、集合取交集、布尔只能 false→true 收紧；Assignment 试图放宽的值被忽略。 */
function tighter(cur: Cap | undefined, next: Cap): Cap {
  if (cur === undefined) return next
  if (typeof cur === 'number' && typeof next === 'number') return Math.min(cur, next)
  if (Array.isArray(cur) && Array.isArray(next)) return cur.filter((x) => next.includes(x))
  if (typeof cur === 'boolean' && typeof next === 'boolean') return cur || next
  return cur
}

export function mandateHash(m: Mandate): string { return 'm:' + sha256(canonicalJson(m)).slice(0, 16) }

export function capNumber(m: Mandate, name: string): number | undefined {
  const v = m.caps[name]
  return typeof v === 'number' ? v : undefined
}
export function capBool(m: Mandate, name: string): boolean { return m.caps[name] === true }
export function capList(m: Mandate, name: string): string[] { const v = m.caps[name]; return Array.isArray(v) ? v : [] }
