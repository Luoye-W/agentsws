/**
 * WP182（docs/84 §3.2）：样品——待寄 → 已寄（必须带单号）→ 已签收 → 已反馈。
 *
 * 两件事：状态只能往前走一格（已寄必须带单号，guardrail 那道 `sample_tracking_required` 是最后一道闸）；
 * 超期不寄、超期没反馈出提醒（天数取职责 yml 的 `sample_overdue_days` / `feedback_overdue_days`）。
 */
import type { B2bSample, B2bSampleStatus } from '@agentsws/contracts'

export const SAMPLE_STATUS_ORDER: readonly B2bSampleStatus[] = [
  'to_ship',
  'shipped',
  'delivered',
  'feedback',
]

export const SAMPLE_STATUS_ZH: Readonly<Record<B2bSampleStatus, string>> = {
  to_ship: '待寄',
  shipped: '已寄',
  delivered: '已签收',
  feedback: '已反馈',
}

/** 这一步能不能走（只许往下一格；已寄要带单号）。回不能走的那句人话，能走回 `undefined`。 */
export function sampleStepProblem(
  from: B2bSampleStatus,
  to: B2bSampleStatus,
  tracking_no?: string,
): string | undefined {
  const i = SAMPLE_STATUS_ORDER.indexOf(from)
  const j = SAMPLE_STATUS_ORDER.indexOf(to)
  if (j !== i + 1)
    return `样品只能一步一步往前走：现在是「${SAMPLE_STATUS_ZH[from]}」，下一步是「${SAMPLE_STATUS_ZH[SAMPLE_STATUS_ORDER[i + 1] ?? from]}」。`
  if (to === 'shipped' && (tracking_no ?? '').trim() === '') return '标「已寄」要带快递单号。'
  return undefined
}

export interface SampleReminderRule {
  /** 过了 `ship_by` 几天还没寄算超期（yml `sample_overdue_days`，缺省 0 = 过了截止日就算）。 */
  ship_grace_days?: number
  /** 签收后几天没反馈算超期（yml `feedback_overdue_days`，缺省 14）；样品上写了 `feedback_by` 以它为准。 */
  feedback_days?: number
}

export interface SampleReminderDue {
  sample_id: string
  kind: 'ship_overdue' | 'feedback_overdue'
  /** 那个截止日（同一个截止日只提醒一次）。 */
  due: string
  days_over: number
}

const DAY = 86_400_000

/**
 * 到点该提醒的样品。`delivered_at` 是签收那一刻（样品记录上没有这一格的，按 `updated_at` 算）。
 */
export function sampleReminders(
  samples: readonly (B2bSample & { delivered_at?: string })[],
  now: string,
  rule: SampleReminderRule = {},
): SampleReminderDue[] {
  const nowMs = Date.parse(now)
  const out: SampleReminderDue[] = []
  for (const s of samples) {
    if (s.status === 'to_ship') {
      const due = Date.parse(s.ship_by) + (rule.ship_grace_days ?? 0) * DAY
      if (Number.isFinite(due) && nowMs > due)
        out.push({
          sample_id: s.id,
          kind: 'ship_overdue',
          due: s.ship_by,
          days_over: Math.max(1, Math.floor((nowMs - Date.parse(s.ship_by)) / DAY)),
        })
    } else if (s.status === 'shipped' || s.status === 'delivered') {
      const base =
        s.feedback_by ?? (s.status === 'delivered' ? (s.delivered_at ?? s.updated_at) : undefined)
      if (base === undefined) continue
      const due =
        s.feedback_by !== undefined
          ? Date.parse(s.feedback_by)
          : Date.parse(base) + (rule.feedback_days ?? 14) * DAY
      if (Number.isFinite(due) && nowMs > due)
        out.push({
          sample_id: s.id,
          kind: 'feedback_overdue',
          due: new Date(due).toISOString(),
          days_over: Math.max(1, Math.floor((nowMs - due) / DAY)),
        })
    }
  }
  return out
}

/** 寄样通知（英文，发给客户；单号照写，承诺词表不管单号）。 */
export function sampleShippedNotice(input: {
  first_name?: string
  items: string
  carrier?: string
  tracking_no: string
  sender_name: string
  our_company: string
}): { subject: string; body: string } {
  return {
    subject: `Samples shipped — ${input.carrier ?? 'courier'} ${input.tracking_no}`,
    body: [
      `Hi ${input.first_name?.trim() || 'there'},`,
      '',
      `Your samples (${input.items}) have been shipped${input.carrier === undefined ? '' : ` by ${input.carrier}`}.`,
      `Tracking number: ${input.tracking_no}`,
      '',
      'Once you have tested them, we would love to hear your feedback.',
      '',
      'Best regards,',
      input.sender_name,
      input.our_company,
    ].join('\n'),
  }
}
