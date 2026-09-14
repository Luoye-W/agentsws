/**
 * Extracted from KefuAgent src/lib/support/amazon-channel.ts
 * （22 个 marketplace 域表、L1/L2/L3 判定层、子类指纹、认证 fail → phishing_suspect、
 * `AMAZON_MESSAGE_ACTIONS` 动作路由表），rewritten for agentsws contracts。
 *
 * **常量表逐字节抄 KefuAgent**（域名、正则、语言表、动作表）——这是 48 §4 L3 #2
 * 的要求：识别规则是安全边界的一部分，改一个字符就是改边界。舍掉的只有
 * Drizzle 表、`support_thread` 列名与 `server-only`。
 *
 * 这个模块是**纯的**：零 IO、零网络、零模型。判定发生在 AI 分类之前，所以它
 * 不花任何积分，也不受模型可用性影响。
 *
 * ## 判定层次（KefuAgent 产品 doc §2）
 *
 * - **L1**（强判据）：From 或 Reply-To 命中 22 个 marketplace 域，且认证非显式
 *   fail → 买家消息族，再过子类。
 * - **L2**：From 域是 `amazon.<站点tld>`（非 marketplace 子域）→ 系统通知族。
 * - **L3**（增信，绝不单独定案）：`[commMgrTok:…]`、订单号 → 只写 `signals`、
 *   只抬 confidence，不改 messageType。
 *
 * 认证 fail 的 marketplace / amazon 域邮件**绝不静默丢弃**，降级进
 * `phishing_suspect` 人工复核。
 */

/** 消息类型（KefuAgent `AmazonMessageType`，逐字）。 */
export type AmazonMessageType =
  | 'buyer_message'
  | 'amazon_cs_relay'
  | 'delivery_failure'
  | 'buyer_opt_out'
  | 'confirmation_receipt'
  | 'return_request'
  | 'a2z_claim'
  | 'refund_notice'
  | 'amazon_qa'
  | 'amazon_system'
  | 'phishing_suspect'

export interface AmazonChannelDetection {
  channel: 'amazon'
  /** tld，如 `com` / `de` / `co.jp`。 */
  marketplace: string
  message_type: AmazonMessageType
  /** 0-100；未证实判据命中给低置信。 */
  confidence: number
  matched_rule: string
  /** 买家 relay alias（L1 命中必有）。 */
  relay_address: string | null
  /** 全部命中；可空（售前咨询无订单号是合法状态）。 */
  order_ids: string[]
  buyer_name: string | null
  /** tld → ISO 语言码（回复语言的**默认值**，买家语言优先）。 */
  default_language: string
  comm_mgr_tok: string | null
  /** L3 增信记录，进线程的 `channel_meta`。 */
  signals: string[]
}

export interface DetectAmazonChannelInput {
  from_email: string
  from_name?: string | null
  reply_to_email?: string | null
  subject?: string
  body_text?: string
  body_html?: string | null
  /** 原始 `Authentication-Results` 头值；缺失 ≠ fail。 */
  authentication_results?: string | null
  in_reply_to_message_id?: string | null
}

/* ================================================================== */
/* 常量表（逐字节抄 KefuAgent `amazon-channel.ts`）                       */
/* ================================================================== */

/**
 * 22 个 marketplace 站点 tld（KefuAgent：2026-08-14 全部 DNS 实测存在 MX）。
 *
 * `cn` **不收录**：`marketplace.amazon.cn` 无 MX。顺序：长 tld 在前。
 */
export const AMAZON_MARKETPLACE_TLDS = [
  'com.au',
  'com.be',
  'com.br',
  'com.mx',
  'com.tr',
  'co.jp',
  'co.uk',
  'com',
  'ae',
  'ca',
  'de',
  'eg',
  'es',
  'fr',
  'ie',
  'in',
  'it',
  'nl',
  'pl',
  'sa',
  'se',
  'sg',
] as const

const TLD_ALTERNATION = AMAZON_MARKETPLACE_TLDS.map((tld) => tld.replace(/\./g, '\\.')).join('|')

/** L1 买家 relay 地址正则：本地部分 8–32，锚定 `^…$`（`…amazon.com.evil.ru` 不命中）。 */
export const AMAZON_MARKETPLACE_RELAY_RE = new RegExp(
  `^[a-z0-9]{8,32}@marketplace\\.amazon\\.(${TLD_ALTERNATION})$`,
  'i',
)

/** L2 系统域正则：`amazon.<tld>` 或 `<label>.amazon.<tld>`（marketplace 子域除外）。 */
const AMAZON_SYSTEM_DOMAIN_RE = new RegExp(
  `^(?:([a-z0-9-]+(?:\\.[a-z0-9-]+)*)\\.)?amazon\\.(${TLD_ALTERNATION})$`,
  'i',
)

/** 粗判据：跟 Amazon 有关的发件域（L1 ∪ L2，含 marketplace 子域）。 */
const AMAZON_ANY_SENDER_DOMAIN_RE = new RegExp(
  `^(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.)?amazon\\.(${TLD_ALTERNATION})$`,
  'i',
)

/** 系统发件人本地部分表（**辅助**判据：主判据永远是域名 + 认证）。 */
export const AMAZON_SYSTEM_SENDERS = [
  'donotreply',
  'auto-confirm',
  'order-update',
  'payments-messages',
  'no-reply',
  'account-update',
  'seller-performance',
] as const

/** listing 公共问答发件人。 */
export const AMAZON_QA_SENDER = 'community-help'

/** 买家 opt-out 退信指纹。语义只有一条：**拦我方主动外呼**；买家再来信照常入队。 */
export const AMAZON_OPT_OUT_FINGERPRINTS: ReadonlyArray<{
  re: RegExp
  evidence: 'confirmed' | 'unconfirmed'
}> = [
  { re: /buyer\s+has\s+chosen\s+to\s+opt[\s-]?out/i, evidence: 'confirmed' },
  {
    re: /has\s+opted\s+out\s+of\s+receiving\s+(?:unsolicited\s+)?messages/i,
    evidence: 'unconfirmed',
  },
]

/** 送达失败（退信）指纹。 */
export const AMAZON_DELIVERY_FAILURE_FINGERPRINTS: ReadonlyArray<{
  re: RegExp
  evidence: 'confirmed' | 'unconfirmed'
}> = [
  {
    re: /we\s+were\s+unable\s+to\s+deliver\s+the\s+message\s+you\s+sent/i,
    evidence: 'confirmed',
  },
  {
    re: /nous\s+n['’]avons\s+pas\s+pu\s+(?:remettre|livrer|d[ée]livrer)\s+(?:le|votre)\s+message/i,
    evidence: 'unconfirmed',
  },
  {
    re: /\b(?:delivery\s+failure|message\s+(?:could\s+not|was\s+not)\s+(?:be\s+)?delivered|undeliverable\s+message)\b/i,
    evidence: 'unconfirmed',
  },
]

/** 已发送回执指纹（v1 动作 = 剔除 + 计数）。 */
export const AMAZON_CONFIRMATION_RECEIPT_FINGERPRINTS: ReadonlyArray<RegExp> = [
  /\byour\s+message\s+(?:to\s+the\s+buyer\s+)?has\s+been\s+sent\b/i,
  /\bthis\s+is\s+a\s+copy\s+of\s+the\s+message\s+you\s+sent\b/i,
  /\bmessage\s+sent\s+confirmation\b/i,
]

/** Returns / claims / recovery：判据保守到**类别词 + 订单号**双条件。 */
export const AMAZON_RETURNS_CLAIMS_FINGERPRINTS: ReadonlyArray<{
  message_type: Extract<AmazonMessageType, 'a2z_claim' | 'return_request' | 'refund_notice'>
  re: RegExp
}> = [
  {
    message_type: 'a2z_claim',
    re: /\b(?:a[-\s]?to[-\s]?z(?:\s+guarantee)?(?:\s+claim)?|guarantee\s+claim)\b/i,
  },
  {
    message_type: 'return_request',
    re: /\b(?:return\s+request|requested\s+a\s+return|pending\s+return|return\s+authorization)\b/i,
  },
  {
    message_type: 'refund_notice',
    re: /\b(?:refund\s+(?:has\s+been\s+)?(?:issued|processed|initiated)|refund\s+notification)\b/i,
  },
]

/** Amazon 客服代买家发（cs_relay）意语模板标记。 */
export const AMAZON_CS_RELAY_IT_MARKERS: ReadonlyArray<RegExp> = [
  /\bordine\s*#\s*:/i,
  /\basin\s*:/i,
  /\bmotivo\s*:/i,
  /\bservizio\s+clienti\b/i,
]

/** 意语模板判定阈值：4 个标记里至少命中 3 个才定案。 */
const AMAZON_CS_RELAY_IT_MIN_MARKERS = 3

/** 钓鱼启发词：必须「自称」+「危险动作」两类同时命中才升级。 */
export const AMAZON_PHISHING_IMPERSONATION_RE =
  /(?:\b(?:i\s*am|i'm|we\s*are|we're|this\s+is)\b[^.\n]{0,40}\bamazon\b[^.\n]{0,40}\b(?:customer\s+service|support|security|team)\b|\bon\s+behalf\s+of\s+amazon\b|我是\s*amazon\s*(?:官方)?客服|亚马逊(?:官方)?客服(?:团队)?通知)/i

/** 钓鱼危险动作词：点链接 / 改支付 / 站外联系。 */
export const AMAZON_PHISHING_ACTION_RES: ReadonlyArray<{ code: string; re: RegExp }> = [
  {
    code: 'click_link',
    re: /\b(?:click\s+(?:the\s+|this\s+)?link|verify\s+your\s+account|confirm\s+your\s+identity\s+here|log\s*in\s+(?:here|via\s+this\s+link))\b/i,
  },
  {
    code: 'payment_change',
    re: /\b(?:update\s+your\s+(?:payment|billing|bank)|bank\s+(?:account|transfer)|wire\s+transfer|gift\s+card\s+code|pay\s+outside\s+amazon)\b/i,
  },
  {
    code: 'off_platform',
    re: /\b(?:whatsapp|telegram|wechat|contact\s+(?:me|us)\s+(?:directly\s+)?at\b|call\s+(?:me|us)\s+at\b)/i,
  },
]

/** Communication Manager Token：强增信 + 潜在串线程键，绝不单独定案。 */
export const AMAZON_COMM_MGR_TOK_RE = /\[commMgrTok:\s*([^\]\s]{1,120})\s*\]/i

/** 订单号：全文扫描（主题 + 正文），**禁止**用前 3 位推站点。 */
export const AMAZON_ORDER_ID_RE = /\b\d{3}-\d{7}-\d{7}\b/g

/** tld → 站点默认语言（**默认值**；买家用其他语言时以买家语言优先）。 */
export const AMAZON_MARKETPLACE_LANGUAGE: Readonly<Record<string, string>> = {
  com: 'en',
  'co.uk': 'en',
  de: 'de',
  fr: 'fr',
  it: 'it',
  es: 'es',
  'co.jp': 'ja',
  ca: 'en',
  'com.mx': 'es',
  'com.au': 'en',
  ae: 'ar',
  in: 'en',
  sg: 'en',
  nl: 'nl',
  se: 'sv',
  pl: 'pl',
  'com.tr': 'tr',
  'com.br': 'pt',
  eg: 'ar',
  sa: 'ar',
  'com.be': 'nl',
  ie: 'en',
}

/**
 * 认证显式 fail 判据：`spf=fail` 或 `dkim=fail`。
 *
 * 头**缺失 = 非 fail**；`softfail` / `permerror` / `temperror` / `none` 不算 fail
 * （`fail` 前无词边界断点，`spf=softfail` 天然不命中）。
 */
export const AUTH_EXPLICIT_FAIL_RE = /\b(?:spf|dkim)\s*=\s*fail\b/i

/** 渠道标记值（线程与消息上的 `channel`）。 */
export const AMAZON_CHANNEL = 'amazon'

/* 置信度分层：未证实判据命中一律低置信。 */
const CONFIDENCE = {
  l1Base: 95,
  l2KnownSender: 90,
  l2UnknownSender: 75,
  authFail: 90,
  confirmedFingerprint: 90,
  unconfirmedFingerprint: 55,
  unconfirmedCombo: 60,
  phishingHeuristic: 65,
  csRelayItalian: 80,
} as const

/* ================================================================== */
/* 小工具（纯函数）                                                     */
/* ================================================================== */

const normalize = (email: string | null | undefined): string => (email ?? '').trim().toLowerCase()

function domainOf(email: string): string {
  const at = normalize(email).lastIndexOf('@')
  return at === -1 ? '' : normalize(email).slice(at + 1)
}

function localPartOf(email: string): string {
  const at = normalize(email).lastIndexOf('@')
  return at === -1 ? '' : normalize(email).slice(0, at)
}

/**
 * relay 地址打码：告警 / 日志 / 卡片不得出现完整客户邮箱，而 relay alias 就是
 * 这条渠道上的客户邮箱。保留前 4 位与域，中间一律 `*`。
 */
export function maskAmazonRelayAddress(email: string | null | undefined): string | null {
  const normalized = normalize(email)
  if (!normalized.includes('@')) return normalized.length > 0 ? normalized : null
  const local = localPartOf(normalized)
  const domain = domainOf(normalized)
  const head = local.slice(0, 4)
  return `${head}${'*'.repeat(Math.max(2, Math.min(8, local.length - head.length)))}@${domain}`
}

/** From / Reply-To 是否是买家 relay alias（22 域正则的唯一出处）。 */
export function isMarketplaceRelayAddress(email: string | null | undefined): boolean {
  return AMAZON_MARKETPLACE_RELAY_RE.test(normalize(email))
}

/** relay alias → marketplace tld；非 relay 地址返回 null。 */
export function marketplaceTldOf(email: string | null | undefined): string | null {
  const match = AMAZON_MARKETPLACE_RELAY_RE.exec(normalize(email))
  return match?.[1] === undefined ? null : match[1].toLowerCase()
}

/** 发件域跟 Amazon 有没有关系（比 L1/L2 定案判据松，用来决定"值不值得看一眼"）。 */
export function isAmazonRelatedSenderDomain(email: string | null | undefined): boolean {
  return AMAZON_ANY_SENDER_DOMAIN_RE.test(domainOf(normalize(email)))
}

/** 认证结果是否显式 fail（头缺失 = 非 fail）。 */
export function hasExplicitAuthFailure(authentication_results: string | null | undefined): boolean {
  if (authentication_results === undefined || authentication_results === null) return false
  if (authentication_results.length === 0) return false
  return AUTH_EXPLICIT_FAIL_RE.test(authentication_results)
}

function systemDomainTldOf(email: string): string | null {
  const match = AMAZON_SYSTEM_DOMAIN_RE.exec(domainOf(email))
  if (match === null) return null
  const subdomain = (match[1] ?? '').toLowerCase()
  // `marketplace.amazon.<tld>` 只能走 L1：本地部分不合 L1 正则的邮件因此**整体
  // 不命中**，而不是被 L2 兜成系统信——猜一个格式不对的 relay 地址是系统信，
  // 会让真买家消息被原地吞掉。
  if (subdomain === 'marketplace' || subdomain.endsWith('.marketplace')) return null
  return (match[2] ?? '').toLowerCase()
}

const languageOf = (tld: string): string => AMAZON_MARKETPLACE_LANGUAGE[tld] ?? 'en'

function extractOrderIds(input: DetectAmazonChannelInput): string[] {
  const haystack = [input.subject ?? '', input.body_text ?? '', input.body_html ?? '']
    .filter((s) => s.length > 0)
    .join('\n')
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of haystack.matchAll(AMAZON_ORDER_ID_RE)) {
    const id = match[0]
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function extractCommMgrTok(input: DetectAmazonChannelInput): string | null {
  const match = AMAZON_COMM_MGR_TOK_RE.exec(`${input.body_text ?? ''}\n${input.body_html ?? ''}`)
  return match?.[1] ?? null
}

/* ================================================================== */
/* 子类判定                                                            */
/* ================================================================== */

type SubtypeVerdict = {
  message_type: AmazonMessageType
  matched_rule: string
  confidence: number
  signals: string[]
} | null

function matchOptOut(haystack: string): SubtypeVerdict {
  for (const fingerprint of AMAZON_OPT_OUT_FINGERPRINTS) {
    if (!fingerprint.re.test(haystack)) continue
    const confirmed = fingerprint.evidence === 'confirmed'
    return {
      message_type: 'buyer_opt_out',
      matched_rule: confirmed ? 'body_opt_out_confirmed' : 'body_opt_out_unconfirmed',
      confidence: confirmed ? CONFIDENCE.confirmedFingerprint : CONFIDENCE.unconfirmedFingerprint,
      signals: [`opt_out:${fingerprint.evidence}`],
    }
  }
  return null
}

function matchDeliveryFailure(haystack: string): SubtypeVerdict {
  for (const fingerprint of AMAZON_DELIVERY_FAILURE_FINGERPRINTS) {
    if (!fingerprint.re.test(haystack)) continue
    const confirmed = fingerprint.evidence === 'confirmed'
    return {
      message_type: 'delivery_failure',
      matched_rule: confirmed
        ? 'body_delivery_failure_confirmed'
        : 'body_delivery_failure_unconfirmed',
      confidence: confirmed ? CONFIDENCE.confirmedFingerprint : CONFIDENCE.unconfirmedFingerprint,
      signals: [`delivery_failure:${fingerprint.evidence}`],
    }
  }
  return null
}

function matchConfirmationReceipt(haystack: string): SubtypeVerdict {
  for (const re of AMAZON_CONFIRMATION_RECEIPT_FINGERPRINTS) {
    if (!re.test(haystack)) continue
    return {
      message_type: 'confirmation_receipt',
      matched_rule: 'body_confirmation_receipt_unconfirmed',
      confidence: CONFIDENCE.unconfirmedFingerprint,
      signals: ['confirmation_receipt:unconfirmed'],
    }
  }
  return null
}

function matchReturnsClaims(haystack: string, order_ids: readonly string[]): SubtypeVerdict {
  if (order_ids.length === 0) return null
  for (const fingerprint of AMAZON_RETURNS_CLAIMS_FINGERPRINTS) {
    if (!fingerprint.re.test(haystack)) continue
    return {
      message_type: fingerprint.message_type,
      matched_rule: `body_${fingerprint.message_type}_unconfirmed`,
      confidence: CONFIDENCE.unconfirmedCombo,
      signals: [`${fingerprint.message_type}:unconfirmed`, 'order_id_present'],
    }
  }
  return null
}

function matchPhishingHeuristic(haystack: string): SubtypeVerdict {
  if (!AMAZON_PHISHING_IMPERSONATION_RE.test(haystack)) return null
  const actions = AMAZON_PHISHING_ACTION_RES.filter((a) => a.re.test(haystack)).map((a) => a.code)
  if (actions.length === 0) return null
  return {
    message_type: 'phishing_suspect',
    matched_rule: 'body_phishing_heuristic',
    confidence: CONFIDENCE.phishingHeuristic,
    signals: ['phishing:impersonation', ...actions.map((c) => `phishing:${c}`)],
  }
}

function matchCsRelayItalian(haystack: string): SubtypeVerdict {
  const hits = AMAZON_CS_RELAY_IT_MARKERS.filter((re) => re.test(haystack))
  if (hits.length < AMAZON_CS_RELAY_IT_MIN_MARKERS) return null
  return {
    message_type: 'amazon_cs_relay',
    matched_rule: 'body_cs_relay_it_template',
    confidence: CONFIDENCE.csRelayItalian,
    signals: [`cs_relay_it:${hits.length}_markers`],
  }
}

/* ================================================================== */
/* 主入口                                                              */
/* ================================================================== */

/**
 * 判定一封邮件是不是 Amazon 渠道，并给出消息类型与抽取字段。
 * 不命中返回 `undefined`（调用方按现状流程继续，一个字不用改）。
 */
export function detectAmazonChannel(
  input: DetectAmazonChannelInput,
): AmazonChannelDetection | undefined {
  const from_email = normalize(input.from_email)
  const reply_to_email = normalize(input.reply_to_email)

  // L1：From 优先，Reply-To 兜底。
  const relay_address = isMarketplaceRelayAddress(from_email)
    ? from_email
    : isMarketplaceRelayAddress(reply_to_email)
      ? reply_to_email
      : null
  const l1Tld = relay_address === null ? null : marketplaceTldOf(relay_address)
  const l2Tld = l1Tld === null ? systemDomainTldOf(from_email) : null
  const marketplace = l1Tld ?? l2Tld
  if (marketplace === null) return undefined

  const order_ids = extractOrderIds(input)
  const comm_mgr_tok = extractCommMgrTok(input)
  const haystack = `${input.subject ?? ''}\n${input.body_text ?? ''}`

  // L3 增信：只写 signals / 抬 confidence，绝不改 messageType。
  const baseSignals: string[] = []
  if (comm_mgr_tok !== null) baseSignals.push('comm_mgr_tok')
  if (order_ids.length > 0) baseSignals.push(`order_ids:${order_ids.length}`)
  if (relay_address !== null && relay_address === reply_to_email && relay_address !== from_email)
    baseSignals.push('relay_from_reply_to')
  if (input.in_reply_to_message_id !== undefined && input.in_reply_to_message_id !== null)
    baseSignals.push('in_reply_to_present')

  const build = (verdict: NonNullable<SubtypeVerdict>): AmazonChannelDetection => ({
    channel: AMAZON_CHANNEL,
    marketplace,
    message_type: verdict.message_type,
    confidence: Math.max(0, Math.min(100, verdict.confidence)),
    matched_rule: verdict.matched_rule,
    relay_address,
    order_ids,
    buyer_name:
      input.from_name !== undefined && input.from_name !== null && input.from_name.trim().length > 0
        ? input.from_name.trim()
        : null,
    default_language: languageOf(marketplace),
    comm_mgr_tok,
    signals: [...baseSignals, ...verdict.signals],
  })

  // marketplace / amazon 域 + 认证显式 fail → phishing_suspect，**绝不静默丢**。
  if (hasExplicitAuthFailure(input.authentication_results)) {
    return build({
      message_type: 'phishing_suspect',
      matched_rule: l1Tld === null ? 'l2_auth_fail' : 'l1_auth_fail',
      confidence: CONFIDENCE.authFail,
      signals: ['auth:explicit_fail'],
    })
  }

  if (l1Tld !== null) {
    // 子类顺序：opt-out → 退信 → 回执 → returns/claims → 钓鱼启发 → 意语模板 → 买家消息。
    const ordered =
      matchOptOut(haystack) ??
      matchDeliveryFailure(haystack) ??
      matchConfirmationReceipt(haystack) ??
      matchReturnsClaims(haystack, order_ids) ??
      matchPhishingHeuristic(haystack) ??
      matchCsRelayItalian(haystack)
    if (ordered !== null) return build(ordered)
    return build({
      message_type: 'buyer_message',
      matched_rule: 'l1_marketplace_from',
      confidence: CONFIDENCE.l1Base,
      signals: [],
    })
  }

  // L2：community-help@ → amazon_qa；否则 amazon_system（地址表只抬 confidence）。
  const localPart = localPartOf(from_email)
  if (localPart === AMAZON_QA_SENDER) {
    return build({
      message_type: 'amazon_qa',
      matched_rule: 'l2_community_help',
      confidence: CONFIDENCE.l2KnownSender,
      signals: ['sender:community-help'],
    })
  }
  const returnsClaims = matchReturnsClaims(haystack, order_ids)
  if (returnsClaims !== null) return build(returnsClaims)

  const knownSender = (AMAZON_SYSTEM_SENDERS as readonly string[]).includes(localPart)
  return build({
    message_type: 'amazon_system',
    matched_rule: knownSender ? 'l2_system_sender' : 'l2_system_domain',
    confidence: knownSender ? CONFIDENCE.l2KnownSender : CONFIDENCE.l2UnknownSender,
    signals: knownSender ? [`sender:${localPart}`] : [],
  })
}

/* ================================================================== */
/* 动作路由（判定与动作分开两处硬编码迟早会改一处忘另一处，所以只有这一张表） */
/* ================================================================== */

export interface AmazonMessageAction {
  /** 是否当成"一条要处理的客户消息"（系统 / 剔除类恒 false）。 */
  creates_message: boolean
  /** 是否生成回复草稿（只读上下文类与钓鱼类恒 false）。 */
  generates_draft: boolean
  /** 是否要人工看一眼（钓鱼、A-to-z、退信）。 */
  needs_human_review: boolean
  /** 是否重起 24h SLA 倒计时。 */
  restarts_sla: boolean
}

export const AMAZON_MESSAGE_ACTIONS: Readonly<Record<AmazonMessageType, AmazonMessageAction>> = {
  buyer_message: {
    creates_message: true,
    generates_draft: true,
    needs_human_review: false,
    restarts_sla: true,
  },
  amazon_cs_relay: {
    creates_message: true,
    generates_draft: true,
    needs_human_review: false,
    restarts_sla: true,
  },
  delivery_failure: {
    creates_message: false,
    generates_draft: false,
    needs_human_review: true,
    restarts_sla: false,
  },
  buyer_opt_out: {
    creates_message: false,
    generates_draft: false,
    needs_human_review: false,
    restarts_sla: false,
  },
  confirmation_receipt: {
    creates_message: false,
    generates_draft: false,
    needs_human_review: false,
    restarts_sla: false,
  },
  return_request: {
    creates_message: true,
    generates_draft: false,
    needs_human_review: true,
    restarts_sla: false,
  },
  a2z_claim: {
    creates_message: true,
    generates_draft: false,
    needs_human_review: true,
    restarts_sla: false,
  },
  refund_notice: {
    creates_message: true,
    generates_draft: false,
    needs_human_review: false,
    restarts_sla: false,
  },
  amazon_qa: {
    creates_message: false,
    generates_draft: false,
    needs_human_review: false,
    restarts_sla: false,
  },
  amazon_system: {
    creates_message: false,
    generates_draft: false,
    needs_human_review: false,
    restarts_sla: false,
  },
  // 落库供人工复核，绝不生成任何草稿。
  phishing_suspect: {
    creates_message: true,
    generates_draft: false,
    needs_human_review: true,
    restarts_sla: false,
  },
}

export const AMAZON_MESSAGE_TYPE_LABEL_ZH: Readonly<Record<AmazonMessageType, string>> = {
  buyer_message: '买家站内信',
  amazon_cs_relay: 'Amazon 客服代买家转达',
  delivery_failure: '消息送达失败通知',
  buyer_opt_out: '买家已退订主动消息',
  confirmation_receipt: '消息已发送回执',
  return_request: '退货请求通知',
  a2z_claim: 'A-to-z 索赔通知',
  refund_notice: '退款通知',
  amazon_qa: 'Listing 公共问答提醒',
  amazon_system: 'Amazon 系统通知',
  phishing_suspect: '疑似冒充 Amazon 的钓鱼邮件',
}

/** 会把 24h SLA 倒计时重新起表的两种消息——只有它们是"买家在等回复"。 */
export function isAmazonBuyerConversationMessage(message_type: AmazonMessageType): boolean {
  return message_type === 'buyer_message' || message_type === 'amazon_cs_relay'
}

/** 判定 → 给人看的一句话（恒带 `[amazon]` 前缀）。 */
export function describeAmazonDetection(detection: AmazonChannelDetection): string {
  const label = AMAZON_MESSAGE_TYPE_LABEL_ZH[detection.message_type]
  return `[amazon] ${label}（站点 amazon.${detection.marketplace}，判据 ${detection.matched_rule}，置信 ${detection.confidence}）`
}

/**
 * 判定 → 线程 `channel_meta` 的**增量补丁**。
 *
 * 纪律只有一句：**只写自己确实知道的键**。调用方按合并落库，缺省的键 = 保留旧值。
 *
 * `last_buyer_message_at` 是 24h SLA 的**唯一时钟锚**，只有 `buyer_message` /
 * `amazon_cs_relay` 写它。拿"最近一次入站"当锚的话，一封「退款已处理」的系统
 * 通知会把买家那封还没回的信的倒计时重置回 24 小时——面板一片绿，响应率照扣。
 *
 * `relay_address` 同理省略 null：L2 来源的通知没有 relay 地址，照写 null 会把这条
 * 线程的**回信目标**抹掉。
 */
export function buildAmazonChannelMeta(
  detection: AmazonChannelDetection,
  message_at: string,
): Record<string, unknown> {
  return {
    marketplace: detection.marketplace,
    message_type: detection.message_type,
    confidence: detection.confidence,
    matched_rule: detection.matched_rule,
    default_language: detection.default_language,
    order_ids: detection.order_ids,
    signals: detection.signals,
    ...(detection.comm_mgr_tok === null ? {} : { comm_mgr_tok: detection.comm_mgr_tok }),
    ...(detection.relay_address === null ? {} : { relay_address: detection.relay_address }),
    ...(isAmazonBuyerConversationMessage(detection.message_type)
      ? { last_buyer_message_at: message_at }
      : {}),
  }
}
