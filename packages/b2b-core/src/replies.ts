/**
 * WP173（docs/84 §2.2）：**开发信回信分类**——形状照 `kol-core/replies.ts`（词表 + 结构判断，
 * 模型是运行时那一半，这里是兜底与测试锚点），类别换成 B2B 的：
 *
 * | 类 | 接下来 |
 * |---|---|
 * | 有意向 / 要资料 / 问价 | **停序列，交给 `b2b.sales`**（落成询盘） |
 * | 晚点再说 | 停序列（不拉黑） |
 * | 不感兴趣 / 退订 | 停序列 + 进抑制名单 |
 * | 自动回复（休假） | 不算回信：按对方写的回来日期顺延 |
 * | 退信 | 停序列（硬退信在分拣时已进名单） |
 * | 看不出 | 停序列，进「回复待分」等人读 |
 *
 * **任何一封真回信都让这个人的序列立刻停下**——只有自动回复不算。
 * 只看回信开头那一截（引用的原信里有我们自己的页脚"Not interested? Reply unsubscribe"）。
 */
import type { B2bReplyClass } from '@agentsws/contracts'

export interface B2bReplyClassification {
  klass: B2bReplyClass
  /** 命中的那几条（卡面上的"为什么这么判"）。 */
  signals: string[]
  /** 自动回复里写的回来日期（`YYYY-MM-DD`，认得出才有）。 */
  return_date?: string
}

export type B2bReplyAction = 'hand_to_sales' | 'suppress' | 'postpone' | 'stop'

export const B2B_REPLY_ACTION: Readonly<Record<B2bReplyClass, B2bReplyAction>> = {
  interested: 'hand_to_sales',
  wants_info: 'hand_to_sales',
  asks_price: 'hand_to_sales',
  later: 'stop',
  not_interested: 'suppress',
  unsubscribe: 'suppress',
  auto_reply: 'postpone',
  bounce: 'stop',
  unknown: 'stop',
}

export const B2B_REPLY_ZH: Readonly<Record<B2bReplyClass, string>> = {
  interested: '有意向',
  wants_info: '要资料',
  asks_price: '问价',
  later: '晚点再说',
  not_interested: '不感兴趣',
  unsubscribe: '退订',
  auto_reply: '自动回复',
  bounce: '退信',
  unknown: '待分',
}

/** 判序（前面的命中就不往下）：先认"不是人回的"，再认"不要"，最后才认"要"。 */
const RULES: readonly { klass: B2bReplyClass; terms: readonly string[] }[] = [
  {
    klass: 'unsubscribe',
    terms: [
      'unsubscribe',
      'remove me',
      'take me off',
      'stop emailing',
      'do not contact',
      "don't contact",
      'opt out',
      '退订',
      '别再发',
      '不要再发',
    ],
  },
  {
    klass: 'later',
    terms: [
      'not now',
      'next quarter',
      'next year',
      'later this year',
      'reach out in',
      'maybe later',
      'timing is not right',
      "timing isn't right",
      'after the new year',
      '晚点',
      '以后再说',
      '明年再',
      '过段时间',
    ],
  },
  {
    klass: 'not_interested',
    terms: [
      'not interested',
      'no thanks',
      'no thank you',
      'not a fit',
      'no need',
      'we are not looking',
      "we're not looking",
      'already have a supplier',
      'already have suppliers',
      '不需要',
      '不感兴趣',
      '不考虑',
    ],
  },
  {
    klass: 'asks_price',
    terms: [
      'price',
      'pricing',
      'quote',
      'quotation',
      'how much',
      'cost',
      'moq',
      'minimum order',
      'lead time',
      '报价',
      '价格',
      '多少钱',
      '起订量',
      '交期',
    ],
  },
  {
    klass: 'wants_info',
    terms: [
      'catalog',
      'catalogue',
      'brochure',
      'spec sheet',
      'specs',
      'datasheet',
      'more info',
      'more details',
      'sample',
      'overview',
      '资料',
      '目录',
      '规格',
      '样品',
    ],
  },
  {
    klass: 'interested',
    terms: [
      'interested',
      'sounds good',
      "let's talk",
      'tell me more',
      'happy to',
      'yes please',
      'keen',
      '感兴趣',
      '可以聊',
      '有兴趣',
    ],
  },
]

const AUTO_SUBJECT = [
  'automatic reply',
  'auto-reply',
  'autoreply',
  'out of office',
  'out of the office',
  'abwesenheit',
  'absence',
  '自动回复',
  '休假',
]
const AUTO_BODY = [
  'out of the office',
  'out of office',
  'on vacation',
  'on holiday',
  'on leave',
  'limited access to email',
  'i will be back',
  "i'll be back",
  'return on',
  'back on',
  '休假中',
  '不在办公室',
]
const BOUNCE_SUBJECT = [
  'undeliverable',
  'undelivered mail',
  'delivery status notification',
  'mail delivery failed',
  'returned mail',
  '退信',
  '投递失败',
]

/** 引用的原信（`>` 开头、"On … wrote:"、"-----Original Message-----"、"From:" 块）之前那一截。 */
export function replyHead(text: string, max = 600): string {
  const cut = text.search(
    /^(>|On .{4,120} wrote:|-{2,}\s*Original Message|From:\s|发件人[:：]|在.{2,60}写道[:：])/im,
  )
  return (cut < 0 ? text : text.slice(0, cut)).slice(0, max)
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/** 自动回复里写的回来日期：`2026-10-06`，或 `back on October 6`（年按 `now` 推）。 */
export function returnDateOf(text: string, now: string): string | undefined {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text)
  if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const m = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i').exec(text)
  if (m === null || m[1] === undefined || m[2] === undefined) return undefined
  const month = MONTHS.indexOf(m[1].toLowerCase())
  const day = Number(m[2])
  const base = new Date(now)
  let year = base.getUTCFullYear()
  if (Date.UTC(year, month, day) < Date.parse(now) - 86_400_000) year += 1
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)
}

/** 分一封开发信的回信。 */
export function classifyB2bReply(input: {
  subject: string
  text: string
  headers?: Readonly<Record<string, string>>
  now: string
}): B2bReplyClassification {
  const subject = input.subject.toLowerCase()
  const head = replyHead(input.text)
  const low = head.toLowerCase()
  const headers = input.headers ?? {}
  if (
    BOUNCE_SUBJECT.some((t) => subject.includes(t)) ||
    /delivery-status/i.test(headers['content-type'] ?? '')
  )
    return { klass: 'bounce', signals: ['bounce'] }
  const autoHeader = /auto-replied|auto-generated/i.test(headers['auto-submitted'] ?? '')
  const autoSubject = AUTO_SUBJECT.find((t) => subject.includes(t))
  const autoBody = AUTO_BODY.find((t) => low.includes(t))
  if (autoHeader || autoSubject !== undefined || (autoBody !== undefined && head.length < 400)) {
    const back = returnDateOf(head, input.now)
    return {
      klass: 'auto_reply',
      signals: [autoHeader ? 'auto-submitted' : `auto:${autoSubject ?? autoBody}`],
      ...(back === undefined ? {} : { return_date: back }),
    }
  }
  for (const rule of RULES) {
    const term = rule.terms.find((t) => low.includes(t) || subject.startsWith(t))
    if (term !== undefined) return { klass: rule.klass, signals: [`${rule.klass}:${term}`] }
  }
  return { klass: 'unknown', signals: [] }
}
