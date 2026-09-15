/**
 * Extracted from KefuAgent src/lib/support/amazon-guardrail.ts
 * （`evaluateChannelOutbound` 的规则表与正则、`isRewritableViolation`、
 * `buildGuardrailRewriteInstruction`），rewritten for agentsws contracts。
 *
 * **正则逐字节抄 KefuAgent**：这是 48 §4 L3 #2 的要求。
 *
 * ## 为什么是代码层硬闸而不是 prompt 约束
 *
 * Amazon 用 AI 扫描每一条买家消息，违规后果是消息权限降级为「仅模板」，重者账号
 * 处置。prompt 是**建议**：模型有 1% 的概率把知识库里的官网链接原样抄进正文，而
 * 这 1% 落在真实卖家账号上就是不可逆的处置。所以过滤器必须是正则，且拦截 =
 * **打回重写**（把违规原因喂回模型的重写循环），**不是静默删改后照发**——静默
 * 删改会让运营永远不知道模型在写违规内容，问题只会越积越多。
 *
 * 触发条件是**收件人域**（`isMarketplaceRelayAddress`），与任何开关无关：自动
 * 回复关了照样跑（要攒违规样本），急停关了也照样跑（急停该让判定回到现状，不该
 * 让一封已经存在的 Amazon 线程绕过 Amazon 的社区规范）。
 */

import { blocksProactiveOutbound } from '@agentsws/core'
import { AMAZON_MARKETPLACE_TLDS, AMAZON_ORDER_ID_RE, isMarketplaceRelayAddress } from './detect.js'

/** 接第二个卖家消息渠道（Walmart / eBay）时扩展这个联合。 */
export type ChannelGuardrailProfile = 'amazon'

export type AmazonOutboundViolationCode =
  | 'external_link'
  | 'emoji'
  | 'gif'
  | 'phone_number'
  | 'email_address'
  | 'tracking_pixel'
  | 'marketing_content'
  | 'review_manipulation'
  | 'centered_text'
  | 'excess_line_breaks'
  | 'font_variety'
  | 'oversize_image'
  | 'attachment_count'
  | 'attachment_type'
  | 'message_size'
  | 'important_marker'
  | 'subject_rewritten'
  | 'not_reply_thread'

export interface AmazonOutboundViolation {
  code: AmazonOutboundViolationCode
  /** 中文，给复核卡与重写指令用。 */
  detail: string
  /** 命中片段（截断；不放完整客户邮箱、不放凭据）。 */
  evidence?: string
}

export type AmazonOutboundResult =
  | { ok: true; send_as_plain_text: true }
  | { ok: false; violations: AmazonOutboundViolation[] }

export interface AmazonOutboundAttachment {
  filename: string
  size_bytes: number
  content_type: string
}

export interface AmazonOutboundInput {
  to_address: string
  subject: string
  /** 线程首封来信主题；不给 = 无从校验，跳过主题规则。 */
  original_subject?: string | null
  body_text: string
  body_html?: string | null
  attachments?: readonly AmazonOutboundAttachment[]
  /** 有 In-Reply-To / References。 */
  is_reply_to_buyer_thread?: boolean
  recipient_opted_out?: boolean
}

/* ================================================================== */
/* 常量表（逐字节抄 KefuAgent）                                          */
/* ================================================================== */

/** 附件数量上限（官方口径）。 */
export const AMAZON_MAX_ATTACHMENTS = 5
/** 整封邮件大小上限（10MB，官方口径）。 */
export const AMAZON_MAX_MESSAGE_BYTES = 10 * 1024 * 1024
/** 允许的附件扩展名（官方口径）。 */
export const AMAZON_ALLOWED_ATTACHMENT_EXTENSIONS = ['pdf', 'jpeg', 'jpg', 'png', 'xml'] as const

const ALLOWED_ATTACHMENT_MIME: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/xml',
  'text/xml',
])

/** 连续换行上限（官方排版规则）。 */
const MAX_CONSECUTIVE_LINE_BREAKS = 2
/** 字号种类上限（官方排版规则）。 */
const MAX_FONT_SIZE_VARIETY = 3
/** 图片宽度上限（百分比，官方排版规则）。 */
const MAX_IMAGE_WIDTH_PERCENT = 80
/** px 图宽的判定基准：邮件正文事实标准 600px × 80%。 */
const MAX_IMAGE_WIDTH_PX = 480

/** `[Important]` 系标记：Amazon 已收回它旁路 opt-out 的能力，出站自行添加一律拦。 */
const IMPORTANT_MARKER_RE = /[[【]\s*(important|wichtig|重要)\s*[\]】]/i

/** 外链白名单：`amazon.<22 站点 tld>` 自家域（含任意子域）。 */
const AMAZON_HOST_RE = new RegExp(
  `^(?:[a-z0-9-]+\\.)*amazon\\.(?:${AMAZON_MARKETPLACE_TLDS.map((tld) =>
    tld.replace(/\./g, '\\.'),
  ).join('|')})$`,
  'i',
)

/** 带协议 / www. 前缀的链接。 */
const SCHEME_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi

/** 裸域名。范围收在常见商用 tld，避免把 `v1.2`、`Fig.3` 当成域名。 */
const BARE_DOMAIN_RE =
  /(^|[^\w@.])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|co|io|shop|store|info|biz|me|xyz|site|online|link|app|dev|de|fr|it|es|jp|ca|mx|au|ae|in|sg|nl|se|pl|tr|br|eg|sa|be|ie|uk|cn|ru))\b/gi

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

/**
 * emoji。显式码点区间，刻意**不含** `2190–21FF` 箭头：`→` 是排版符号不是 emoji，
 * 误判会让正常文案反复被打回重写。
 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}/u

/**
 * 电话号码。扫描前先把 Amazon 订单号（`\d{3}-\d{7}-\d{7}`）挖掉——否则每封带
 * 订单号的正常回复都会被判成留电话，形成永远修不好的重写死循环。
 */
const PHONE_RES: readonly RegExp[] = [
  /\+\d[\d\s().-]{7,17}\d/,
  /\(\d{3}\)\s*\d{3}[\s.-]?\d{4}/,
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/,
]

/** GIF：附件、HTML `<img src=…gif>`、data URI。 */
const GIF_RES: readonly RegExp[] = [/\.gif\b/i, /image\/gif/i]

/** 营销 / 优惠券 / 引导他 ASIN。宁可漏也不要误伤正常售后措辞。 */
const MARKETING_RES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bcoupon\b|\bpromo\s*code\b|\bdiscount\s*code\b/i, label: '优惠码' },
  { re: /\bgutschein\b|\brabattcode\b/i, label: '优惠码（德语）' },
  { re: /\bcode\s+promo\b|\bbon\s+de\s+r[ée]duction\b/i, label: '优惠码（法语）' },
  { re: /\bnewsletter\b|\bsubscribe\s+to\b/i, label: '订阅引导' },
  {
    re: /\bcheck\s+out\s+our\b|\bvisit\s+our\s+(?:store|shop|website)\b|\bshop\s+now\b/i,
    label: '引导访问店铺/官网',
  },
  {
    re: /\bour\s+other\s+products\b|\byou\s+may\s+also\s+like\b|\bbuy\s+again\b/i,
    label: '引导购买其他商品',
  },
  { re: /\bB0[A-Z0-9]{8}\b/, label: '引导他 ASIN' },
]

/** 诱评 / 删改差评（官方处置最重的一类）。只拦「我方索取 / 引导」的措辞。 */
const REVIEW_MANIPULATION_RES: ReadonlyArray<{ re: RegExp; label: string }> = [
  {
    re: /\b(?:leave|write|post|give)\s+(?:us\s+)?(?:a\s+)?(?:5|five)[\s-]*star\b/i,
    label: '索要五星好评',
  },
  {
    re: /\b(?:leave|write|post|give)\s+(?:us\s+)?(?:a\s+)?(?:positive\s+)?(?:review|feedback)\b/i,
    label: '索要好评',
  },
  {
    re: /\b(?:remove|delete|revise|update|change)\s+(?:your|the)\s+(?:negative\s+|bad\s+|1[\s-]*star\s+)?(?:review|feedback|rating)\b/i,
    label: '要求删改评价',
  },
  { re: /\bin\s+exchange\s+for\s+(?:a\s+)?review\b/i, label: '有偿评价' },
  {
    re: /\bpositive\s+bewertung\b|\bbewertung\s+entfernen\b/i,
    label: '评价引导（德语）',
  },
]

/** 居中排版。 */
const CENTERED_RES: readonly RegExp[] = [
  /<center\b/i,
  /text-align\s*:\s*center/i,
  /\balign\s*=\s*["']?center\b/i,
]

/** HTML 字号声明。 */
const FONT_SIZE_RES: readonly RegExp[] = [
  /font-size\s*:\s*([0-9.]+\s*(?:px|pt|em|rem|%))/gi,
  /<font[^>]*\bsize\s*=\s*["']?(\d+)["']?/gi,
]

/* ================================================================== */
/* 小工具                                                              */
/* ================================================================== */

function clip(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function hostOfUrl(raw: string): string | undefined {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(withScheme).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** 订单号挖空后的正文——电话号码扫描专用。 */
const stripOrderIds = (value: string): string => value.replace(AMAZON_ORDER_ID_RE, ' ')

/**
 * HTML 检查面：`body_html` + 正文里夹带的裸 HTML。
 *
 * 为什么正文也要扫：人可以手改草稿，`<img src=… width="100%">` 塞进纯文本正文时
 * 它在 `body_html` 里是转义过的实体，只看 `body_html` 会漏。
 */
function htmlHaystack(input: AmazonOutboundInput): string {
  const parts = [input.body_html ?? '']
  if (/<[a-z]/i.test(input.body_text)) parts.push(input.body_text)
  return parts.join('\n')
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

const byteLength = (value: string): number => new TextEncoder().encode(value).length

type Push = (v: AmazonOutboundViolation) => void

/* ================================================================== */
/* 规则实现                                                            */
/* ================================================================== */

function checkLinks(input: AmazonOutboundInput, push: Push): void {
  const haystack = `${input.body_text}\n${htmlHaystack(input)}`
  const seen = new Set<string>()
  const report = (raw: string): void => {
    const host = hostOfUrl(raw)
    // 白名单：v1 只放行 amazon.<tld> 自家链接（订单详情页等）。
    if (host === undefined || AMAZON_HOST_RE.test(host)) return
    if (seen.has(host)) return
    seen.add(host)
    push({
      code: 'external_link',
      detail: `正文含外部链接（${host}）。Amazon 站内信禁止任何站外链接，只有 amazon.<站点> 自家订单链接可以出现。`,
      evidence: clip(raw, 80),
    })
  }
  for (const match of haystack.matchAll(SCHEME_URL_RE)) report(match[0])
  for (const match of haystack.matchAll(BARE_DOMAIN_RE)) {
    const bare = match[2]
    if (bare !== undefined) report(bare)
  }
}

function checkEmojiAndGif(input: AmazonOutboundInput, push: Push): void {
  const haystack = `${input.subject}\n${input.body_text}\n${htmlHaystack(input)}`
  const emoji = EMOJI_RE.exec(haystack)
  if (emoji !== null) {
    push({
      code: 'emoji',
      detail: 'Amazon 站内信禁止 emoji，请改成纯文字表达。',
      evidence: emoji[0],
    })
  }
  const gifHaystack = [
    haystack,
    ...(input.attachments ?? []).map((a) => `${a.filename} ${a.content_type}`),
  ].join('\n')
  for (const re of GIF_RES) {
    const hit = re.exec(gifHaystack)
    if (hit === null) continue
    push({ code: 'gif', detail: 'Amazon 站内信禁止 GIF 动图。', evidence: clip(hit[0], 40) })
    break
  }
}

function checkContactInfo(input: AmazonOutboundInput, push: Push): void {
  const textForPhone = stripOrderIds(`${input.body_text}\n${htmlHaystack(input)}`)
  for (const re of PHONE_RES) {
    const hit = re.exec(textForPhone)
    if (hit === null) continue
    push({
      code: 'phone_number',
      detail: '正文含电话号码。Amazon 禁止在站内信里给出任何站外联系方式，只能在站内消息里沟通。',
      evidence: clip(hit[0], 40),
    })
    break
  }
  const emailHaystack = `${input.body_text}\n${htmlHaystack(input)}`
  for (const match of emailHaystack.matchAll(EMAIL_RE)) {
    // 买家自己的 relay alias 不算「站外联系方式」——它就是 Amazon 的匿名地址，
    // 引用原文时会带上，拦它只会制造修不好的重写循环。
    if (isMarketplaceRelayAddress(match[0])) continue
    push({
      code: 'email_address',
      detail:
        '正文含邮箱地址。Amazon 禁止在站内信里给出邮箱等站外联系方式（引导站外沟通是高风险违规）。',
      // 只留域名侧片段，不把完整邮箱写进卡片与日志。
      evidence: clip(match[0].replace(/^[^@]+/, '***'), 60),
    })
    break
  }
}

function checkMarketingAndReview(input: AmazonOutboundInput, push: Push): void {
  const haystack = `${input.subject}\n${input.body_text}`
  for (const rule of MARKETING_RES) {
    const hit = rule.re.exec(haystack)
    if (hit === null) continue
    push({
      code: 'marketing_content',
      detail: `正文含营销内容（${rule.label}）。Amazon 站内信只能就买家本次问题沟通，禁止促销、优惠券与引导购买其他商品。`,
      evidence: clip(hit[0], 60),
    })
    break
  }
  for (const rule of REVIEW_MANIPULATION_RES) {
    const hit = rule.re.exec(haystack)
    if (hit === null) continue
    push({
      code: 'review_manipulation',
      detail: `正文含诱导评价措辞（${rule.label}）。索要好评或要求删改差评是 Amazon 处置最重的一类违规。`,
      evidence: clip(hit[0], 60),
    })
    break
  }
}

function checkImages(html: string, push: Push): void {
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0]
    const widthAttr = /\bwidth\s*=\s*["']?([0-9.]+)(%?)/i.exec(tag)
    const heightAttr = /\bheight\s*=\s*["']?([0-9.]+)(%?)/i.exec(tag)
    const styleWidth = /width\s*:\s*([0-9.]+)\s*(px|%)/i.exec(tag)

    // 追踪像素：1×1（或更小）、或 display:none 的隐藏图。
    const tiny = (value: RegExpExecArray | null): boolean =>
      value !== null && value[2] === '' && Number(value[1]) <= 1
    const hidden = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(tag)
    if ((tiny(widthAttr) && tiny(heightAttr)) || hidden) {
      push({
        code: 'tracking_pixel',
        detail: '正文含追踪像素（1×1 或隐藏图片）。Amazon 禁止在站内信里追踪买家行为。',
        evidence: clip(tag, 80),
      })
      continue
    }

    const percent =
      widthAttr?.[2] === '%'
        ? Number(widthAttr[1])
        : styleWidth?.[2] === '%'
          ? Number(styleWidth[1])
          : undefined
    const px =
      widthAttr !== null && widthAttr[2] === ''
        ? Number(widthAttr[1])
        : styleWidth?.[2] === 'px'
          ? Number(styleWidth[1])
          : undefined
    if (
      (percent !== undefined && percent > MAX_IMAGE_WIDTH_PERCENT) ||
      (px !== undefined && px > MAX_IMAGE_WIDTH_PX)
    ) {
      push({
        code: 'oversize_image',
        detail: `图片宽度超过正文宽度的 ${MAX_IMAGE_WIDTH_PERCENT}%（px 判定基准 ${MAX_IMAGE_WIDTH_PX}px），Amazon 排版规则不允许。`,
        evidence: clip(tag, 80),
      })
    }
  }
}

function checkLayout(input: AmazonOutboundInput, push: Push): void {
  const html = htmlHaystack(input)
  for (const re of CENTERED_RES) {
    const hit = re.exec(html)
    if (hit === null) continue
    push({
      code: 'centered_text',
      detail: 'Amazon 站内信禁止居中排版，正文一律左对齐。',
      evidence: clip(hit[0], 40),
    })
    break
  }
  // 连续换行 >2：纯文本看 \n，HTML 看连续 <br>。
  const textBreaks = /(\r?\n[ \t]*){3,}/.exec(input.body_text)
  const htmlBreaks = /(?:<br\s*\/?>\s*){3,}/i.exec(html)
  if (textBreaks !== null || htmlBreaks !== null) {
    push({
      code: 'excess_line_breaks',
      detail: `正文出现超过 ${MAX_CONSECUTIVE_LINE_BREAKS} 个连续换行，Amazon 排版规则不允许，请压缩空行。`,
    })
  }
  const fontSizes = new Set<string>()
  for (const re of FONT_SIZE_RES) {
    // 每条都是 /g，用前先归零：模块级正则跨调用共享 lastIndex。
    re.lastIndex = 0
    for (const match of html.matchAll(re)) {
      const size = match[1]
      if (size !== undefined) fontSizes.add(size.replace(/\s+/g, '').toLowerCase())
    }
  }
  if (fontSizes.size > MAX_FONT_SIZE_VARIETY) {
    push({
      code: 'font_variety',
      detail: `正文用了 ${fontSizes.size} 种字号，Amazon 排版规则上限是 ${MAX_FONT_SIZE_VARIETY} 种。`,
      evidence: clip([...fontSizes].join(', '), 60),
    })
  }
  checkImages(html, push)
}

function checkAttachments(input: AmazonOutboundInput, push: Push): void {
  const attachments = input.attachments ?? []
  if (attachments.length > AMAZON_MAX_ATTACHMENTS) {
    push({
      code: 'attachment_count',
      detail: `附件 ${attachments.length} 个，超过 Amazon 上限 ${AMAZON_MAX_ATTACHMENTS} 个。`,
    })
  }
  for (const attachment of attachments) {
    const ext = extensionOf(attachment.filename)
    const mime = (attachment.content_type.split(';')[0] ?? '').trim().toLowerCase()
    const extOk = (AMAZON_ALLOWED_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)
    if (extOk && ALLOWED_ATTACHMENT_MIME.has(mime)) continue
    push({
      code: 'attachment_type',
      detail: `附件类型不被 Amazon 接受（只允许 ${AMAZON_ALLOWED_ATTACHMENT_EXTENSIONS.join('/').toUpperCase()}）。`,
      evidence: clip(`${attachment.filename} (${mime.length === 0 ? '未知类型' : mime})`, 80),
    })
    break
  }
  const total =
    byteLength(input.body_text) +
    byteLength(input.body_html ?? '') +
    attachments.reduce((sum, item) => sum + (item.size_bytes || 0), 0)
  if (total > AMAZON_MAX_MESSAGE_BYTES) {
    push({
      code: 'message_size',
      detail: `整封邮件约 ${(total / 1024 / 1024).toFixed(1)}MB，超过 Amazon 上限 10MB。`,
    })
  }
}

/** 剥掉所有回复前缀后的主题核心（大小写 / 空白归一）。 */
function subjectCore(subject: string): string {
  let normalized = subject.trim()
  const prefix = /^(re|aw|sv|antw|rif|res|答复|回复)\s*[:：]\s*/i
  while (prefix.test(normalized)) normalized = normalized.replace(prefix, '')
  return normalized.replace(/\s+/g, ' ').trim().toLowerCase()
}

const hasReplyPrefix = (subject: string): boolean =>
  /^(re|aw|sv|antw|rif|res|答复|回复)\s*[:：]/i.test(subject.trim())

function checkSubjectAndThread(input: AmazonOutboundInput, push: Push): void {
  if (IMPORTANT_MARKER_RE.test(input.subject)) {
    push({
      code: 'important_marker',
      detail:
        '主题含 [Important]/[Wichtig]/[重要] 标记。Amazon 已收回该标记旁路 opt-out 的能力，出站禁止自行添加。',
      evidence: clip(input.subject, 80),
    })
  } else if (IMPORTANT_MARKER_RE.test(input.body_text)) {
    push({
      code: 'important_marker',
      detail: '正文含 [Important]/[Wichtig]/[重要] 标记，Amazon 站内信禁止自行添加该标记。',
    })
  }

  // 主题必须恒为 `Re: <原主题>`：改写主题会不会断线程未证实，采样前禁止改写。
  const original = input.original_subject
  if (original !== undefined && original !== null) {
    if (subjectCore(original) !== subjectCore(input.subject)) {
      push({
        code: 'subject_rewritten',
        detail:
          '出站主题与原始来信主题不一致。Amazon 会话靠主题串联，v1 一律保留 `Re: <原主题>`，禁止改写。',
        evidence: clip(input.subject, 80),
      })
    } else if (!hasReplyPrefix(input.subject)) {
      push({
        code: 'subject_rewritten',
        detail: '出站主题缺少 `Re:` 前缀，必须以 `Re: <原主题>` 形式发出。',
        evidence: clip(input.subject, 80),
      })
    }
  }

  // opt-out 买家只能在原线程内回复。
  //
  // 判定本身在 `@agentsws/core` 的 `blocksProactiveOutbound`——WP64 的邮件营销要的是
  // 同一条规则（名单上的人收不到主动外发），两处调同一个函数，不各写一份 if。
  if (
    blocksProactiveOutbound({
      suppressed_hits: input.recipient_opted_out === true ? 1 : 0,
      reply_in_original_thread: input.is_reply_to_buyer_thread === true,
    })
  ) {
    push({
      code: 'not_reply_thread',
      detail:
        '该买家已退订主动消息，只能在其发起的原会话线程内回复（必须带 In-Reply-To/References），不能新起一封。',
    })
  }
}

/* ================================================================== */
/* 入口                                                                */
/* ================================================================== */

/**
 * 出站硬闸。触发前提由调用方判定：收件人命中 `isMarketplaceRelayAddress`。
 *
 * `ok:true` 时恒带 `send_as_plain_text:true`——marketplace 收件人默认纯文本，
 * 不发 HTML 部件（HTML 排版规则再严也不如干脆不发 HTML）。
 */
export function evaluateAmazonOutbound(
  profile: ChannelGuardrailProfile,
  input: AmazonOutboundInput,
): AmazonOutboundResult {
  // v1 只有 amazon profile；switch 保留是为了接第二个渠道时这里编译报错，
  // 逼人显式给出新渠道的规则表，而不是静默套用 Amazon 的。
  switch (profile) {
    case 'amazon':
      break
    default: {
      const exhaustive: never = profile
      throw new Error(`unknown guardrail profile: ${String(exhaustive)}`)
    }
  }

  const violations: AmazonOutboundViolation[] = []
  const push: Push = (violation) => {
    violations.push(violation)
  }

  checkLinks(input, push)
  checkEmojiAndGif(input, push)
  checkContactInfo(input, push)
  checkMarketingAndReview(input, push)
  checkLayout(input, push)
  checkAttachments(input, push)
  checkSubjectAndThread(input, push)

  if (violations.length > 0) return { ok: false, violations }
  return { ok: true, send_as_plain_text: true }
}

/**
 * 能靠「重写正文」修好的违规码。
 *
 * 反过来说，`attachment_*` / `message_size` / `subject_rewritten` /
 * `not_reply_thread` 是**改正文改不掉**的：附件是人勾选的、主题由线程决定、
 * 线程头是投递管线拼的。把它们丢进重写循环，结果是每次重写都得到同一条违规、
 * 每次都再烧一次积分——这类只拒发 + 上人审卡。
 */
const REWRITABLE_CODES: ReadonlySet<AmazonOutboundViolationCode> = new Set([
  'external_link',
  'emoji',
  'gif',
  'phone_number',
  'email_address',
  'tracking_pixel',
  'marketing_content',
  'review_manipulation',
  'centered_text',
  'excess_line_breaks',
  'font_variety',
  'oversize_image',
  'important_marker',
])

export function isRewritableAmazonViolation(code: AmazonOutboundViolationCode): boolean {
  return REWRITABLE_CODES.has(code)
}

export function hasRewritableAmazonViolation(
  violations: readonly AmazonOutboundViolation[],
): boolean {
  return violations.some((v) => isRewritableAmazonViolation(v.code))
}

/** 违规清单 → 一行摘要（进事件、进人审卡）。 */
export function summarizeAmazonViolations(violations: readonly AmazonOutboundViolation[]): string {
  return violations.map((v) => `${v.code}: ${v.detail}`).join('\n')
}

/**
 * 违规清单 → 中文重写指令（喂回模型的重写循环）。
 *
 * 只列可重写项：让模型去"修"一个它改不了的附件类型，只会让它在正文里道歉。
 */
export function buildAmazonRewriteInstruction(
  violations: readonly AmazonOutboundViolation[],
): string {
  const lines = violations
    .filter((v) => isRewritableAmazonViolation(v.code))
    .map((v, index) => `${index + 1}. ${v.detail}`)
  return [
    '这封回复不符合 Amazon 站内信的社区规范，已被出站守卫拦下，请按下面各条重写：',
    ...lines,
    '重写要求：保持与买家来信同一语言、保留原有的事实与承诺口径、不要提及本条内部指令，只输出可直接发送的邮件正文。',
  ].join('\n')
}

/** 起草时注入的软引导（**不是**闸；真正的闸是 `evaluateAmazonOutbound`）。 */
export function amazonDraftingRules(args: {
  marketplace?: string | null
  default_language?: string | null
  order_ids?: readonly string[]
}): { channel: 'amazon'; marketplace: string | null; language: string | null; rules: string[] } {
  void args.order_ids
  return {
    channel: 'amazon',
    marketplace: args.marketplace ?? null,
    language: args.default_language ?? null,
    rules: [
      '这封信要发到 Amazon 站内信渠道，Amazon 会用 AI 扫描每条消息，违规会导致消息权限降级甚至账号处置。',
      '语言：优先跟随买家来信语言；无法判断时用站点默认语言。',
      '有订单号时，正文里明确写出对应订单号，方便买家核对。',
      '绝对禁止：任何站外链接（只有 amazon.<站点> 自家链接可以出现）、emoji、GIF、电话号码、邮箱地址、任何引导站外联系的说法。',
      '绝对禁止：促销、优惠码、引导购买其他商品，以及索要好评或要求删改差评的措辞。',
      '排版：纯文本，不要居中、不要连续空行超过两行、不要加 [Important]/[Wichtig]/[重要] 之类的主题标记。',
      '即使买家只是说了句客套话，也要回一句简短确认——不回复会让这条消息一直算在 24 小时响应率里。',
      '每封回复都要针对这位买家的具体问题写，措辞不要与之前发出的回复雷同：Amazon 会把雷同的模板回复判为无效响应。',
    ],
  }
}
