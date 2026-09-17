/**
 * 通知邮件模板（59 §2）：**Liquid 变量抽取与校验。**
 *
 * 必需变量表在 `@agentsws/core` 的 {@link EMAIL_TEMPLATE_REQUIRED_VARS}，
 * 不在这里——guardrail 那一侧是最后一道门，两边读的必须是**同一份**
 * （与 `KOL_OUTREACH_FORBIDDEN` 的做法逐字相同）。这里做的是另外两件事：
 *
 * 1. **起草时先自查一遍**，尽早把"少了 `order.name`"说给模型听，别让它提了才被拦。
 * 2. 把"这封信是哪一封"翻成人话（订单确认 / 发货通知 / …），面板与卡面都读它。
 *
 * 为什么不校验 Liquid 语法：Shopify 的通知模板跑在它自己的 Liquid 引擎上，
 * 语法错误在后台保存那一步就会被顶回来。我们判得准的只有"该有的变量在不在"——
 * 判不准的事情不假装判得准（同 43 §2.5 "读不懂绝不判成通过"那一条）。
 */
import {
  EMAIL_TEMPLATE_REQUIRED_VARS,
  liquidVariables,
  missingEmailTemplateVars,
} from '@agentsws/core'

/** 一种通知邮件。`handle` 是 Shopify 的官方 handle，与必需变量表的键一个字不差。 */
export interface NotificationType {
  handle: string
  name: { zh: string; en: string }
  /** 发给谁：`customer` 给顾客，`staff` 给店里的人。 */
  audience: 'customer' | 'staff'
  /** 一句话：什么时候发。 */
  when: { zh: string; en: string }
}

/**
 * 这一版管得着的通知邮件（顺序 = 面板上的出场顺序，按"一笔单走一遍"排）。
 *
 * **只列有必需变量的那些**：表里没有必需变量的类型，guardrail 判不了、面板上也
 * 说不出"这封信少了什么"，列出来只是给人一个点不动的行。要加，先在
 * `EMAIL_TEMPLATE_REQUIRED_VARS` 里补一行。
 */
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  {
    handle: 'order_confirmation',
    name: { zh: '订单确认', en: 'Order confirmation' },
    audience: 'customer',
    when: { zh: '下单付款之后立刻发', en: 'Sent right after checkout' },
  },
  {
    handle: 'shipping_confirmation',
    name: { zh: '发货通知', en: 'Shipping confirmation' },
    audience: 'customer',
    when: { zh: '标记发货那一下发', en: 'Sent when the order is fulfilled' },
  },
  {
    handle: 'shipping_update',
    name: { zh: '物流更新', en: 'Shipping update' },
    audience: 'customer',
    when: { zh: '单号或承运商改了的时候发', en: 'Sent when tracking changes' },
  },
  {
    handle: 'out_for_delivery',
    name: { zh: '派送中', en: 'Out for delivery' },
    audience: 'customer',
    when: { zh: '包裹当天派送时发', en: 'Sent on the delivery day' },
  },
  {
    handle: 'order_cancelled',
    name: { zh: '订单取消', en: 'Order cancelled' },
    audience: 'customer',
    when: { zh: '订单被取消时发', en: 'Sent when an order is cancelled' },
  },
  {
    handle: 'order_refund',
    name: { zh: '退款通知', en: 'Refund notification' },
    audience: 'customer',
    when: { zh: '退款成功之后发', en: 'Sent after a refund goes through' },
  },
  {
    handle: 'abandoned_checkout',
    name: { zh: '弃购提醒', en: 'Abandoned checkout' },
    audience: 'customer',
    when: { zh: '结账没走完、隔一段时间发', en: 'Sent a while after an abandoned checkout' },
  },
  {
    handle: 'customer_account_activation',
    name: { zh: '账号激活', en: 'Account activation' },
    audience: 'customer',
    when: { zh: '给顾客发激活链接时', en: 'Sent with the activation link' },
  },
  {
    handle: 'customer_account_password_reset',
    name: { zh: '重置密码', en: 'Password reset' },
    audience: 'customer',
    when: { zh: '顾客点了忘记密码', en: 'Sent when a customer resets their password' },
  },
  {
    handle: 'gift_card_created',
    name: { zh: '礼品卡', en: 'Gift card created' },
    audience: 'customer',
    when: { zh: '礼品卡发出去时', en: 'Sent when a gift card is issued' },
  },
  {
    handle: 'pos_and_mobile_receipt',
    name: { zh: '门店小票', en: 'POS receipt' },
    audience: 'customer',
    when: { zh: '线下门店结账时', en: 'Sent from POS checkout' },
  },
]

const BY_HANDLE = new Map(NOTIFICATION_TYPES.map((t) => [t.handle, t]))

/** 查一种通知邮件；不认识的回 undefined（新类型随时会加，认不出不等于错）。 */
export function notificationType(handle: string): NotificationType | undefined {
  return BY_HANDLE.get(handle)
}

/** 这种通知邮件必须出现哪几个 Liquid 变量。表里没有的回空数组。 */
export function requiredVariables(handle: string): readonly string[] {
  return EMAIL_TEMPLATE_REQUIRED_VARS[handle] ?? []
}

/** 一份待提交的模板草稿。 */
export interface EmailTemplateDraft {
  notification_type: string
  subject: string
  /** Liquid 正文。 */
  body: string
  /** `true` = 提交的是"以后就发这一份"（L1）；`false` = 草稿（L2）。 */
  enabled: boolean
}

export interface EmailTemplateCheck {
  /** `false` = 这份草稿提上去也会被 guardrail 当场 block。 */
  ok: boolean
  /** 缺了哪几个必需变量。 */
  missing_variables: readonly string[]
  /** 正文里实际用到的变量（面板上"这封信用了什么"那一栏）。 */
  used_variables: readonly string[]
  /** 这次提交会落到哪一档（界面上先说清"这张卡要不要你点"）。 */
  level: 'L1' | 'L2'
  /** 一句给人 / 给模型看的话；`ok` 时为空串。 */
  message: string
}

/**
 * 起草时先自查一遍。
 *
 * 判据与 guardrail 逐字相同（同一张表、同一个函数），所以"这里说过得去、
 * 那边被拦下"这种两头不一致不会发生。主题行空也算不过——一封没有主题行的
 * 通知邮件在多数邮箱客户端里显示成 `(no subject)`，而 Shopify 不会拦它。
 */
export function checkEmailTemplate(draft: EmailTemplateDraft): EmailTemplateCheck {
  const missing = missingEmailTemplateVars(draft.notification_type, draft.body)
  const used = liquidVariables(draft.body)
  const level: 'L1' | 'L2' = draft.enabled ? 'L1' : 'L2'
  if (draft.subject.trim() === '')
    return {
      ok: false,
      missing_variables: missing,
      used_variables: used,
      level,
      message: '这封信没有主题行——顾客邮箱里会显示成 (no subject)。',
    }
  if (missing.length > 0)
    return {
      ok: false,
      missing_variables: missing,
      used_variables: used,
      level,
      message:
        `${draft.notification_type} 少了必需变量：${missing.join('、')}。` +
        '缺了它顾客收到的是一封认不出是哪一单的信，所以这一条是拦不是转人审。',
    }
  return { ok: true, missing_variables: [], used_variables: used, level, message: '' }
}

/**
 * 组一条 `email_template_edit` 变更的 `after`。
 *
 * `enabled` 原样带上：guardrail 就是靠它分档的（草稿 L2 / 启用 L1），
 * 少带一格等于把启用那一下悄悄降成草稿。
 */
export function emailTemplateAfter(draft: EmailTemplateDraft): Record<string, unknown> {
  return {
    notification_type: draft.notification_type,
    subject: draft.subject,
    body: draft.body,
    enabled: draft.enabled,
  }
}

/**
 * 渲染预览：把 Liquid 变量换成示例值，给审批卡当材料用。
 *
 * **不是真渲染**——不跑 Liquid，不跑 `{% if %}`。审批卡要回答的问题是
 * "这封信写的是什么、变量填进去读起来通不通顺"，而不是"这段模板在 Shopify 上
 * 会不会报错"（后者在后台保存那一步就有答案）。控制标签原样留着，人一眼看得出
 * 那是条件块，不会当成正文。
 */
export function renderPreview(body: string, sample: Record<string, string> = {}): string {
  return body.replace(
    /\{\{-?\s*([^}|]+?)\s*(?:\|[^}]*)?-?\}\}/g,
    (whole, name: string) => sample[name.trim()] ?? whole,
  )
}

/** 预览用的一组示例值（面板与卡面共用，省得两处各编一份）。 */
export const PREVIEW_SAMPLE: Readonly<Record<string, string>> = {
  'customer.first_name': '张伟',
  'customer.last_name': '张',
  'shop.name': 'Glass Bowl',
  'order.name': '#1042',
  'order.order_status_url': 'https://example.com/orders/1042',
  'order.total_price': '¥328.00',
  'fulfillment.tracking_numbers': 'SF1234567890',
  'fulfillment.tracking_company': '顺丰',
  'refund.amount': '¥328.00',
  'checkout.url': 'https://example.com/checkouts/abc',
  'customer.account_activation_url': 'https://example.com/activate',
  'customer.reset_password_url': 'https://example.com/reset',
  'gift_card.code': 'GB-1234-5678',
}
