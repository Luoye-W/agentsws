/**
 * Extracted from KefuAgent src/lib/support/policy/l3-denylist.ts +
 * src/lib/support/verticals/goods/l3.ts（九类六语的 Tier-2 / Tier-3 词表、第一人称
 * 承诺框架正则、子句级否定守卫、句内共现的让步兜底）与
 * src/lib/support/knowledge-learning.ts（`POLICY_COMMITMENT_RE` 金额 / 百分比 /
 * 期限让步检测），rewritten for agentsws contracts。
 *
 * **词表与正则逐字节抄 KefuAgent**：契约是「只可加行、绝不删 / 弱化行」，而
 * `GATE_RULESET_HASH` 是自主发送审计链的锚——每条门决策都印这个哈希。删一行、
 * 挪一个键名、改一个字符，哈希就变，快照测试当场红。
 *
 * ## 三层检测
 *
 * - **Tier-1**：结构化意图映射。分类器说了话就按它的意图 / 类目查表。
 * - **Tier-2**（入站盲扫）：第一 / 第二人称的请求构造，围绕类目名词 / 动词集。
 *   裸名词出现（单个 `refund`）**不构成**命中。**仅当分类器没说话时**跑，
 *   命中即 fail-closed——over-holding 是这一层的正确方向。
 * - **Tier-3**（出站承诺）：第一人称商家承诺构造 + 具体新让步。信息性政策援引
 *   （"our refund policy allows returns within 30 days" 作为 FAQ 回答）靠"承诺
 *   动词绑定第一人称主语"区分；模板无法区分处偏向匹配（fail-closed）。
 */

import { sha256 } from '@agentsws/core'

/** 九类「AI 永远不得自主承诺」的高风险动作。任何语言、任何配置下都不行。 */
export type L3Category =
  | 'refund'
  | 'compensation'
  | 'replacement_reship'
  | 'cancel_order'
  | 'address_change'
  | 'chargeback_dispute'
  | 'legal_threat'
  | 'product_safety'
  | 'platform_complaint'

export type L3DetectionTier = 't1' | 't2' | 't3'

/** 支持语言。检测不需要预知文本语言：所有语言 pattern 都跑一遍。 */
export type L3Lang = 'en' | 'zh' | 'es' | 'fr' | 'de' | 'ja'

export const L3_CATEGORIES = [
  'refund',
  'compensation',
  'replacement_reship',
  'cancel_order',
  'address_change',
  'chargeback_dispute',
  'legal_threat',
  'product_safety',
  'platform_complaint',
] as const satisfies readonly L3Category[]

export const L3_LANGS = ['en', 'zh', 'es', 'fr', 'de', 'ja'] as const satisfies readonly L3Lang[]

/** `l3:<cat>#t1` | `l3:<cat>#t2:<lang>` | `l3:<cat>#t3:<lang>`。 */
export function formatL3Rule(category: L3Category, tier: L3DetectionTier, lang?: L3Lang): string {
  if (tier === 't1') return `l3:${category}#t1`
  return `l3:${category}#${tier}:${lang}`
}

/* ------------------------------------------------------------------ */
/* 1. Tier-1 意图映射                                                   */
/* ------------------------------------------------------------------ */

/** 邮件意图 / 类目 → L3（大小写不敏感）。 */
const EMAIL_INTENT_TO_L3: Readonly<Record<string, L3Category>> = {
  returns_refunds: 'refund',
  return_or_refund_request: 'refund',
  complaint: 'compensation',
  damaged_or_defective_item: 'replacement_reship',
}

/** 聊天意图 → L3。 */
const CHAT_INTENT_TO_L3: Readonly<Record<string, L3Category>> = {
  return_refund: 'refund',
}

/**
 * 「意图本身不够、还要看风险等级」的那几条：`product_issue` 只在高风险（安全词）
 * 时落 `product_safety`——普通的"这个东西不好用"不是安全事故。
 */
const RISK_GATED_CHAT_INTENTS: Readonly<
  Record<string, { risk_level: 'normal' | 'high'; category: L3Category }>
> = {
  product_issue: { risk_level: 'high', category: 'product_safety' },
}

function mapIntent(
  table: Readonly<Record<string, L3Category>>,
  intent: string | null | undefined,
): L3Category | undefined {
  if (intent === null || intent === undefined || intent.length === 0) return undefined
  return table[intent.trim().toLowerCase()]
}

export function mapEmailIntentToL3(intent: string | null | undefined): L3Category | undefined {
  return mapIntent(EMAIL_INTENT_TO_L3, intent)
}

export function mapChatIntentToL3(
  intent: string | null | undefined,
  risk_level: 'normal' | 'high',
): L3Category | undefined {
  if (intent === null || intent === undefined || intent.length === 0) return undefined
  const key = intent.trim().toLowerCase()
  const gate = RISK_GATED_CHAT_INTENTS[key]
  if (gate !== undefined) return risk_level === gate.risk_level ? gate.category : undefined
  return mapIntent(CHAT_INTENT_TO_L3, key)
}

/* ------------------------------------------------------------------ */
/* 2. Tier-2 / Tier-3 词表（逐字节抄 KefuAgent goods 包）                 */
/* ------------------------------------------------------------------ */

type PatternTable = Readonly<Record<string, Partial<Record<string, readonly RegExp[]>>>>

/** Tier-2（入站请求形态）：第一 / 第二人称的请求构造，裸名词不算命中。 */
const T2_PATTERNS: PatternTable = {
  refund: {
    en: [
      /\b(i|we)\s+(want|need|demand|would like|request|expect)\b[^.!?]{0,60}\brefund\b/i,
      /\bgive me (my|a) (money back|refund)\b/i,
      /\brefund\b[^.!?]{0,30}\b(please|now|asap)\b/i,
    ],
    zh: [/(要|想要|需要|请|给我|要求)[^。！？]{0,20}退(款|钱)/],
    es: [
      /\b(quiero|necesito|exijo|solicito)\b[^.!?]{0,40}\breembols/i,
      /\bdevuelvan?\s+(mi|el)\s+dinero\b/i,
    ],
    fr: [/\b(je veux|nous voulons|j'exige|je demande|je souhaite)\b[^.!?]{0,40}\brembours/i],
    de: [
      /\b(ich|wir)\s+(will|wollen|möchte|verlange|fordere|brauche)\b[^.!?]{0,40}\b(rückerstattung|erstattung|geld zurück)\b/i,
    ],
    ja: [/返金\s*(して|を|し)/],
  },
  compensation: {
    en: [
      /\b(i|we)\s+(want|need|demand|expect|deserve)\b[^.!?]{0,60}\b(compensation|compensate|goodwill|voucher|store credit)\b/i,
    ],
    zh: [/(要|想要|需要|请|要求)[^。！？]{0,20}(赔偿|补偿|赔付)/],
    es: [/\b(quiero|necesito|exijo|solicito)\b[^.!?]{0,40}\b(compensaci[oó]n|indemnizaci[oó]n)\b/i],
    fr: [
      /\b(je veux|nous voulons|j'exige|je demande)\b[^.!?]{0,40}\b(compensation|d[ée]dommagement|indemnisation)\b/i,
    ],
    de: [
      /\b(ich|wir)\s+(will|wollen|verlange|fordere)\b[^.!?]{0,40}\b(entsch[aä]digung|wiedergutmachung)\b/i,
    ],
    ja: [/(補償|賠償)\s*(して|を)/],
  },
  replacement_reship: {
    en: [
      /\b(i|we)\s+(want|need|demand|request)\b[^.!?]{0,60}\b(replacement|reship|resend|new one sent)\b/i,
      /\bsend me (a|another)\b[^.!?]{0,30}\b(replacement|one)\b/i,
    ],
    zh: [/(要|想要|需要|请|要求)[^。！？]{0,20}(补发|重发|换新|换货)/],
    es: [/\b(quiero|necesito|exijo)\b[^.!?]{0,40}\b(reemplazo|reenv[ií]o|reponer)\b/i],
    fr: [
      /\b(je veux|nous voulons|j'exige|je demande)\b[^.!?]{0,40}\b(remplacement|renvoi|renvoyer)\b/i,
    ],
    de: [
      /\b(ich|wir)\s+(will|wollen|verlange|fordere)\b[^.!?]{0,40}\b(ersatz|neu(e)? sendung|erneut senden)\b/i,
    ],
    ja: [/(交換|再送|再発送)\s*(して|を)/],
  },
  cancel_order: {
    en: [
      /\b(please\s+)?cancel (my|the|this)\s+order\b/i,
      /\b(i|we)\s+(want|need|would like)\s+to cancel\b[^.!?]{0,30}\border\b/i,
    ],
    zh: [/(取消|撤销|作废)[^。！？]{0,10}(这个|该|我的|此)?订单/],
    es: [/\bcancel(en|ar|e)\b[^.!?]{0,20}\b(mi|el|este)\s+pedido\b/i],
    fr: [/\bannul(er|ez|e)\b[^.!?]{0,20}\b(ma|la|cette)\s+commande\b/i],
    de: [
      /\b(meine|die|diese)\s+bestellung\b[^.!?]{0,20}\bstornieren\b/i,
      /\bstornieren\s+sie\b[^.!?]{0,20}\bbestellung\b/i,
    ],
    ja: [/注文\s*(を)?\s*(キャンセル|取り消)/],
  },
  address_change: {
    en: [
      /\b(change|update|correct)\b[^.!?]{0,30}\b(shipping|delivery|my)\s+address\b/i,
      /\b(i|we)\s+(need|want)\s+to\b[^.!?]{0,30}\baddress\b[^.!?]{0,20}\bchange(d)?\b/i,
    ],
    zh: [/(修改|更改|变更|换)[^。！？]{0,10}(收货|收件|邮寄)?地址/],
    es: [/\bcambi(ar|e|en)\b[^.!?]{0,30}\b(direcci[oó]n)\b/i],
    fr: [/\b(changer|modifier)\b[^.!?]{0,30}\b(adresse)\b/i],
    de: [/\b(liefer)?adresse\b[^.!?]{0,20}\b(ändern|zu ändern)\b/i],
    ja: [/(配送先|住所|お届け先)[^。！？]{0,10}(変更|修正)/],
  },
  chargeback_dispute: {
    en: [
      /\b(chargeback|charge\s*back)\b/i,
      /\b(open(ed)?|file(d)?|start(ed)?|dispute(d)?)\b[^.!?]{0,40}\b(dispute|chargeback|with my bank|bank claim)\b/i,
      /\bdispute (this|the) (charge|payment|transaction)\b/i,
    ],
    zh: [/(拒付|撤销付款|银行争议|支付争议)/],
    es: [/\b(contracargo|devoluci[oó]n de cargo|disputa con (el|mi) banco)\b/i],
    fr: [/\b(rétrofacturation|litige avec (ma|la) banque|opposition)\b/i],
    de: [/\b(rückbuchung|chargeback|zahlungsstreit)\b/i],
    ja: [/(チャージバック|支払い?拒否|銀行.{0,4}異議)/],
  },
  legal_threat: {
    en: [
      /\b(my )?(lawyer|attorney|solicitor)\b[^.!?]{0,40}\b(contact|reach|sue|be in touch|will)\b/i,
      /\b(i|we)('| wi)?ll (sue|take legal action|see you in court)\b/i,
      /\blegal action\b/i,
    ],
    zh: [/(律师|起诉|法律行动|法院见|上法庭|诉讼)/],
    es: [/\b(abogado|acci[oó]n legal|demandar|los ver[eé] en (el )?tribunal)\b/i],
    fr: [/\b(avocat|action en justice|poursuite|tribunal)\b/i],
    de: [/\b(anwalt|rechtsanwalt|rechtliche schritte|klage|gericht)\b/i],
    ja: [/(弁護士|訴訟|法的措置|裁判)/],
  },
  product_safety: {
    en: [
      /\b(caught fire|on fire|electric shock|electrocut|exploded?|explosion|burn(ed|t|s|ing)?|injur(y|ed|ies)|hazard|unsafe|dangerous)\b/i,
    ],
    zh: [/(起火|着火|爆炸|触电|烫伤|受伤|烧伤|危险|不安全|安全隐患)/],
    es: [
      /\b(se incendi[oó]|fuego|explot[oó]|descarga el[eé]ctrica|quemadura|lesi[oó]n|peligros[oa])\b/i,
    ],
    fr: [/\b(a pris feu|incendie|explos|choc [eé]lectrique|br[uû]lure|blessure|dangereux)\b/i],
    de: [/\b(fing feuer|in brand|explodiert|stromschlag|verbrennung|verletzung|gef[aä]hrlich)\b/i],
    ja: [/(発火|出火|爆発|感電|やけど|火傷|怪我|危険)/],
  },
  platform_complaint: {
    en: [
      /\ba-?to-?z\b/i,
      /\b(file|open|start|escalate)\b[^.!?]{0,40}\b(claim|complaint|case)\b[^.!?]{0,20}\b(amazon|paypal|ebay|marketplace|platform)\b/i,
      /\b(amazon|paypal|ebay)\b[^.!?]{0,20}\bclaim\b/i,
    ],
    zh: [/(平台投诉|向.{0,4}(亚马逊|amazon|paypal).{0,4}投诉|A-to-Z|平台索赔)/],
    es: [/\b(reclamaci[oó]n (en|a) (amazon|paypal)|denunciar? en (la )?plataforma)\b/i],
    fr: [/\b(r[ée]clamation (aupr[eè]s d'|à )(amazon|paypal)|signaler sur la plateforme)\b/i],
    de: [/\b(beschwerde bei (amazon|paypal)|plattform-?beschwerde|a-?bis-?z)\b/i],
    ja: [/(プラットフォーム.{0,4}(苦情|クレーム)|(amazon|paypal).{0,4}クレーム)/],
  },
}

/** Tier-3（出站承诺形态）：第一人称商家承诺构造 + 具体新让步。 */
const T3_PATTERNS: PatternTable = {
  refund: {
    en: [
      /\bwe\s+(will|can|are going to|'ll|have|'ve)\b[^.!?]{0,60}\b(refund|reimburse)\b/i,
      /\b(issue|issuing|process|processing|give you)\b[^.!?]{0,40}\b(a\s+)?(full|partial)?\s*refund\b/i,
      /\byour refund (has been|is being|will be) (issued|processed|sent)\b/i,
    ],
    zh: [/(为您|给您|帮您)?(退款|退还|返还)(给您)?/, /退款给您/],
    es: [/\b(le|te)\s+reembolsar(emos|é|á)\b/i, /\bprocesaremos (su|el)\s+reembolso\b/i],
    fr: [/\bnous vous rembours(erons|ons)\b/i, /\bremboursement (sera|a été) (effectué|traité)\b/i],
    de: [/\bwir erstatten\b/i, /\berstatten wir\b/i, /\brückerstattung (wird|erfolgt)\b/i],
    ja: [/返金(いたします|します|致します)/],
  },
  compensation: {
    en: [
      /\bwe\s+(will|can|'ll)\b[^.!?]{0,60}\b(compensate|give you|offer you)\b[^.!?]{0,40}\b(compensation|discount|voucher|credit|%|percent)\b/i,
      /\bas an apology\b[^.!?]{0,60}\b(discount|voucher|credit|refund|%|percent)\b/i,
    ],
    zh: [/(赔偿|补偿)您/, /(作为|以示)(歉意|补偿)[^。！？]{0,20}(折扣|优惠|代金券|%|％|元)/],
    es: [/\ble (compensaremos|daremos)\b[^.!?]{0,40}\b(compensaci[oó]n|descuento|%)\b/i],
    fr: [
      /\bnous vous (compensons|offrons|d[ée]dommageons)\b[^.!?]{0,40}\b(compensation|remise|%)\b/i,
    ],
    de: [/\bwir entsch[aä]digen\b/i, /\bals entschuldigung\b[^.!?]{0,40}\b(rabatt|gutschein|%)\b/i],
    ja: [/(補償|賠償).{0,20}(いたします|します)/],
  },
  replacement_reship: {
    en: [
      /\bwe\s+(will|can|are going to|'ll)\b[^.!?]{0,60}\b(send|ship|dispatch)\b[^.!?]{0,40}\b(replacement|new one|another one)\b/i,
      /\bsend (you )?a (free )?(replacement|reshipment)\b/i,
      /\bwe('| wi)?ll reship\b/i,
    ],
    zh: [/(为您|给您|帮您)?(补发|重发|重新发货|换新)(给您)?/],
    es: [/\ble (enviaremos|reenviaremos)\b[^.!?]{0,40}\b(reemplazo|repuesto|otro)\b/i],
    fr: [/\bnous (vous )?(enverrons|renverrons)\b[^.!?]{0,40}\b(remplacement|nouveau|autre)\b/i],
    de: [
      /\bwir senden (ihnen )?(einen )?(kostenlosen )?ersatz\b/i,
      /\bersatz (wird|senden wir)\b/i,
    ],
    ja: [
      /(交換品|代替品).{0,10}(お送り|送付|発送)(いたします|します)/,
      /(再送|再発送)(いたします|します)/,
    ],
  },
  cancel_order: {
    en: [
      /\bwe\s+(will|can|'ll)\b[^.!?]{0,40}\bcancel\b[^.!?]{0,30}\border\b/i,
      /\b(cancel(l)?ing|cancelled) (your|the) order\b/i,
      /\bconsider it (done|cancelled)\b/i,
    ],
    zh: [/(为您|帮您|已为您)?(取消|撤销)(了)?[^。！？]{0,6}订单/],
    es: [/\b(cancelaremos|hemos cancelado)\b[^.!?]{0,20}\b(su|el)\s+pedido\b/i],
    fr: [/\bnous (annulerons|avons annulé)\b[^.!?]{0,20}\b(votre|la)\s+commande\b/i],
    de: [/\bwir (stornieren|haben) (ihre|die) bestellung\b/i],
    ja: [/注文.{0,6}(キャンセル|取り消し)(いたします|します)/],
  },
  address_change: {
    en: [
      /\bwe\s+(will|can|'ll|have)\b[^.!?]{0,40}\b(change|update)\b[^.!?]{0,30}\baddress\b/i,
      /\byour (shipping )?address (has been|will be) (changed|updated)\b/i,
    ],
    zh: [/(为您|已为您|帮您)?(修改|更改|更新)(了)?[^。！？]{0,6}地址/],
    es: [/\b(cambiaremos|actualizaremos|hemos cambiado)\b[^.!?]{0,20}\b(la )?direcci[oó]n\b/i],
    fr: [/\bnous (changerons|modifierons|avons modifié)\b[^.!?]{0,20}\b(l')?adresse\b/i],
    de: [/\bwir (ändern|haben) (ihre )?(liefer)?adresse\b/i],
    ja: [/(配送先|住所|お届け先).{0,8}(変更|修正)(いたします|します)/],
  },
  chargeback_dispute: {
    en: [
      /\bwe\s+(will|can|'ll)\b[^.!?]{0,40}\b(accept|process|handle)\b[^.!?]{0,30}\b(chargeback|dispute)\b/i,
    ],
    zh: [/(接受|处理)[^。！？]{0,10}(拒付|争议)/],
    es: [/\b(aceptaremos|procesaremos)\b[^.!?]{0,30}\b(contracargo|disputa)\b/i],
    fr: [/\bnous (accepterons|traiterons)\b[^.!?]{0,30}\b(rétrofacturation|litige)\b/i],
    de: [/\bwir (akzeptieren|bearbeiten)\b[^.!?]{0,30}\b(rückbuchung|streitfall)\b/i],
    ja: [/(チャージバック|異議).{0,10}(承ります|対応いたします)/],
  },
  legal_threat: {
    // 出站承诺：AI 不得自行做法律让步 / 认责。
    en: [
      /\bwe\s+(accept|admit|acknowledge)\b[^.!?]{0,40}\b(liability|fault|responsibility|legal)\b/i,
    ],
    zh: [/(我们)?(承认|接受)[^。！？]{0,10}(责任|法律责任|过错)/],
    es: [/\baceptamos\b[^.!?]{0,30}\b(responsabilidad|culpa)\b/i],
    fr: [/\bnous acceptons\b[^.!?]{0,30}\b(responsabilit[ée]|faute)\b/i],
    de: [/\bwir (übernehmen|akzeptieren)\b[^.!?]{0,30}\b(haftung|verantwortung|schuld)\b/i],
    ja: [/(法的)?責任.{0,8}(認めます|負います)/],
  },
  product_safety: {
    // 出站承诺：AI 不得自行对安全事故下结论 / 认责 / 承诺召回。
    en: [
      /\bwe\s+(will|'ll)\b[^.!?]{0,40}\b(recall|replace|compensate)\b[^.!?]{0,40}\b(safety|hazard|injur|fire)\b/i,
    ],
    zh: [/(我们)?(会|将)[^。！？]{0,20}(召回|安全事故)/],
    es: [],
    fr: [],
    de: [],
    ja: [],
  },
  platform_complaint: {
    en: [/\bwe\s+(will|'ll)\b[^.!?]{0,40}\b(accept|resolve)\b[^.!?]{0,30}\b(a-?to-?z|claim)\b/i],
    zh: [],
    es: [],
    fr: [],
    de: [],
    ja: [],
  },
}

/**
 * 第一人称商家承诺框架（多语言）：区分"我们将 / 给您 …"这类主动承诺，与信息性
 * 政策援引（"our refund policy allows returns within 30 days"）。
 */
const FIRST_PERSON_COMMITMENT_RE =
  /\b(we\s+(will|can|'ll|are going to|are able to|would|have|'ve)|i\s+(will|can|'ll)|let me|as an apology|as a gesture|as compensation|on us|free of charge)\b|(我们|本店|小店)?(会|将|可以|为您|给您|帮您|免费)|(nous\s+(vous\s+)?(all|pouv|offr|rembours))|(wir\s+(werden|können|erstatten|bieten|schicken))|(le\s+(reembolsaremos|daremos|enviaremos)|le ofrecemos)|(いたします|します|お送り|進呈)/i

/**
 * 具体让步（金额 / 百分比 / 期限）。逐字抄 KefuAgent 的 `POLICY_COMMITMENT_RE`
 * ——出站草稿里的"无依据让步"靠它与第一人称承诺框架**句内共现**才算数。
 */
const POLICY_COMMITMENT_RE =
  /(\b\d+\s*(?:day|days|hour|hours|week|weeks|month|months|business\s*days?)\b|\b\d+\s*%|\$\s*\d+|€\s*\d+|£\s*\d+|¥\s*\d+|\b(?:refund|return|exchange|warranty|guarantee|compensation|compensate|replace|replacement|resend|ship|deliver|delivery)\b.{0,40}\b(?:within|after|before|free|full|partial|days?|hours?|weeks?|months?|%|\$|€|£|¥)\b|(?:退款|退货|换货|保修|保固|质保|赔偿|补偿|补发|重发|发货|送达|配送).{0,40}(?:\d+\s*(?:天|小时|周|个月|个工作日)|免费|全额|部分|比例|%|元|美元))/i

/* ------------------------------------------------------------------ */
/* 3. 子句级否定守卫                                                     */
/* ------------------------------------------------------------------ */

/**
 * 否定 / 无能力标记，按语言。
 *
 * **故意不进规则集哈希**：它改的是**扫法**不是**词表**。哈希锚的是「有哪些规则」，
 * 扫法的收紧 / 放松要靠用例钉，不该让每次算法修正都把审计链的锚换掉。
 *
 * 语义：T3 命中的**子句**里若出现这些标记，该命中不算承诺（"I'm not able to
 * issue a refund" 是在拒绝，不是在承诺）。它记进 `negated_hits` 供审计，不阻断。
 */
const NEGATION_MARKERS: Readonly<Record<L3Lang, RegExp>> = {
  en: /\b(not|cannot|can't|cant|unable|no longer|never|won't|wouldn't|couldn't|isn't|aren't|don't|doesn't|didn't|without)\b|n't\b/i,
  zh: /(无法|不能|不会|没法|没办法|暂不|不予|不可以|未能|并未|并不|不再)/,
  es: /\b(no|nunca|jamás|imposible)\b/i,
  fr: /\b(ne|n'|pas|jamais|impossible|aucun|aucune)\b/i,
  de: /\b(nicht|kein|keine|keinen|leider)\b/i,
  ja: /(できません|いたしかねます|できかねます|ません|られません)/,
}

/**
 * 子句分隔符。窗口在这里被切断，是这套守卫的**收紧**方向而非放松方向：
 * 切得越多 ⇒ 看到的否定越少 ⇒ 越倾向阻断（fail-closed）。
 *
 * 所以 "We can't wait to help — we will refund you in full." 里的 `n't` 被破折号
 * 切掉，该句仍然阻断。
 */
const CLAUSE_SEPARATOR_RE =
  /[,;:，；：—–]|\s-\s|\b(?:and|but|so|however|yet)\b|(?:而|但是|但|不过)/gi

/** 命中前看多少个字符。 */
const NEGATION_WINDOW_CHARS = 30

/** 原文 + 其 NFKC 归一化两份都扫。 */
function textVariants(text: string): string[] {
  const normalized = text.normalize('NFKC')
  return normalized === text ? [text] : [text, normalized]
}

/**
 * 取「命中所在子句」：命中前 30 字 + 命中原文，再从**最后一个**子句分隔符之后截断。
 *
 * 分隔符是在【窗口 + 命中原文】这整段里找的，不只在窗口里找——否则
 * "We can't wait to help — we will refund" 会因为命中原文自带 `n't` 被误判成否定。
 */
function clauseWindow(text: string, matchStart: number, matchText: string): string {
  const before = text.slice(Math.max(0, matchStart - NEGATION_WINDOW_CHARS), matchStart)
  const region = before + matchText
  const separator = new RegExp(CLAUSE_SEPARATOR_RE.source, 'gi')
  let cut = 0
  for (const hit of region.matchAll(separator)) cut = (hit.index ?? 0) + hit[0].length
  return region.slice(cut)
}

function isNegatedClause(clause: string, langs: readonly L3Lang[]): boolean {
  const variants = textVariants(clause)
  return langs.some((lang) => {
    const marker = NEGATION_MARKERS[lang]
    return variants.some((variant) => marker.test(variant))
  })
}

/** 非全局正则 → 全局克隆（`test` 拿不到位置，而且 lastIndex 会跨调用泄漏）。 */
function globalClone(regex: RegExp): RegExp {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
  return new RegExp(regex.source, flags)
}

/* ------------------------------------------------------------------ */
/* 4. 扫描                                                              */
/* ------------------------------------------------------------------ */

export interface L3PatternHit {
  category: L3Category
  tier: L3DetectionTier
  lang: L3Lang
  rule: string
}

function scanPatternSet(
  text: string,
  patternSet: PatternTable,
  tier: L3DetectionTier,
  opts: { negation_guard?: boolean } = {},
): { hits: L3PatternHit[]; negated_hits: L3PatternHit[] } {
  const hits: L3PatternHit[] = []
  const negated_hits: L3PatternHit[] = []
  const seen = new Set<string>()
  const variants = textVariants(text)
  for (const category of L3_CATEGORIES) {
    const perLang = patternSet[category]
    if (perLang === undefined) continue
    for (const lang of L3_LANGS) {
      const regexes = perLang[lang]
      if (regexes === undefined || regexes.length === 0) continue
      const rule = formatL3Rule(category, tier, lang)
      if (seen.has(rule)) continue
      let matched = false
      let unnegated = false
      for (const regex of regexes) {
        for (const variant of variants) {
          for (const hit of variant.matchAll(globalClone(regex))) {
            const text0 = hit[0]
            if (text0.length === 0) continue
            matched = true
            if (opts.negation_guard !== true) {
              unnegated = true
              break
            }
            if (!isNegatedClause(clauseWindow(variant, hit.index ?? 0, text0), [lang])) {
              unnegated = true
              break
            }
          }
          if (unnegated) break
        }
        if (unnegated) break
      }
      if (!matched) continue
      seen.add(rule)
      const entry: L3PatternHit = { category, tier, lang, rule }
      // 同一 (category, lang) 只要有**一处**未被否定就算阻断命中；全部被否定才降级。
      if (unnegated) hits.push(entry)
      else negated_hits.push(entry)
    }
  }
  return { hits, negated_hits }
}

/** 句切分：`.!?。！？` 与换行。 */
function splitSentences(text: string): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = []
  let start = 0
  for (const hit of text.matchAll(/[.!?。！？\n]+/g)) {
    const end = (hit.index ?? 0) + hit[0].length
    out.push({ index: out.length, text: text.slice(start, end) })
    start = end
  }
  if (start < text.length) out.push({ index: out.length, text: text.slice(start) })
  return out
}

/**
 * `unsourced_concession`：**同一句**里同时出现【金额 / 百分比 / 期限让步】与
 * 【第一人称承诺框架】，且该第一人称标记没有被子句级否定抵消。
 *
 * 为什么是句内而不是整篇：整篇共现会把「政策援引在第二句、`I'll` 在第四句」的
 * 正确回复误判掉，而整篇共现挡不住的**跨句臆造让步**几乎必然在某一句内自证。
 */
function findUnsourcedConcession(text: string): { index: number; length: number } | undefined {
  for (const sentence of splitSentences(text)) {
    const body = sentence.text
    if (!POLICY_COMMITMENT_RE.test(body) && !POLICY_COMMITMENT_RE.test(body.normalize('NFKC')))
      continue
    const committed = textVariants(body).some((variant) => {
      for (const hit of variant.matchAll(globalClone(FIRST_PERSON_COMMITMENT_RE))) {
        const text0 = hit[0]
        if (text0.length === 0) continue
        if (!isNegatedClause(clauseWindow(variant, hit.index ?? 0, text0), L3_LANGS)) return true
      }
      return false
    })
    // 证据只留句序号与长度：证据要能审计，但不该把客户文本抄进审计行。
    if (committed) return { index: sentence.index, length: body.trim().length }
  }
  return undefined
}

/**
 * Tier-2 入站盲扫：**仅当分类器没说话时**调用。命中即 fail-closed。
 *
 * **不走否定守卫**：盲扫这一层 over-holding 是正确方向，否定语义由 Tier-1 承担。
 */
export function scanInboundBackstop(inbound_text: string): L3PatternHit[] {
  return scanPatternSet(inbound_text, T2_PATTERNS, 't2').hits
}

/** Tier-3 出站承诺扫描：恒调用。 */
export function scanOutboundCommitment(proposed_reply_text: string): {
  hits: L3PatternHit[]
  negated_hits: L3PatternHit[]
  unsourced_concession: boolean
  concession_sentence?: { index: number; length: number }
} {
  const { hits, negated_hits } = scanPatternSet(proposed_reply_text, T3_PATTERNS, 't3', {
    negation_guard: true,
  })
  const concession = findUnsourcedConcession(proposed_reply_text)
  return {
    hits,
    negated_hits,
    unsourced_concession: concession !== undefined,
    ...(concession === undefined ? {} : { concession_sentence: concession }),
  }
}

/* ------------------------------------------------------------------ */
/* 5. 规则集哈希（只可加行的锚）                                          */
/* ------------------------------------------------------------------ */

/**
 * 规范化序列化。**键的顺序与名字是契约的一部分**：改一个键名、挪一个字段，哈希
 * 就变，而哈希是每条门决策审计行上的锚。
 */
export function buildCanonicalGateRuleset(): unknown {
  const serialize = (set: PatternTable): Record<string, Record<string, string[]>> => {
    const out: Record<string, Record<string, string[]>> = {}
    for (const category of L3_CATEGORIES) {
      out[category] = {}
      for (const lang of L3_LANGS) {
        const regexes = set[category]?.[lang]
        if (regexes !== undefined && regexes.length > 0) {
          const bucket = out[category]
          if (bucket !== undefined) bucket[lang] = regexes.map((r) => r.source)
        }
      }
    }
    return out
  }
  return {
    categories: L3_CATEGORIES,
    langs: L3_LANGS,
    emailIntentMap: EMAIL_INTENT_TO_L3,
    chatIntentMap: CHAT_INTENT_TO_L3,
    firstPersonCommitment: FIRST_PERSON_COMMITMENT_RE.source,
    policyCommitment: POLICY_COMMITMENT_RE.source,
    t2: serialize(T2_PATTERNS),
    t3: serialize(T3_PATTERNS),
  }
}

/**
 * 三道门的规则集哈希。每条门决策都印它——「当时用的是哪一版规则」必须能事后复核。
 *
 * 契约是**只可加行**：加一条 pattern 哈希会变（预期，改快照），删一条 / 弱化一条
 * 哈希也会变（不预期，快照测试当场红，改动要有人解释）。
 */
export const GATE_RULESET_HASH: string = sha256(JSON.stringify(buildCanonicalGateRuleset()))
