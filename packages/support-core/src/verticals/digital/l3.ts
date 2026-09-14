/**
 * Extracted from KefuAgent src/lib/support/verticals/digital/l3.ts
 * （DIGITAL_L3_DENYLIST，S039 FR-020），**逐字节**。
 *
 * 七类：退款、补偿（积分 / SLA）、拒付、法律威胁、账号安全事故、数据删除请求、
 * 服务中断索赔。goods 的产品安全 / 补发 / 取消订单 / 改地址 / 平台投诉**不进** digital
 * ——没有实物就没有召回、补发、改地址，也没有 A-to-Z。
 *
 * 类目集不同 → 两个垂直算出来的规则集哈希必然不同，这是设计而不是巧合：
 * 审计行必须能分辨出这一次用的是哪一套 ruleset。
 *
 * 四类的词表直接**引用 goods 的同名表**（退款 / 补偿 / 拒付 / 法律威胁）：
 * 「我要退款」「我要找律师」在哪个行业都是同一句话，抄一份只会让两边各自漂移。
 */

import { GOODS_L3_DENYLIST } from '../goods/l3.js'
import type { L3DenylistPack, L3PatternTable } from '../types.js'

/** 七类（固定，v1）。顺序即序列化顺序，改动即改 hash。 */
export const DIGITAL_L3_CATEGORIES = [
  'refund',
  'compensation',
  'chargeback_dispute',
  'legal_threat',
  'account_security_incident',
  'data_deletion_request',
  'outage_sla_claim',
] as const

/** 六语，与 goods 同构（检测不预知语言，所有语言 pattern 都跑一遍）。 */
export const DIGITAL_L3_LANGS = GOODS_L3_DENYLIST.langs

/**
 * 邮件 Tier-1：`support_email_classification_result.category` /
 * `classifyInboundEmail` 意图 → L3。
 *
 * 只保留在 digital 里仍然成立的三条；goods 的 `damaged_or_defective_item →
 * replacement_reship` 随类目一起去掉（没有实物可补发）。
 */
const EMAIL_INTENT_TO_L3: Record<string, string> = {
  returns_refunds: 'refund',
  return_or_refund_request: 'refund',
  complaint: 'compensation',
}

/**
 * 聊天 Tier-1：`DigitalChatIntent` → L3。
 *
 * 只有一条无条件映射：**任何账单/额度类会话都不自动发送**。SaaS 的钱都在这一类
 * 意图里（发票、扣费、退款、额度），而 V0 的 digital 没有 `account_context`
 * provider，AI 手上一个账户事实都没有 —— 让它自动发一封谈钱的信，等于让它猜。
 *
 * 另外两条是**带风险门**的（见 `riskGatedChatIntents`）：账号与数据类问题日常
 * 大多是「怎么改邮箱」这种，只有升到高风险（盗号 / 删除数据）才是 L3。
 */
const CHAT_INTENT_TO_L3: Record<string, string> = {
  billing_credits: 'refund',
}

/* ------------------------------------------------------------------ */
/* Tier-2（入站请求形态）                                                */
/* ------------------------------------------------------------------ */

const T2_PATTERNS: Record<string, Partial<Record<string, RegExp[]>>> = {
  refund: GOODS_L3_DENYLIST.t2.refund ?? {},
  compensation: {
    ...(GOODS_L3_DENYLIST.t2.compensation ?? {}),
    // SaaS 的「补偿」是积分 / 账户额度 / 免单月，不是代金券。
    en: [
      ...(GOODS_L3_DENYLIST.t2.compensation?.en ?? []),
      /\b(i|we)\s+(want|need|demand|expect|deserve)\b[^.!?]{0,60}\b(service credit|account credit|credits back|free month|extra credits)\b/i,
    ],
    zh: [
      ...(GOODS_L3_DENYLIST.t2.compensation?.zh ?? []),
      /(要|想要|需要|请|要求)[^。！？]{0,20}(返还|补回|补偿)[^。！？]{0,6}(积分|额度|时长)/,
    ],
  },
  chargeback_dispute: GOODS_L3_DENYLIST.t2.chargeback_dispute ?? {},
  legal_threat: GOODS_L3_DENYLIST.t2.legal_threat ?? {},
  account_security_incident: {
    en: [
      /\b(my|our)\s+(account|profile|workspace)\b[^.!?]{0,40}\b(hacked|compromised|breached|stolen|taken over)\b/i,
      /\b(unauthori[sz]ed|unauthori[sz]ed access|someone else)\b[^.!?]{0,40}\b(access|accessed|logged in|login|charge|activity|using my)\b/i,
      /\bdata breach\b/i,
      /\bsomeone\b[^.!?]{0,30}\b(logged in|is using|got into)\b[^.!?]{0,30}\b(my account|our account)\b/i,
    ],
    zh: [
      /(账号|帐号|账户)[^。！？]{0,10}(被盗|被入侵|被盗用|遭入侵|被人登录)/,
      /(未授权|未经授权|不是我)[^。！？]{0,10}(登录|访问|操作|扣费)/,
      /(数据|信息)[^。！？]{0,6}泄[露漏]/,
    ],
    es: [
      /\b(mi )?cuenta\b[^.!?]{0,30}\b(hackeada|comprometida|robada)\b/i,
      /\bacceso no autorizado\b/i,
    ],
    fr: [
      /\b(mon )?compte\b[^.!?]{0,30}\b(pirat[ée]|compromis|vol[ée])\b/i,
      /\bacc[eè]s non autoris[ée]\b/i,
    ],
    de: [
      /\b(mein )?(konto|account)\b[^.!?]{0,30}\b(gehackt|kompromittiert|gestohlen)\b/i,
      /\bunbefugter zugriff\b/i,
    ],
    ja: [/(アカウント).{0,10}(乗っ取|不正アクセス|盗ま)/, /(情報|データ).{0,6}漏[洩え]/],
  },
  data_deletion_request: {
    en: [
      /\b(delete|erase|remove|wipe|purge)\b[^.!?]{0,30}\b(my|our|all my|all our)\s+(data|account|information|personal data|records)\b/i,
      /\b(gdpr|ccpa|dsar)\b[^.!?]{0,40}\b(request|delete|deletion|erasure|access|export)\b/i,
      /\bright to be forgotten\b/i,
      /\b(export|download)\b[^.!?]{0,30}\b(my|our|all my)\s+(data|personal data)\b/i,
    ],
    zh: [
      /(删除|清除|抹除|注销)[^。！？]{0,10}(我的|我们的)?(数据|账号|帐号|账户|个人信息)/,
      /(导出|下载)[^。！？]{0,10}(我的|我们的)?(全部)?(数据|个人信息)/,
    ],
    es: [
      /\b(elimin|borr|supprim)[a-zéó]*\b[^.!?]{0,30}\b(mis|mi|nuestros)\s+(datos|cuenta|informaci[oó]n)\b/i,
    ],
    fr: [
      /\b(supprim|effac)[a-zé]*\b[^.!?]{0,30}\b(mes|mon|nos)\s+(donn[ée]es|compte)\b/i,
      /\bdroit [àa] l'oubli\b/i,
    ],
    de: [
      /\b(meine|unsere)\s+(daten|konto|account)\b[^.!?]{0,30}\b(l[oö]schen|entfernen)\b/i,
      /\bl[oö]schen sie\b[^.!?]{0,30}\b(meine|unsere)\s+daten\b/i,
    ],
    ja: [/(データ|アカウント|個人情報).{0,10}(削除|消去|抹消)/],
  },
  outage_sla_claim: {
    en: [
      /\b(sla|uptime)\b[^.!?]{0,40}\b(credit|credits|breach|violat|guarantee|refund|compensation)\b/i,
      /\b(down|outage|downtime|unavailable)\b[^.!?]{0,50}\b(refund|compensation|credit|credits|sla)\b/i,
      /\b(i|we)\s+(want|need|demand|expect)\b[^.!?]{0,50}\b(for the (outage|downtime)|because (you|it) (were|was) down)\b/i,
    ],
    zh: [
      /(宕机|停机|中断|不可用|挂了)[^。！？]{0,25}(赔偿|补偿|索赔|退款|sla)/i,
      /(sla)[^。！？]{0,20}(赔偿|补偿|违约|索赔)/i,
    ],
    es: [/\b(ca[ií]da|inactividad|sla)\b[^.!?]{0,40}\b(compensaci[oó]n|reembolso|cr[eé]dito)\b/i],
    fr: [
      /\b(panne|indisponibilit[ée]|sla)\b[^.!?]{0,40}\b(compensation|remboursement|cr[ée]dit)\b/i,
    ],
    de: [/\b(ausfall|st[oö]rung|sla)\b[^.!?]{0,40}\b(entsch[aä]digung|erstattung|gutschrift)\b/i],
    ja: [/(障害|停止|ダウン|sla).{0,20}(補償|返金|クレジット)/i],
  },
}

/* ------------------------------------------------------------------ */
/* Tier-3（出站承诺形态）                                                */
/* ------------------------------------------------------------------ */

const T3_PATTERNS: Record<string, Partial<Record<string, RegExp[]>>> = {
  refund: GOODS_L3_DENYLIST.t3.refund ?? {},
  compensation: {
    ...(GOODS_L3_DENYLIST.t3.compensation ?? {}),
    en: [
      ...(GOODS_L3_DENYLIST.t3.compensation?.en ?? []),
      /\bwe\s+(will|can|'ll|have|'ve)\b[^.!?]{0,60}\b(add|credit|grant|top up)\b[^.!?]{0,40}\b(credits|to your account|free month|extra quota)\b/i,
    ],
    zh: [
      ...(GOODS_L3_DENYLIST.t3.compensation?.zh ?? []),
      /(为您|给您|帮您|已为您)?(补|返|加|赠送)[^。！？]{0,10}(积分|额度|时长|一个月)/,
    ],
  },
  chargeback_dispute: GOODS_L3_DENYLIST.t3.chargeback_dispute ?? {},
  legal_threat: GOODS_L3_DENYLIST.t3.legal_threat ?? {},
  account_security_incident: {
    en: [
      // 词干 + `[a-z]*`：现网最常见的出站承诺是完成时（"we have restored your
      // account"），`\brestore\b` 对 "restored" 不成立，正好漏掉最危险的那一句。
      /\bwe\s+(will|can|'ll|have|'ve)\b[^.!?]{0,50}\b(restor|recover|secur|unlock|reset)[a-z]*\b[^.!?]{0,30}\b(your (account|access|password))\b/i,
      /\bwe (can )?confirm\b[^.!?]{0,50}\b(no (data|information) (was|has been)|there was no (breach|unauthori))\b/i,
    ],
    zh: [
      /(我们)?(会|将|已)[^。！？]{0,20}(恢复|找回|解锁|重置)[^。！？]{0,10}(您的)?(账号|帐号|账户|访问权限|密码)/,
      /(我们)?(确认|可以确认)[^。！？]{0,15}(没有|未)[^。！？]{0,10}(数据泄[露漏]|越权访问|被盗)/,
    ],
    es: [],
    fr: [],
    de: [],
    ja: [],
  },
  data_deletion_request: {
    en: [
      /\bwe\s+(will|can|'ll|have|'ve)\b[^.!?]{0,50}\b(delete|erase|remove|purge|wipe)\b[^.!?]{0,40}\b(your (data|account|information)|all your data)\b/i,
      /\byour (data|account) (has been|have been|will be) (deleted|erased|removed|purged)\b/i,
    ],
    zh: [
      /(我们)?(会|将|已)[^。！？]{0,20}(删除|清除|注销)[^。！？]{0,10}(您的)?(数据|账号|帐号|个人信息)/,
    ],
    es: [],
    fr: [],
    de: [],
    ja: [],
  },
  outage_sla_claim: {
    en: [
      /\bwe\s+(will|can|'ll)\b[^.!?]{0,50}\b(credit|compensate|refund|extend)\b[^.!?]{0,50}\b(for the (outage|downtime)|your (subscription|account|plan))\b/i,
      /\bwe\s+(will|'ll)\b[^.!?]{0,40}\bhonou?r\b[^.!?]{0,20}\bsla\b/i,
    ],
    zh: [
      /(我们)?(会|将)[^。！？]{0,20}(补偿|赔偿|退款|延长)[^。！？]{0,15}(宕机|停机|中断|您的订阅|您的账号)/,
    ],
    es: [],
    fr: [],
    de: [],
    ja: [],
  },
}

export const DIGITAL_L3_DENYLIST: L3DenylistPack = {
  categories: DIGITAL_L3_CATEGORIES,
  langs: DIGITAL_L3_LANGS,
  t2: T2_PATTERNS as L3PatternTable,
  t3: T3_PATTERNS as L3PatternTable,
  emailIntentMap: EMAIL_INTENT_TO_L3,
  chatIntentMap: CHAT_INTENT_TO_L3,
  // 第一人称承诺框架与行业无关（"we will …" / "我们会为您…"），引用 goods 的同一
  // 个正则，不复制。它同时是 unsourced_concession 兜底的触发条件之一。
  firstPersonCommitment: GOODS_L3_DENYLIST.firstPersonCommitment,
  /**
   * 「意图本身不够、还要看风险等级」的映射（同 goods 的 product_issue 语义）。
   *
   * - `account_access` 高风险 = 命中盗号 / 未授权访问词 → 账号安全事故；
   * - `data_privacy` 高风险 = 命中删除 / GDPR 词 → 数据删除请求（有法定时限，
   *   答错就是合规事故）；
   * - `bug_report` 高风险 = 命中 outage / SLA / 数据丢失词 → 服务中断索赔。
   */
  riskGatedChatIntents: {
    account_access: {
      riskLevel: 'high',
      category: 'account_security_incident',
    },
    data_privacy: { riskLevel: 'high', category: 'data_deletion_request' },
    bug_report: { riskLevel: 'high', category: 'outage_sla_claim' },
  },
}
