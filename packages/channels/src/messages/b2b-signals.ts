/**
 * WP172（docs/84 §5）：分拣时 B2B 那一侧要认的三样东西——**纯函数**，不花一个 token。
 *
 * 1. {@link platformInquiryOf}：B2B 平台（阿里国际站 / 中国制造网 / 环球资源）的询盘或 RFQ 通知信。
 *    只认域名不够：同一个域名也发营销订阅，所以还要主题 / 正文里有询盘字样。
 * 2. {@link unsubscribeReplyOf}：一封**人回的**退订（"unsubscribe" / 退订 / remove me …）。
 *    群发信（有 `List-Unsubscribe` 头的那种）自己页脚里就写着 unsubscribe，不算。
 * 3. {@link bounceOf}：退信（DSN）。只有**硬退信**（5.x.x、用户不存在）才进抑制名单；
 *    软退信（邮箱满了、临时拒收）过几天可能就好了，不拉黑。
 *
 * 另外一个 {@link looksLikeB2bInquiry}：分拣第 ④ 层（模型）的**兜底与测试锚点**——
 * 模型不可用 / 模拟世界里的替身模型用它判"这像不像一封询盘"（问价、要目录、问 MOQ、
 * 要样品、找代理）。服务进程里真判的是模型，这里只是没有模型时的那一半。
 */

import { B2B_PLATFORM_DOMAINS } from '@agentsws/contracts'
import { isAutomatedMail, type TriageInput } from './triage.js'

const low = (s: string): string => s.toLowerCase()

/** 发件人域名（小写，不带 `@`）。 */
export function senderDomain(from_email: string): string {
  const addr = from_email.trim().toLowerCase()
  const at = addr.lastIndexOf('@')
  return at < 0 ? '' : addr.slice(at + 1)
}

/** 一个域名是不是某个平台域名（本身或它的子域：`notice.alibaba.com`）。 */
function platformOfDomain(domain: string): string | undefined {
  return B2B_PLATFORM_DOMAINS.find((p) => domain === p.domain || domain.endsWith(`.${p.domain}`))
    ?.platform
}

/** 平台通知信里说明"这是一条询盘 / RFQ"的字样。 */
const PLATFORM_INQUIRY_TERMS: readonly string[] = [
  'inquiry',
  'enquiry',
  'rfq',
  'buying request',
  'request for quotation',
  'quotation request',
  'new message from',
  'buyer',
  '询盘',
  '询价',
  '买家',
  '采购需求',
]

/**
 * 平台询盘通知（docs/84 §5 第 3 条）。命中回平台名（`alibaba` …），否则 `undefined`。
 *
 * 阿里国际站的询盘通知只有摘要，正文要去后台看——认出来之后由 B2B 那一路开一个
 * 「去国际站后台回复」的任务（§3.1），这里只管认。
 */
export function platformInquiryOf(
  input: Pick<TriageInput, 'from_email' | 'subject' | 'text'>,
): string | undefined {
  const platform = platformOfDomain(senderDomain(input.from_email))
  if (platform === undefined) return undefined
  const hay = low(`${input.subject}\n${input.text.slice(0, 2000)}`)
  return PLATFORM_INQUIRY_TERMS.some((t) => hay.includes(t)) ? platform : undefined
}

/** 退订的说法（人自己写的回信里）。 */
const UNSUBSCRIBE_TERMS: readonly string[] = [
  'unsubscribe',
  'remove me',
  'take me off',
  'stop emailing',
  'stop sending',
  'stop contacting',
  'do not contact me',
  "don't contact me",
  'do not email me',
  "don't email me",
  'opt out',
  'opt-out',
  '退订',
  '取消订阅',
  '别再发',
  '不要再发',
  '请勿再发',
  '不要再联系',
]

/** 只看开头这么多字：回信开头说"别再发了"才算，引用的旧信尾巴里那个页脚不算。 */
export const UNSUBSCRIBE_HEAD = 400

/**
 * 这封信是不是一封**人回的退订**。命中回那句说法（原样，进事件的是它不是正文）。
 *
 * 群发 / 通知（`isAutomatedMail` 认得出的）一律不算：它们的页脚里本来就有 unsubscribe。
 */
export function unsubscribeReplyOf(input: TriageInput): string | undefined {
  if (isAutomatedMail(input) !== undefined) return undefined
  const head = low(`${input.subject}\n${input.text.slice(0, UNSUBSCRIBE_HEAD)}`)
  return UNSUBSCRIBE_TERMS.find((t) => head.includes(t))
}

export interface BounceSignal {
  /** 退回来的那个收件人（认得出才有）。 */
  recipient?: string
  /** 硬退信（5.x.x / 用户不存在）才进抑制名单。 */
  hard: boolean
  /** DSN 的状态码（`5.1.1`）。 */
  status?: string
}

const BOUNCE_SUBJECTS: readonly string[] = [
  'undeliverable',
  'undelivered mail',
  'delivery status notification',
  'mail delivery failed',
  'delivery failure',
  'returned mail',
  'failure notice',
  'message not delivered',
  '退信',
  '投递失败',
  '无法投递',
  '系统退信',
]

const HARD_TERMS: readonly string[] = [
  'user unknown',
  'unknown user',
  'no such user',
  'does not exist',
  "doesn't exist",
  'mailbox unavailable',
  'recipient address rejected',
  'address rejected',
  'invalid recipient',
  'account has been disabled',
  'mailbox not found',
  '用户不存在',
  '收件人不存在',
  '地址不存在',
]

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i

/**
 * 退信（DSN）。不是退信回 `undefined`。
 *
 * 认法全是结构性的：`mailer-daemon@` / `postmaster@` 发来的、`multipart/report;
 * report-type=delivery-status`、或主题是那几种退信说法。收件人按 `X-Failed-Recipients`
 * → `Final-Recipient` → `<地址>: … 550` 的顺序认；认不出就只记"有一封退信"，不猜。
 */
export function bounceOf(input: TriageInput): BounceSignal | undefined {
  const from = input.from_email.trim().toLowerCase()
  const daemon = /^(mailer-daemon|postmaster)@/.test(from)
  const report = low(input.headers['content-type'] ?? '').includes('report-type=delivery-status')
  const subject = low(input.subject)
  const titled = BOUNCE_SUBJECTS.some((t) => subject.includes(t))
  if (!daemon && !report && !titled) return undefined
  const text = input.text.slice(0, 4000)
  const failed = input.headers['x-failed-recipients']?.match(EMAIL)?.[0]
  const finalRcpt = /final-recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i.exec(text)?.[1]
  const angle = /<([^\s<>]+@[^\s<>]+)>\s*:/.exec(text)?.[1]
  const recipient = (failed ?? finalRcpt ?? angle)?.trim().toLowerCase()
  const status = /\b([245])\.\d{1,3}\.\d{1,3}\b/.exec(text)?.[0]
  const hay = low(text)
  const hard =
    status !== undefined
      ? status.startsWith('5')
      : HARD_TERMS.some((t) => hay.includes(t)) || /\b550\b/.test(hay)
  return {
    hard,
    ...(recipient === undefined || recipient === from ? {} : { recipient }),
    ...(status === undefined ? {} : { status }),
  }
}

/** 询盘的说法（问价、要目录、问 MOQ、要样品、找代理 / 分销、OEM）。 */
const B2B_INQUIRY_TERMS: readonly string[] = [
  'moq',
  'minimum order',
  'price list',
  'pricelist',
  'quotation',
  'quote for',
  'fob',
  'cif',
  'exw',
  'catalog',
  'catalogue',
  'wholesale',
  'distributor',
  'distribution',
  'oem',
  'odm',
  'private label',
  'bulk order',
  'container',
  'lead time',
  'sample order',
  'samples',
  '起订量',
  '报价',
  '批发',
  '代理',
  '经销',
  '目录',
  '样品',
  '贴牌',
  '大货',
]

/**
 * 这封信像不像一封 B2B 询盘（模型那一层的兜底 / 测试锚点）。回命中的说法，没有回空数组。
 *
 * 至少两个说法才算像（一封零售客户的信里出现一个"samples"不该被判成询盘）。
 */
export function looksLikeB2bInquiry(input: Pick<TriageInput, 'subject' | 'text'>): string[] {
  const hay = low(`${input.subject}\n${input.text.slice(0, 2000)}`)
  const hits = B2B_INQUIRY_TERMS.filter((t) =>
    /^[a-z]+$/.test(t) ? new RegExp(`\\b${t}\\b`).test(hay) : hay.includes(t),
  )
  return hits.length >= 2 ? hits : []
}
