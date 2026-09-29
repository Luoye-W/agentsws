/**
 * WP182（docs/84 §3.1）：询盘分级与首回——`b2b-inquiry` 技能「先分级」「首回怎么写」「需求确认清单」
 * 那三段落成的纯函数。服务进程与模拟世界用同一份。
 *
 * 分级是**给人看的提示**：卡上一档 + 一句理由；回信对谁都一样礼貌。诈骗嫌疑（D）不起草、出红卡。
 * 判据全是技能正文里列的信号，逐条对得上（改信号先改技能正文）。
 */
import type { B2bInquiryGrade } from '@agentsws/contracts'
import { detectPaymentAccountChange } from '@agentsws/core'

export interface InquirySignalsInput {
  subject: string
  text: string
  from_email: string
  /** 附件文件名（只看名字与类型，不打开）。 */
  attachments?: readonly string[]
  /** 发件人在客户库里 / 回的是我们的信。 */
  known?: boolean
}

export interface InquiryGrading {
  grade: B2bInquiryGrade
  /** 命中的信号（中文一句一个），卡上照写。 */
  reasons: string[]
}

/** 免费邮箱（自称大公司却用免费邮箱是诈骗信号之一）。 */
const FREE_MAIL =
  /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|qq|163|126|aol|proton|protonmail|gmx|mail|yandex)\./i
const BIG_NAMES = /\b(walmart|amazon|costco|carrefour|tesco|target|best ?buy|ikea|lidl|aldi)\b/i
const RISKY_ATTACHMENT = /\.(zip|rar|7z|exe|scr|js|jar|html?|iso|img|docm|xlsm|pptm|bat|cmd|vbs)$/i

const SCAM_RULES: readonly { re: RegExp; reason: string }[] = [
  {
    re: /(click|open|visit|follow)[^.\n]{0,40}(link|url)[^.\n]{0,60}(view|see|download|check)[^.\n]{0,30}(order|inquiry|rfq|po|quotation|purchase)|(log ?in|sign ?in)[^.\n]{0,50}(view|see|download)[^.\n]{0,30}(order|inquiry|rfq|po)/i,
    reason: '要先点链接 / 登录某个网站才能「看询价单」（钓鱼常见手法）',
  },
  {
    re: /(registration|certification|membership|vendor|supplier|listing|legal|lawyer|entry)\s+(fee|charge)|入围费|注册费|认证费|律师费/i,
    reason: '要先付注册费 / 认证费 / 律师费才能当供应商',
  },
  {
    re: /(urgent|asap|immediately)[^.\n]{0,80}(large|big|huge|bulk)\s+(order|quantity)[^.\n]{0,80}(any price|price is not|no matter the price|whatever price)/i,
    reason: '大单急得离谱、价格不问',
  },
]

const SAMPLE_RULES: readonly { re: RegExp; reason: string }[] = [
  {
    re: /free\s+samples?|免费样品/i,
    reason: '一上来就要免费样品',
  },
  {
    re: /(freight|shipping|courier)\s+(collect|free|paid by you)|you (pay|cover) (the )?(shipping|freight)|运费你们付|包邮/i,
    reason: '运费也不肯付',
  },
  {
    re: /(one|1)\s+(piece|pc|sample)\s+(of|for)\s+(each|every|all)|each (model|item|style) one|每款一个/i,
    reason: '要很多款、每款一个',
  },
]

const COMPARING_RULES: readonly { re: RegExp; reason: string }[] = [
  {
    re: /dear\s+(supplier|sir|madam|sir\/madam|sir or madam|manufacturer)/i,
    reason: '抬头是群发式的',
  },
  {
    re: /\b(best|lowest|cheapest)\s+price\b|\bprice\s*list\b|catalog(ue)?\s+(and|with)\s+price|价格表|最低价/i,
    reason: '只问最低价 / 价格表',
  },
]

const BUYER_RULES: readonly { re: RegExp; reason: string }[] = [
  {
    re: /\b\d[\d,.]*\s*(k\s*)?(pcs|pieces|units|sets|cartons|ctns)\b|\b(moq|order quantity|首单|数量)\b[^.\n]{0,30}\d/i,
    reason: '说得出数量',
  },
  {
    re: /\b\d{2,3}\s*w\b|\b\d{4,5}\s*mah\b|usb[- ]?c|type[- ]?c|\bpd\s*3|\bqi2?\b|bluetooth\s*\d|\banc\b|gan\b|model\s*(no\.?|number)?\s*[a-z0-9-]{3,}/i,
    reason: '说得出型号或规格',
  },
  {
    re: /\b(ce|fcc|rohs|ukca|pse|ul|etl|reach|kc|matter|un38\.3)\b/i,
    reason: '主动提认证要求',
  },
  {
    re: /\b(fob|cif|exw|ddp|dap|fca)\b|port of|destination port|目的港/i,
    reason: '提了贸易术语或目的港',
  },
  {
    re: /(our|we are a|we're a)\s+(company|distributor|retailer|brand|importer|wholesaler|chain)|we sell (on|through|in)|our (stores|customers|shop)/i,
    reason: '说了自己是谁、在哪卖',
  },
]

const hitsOf = (rules: readonly { re: RegExp; reason: string }[], hay: string): string[] =>
  rules.filter((r) => r.re.test(hay)).map((r) => r.reason)

/**
 * 给一封询盘分级。顺序就是严重程度：诈骗嫌疑 > 骗样嫌疑 > 真买家 > 在比价。
 *
 * - **诈骗嫌疑**：钓鱼链接 / 先交费 / 危险附件 / 自称大公司却用免费邮箱 / 要改收款账户，命中一条就算。
 * - **骗样嫌疑**：要免费样品，再加运费不付 / 每款一个 / 别的都不问（至少两条，或只要样品不问别的）。
 * - **真买家**：客户库里认得，或数量 / 规格 / 认证 / 术语 / 自我介绍里至少两样。
 * - 其余都按**在比价**：看不出数量和规格，先问清需求。
 */
export function gradeB2bInquiry(input: InquirySignalsInput): InquiryGrading {
  const hay = `${input.subject}\n${input.text}`
  const scam = hitsOf(SCAM_RULES, hay)
  const attachments = input.attachments ?? []
  if (attachments.some((a) => RISKY_ATTACHMENT.test(a.trim())))
    scam.push('附件是压缩包 / 可执行文件 / 带宏的文档')
  if (FREE_MAIL.test(input.from_email) && BIG_NAMES.test(hay)) scam.push('自称大公司却用免费邮箱')
  const account = detectPaymentAccountChange(hay)
  if (account.hit) scam.push('要求改收款账户')
  if (scam.length > 0) return { grade: 'scam', reasons: scam }

  const buyer = hitsOf(BUYER_RULES, hay)
  const sample = hitsOf(SAMPLE_RULES, hay)
  const wantsFreeSample = sample.includes(SAMPLE_RULES[0]?.reason ?? '')
  if (wantsFreeSample && (sample.length >= 2 || buyer.length === 0))
    return {
      grade: 'sample_hunter',
      reasons: buyer.length === 0 ? [...sample, '除了样品别的都不问'] : sample,
    }

  if (input.known === true)
    return { grade: 'buyer', reasons: ['客户库里认得这个人 / 这家公司', ...buyer] }
  if (buyer.length >= 2) return { grade: 'buyer', reasons: buyer }

  const comparing = hitsOf(COMPARING_RULES, hay)
  return {
    grade: 'comparing',
    reasons: comparing.length > 0 ? comparing : ['看不出数量和规格，先问清需求'],
  }
}

/* ── 需求确认清单（技能「需求确认清单」那六样）──────────────────────────── */

export type RequirementId =
  | 'quantity'
  | 'target_price'
  | 'certification'
  | 'lead_time'
  | 'packaging'
  | 'payment'

export const REQUIREMENTS: readonly {
  id: RequirementId
  zh: string
  /** 信里已经说了的认法。 */
  stated: RegExp
  /** 首回里怎么问（英文，对方多半用英文）。 */
  ask: string
}[] = [
  {
    id: 'quantity',
    zh: '数量',
    stated: /\b\d[\d,.]*\s*(k\s*)?(pcs|pieces|units|sets|cartons|ctns)\b|order quantity\s*\d/i,
    ask: 'How many pieces would the first order be, and roughly how many per year?',
  },
  {
    id: 'target_price',
    zh: '目标价',
    stated: /target price|our budget|current price|\$\s?\d|usd\s?\d/i,
    ask: 'Do you have a target price or a current purchase price in mind?',
  },
  {
    id: 'certification',
    zh: '认证',
    stated: /\b(ce|fcc|rohs|ukca|pse|ul|etl|reach|kc|matter)\b/i,
    ask: 'Which markets will you sell in, and which certifications do you need (e.g. CE, FCC, UKCA)?',
  },
  {
    id: 'lead_time',
    zh: '交期',
    stated:
      /deliver(y|ed)? (by|before|in)|need (it|them|the goods) (by|before)|lead time of|ship (by|before)/i,
    ask: 'When do you need the goods, and to which port or city?',
  },
  {
    id: 'packaging',
    zh: '包装',
    stated: /packag|gift box|color box|neutral|logo|private label|oem/i,
    ask: 'Neutral packing, a color box, or custom packaging with your logo?',
  },
  {
    id: 'payment',
    zh: '付款方式',
    stated: /t\/t|\btt\b|l\/c|letter of credit|deposit|payment terms|net\s?\d{2}/i,
    ask: 'Which payment method do you prefer (T/T deposit + balance, L/C …)?',
  },
]

/** 信里还没说的那几样（按清单顺序）。 */
export function missingRequirements(text: string): RequirementId[] {
  return REQUIREMENTS.filter((r) => !r.stated.test(text)).map((r) => r.id)
}
