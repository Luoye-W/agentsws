import { createHash } from 'node:crypto'
import type { ExecutionSnapshot } from '@agentsws/contracts'

/** 稳定序列化：键排序，保证同一内容同一哈希。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const obj = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
      .join(',') +
    '}'
  )
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * 14 §4（09-08）执行快照：批准绑定的不可变分量。任一分量在 apply 时变化 → snapshot_mismatch。
 * 分量：workspace、connection、target + record_version、recipients、final_payload、attachments、executor_version、mandate_hash。
 */
export function executionSnapshot(components: Record<string, unknown>): ExecutionSnapshot {
  const flat: Record<string, string> = {}
  for (const k of Object.keys(components).sort()) flat[k] = sha256(canonicalJson(components[k]))
  return { hash: sha256(canonicalJson(flat)), components: flat }
}

export function snapshotMatches(
  a: ExecutionSnapshot,
  b: ExecutionSnapshot,
): { ok: boolean; changed: string[] } {
  const keys = new Set([...Object.keys(a.components), ...Object.keys(b.components)])
  const changed = [...keys].filter((k) => a.components[k] !== b.components[k])
  return { ok: a.hash === b.hash && changed.length === 0, changed }
}
