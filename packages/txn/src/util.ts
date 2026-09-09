import { createHmac } from 'node:crypto'
import type { ApprovalKind, Iso8601, ObjectRef } from '@agentsws/contracts'
import { canonicalJson, scanSecrets as scanSecretsInText, sha256 } from '@agentsws/core'
import type { TxnPolicy } from './types.js'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID 风格 id：时间前缀（可排序）+ 注入随机；不裸调 Date.now / Math.random。 */
export function makeIdFactory(random: () => number, now: () => Iso8601) {
  let seq = 0
  return (prefix: string): string => {
    const t = Date.parse(now())
    let time = ''
    let n = Number.isFinite(t) ? t : 0
    for (let i = 0; i < 10; i++) {
      time = (ALPHABET[n % 32] ?? '0') + time
      n = Math.floor(n / 32)
    }
    let rand = ''
    for (let i = 0; i < 10; i++) {
      const r = Math.floor(random() * 32) % 32
      rand += ALPHABET[r] ?? '0'
    }
    seq = (seq + 1) % 32
    return `${prefix}_${time}${rand}${ALPHABET[seq] ?? '0'}`
  }
}

/** 14 §7：decision_token = hmac(secret, item_id|revision|snapshot_hash|nonce)。 */
export function signToken(
  secret: string,
  parts: { item_id: string; revision: number; snapshot_hash: string; nonce: string },
): string {
  const mac = createHmac('sha256', secret)
    .update(`${parts.item_id}|${parts.revision}|${parts.snapshot_hash}|${parts.nonce}`)
    .digest('hex')
  return `dt_${mac.slice(0, 40)}`
}

export function nonceFrom(random: () => number): string {
  let s = ''
  for (let i = 0; i < 16; i++) s += ALPHABET[Math.floor(random() * 32) % 32] ?? '0'
  return s
}

export const ms = (iso: Iso8601): number => Date.parse(iso)
export const plusMs = (iso: Iso8601, delta: number): Iso8601 =>
  new Date(Date.parse(iso) + delta).toISOString()
export const DAY_MS = 86_400_000

export const refKey = (r: ObjectRef): string => `${r.type}:${r.id}`

/**
 * 工作时间（14 §7 升级）：简化为周一至周五 9–18，按工作区 tz 偏移解释。
 * 逐小时累计，from 与 to 之间落在工作时间内的整小时数。
 */
export function businessHoursBetween(from: Iso8601, to: Iso8601, tzOffsetMinutes: number): number {
  const start = ms(from)
  const end = ms(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  const HOUR = 3_600_000
  let count = 0
  for (let t = start; t < end; t += HOUR) {
    const local = new Date(t + tzOffsetMinutes * 60_000)
    const day = local.getUTCDay()
    const hour = local.getUTCHours()
    if (day >= 1 && day <= 5 && hour >= 9 && hour < 18) count += 1
  }
  return count
}

/** 本地日（按工作区 tz）作为预占计数器的天键。 */
export function localDay(at: Iso8601, tzOffsetMinutes: number): string {
  const local = new Date(ms(at) + tzOffsetMinutes * 60_000)
  const y = local.getUTCFullYear()
  const m = `${local.getUTCMonth() + 1}`.padStart(2, '0')
  const d = `${local.getUTCDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function counterKey(assignment_id: string, kind: string, day: string): string {
  return `${assignment_id}|${kind}|${day}`
}

export const DEFAULT_POLICY: TxnPolicy = {
  sampling_rate: 0.1,
  cancel_window_sec: 120,
  expiry_days: { default: 7, outbound_draft: 2, claim: 14 },
  escalation_hours: { scope_manager: 24, owner: 48 },
  business_tz_offset_minutes: 480,
  retry_max: 3,
  cumulative_window_days: 30,
  executor_id: 'txn.executor',
  executor_version: 'txn/1',
}

export function resolvePolicy(p?: Partial<TxnPolicy>): TxnPolicy {
  return {
    ...DEFAULT_POLICY,
    ...p,
    expiry_days: { ...DEFAULT_POLICY.expiry_days, ...p?.expiry_days },
    escalation_hours: { ...DEFAULT_POLICY.escalation_hours, ...p?.escalation_hours },
  }
}

export function expiryFor(kind: ApprovalKind, created_at: Iso8601, policy: TxnPolicy): Iso8601 {
  const days = policy.expiry_days[kind] ?? policy.expiry_days.default
  return plusMs(created_at, days * DAY_MS)
}

/** 14 §5：dedupe_key = hash(workspace, kind, subject.object, discriminator)。 */
export function dedupeKey(
  workspace_id: string,
  kind: ApprovalKind,
  object: ObjectRef,
  discriminator: unknown,
): string {
  return `dk_${sha256(canonicalJson([workspace_id, kind, refKey(object), discriminator])).slice(0, 24)}`
}

/**
 * 14 §6 密钥扫描：payload 里出现 key / 卡号形态 → blocked。
 * 模式表在 `@agentsws/core`（WP31 上移；本包过去抄过一份，两份跑偏就是两套纪律）。
 */
export function scanSecrets(value: unknown): string[] {
  return scanSecretsInText(typeof value === 'string' ? value : canonicalJson(value))
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}
