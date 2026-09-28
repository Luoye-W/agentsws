/**
 * WP171（docs/84 §2.1 / §3.1 / §11.3）：B2B 的承诺词表与"改收款账户"识别。
 *
 * 两份东西、两种后果：
 *
 * 1. **承诺词表**（{@link B2B_COMMITMENT_TERMS}）：价格、交期、认证、MOQ、独家、账期、保证。
 *    出处是 BtoBAgents `domain/policy.ts` 那条「邮件含价格 / 交期 / 认证 / 合同承诺要人审」。
 *    回询盘（`b2b_reply`）碰到 → **转人审**（出卡）；开发信（`b2b_outreach`）碰到 →
 *    **block**（同红人开发信：冷邮件里不该有"人点一下就发出去"的承诺）。
 * 2. **改收款账户**（{@link detectPaymentAccountChange}）：B2B 最常见的邮件诈骗是冒充客户
 *    或自己人改账户。命中 = 出红卡、**不采纳**信里的任何账户信息；收款账户只从事实卡取。
 *
 * 大小写不敏感。**只可加行**（15 §2 对规则集的老规矩）。起草那一跳与 guardrail 读的是
 * 同一个数组，不许各写一张。
 */
import type { PaymentAccountChangeSignal } from '@agentsws/contracts'

export type B2bCommitmentCategory =
  | 'price'
  | 'lead_time'
  | 'certification'
  | 'moq'
  | 'exclusive'
  | 'payment_terms'
  | 'guarantee'

/** 七类承诺说法。类名进 guardrail 的 hit，卡面上按类说人话。 */
export const B2B_COMMITMENT_TERMS: Readonly<Record<B2bCommitmentCategory, readonly string[]>> = {
  price: [
    '单价',
    '报价是',
    '价格是',
    '美元/个',
    '美金',
    'unit price',
    'price is',
    'per piece',
    '/pc',
    '/pcs',
    'usd ',
    'us$',
    'fob price',
    'cif price',
    'exw price',
  ],
  lead_time: [
    '交期',
    '交货期',
    '天内发货',
    '天出货',
    '保证交期',
    'lead time',
    'delivery time',
    'ship within',
    'ready in',
    'days after deposit',
  ],
  certification: [
    '已通过认证',
    '有认证',
    '认证齐全',
    'ce certified',
    'fcc certified',
    'ul certified',
    'rohs compliant',
    'certified by',
    'we have ce',
    'we have fcc',
  ],
  moq: ['起订量', '最小起订', 'moq', 'minimum order'],
  exclusive: ['独家', '独家代理', '唯一代理', 'exclusive', 'sole distributor', 'sole agent'],
  payment_terms: [
    '账期',
    '月结',
    '货到付款',
    '赊销',
    'net 30',
    'net 60',
    'net 90',
    'payment terms',
    'open account',
    'o/a',
    'l/c at sight',
    'days credit',
  ],
  guarantee: ['保证', '一定能', '绝对', 'guarantee', 'guaranteed', 'we promise', '100% no defect'],
}

export interface B2bCommitmentHit {
  category: B2bCommitmentCategory
  term: string
}

/** 扫一段正文里的承诺说法（每类最多报一个命中词，按表里的顺序）。 */
export function scanB2bCommitments(text: string): B2bCommitmentHit[] {
  const body = text.toLowerCase()
  const out: B2bCommitmentHit[] = []
  for (const [category, terms] of Object.entries(B2B_COMMITMENT_TERMS) as [
    B2bCommitmentCategory,
    readonly string[],
  ][]) {
    const term = terms.find((t) => body.includes(t.toLowerCase()))
    if (term !== undefined) out.push({ category, term })
  }
  return out
}

/** 卡面上念的类名（不把枚举值印上去，36 §2）。 */
export const B2B_COMMITMENT_LABELS: Readonly<Record<B2bCommitmentCategory, string>> = {
  price: '价格',
  lead_time: '交期',
  certification: '认证',
  moq: '起订量',
  exclusive: '独家',
  payment_terms: '账期',
  guarantee: '保证',
}

/* ── 改收款账户（docs/84 §11.3 防诈骗）──────────────────────────────────── */

/**
 * "改收款账户"的说法。命中任何一条就是红卡——不管信是不是看起来来自老客户：
 * 诈骗信恰恰是从被盗的真邮箱发出来的。
 */
export const PAYMENT_ACCOUNT_CHANGE_PHRASES: readonly string[] = [
  '更换收款账户',
  '更改收款账户',
  '新的收款账户',
  '新收款账户',
  '收款账户变更',
  '收款账号变更',
  '银行账户变更',
  '账户已变更',
  '换了银行账户',
  '请汇款至新',
  '请付款到以下新',
  'new bank account',
  'new bank details',
  'new banking details',
  'new account details',
  'changed our bank',
  'change of bank',
  'bank details have changed',
  'banking details have changed',
  'updated bank details',
  'update our bank',
  'account is under audit',
  'account is currently under audit',
  'remit to the following account',
  'pay to the following account',
  'use the account below instead',
]

/** 信里有没有像账户的东西：一个账户字样 + 一串 6 位以上的数字（号码本身不回显）。 */
const ACCOUNT_WORDS =
  /(iban|swift|bic\b|account\s*(no|number|#)|a\/c\s*(no)?|routing|beneficiary|开户行|账号|帐号|收款人账户)/i
const LONG_DIGITS = /\d[\d\s-]{5,}\d/
/** 一句"换 / 新"的话（和账户字样同时出现才算）。 */
const CHANGE_WORDS = /(\bnew\b|\bchang|\bupdat|\bswitch|更换|更改|变更|新的|改用|换成)/i

/**
 * 识别一封信是不是在要求"改收款账户"。
 *
 * 两条路都算命中：
 * 1. 出现 {@link PAYMENT_ACCOUNT_CHANGE_PHRASES} 里的说法；
 * 2. 出现账户字样 + 长数字，**同时**有"换 / 新"的字眼（"我们换了新账户：IBAN …"）。
 *
 * 只出现账户字样与数字、没有"换"的字眼（比如对方复述我们给过的账户）不算命中，
 * 但 `has_account_details` 照实报——调用方要不要多看一眼由它定。
 */
export function detectPaymentAccountChange(text: string): PaymentAccountChangeSignal {
  const body = text.toLowerCase()
  const phrases = PAYMENT_ACCOUNT_CHANGE_PHRASES.filter((p) => body.includes(p.toLowerCase()))
  const has_account_details = ACCOUNT_WORDS.test(text) && LONG_DIGITS.test(text)
  const combo = has_account_details && CHANGE_WORDS.test(text)
  return {
    hit: phrases.length > 0 || combo,
    phrases: phrases.length > 0 ? phrases : combo ? ['账户信息 + 更换字眼'] : [],
    has_account_details,
  }
}
