import type { ApprovalKind, ObjectRef, PrecheckResult } from '@agentsws/contracts'
import { EXTERNAL_FENCE } from '@agentsws/core'
import type { ApprovalContext, CreateApprovalInput } from './types.js'
import { deepEqual, refKey, scanSecrets } from './util.js'

const KNOWN_KINDS: ReadonlySet<string> = new Set<ApprovalKind>([
  'outbound_draft',
  'staged_change',
  'knowledge_update',
  'skill_promotion',
  'skill_lesson',
  'claim',
  'policy_change',
  'home_suggestion',
  'scheduled_task',
  'app_install',
  'app_upgrade',
  'app_uninstall',
  'upstream_upgrade',
  'join_mapping',
  'dev_handoff_result',
])

export function isKnownKind(kind: string): boolean {
  return KNOWN_KINDS.has(kind)
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

function asRef(v: unknown): ObjectRef | undefined {
  const o = rec(v)
  return typeof o.type === 'string' && typeof o.id === 'string'
    ? { type: o.type, id: o.id }
    : undefined
}

function textOf(payload: unknown): string {
  const p = rec(payload)
  const body = rec(p.body)
  const parts = [p.text, body.text, body.subject, p.quote, p.redaction_preview]
  return parts.filter((x): x is string => typeof x === 'string').join('\n')
}

export interface PrecheckOutcome {
  precheck: PrecheckResult
  /** 非空 = blocked，不进队列（14 §6） */
  blocked: string[]
  /** outbound_draft 生成的脱敏预览 */
  redaction_preview?: string
}

/**
 * 14 §6 预检：创建时自动跑，失败即 blocked（不进队列，回给提议者）。
 * 31 §3.3 收件人门禁一并在此：收件人必须在 provenance.seen，且是线程原参与者或已验证联系方式。
 */
export function runPrecheck<P>(
  input: CreateApprovalInput<P>,
  ctx: ApprovalContext = {},
): PrecheckOutcome {
  const blocked: string[] = []
  const notes: string[] = []
  const precheck: PrecheckResult = { ...input.evidence.precheck }
  const seen = new Set((input.evidence.provenance?.seen ?? []).map(refKey))
  const payload = input.payload as unknown
  const p = rec(payload)
  const writeKinds: ApprovalKind[] = ['outbound_draft', 'staged_change']

  // provenance（写类必查）
  if (writeKinds.includes(input.kind)) {
    const targets: ObjectRef[] = []
    const target = asRef(p.target) ?? input.subject.object
    targets.push(target)
    const to = asRef(p.to)
    if (input.kind === 'outbound_draft' && to) targets.push(to)
    const missing = targets.filter((t) => !seen.has(refKey(t)))
    if (missing.length > 0) {
      precheck.provenance = 'fail'
      blocked.push('provenance_missing')
      notes.push(`本次运行未读取过：${missing.map(refKey).join(', ')}`)
    } else precheck.provenance = 'ok'
  }

  // 31 §3.3 收件人门禁
  let redaction_preview: string | undefined
  if (input.kind === 'outbound_draft') {
    const to = asRef(p.to)
    const allowed = new Set([...(ctx.thread_participants ?? []), ...(ctx.verified_contacts ?? [])])
    if (!to || !allowed.has(to.id)) {
      blocked.push('recipient_gate')
      notes.push('收件人不是线程原参与者，也不是已验证联系方式（31 §3.3）')
    }
    redaction_preview =
      typeof p.redaction_preview === 'string' ? p.redaction_preview : textOf(payload)
    precheck.redaction = ctx.precheck_overrides?.redaction ?? 'ok'
    if (precheck.redaction === 'fail') {
      blocked.push('redaction')
      notes.push('含机密字段且接收方无权')
    }
  }

  // 围栏：外部文本进 payload 前必须已清洗（未清洗 = 执行器的 bug）
  const text = textOf(payload)
  if (text && EXTERNAL_FENCE.sanitizeText(text) !== text) {
    precheck.fencing = 'fail'
    blocked.push('fencing')
    notes.push('payload 含未围栏的外部文本标记')
  } else if (text) precheck.fencing = 'ok'

  // 密钥扫描（所有 kind）
  const secrets = scanSecrets(payload)
  if (secrets.length > 0) {
    precheck.secret_scan = 'fail'
    blocked.push('secret_scan')
    notes.push(`payload 含密钥 / 卡号形态：${secrets.join(', ')}`)
  } else precheck.secret_scan = 'ok'

  // 语义 diff：空 diff 不建项
  if (['knowledge_update', 'skill_promotion', 'skill_lesson'].includes(input.kind)) {
    const diff = input.evidence.diff
    if (!diff || deepEqual(diff.before, diff.after)) {
      precheck.semantic_diff = 'empty'
      blocked.push('empty_diff')
      notes.push('语义 diff 为空，不建项')
    } else precheck.semantic_diff = 'ok'
  }

  // 改前必读（listing_edit）
  if (input.kind === 'staged_change' && p.kind === 'listing_edit') {
    const target = asRef(p.target) ?? input.subject.object
    const full = new Set(ctx.precheck_overrides?.record_read === 'ok' ? [refKey(target)] : [])
    precheck.record_read = full.has(refKey(target))
      ? 'ok'
      : (input.evidence.precheck.record_read ?? 'fail')
    if (precheck.record_read === 'fail') {
      blocked.push('record_read')
      notes.push('改前没读过全记录')
    }
  }

  // 额度：超额不是失败，是 L1 路由
  precheck.mandate = input.automation.mandate_check.within ? 'within' : 'review'

  if (notes.length > 0) precheck.notes = [...(precheck.notes ?? []), ...notes]
  return {
    precheck,
    blocked,
    ...(redaction_preview !== undefined ? { redaction_preview } : {}),
  }
}
