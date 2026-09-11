/**
 * 36 §2.2 的卡型表：动作矩阵 + 动词。
 *
 * 「动作矩阵只有五个」是硬约束；每张卡显示哪几个由 kind × state 决定，
 * 快捷行由前端取前三个（36 §2.1 FR-015：≤ 3 个按钮）。
 */
import type { ApprovalState, RiskClass } from '@agentsws/contracts'
import type { DeckAction, DeckKind } from './types.js'

/** 14 §4：只有这两个状态还能被决定。 */
export const DECIDABLE_STATES: readonly ApprovalState[] = ['pending', 'in_review']

/** 已决定 / 已终态的卡只剩「打开」。 */
export const READ_ONLY_ACTIONS: readonly DeckAction[] = ['open']

const FULL: DeckAction[] = ['approve', 'reject', 'instruct', 'snooze', 'open']
const NO_INSTRUCT: DeckAction[] = ['approve', 'reject', 'snooze', 'open']
const GENERIC: DeckAction[] = ['approve', 'reject', 'open']

/** kind → 可用动作（顺序即快捷行顺序）。表里没有的走通用卡（36 §2.2 末段）。 */
const BY_KIND: Partial<Record<DeckKind, DeckAction[]>> = {
  outbound_draft: FULL,
  staged_change: FULL,
  policy_change: ['approve', 'instruct', 'snooze', 'open'],
  ai_question: ['approve', 'instruct', 'snooze', 'open'],
  knowledge_update: FULL,
  skill_lesson: NO_INSTRUCT,
  skill_promotion: NO_INSTRUCT,
  claim: NO_INSTRUCT,
  system_alert: ['open', 'snooze'],
  digest: ['open', 'snooze'],
  // 37 §2.4：早上的计划卡与晚上的复盘卡。计划**只是建议**，采纳才写待办；
  // 复盘的产物是明天计划的草案，所以它也有「按建议排明天」这一路。
  daily_plan: ['approve', 'instruct', 'snooze', 'open'],
  review: ['approve', 'reject', 'snooze', 'open'],
  // 46 I3：同意 / 拒绝，没有第三条路——「指导」在这里无从谈起（对方要么进来要么不进来）
  membership: ['approve', 'reject', 'open'],
}

export function actionsFor(kind: DeckKind, state: ApprovalState): DeckAction[] {
  // 系统卡不进审批状态机：它们永远可操作。
  if (kind === 'system_alert' || kind === 'digest') return [...(BY_KIND[kind] ?? GENERIC)]
  if (!DECIDABLE_STATES.includes(state)) return [...READ_ONLY_ACTIONS]
  return [...(BY_KIND[kind] ?? GENERIC)]
}

/** 36 §2.2 的「快捷行」动词。服务端给，前端不硬编码 kind → 中文。 */
const LABELS: Partial<Record<DeckKind, Partial<Record<DeckAction, string>>>> = {
  outbound_draft: { approve: '发送', reject: '不发', instruct: '指导' },
  staged_change: { approve: '批准', reject: '驳回', instruct: '指导' },
  policy_change: { approve: '就这么定', instruct: '其他…', snooze: '稍后' },
  ai_question: { approve: '就这个', instruct: '我来说', snooze: '稍后' },
  knowledge_update: { approve: '采纳', reject: '不采纳', instruct: '指导' },
  skill_lesson: { approve: '采纳', reject: '不采纳', snooze: '稍后' },
  skill_promotion: { approve: '同意晋升', reject: '不晋升', snooze: '稍后' },
  claim: { approve: '接', reject: '不接', snooze: '稍后' },
  system_alert: { open: '去处理', snooze: '稍后' },
  digest: { open: '看', snooze: '稍后' },
  daily_plan: { approve: '采纳', instruct: '我改几条', snooze: '稍后', open: '打开' },
  review: { approve: '按建议排明天', reject: '我来排', snooze: '稍后', open: '看完' },
  membership: { approve: '让他进来', reject: '不让', open: '看看是谁' },
}

const DEFAULT_LABELS: Record<DeckAction, string> = {
  approve: '批准',
  reject: '驳回',
  instruct: '指导',
  snooze: '稍后',
  open: '打开',
}

export function labelsFor(
  kind: DeckKind,
  actions: DeckAction[],
): Partial<Record<DeckAction, string>> {
  const specific = LABELS[kind] ?? {}
  const out: Partial<Record<DeckAction, string>> = {}
  for (const a of actions) out[a] = specific[a] ?? DEFAULT_LABELS[a]
  return out
}

/** kind → 默认风险等级（宿主给了 risk_class 就用宿主的；15 §2 的真源在账本上）。 */
const RISK_BY_KIND: Partial<Record<DeckKind, RiskClass>> = {
  policy_change: 'high',
  app_install: 'high',
  app_upgrade: 'high',
  app_uninstall: 'high',
  upstream_upgrade: 'high',
  join_mapping: 'high',
  // 46 I1：放人进来 = 让他看见公司的数据，和 Join 一档
  membership: 'high',
  staged_change: 'medium',
  outbound_draft: 'medium',
  dev_handoff_result: 'medium',
  scheduled_task: 'medium',
  system_alert: 'medium',
  knowledge_update: 'low',
  skill_lesson: 'low',
  skill_promotion: 'low',
  claim: 'low',
  home_suggestion: 'low',
  digest: 'low',
  daily_plan: 'low',
  review: 'low',
}

export function riskClassFor(kind: DeckKind): RiskClass {
  return RISK_BY_KIND[kind] ?? 'low'
}

/** 14 §8「今天队列预计 X 分钟」：每种卡的平均处理时长（分钟）。 */
const MINUTES_BY_KIND: Partial<Record<DeckKind, number>> = {
  outbound_draft: 2,
  staged_change: 2,
  policy_change: 4,
  ai_question: 1,
  knowledge_update: 2,
  skill_lesson: 1,
  skill_promotion: 3,
  claim: 1,
  scheduled_task: 2,
  app_install: 5,
  app_upgrade: 5,
  app_uninstall: 3,
  upstream_upgrade: 5,
  join_mapping: 5,
  membership: 2,
  dev_handoff_result: 5,
  home_suggestion: 1,
  system_alert: 3,
  digest: 3,
  daily_plan: 3,
  review: 4,
}

export function minutesFor(kind: DeckKind): number {
  return MINUTES_BY_KIND[kind] ?? 2
}
