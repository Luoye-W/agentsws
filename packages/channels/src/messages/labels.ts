/**
 * WP113（63 §5）：内置标签那十一个。
 *
 * 为什么内置一套而不是让用户自己建：一只用了五年的邮箱里有两千封信，
 * "先自己想十个标签"是个没人会完成的作业。内置的这十一个覆盖 DTC 卖家邮箱里
 * 九成的信；用户可自建、改名、改色、合并（那几件事在消息库里做，不在这个文件里）。
 *
 * **「可疑」只提示不删信**——我们不替用户判"这封是诈骗"，只把它标出来。
 */

import type { MessageLabel } from '@agentsws/contracts'

/** 内置标签的定义（中英名 + 六档语义色之一）。 */
export const BUILTIN_LABELS: readonly MessageLabel[] = [
  {
    id: 'orders',
    name_zh: '订单与物流',
    name_en: 'Orders & shipping',
    color: 'blue',
    builtin: true,
  },
  { id: 'suppliers', name_zh: '供应商', name_en: 'Suppliers', color: 'slate', builtin: true },
  {
    id: 'platform',
    name_zh: '平台通知',
    name_en: 'Platform notices',
    color: 'slate',
    builtin: true,
  },
  {
    id: 'billing',
    name_zh: '账单与发票',
    name_en: 'Billing & invoices',
    color: 'amber',
    builtin: true,
  },
  {
    id: 'partnership',
    name_zh: '合作邀约',
    name_en: 'Partnerships',
    color: 'violet',
    builtin: true,
  },
  {
    id: 'newsletters',
    name_zh: '营销订阅',
    name_en: 'Newsletters',
    color: 'slate',
    builtin: true,
  },
  {
    id: 'hiring',
    name_zh: '招聘与人事',
    name_en: 'Hiring & people',
    color: 'green',
    builtin: true,
  },
  {
    id: 'legal',
    name_zh: '法务与合规',
    name_en: 'Legal & compliance',
    color: 'violet',
    builtin: true,
  },
  { id: 'security', name_zh: '账号安全', name_en: 'Account security', color: 'red', builtin: true },
  { id: 'personal', name_zh: '个人', name_en: 'Personal', color: 'green', builtin: true },
  { id: 'suspicious', name_zh: '可疑', name_en: 'Suspicious', color: 'red', builtin: true },
]

const BY_ID = new Map(BUILTIN_LABELS.map((l) => [l.id, l]))

export function builtinLabel(id: string): MessageLabel | undefined {
  return BY_ID.get(id)
}
