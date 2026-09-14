/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/l3.ts
 * （GOODS_L3_DENYLIST，023 / S039 FR-005），**逐字节**。
 *
 * 九类 × 六语的「永不自动发送」词表。它是 48 §4 第 3 项那三道门里 `l3_denylist`
 * 的原料（WP55 把它接进 15 的 guardrail 前置）。
 *
 * 契约是「只可加行、绝不删 / 弱化行」：序列化出来的哈希是自主发送审计链的锚，
 * 每一次门的判定都落这个 hash。序列化的原料除九类六语词表与两张意图映射外，
 * **还有 `firstPersonCommitment` 的 source**——少收编它就复现不出同一个序列化。
 *
 * Tier-2 是**入站请求形态**（"我要退款"），只在没有别的分类结论时盲跑，命中即
 * fail-closed 转人工——over-holding 是正确方向。
 * Tier-3 是**出站承诺形态**（"我们会为您退款"），靠"承诺动词绑定第一人称主语"与
 * 信息性政策援引（"our refund policy allows returns within 30 days"）区分；
 * 模板无法区分处偏向匹配。
 */

import type { L3DenylistPack, L3PatternTable } from '../types.js'

/** 类目（固定，v1）。 */
export const GOODS_L3_CATEGORIES = [
  'refund',
  'compensation',
  'replacement_reship',
  'cancel_order',
  'address_change',
  'chargeback_dispute',
  'legal_threat',
  'product_safety',
  'platform_complaint',
] as const

/** 支持语言（FR-007）。检测不需要预知文本语言：所有语言 pattern 都跑一遍。 */
export const GOODS_L3_LANGS = ['en', 'zh', 'es', 'fr', 'de', 'ja'] as const

/**
 * 邮件 Tier-1：support_email_classification_result.category（CATEGORY_LABELS_ZH
 * 见 agent-task-delegation.ts）与 classifyInboundEmail 意图（email-triage.ts）→ L3。
 * 映射缺口在 v1 明确可接受：(a) T3 恒守出站承诺；(b) 邮件高风险词已在 G04 风险门
 * 强制人工。分类器长出更细意图时只改本表（与 rulesetHash）。
 */
const EMAIL_INTENT_TO_L3: Record<string, string> = {
  returns_refunds: 'refund',
  return_or_refund_request: 'refund',
  complaint: 'compensation',
  damaged_or_defective_item: 'replacement_reship',
}

/**
 * 聊天 Tier-1：`CommerceChatIntent`（chat.ts）→ L3。
 * `product_issue` 仅在 riskLevel='high'（安全词）时映射 product_safety，故意图映射
 * 需附带风险判定 —— 见 `riskGatedChatIntents`。
 */
const CHAT_INTENT_TO_L3: Record<string, string> = {
  return_refund: 'refund',
}

/* ------------------------------------------------------------------ */
/* 4. Tier-2 / Tier-3 pattern（结构化模板，非裸关键词）                  */
/* ------------------------------------------------------------------ */

/**
 * Tier-2（入站请求形态）：第一/第二人称的请求/要求构造，围绕类目名词/动词集。
 * 裸名词出现（单个 `refund`）不构成 T2 命中。仅当 classification.source==='none'
 * 时运行（盲跑），命中即 fail-closed 转人工——over-holding 是正确方向。
 */
const T2_PATTERNS: Record<string, Partial<Record<string, RegExp[]>>> = {
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

/**
 * Tier-3（出站承诺形态）：第一人称商家承诺构造 + 具体新让步（金额/百分比/期限）。
 * 信息性政策援引（"our refund policy allows returns within 30 days" 作为 FAQ 回答）
 * 靠"承诺动词绑定第一人称主语"区分；模板无法区分处偏向匹配（fail-closed）。
 */
const T3_PATTERNS: Record<string, Partial<Record<string, RegExp[]>>> = {
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
    // 出站承诺：AI 不得自行做法律让步/认责。
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
    // 出站承诺：AI 不得自行对安全事故下结论/认责/召回承诺。
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
 * 第一人称商家承诺框架（多语言）：区分"我们将/给您 …"这类主动承诺，与信息性政策
 * 援引（"our refund policy allows returns within 30 days"、"you can start one …"）。
 * unsourced_concession 兜底仅在同时出现【承诺框架】+【金额/百分比/期限让步】时才触发，
 * 让信息性政策 FAQ 回答（N5/N8）安全通过、而具体新让步（B22）被拦。
 */
const FIRST_PERSON_COMMITMENT_RE =
  /\b(we\s+(will|can|'ll|are going to|are able to|would|have|'ve)|i\s+(will|can|'ll)|let me|as an apology|as a gesture|as compensation|on us|free of charge)\b|(我们|本店|小店)?(会|将|可以|为您|给您|帮您|免费)|(nous\s+(vous\s+)?(all|pouv|offr|rembours))|(wir\s+(werden|können|erstatten|bieten|schicken))|(le\s+(reembolsaremos|daremos|enviaremos)|le ofrecemos)|(いたします|します|お送り|進呈)/i

export const GOODS_L3_DENYLIST: L3DenylistPack = {
  categories: GOODS_L3_CATEGORIES,
  langs: GOODS_L3_LANGS,
  t2: T2_PATTERNS as L3PatternTable,
  t3: T3_PATTERNS as L3PatternTable,
  emailIntentMap: EMAIL_INTENT_TO_L3,
  chatIntentMap: CHAT_INTENT_TO_L3,
  firstPersonCommitment: FIRST_PERSON_COMMITMENT_RE,
  riskGatedChatIntents: {
    product_issue: { riskLevel: 'high', category: 'product_safety' },
  },
}
