/**
 * WP257（决策 152）：自动进来的帖子（Reddit 自家版新帖、Discord、Telegram 群）入库时**判一类、打标签**。
 *
 * 类目沿用社群职责原有的封闭六类（契约 `CommunityTriage`，`triage.ts` 那一份）——不另起一套：
 * 客户问题（含售后：订单 / 物流 / 退换 / 保修 / 怎么用）、投诉、夸赞、广告垃圾、合作询问、其它（闲聊等）。
 *
 * 和经接口进来的那条路（`POST /v1/social/threads`：判完客户问题就出转客服卡）不一样，这里**只打标签**：
 * 不出卡、不转客服。人在「群里的帖子」里按标签筛着看；跑一两周看看量，再定要不要自动出卡。
 *
 * 判据三样（全是规则，不花钱；可选的模型复核在服务端那一层，默认关）：
 *
 * 1. **关键词**：`triageThread` 那张词表，一个字都不改。
 * 2. **渠道**：聊天群（Discord / Telegram / WhatsApp / FB 群组）里贴别的群的邀请链接，按广告垃圾算；
 *    Reddit 自家版是我们自己的版，发在里面的帖子本来就是冲着我们来的。
 * 3. **是否 @品牌**：@ 了我们的机器人、回了机器人的话、或者正文里提到品牌名，又是一句问话，
 *    词表没命中也按客户问题算——问到我们头上的事，漏了比多看一眼贵。
 *
 * 判据名进结论（`signals`），原句不进（同 `triage.ts` 纪律 3）。
 */
import type { SocialChannel } from '@agentsws/contracts'
import { TRIAGE_ROUTES, type TriageResult, triageThread } from './triage.js'

/** 聊天群：大家随口说话的地方（区别于 Reddit 那种发帖）。 */
const CHAT_CHANNELS: ReadonlySet<SocialChannel> = new Set([
  'discord',
  'telegram_group',
  'whatsapp',
  'facebook_group',
])

/** 聊天群里拉人去别的群的邀请链接（广告垃圾的老样子）。 */
const INVITE_LINKS = [
  'discord.gg/',
  'discord.com/invite/',
  't.me/+',
  't.me/joinchat',
  'chat.whatsapp.com/',
]

/** 一句问话（中英文都认；只看形状，不看内容）。 */
export function looksLikeQuestion(text: string): boolean {
  const s = text.trim()
  if (s === '') return false
  if (/[?？]/u.test(s)) return true
  if (/(吗|么|呢)[。！!～~\s]*$/u.test(s)) return true
  return /^(how|what|why|when|where|which|can|could|does|do|is|are|will|would|should|any(one|body))\b/iu.test(
    s,
  )
}

export interface ThreadTagInput {
  text: string
  channel: SocialChannel
  surface: 'thread' | 'comment' | 'dm'
  /** 平台判得出的「冲着我们来的」（@ 了机器人 / 回了机器人的话）。 */
  mentions_us?: boolean
  /** 品牌名（正文里提到也算冲着我们来）。太短（< 2 个字）的不认，免得误中。 */
  brand_terms?: readonly string[]
  /** Reddit：是不是我们自己的版（自家版里的帖子本来就是冲着我们来的）。 */
  own_community?: boolean
}

export interface ThreadTag extends TriageResult {
  /** 最后按「冲着我们来的」算了没有（三样里任一样）。 */
  mentions_us: boolean
}

/** 判一条自动进来的帖子（只打标签，见文件头）。 */
export function tagThread(input: ThreadTagInput): ThreadTag {
  const lower = input.text.toLowerCase()
  const named = (input.brand_terms ?? []).some((t) => {
    const term = t.trim().toLowerCase()
    return term.length >= 2 && lower.includes(term)
  })
  const mentions_us = input.mentions_us === true || input.own_community === true || named
  const base = triageThread({ text: input.text, is_dm: input.surface === 'dm', mentions_us })
  const signals = [...base.signals]

  // ② 渠道：聊天群里拉人去别的群 → 广告垃圾（除非这句本身是在问我们东西）
  if (CHAT_CHANNELS.has(input.channel) && base.klass !== 'customer_question') {
    const hit = INVITE_LINKS.find((l) => lower.includes(l))
    if (hit !== undefined) {
      signals.push('spam:invite_link')
      return { klass: 'spam', confidence: 0.7, signals, route: TRIAGE_ROUTES.spam, mentions_us }
    }
  }

  // ③ 是否 @品牌：问到我们头上、词表没命中 → 客户问题
  if (base.klass === 'other' && mentions_us && looksLikeQuestion(input.text)) {
    signals.push('customer_question:asked_us')
    return {
      klass: 'customer_question',
      confidence: 0.55,
      signals,
      route: TRIAGE_ROUTES.customer_question,
      mentions_us,
    }
  }
  return { ...base, signals, mentions_us }
}
