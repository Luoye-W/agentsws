/**
 * WP212（docs/88 §3）：**类型**——每条进来的消息多判一格「这件事是什么」（十种，单选）。
 *
 * 与分拣四层同一个顺序：规则层先给（线程归并 / 发件人规则 / 自动信头），给不出才问模型；
 * 模型没给类型就按它给的路由与标签推一个。老记录没有这一格，按标签对照表回填
 * （docs/88 §7：订单与物流 → 物流、营销订阅 → 垃圾与营销、账单与发票 / 平台通知 / 账号安全 →
 * 账单与系统通知、合作邀约 → 合作；可疑是旗标，不是类型）。
 *
 * 这个文件全是纯函数：不碰库、不调模型。
 */

import type {
  MessageKind,
  MessagePositionOption,
  MessageRoute,
  MessageSuggest,
  MessageTriage,
} from '@agentsws/contracts'
import { MESSAGE_KINDS, NOTICE_KINDS } from '@agentsws/contracts'

/** 认得这个值吗（模型回的、入参带的都先过它）。 */
export function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === 'string' && (MESSAGE_KINDS as readonly string[]).includes(value)
}

/** 这一类默认是"只是通知"吗（AI 判了不用回时成捆）。 */
export function isNoticeKind(kind: MessageKind): boolean {
  return NOTICE_KINDS.includes(kind)
}

/** 63 那三条分拣路对应的岗位模板（`packages/roles/positions/*.yml` 的 id）。 */
export const POSITION_OF_ROUTE: Readonly<Record<'support' | 'kol' | 'b2b', string>> = {
  support: 'customer-care',
  kol: 'kol-marketing',
  b2b: 'b2b',
}

/** 岗位模板 → 63 的分拣路（其余岗位没有，走 54 的「交给这个岗位一件事」）。 */
export function routeOfPosition(position_id: string): 'support' | 'kol' | 'b2b' | undefined {
  for (const [route, id] of Object.entries(POSITION_OF_ROUTE))
    if (id === position_id) return route as 'support' | 'kol' | 'b2b'
  return undefined
}

/** 类型 → 默认对口的岗位（没有对口岗位的类型回 `undefined`：建议「我自己回」或「只是通知」）。 */
export function positionForKind(kind: MessageKind): string | undefined {
  switch (kind) {
    case 'customer_question':
    case 'after_sales':
      return 'customer-care'
    case 'inquiry':
      return 'b2b'
    case 'creator_reply':
    case 'partnership':
      return 'kol-marketing'
    case 'media':
      return 'pr'
    default:
      return undefined
  }
}

/** 路由 → 类型（线程归并与模型只给了路由时用）。 */
export function kindOfRoute(route: MessageRoute | undefined): MessageKind | undefined {
  if (route === 'support') return 'customer_question'
  if (route === 'kol') return 'creator_reply'
  if (route === 'b2b') return 'inquiry'
  return undefined
}

/** 标签 → 类型（docs/88 §7 的回填对照表；`suspicious` 是旗标，不决定类型）。 */
export function kindOfLabels(labels: readonly string[]): MessageKind | undefined {
  if (labels.some((l) => l === 'billing' || l === 'platform' || l === 'security'))
    return 'billing_system'
  if (labels.includes('orders')) return 'logistics'
  if (labels.includes('partnership')) return 'partnership'
  if (labels.includes('newsletters')) return 'marketing'
  if (labels.some((l) => l === 'personal' || l === 'hiring' || l === 'legal' || l === 'suppliers'))
    return 'personal_other'
  return undefined
}

/**
 * 老记录（WP212 之前落库的）没有 `kind`：按路由、标签推一个，推不出就是「个人与其他」。
 * 回填的把握照实写低一点——界面上会显示「像是 X · 把握 N%」，人一眼看得出是推的。
 */
export function kindOfLegacy(
  triage: MessageTriage | undefined,
  labels: readonly string[],
  route: MessageRoute,
): { kind: MessageKind; confidence: number } {
  if (triage?.kind !== undefined)
    return { kind: triage.kind, confidence: triage.kind_confidence ?? triage.confidence }
  const byRoute = kindOfRoute(route) ?? kindOfRoute(triage?.suggested_route)
  if (byRoute !== undefined) return { kind: byRoute, confidence: triage?.confidence ?? 0.7 }
  const byLabels = kindOfLabels([...labels, ...(triage?.labels ?? [])])
  if (byLabels !== undefined) return { kind: byLabels, confidence: 0.8 }
  return { kind: 'personal_other', confidence: 0.4 }
}

/**
 * 「没人接的」每条那三个建议里 AI 挑哪一个当主按钮（docs/88 §3.2）。
 *
 * - 发件人规则教过岗位、或类型对得上一个**开着**的岗位 → 「交给 X」；
 * - 否则像通知的 → 「只是通知」；
 * - 其余（个人来信、要你本人出面的、没有对口岗位的）→ 「我自己回」。
 */
export function suggestFor(
  input: {
    kind: MessageKind
    needs_reply: boolean
    suggested_position?: string | undefined
    suggested_route?: MessageRoute | undefined
  },
  positions: readonly MessagePositionOption[],
): MessageSuggest {
  const open = (id: string | undefined): id is string =>
    id !== undefined && positions.some((p) => p.id === id && p.open)
  const fromRoute =
    input.suggested_route === 'support' ||
    input.suggested_route === 'kol' ||
    input.suggested_route === 'b2b'
      ? POSITION_OF_ROUTE[input.suggested_route]
      : undefined
  for (const id of [input.suggested_position, fromRoute, positionForKind(input.kind)])
    if (open(id)) return { action: 'hand', position: id }
  // 账单与系统通知里要你动手的（结算暂停、账号风险）→ 我自己处理；物流、营销这类像通知的 → 只是通知
  if (input.kind === 'billing_system' && input.needs_reply) return { action: 'self' }
  if (isNoticeKind(input.kind)) return { action: 'notice' }
  return { action: 'self' }
}
