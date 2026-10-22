/**
 * WP440（docs/108 M9）：**邮件客服也按把握直接回**——照在线客服 WP428 那一套。
 *
 * 判定不另写：一律转人清单、打分、三档、出处核对、学到的「不该直接答」全是
 * `scoreChatAutoAnswer`（这里另起一个渠道无关的名字 `scoreAutoAnswer`，旧导出照留）。
 * 本文件只补**邮件特有的那几步**，全是纯函数，服务进程（`apps/server/src/email-auto-reply.ts`）
 * 与模拟回路（`packages/simulation/src/email-auto.ts`）用的是同一份：
 *
 * 1. **先剥再判**（`splitEmailForAnswer`）：来信里引用的旧邮件、签名（落款、电话、地址、
 *    「Sent from my iPhone」）一律剥掉，只拿这一封新写的部分当「问句」。签名里的电话不会让它转人——
 *    决策 1303 起「个人信息」只看**要发出去的回复**里带没带出。
 * 2. **能不能试**（`emailAutoReplyGate`）：开关、Amazon 这类排除的渠道、影子模式、收件人待定、
 *    判断层的三道自主门没放行——任何一样不过就不去问模型，照旧出卡。
 * 3. **起草的格式**（`EMAIL_ANSWER_CITE_INSTRUCTION`）：材料带编号、句后标出处、末尾自评，
 *    同聊天；多一条「只写回答本身，称呼和落款我们来加」。一封信问了几件事就逐一回答，
 *    任何一句对不上出处（同档位规则），整封出卡。
 * 4. **发出去的那一封**（`composeEmailReply`）：去掉出处标记与自评那一行之后，加上称呼与落款。
 */

import { classifyChatTurn } from '../chat/classify.js'
import {
  type ChatAnswerSource,
  type ChatAutoAnswerInput,
  type ChatAutoAnswerStrictness,
  type ChatAutoAnswerVerdict,
  type ChatHoldKind,
  chatCoverage,
  chatTokens,
  formatChatSources,
  scoreChatAutoAnswer,
} from '../chat/confidence.js'
import { buildChatPlan } from '../chat/plan.js'
import type { ChatResponsePlan } from '../chat/types.js'
import { fenceForPrompt } from '../prompt-text.js'

/* ------------------------------------------------------------------ */
/* 渠道无关的名字（旧的 chat 导出一个不删）                                 */
/* ------------------------------------------------------------------ */

/** 「严格 / 适中 / 宽松」——聊天与邮件同一套。 */
export type AutoAnswerStrictness = ChatAutoAnswerStrictness
export type AutoAnswerSource = ChatAnswerSource
export type AutoAnswerInput = ChatAutoAnswerInput
export type AutoAnswerVerdict = ChatAutoAnswerVerdict

/**
 * 按把握直接发的判定（渠道无关）。就是 `scoreChatAutoAnswer`——同一个函数、同一套门槛，
 * 邮件不另写一份（WP440 派工单第 1 条）。
 */
export const scoreAutoAnswer: (input: AutoAnswerInput) => AutoAnswerVerdict = scoreChatAutoAnswer

/* ------------------------------------------------------------------ */
/* ① 先剥：引用的旧邮件与签名                                              */
/* ------------------------------------------------------------------ */

export interface EmailQuestion {
  /** 这一封新写的部分（剥掉引用与签名之后）。 */
  question: string
  quote_removed: boolean
  signature_removed: boolean
}

/** 一行就标志着「下面是引用的旧邮件」。 */
const QUOTE_START: readonly RegExp[] = [
  /^\s*>/,
  /^\s*On\b.{0,200}\bwrote:\s*$/i,
  /^\s*On\b.{0,200}$/i, // 「On Mon, … <x@y.com>」折到下一行才有 wrote:（由下面的两行判定兜）
  /^\s*(?:在|于).{0,120}(?:写道|wrote)\s*[:：]\s*$/,
  /^\s*-{2,}\s*(?:Original Message|Forwarded message|原始邮件|转发的邮件|原邮件)\s*-{2,}\s*$/i,
  /^\s*_{8,}\s*$/,
  /^\s*(?:From|发件人)\s*[:：].+$/i,
]

/** 签名分隔线（RFC 3676 的「-- 」，以及常见的一串横线）。 */
const SIG_DELIM = /^\s*(?:--|—|__)\s*$/

/** 「Sent from my iPhone」这类客户端尾巴。 */
const CLIENT_TAIL =
  /^\s*(?:sent from my|sent from|get outlook for|发自我的|发送自|来自我的)\b.*$|^\s*(?:发自我的|来自我的).*$/i

/** 落款那一行（单独成行的「Best regards,」「谢谢」「此致」）。 */
const SIGN_OFF =
  /^\s*(?:best(?: regards| wishes)?|kind regards|warm regards|regards|many thanks|thanks(?: so much| a lot| again| in advance)?|thank you(?: so much| in advance)?|cheers|sincerely|yours(?: truly| sincerely)?|br|谢谢(?:您|你)?|多谢|感谢|此致|祝好|顺祝(?:商祺|安好)?|敬礼)\s*[,，!！.。]?\s*$/i

/** 签名里常见的联系方式行（电话、邮箱、网址、地址、职位抬头）。 */
const CONTACTISH =
  /(?:\+?\d[\d\s().-]{6,}\d)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https?:\/\/|www\.|^\s*(?:tel|phone|mobile|cell|fax|电话|手机|微信|地址|address|wechat)\s*[:：]/i

/**
 * 来信 → 这一封新写的部分。剥不出东西（整封都像引用）就退回原文——宁可多判一些字，
 * 也不能把客户的问题剥没了。
 */
export function splitEmailForAnswer(text: string): EmailQuestion {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let end = lines.length
  let quote_removed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const next = lines[i + 1] ?? ''
    const isOnLine = /^\s*On\b/i.test(line)
    const hit = QUOTE_START.some((re, idx) => {
      // 「On …」只有本行或下一行以 wrote: 结尾才算
      if (idx === 2) return isOnLine && /\bwrote:\s*$/i.test(`${line} ${next}`)
      if (idx === 1) return isOnLine && re.test(line)
      // 「From:」只有紧跟着 Sent / Date / 发送时间 才算 Outlook 的引用头
      if (idx === 6)
        return re.test(line) && /^\s*(?:sent|date|to|发送时间|时间|收件人)\s*[:：]/i.test(next)
      return re.test(line)
    })
    if (hit && i > 0) {
      end = i
      quote_removed = true
      break
    }
  }
  const body = lines.slice(0, end)
  // ── 签名：分隔线 / 客户端尾巴 / 落款行之后，或者末尾那一串联系方式
  let sigAt = body.length
  for (let i = 0; i < body.length; i++) {
    const line = body[i] ?? ''
    if (SIG_DELIM.test(line) || CLIENT_TAIL.test(line)) {
      sigAt = i
      break
    }
  }
  for (let i = 0; i < sigAt; i++) {
    const line = body[i] ?? ''
    // 落款行出现在后半段、后面最多 6 行：从它开始都是签名
    if (SIGN_OFF.test(line) && sigAt - i <= 7 && i > 0) {
      sigAt = i
      break
    }
  }
  // 末尾的联系方式 / 名字行（没有落款行的签名）：从后往前吃掉短行
  let tail = sigAt
  while (tail > 1) {
    const line = (body[tail - 1] ?? '').trim()
    if (line === '') {
      tail -= 1
      continue
    }
    const short = line.length <= 60 && !/[?？]/.test(line)
    if (short && CONTACTISH.test(line)) {
      tail -= 1
      continue
    }
    break
  }
  const signature_removed = tail < body.length && body.slice(tail).some((l) => l.trim() !== '')
  const question = body.slice(0, tail).join('\n').trim()
  if (question === '')
    return { question: text.trim(), quote_removed: false, signature_removed: false }
  return { question, quote_removed, signature_removed }
}

/* ------------------------------------------------------------------ */
/* ② 能不能试                                                           */
/* ------------------------------------------------------------------ */

/**
 * 第一版不直发的渠道细分（docs/108 §8.1 自主决定，Luoye 可改）：**Amazon 买家消息**——
 * 平台对卖家消息管得严，回错了伤账号，照旧出卡。做成一个可改的排除项，不写死在判定里：
 * 装配方可以传自己的一份（`emailAutoReplyGate` 的 `excluded_sub_channels`）。
 */
export const EMAIL_AUTO_REPLY_EXCLUDED_SUB_CHANNELS: readonly string[] = ['amazon']

/** 邮件这边多出来的几种「不直接回」（聊天的那几种照旧用 `ChatHoldKind`）。 */
export type EmailHoldKind =
  | ChatHoldKind
  | 'off'
  | 'excluded_channel'
  | 'shadow_mode'
  | 'no_recipient'
  | 'not_autonomous'
  | 'no_model'
  | 'outbound_blocked'

export interface EmailAutoReplyGateInput {
  /** 「消息渠道 → 这只邮箱」那个开关（缺省开）。 */
  enabled: boolean
  /** 客服判断层对这封来信的结论（三道自主门放行才是 `auto_reply`）。 */
  inbound_action?: 'handoff' | 'boundary_question' | 'pending_review' | 'auto_reply'
  /** 渠道细分（`amazon` …）。 */
  sub_channel?: string
  excluded_sub_channels?: readonly string[]
  /** 回信能不能回给原发件人（收件人待定 = 不直发）。 */
  has_recipient: boolean
  /** 这只邮箱开着「只看不动」。 */
  shadow_mode?: boolean
}

export interface EmailHold {
  kind: EmailHoldKind
  reason: string
}

/** 问模型之前先过的那几样。回 `undefined` = 可以试。 */
export function emailAutoReplyGate(input: EmailAutoReplyGateInput): EmailHold | undefined {
  if (!input.enabled) return { kind: 'off', reason: '这只邮箱关了「有把握就直接回」' }
  const excluded = input.excluded_sub_channels ?? EMAIL_AUTO_REPLY_EXCLUDED_SUB_CHANNELS
  if (input.sub_channel !== undefined && excluded.includes(input.sub_channel))
    return {
      kind: 'excluded_channel',
      reason:
        input.sub_channel === 'amazon'
          ? 'Amazon 买家消息先不直接回（平台管得严，回错了伤账号）'
          : `「${input.sub_channel}」这一路先不直接回`,
    }
  if (input.shadow_mode === true)
    return { kind: 'shadow_mode', reason: '这只邮箱开着「只看不动」，AI 不直接发信' }
  if (!input.has_recipient) return { kind: 'no_recipient', reason: '收件人还没认出来，不替你发' }
  if (input.inbound_action !== 'auto_reply')
    return {
      kind: 'not_autonomous',
      reason:
        input.inbound_action === 'boundary_question'
          ? '有一条业务口径还没定，先问你'
          : input.inbound_action === 'handoff'
            ? '这封要人来处理'
            : '这封要你确认（三道自主门没放行）',
    }
  return undefined
}

/**
 * 这封信按聊天那一套「该怎么办」（同一个分类与涉钱词表）：
 * 退款 / 赔偿 / 改单 / 改地址 / 补发 / 要人工都不是 `answer`，判定里一律转人。
 *
 * 和聊天差一处：聊天里「缺资料」（问保修没说型号、问物流没给单号）先追问一句；邮件一来一回要一天，
 * 不追问——照样让模型只按材料答，答不了的那一件它会照实写「要跟同事确认」，于是整封转人。
 */
export function emailAnswerPlan(question: string): ChatResponsePlan {
  const classification = classifyChatTurn(question)
  const plan = buildChatPlan({ classification, turn_text: question })
  return plan.action === 'collect_info' ? { ...plan, action: 'answer' } : plan
}

/* ------------------------------------------------------------------ */
/* ③ 起草的格式                                                         */
/* ------------------------------------------------------------------ */

/** 这一段出现在 prompt 里 = 这是一次「邮件直接回」起草（stub 剧本靠它认）。 */
export const EMAIL_ANSWER_CITE_INSTRUCTION = [
  '【邮件直接回 · 出处标注】下面每条材料前面有编号（K = 知识，O = 订单现查）。',
  '只写回答本身：不要称呼、不要寒暄、不要落款（我们会加上）。来信问了几件事就逐一回答，用来信的语言写。',
  '你写的每一句事实后面用方括号标出它来自哪条材料，例如「保修期是 24 个月[K1]。」；材料里找不到出处的事不要编，答不了的那一件就照实写「这一点我需要跟同事确认」。',
  '最后单独一行写「把握：0-100」——你有多大把握这封回信准确、完全由材料支持（没把握就写低分，我们会转给同事）。',
].join('\n')

/** 来信那一段的标记（stub 剧本靠它找问句）。 */
export const EMAIL_QUESTION_MARK = '来信（这一封新写的部分）：'

/** 拼给模型的那一段（材料 + 格式要求 + 打码围栏过的问句）。 */
export function emailAnswerPrompt(input: {
  sources: readonly AutoAnswerSource[]
  question: string
  subject?: string
}): string {
  return [
    ...(input.sources.length === 0 ? [] : [`材料：\n${formatChatSources(input.sources)}`]),
    EMAIL_ANSWER_CITE_INSTRUCTION,
    ...(input.subject === undefined || input.subject.trim() === ''
      ? []
      : [`主题：${fenceForPrompt(input.subject, 200).text}`]),
    `${EMAIL_QUESTION_MARK}\n${fenceForPrompt(input.question, 4000).text}`,
  ].join('\n\n')
}

/* ------------------------------------------------------------------ */
/* ④ 发出去的那一封                                                      */
/* ------------------------------------------------------------------ */

const hasCjk = (s: string): boolean => /[一-鿿]/.test(s)

/** 称呼里的名字：发件人显示名的第一个词；是地址 / 太长 / 带怪字符就不用。 */
function greetingName(display: string | undefined): string | undefined {
  const d = display?.trim()
  if (d === undefined || d === '' || d.includes('@') || d.length > 40) return undefined
  if (hasCjk(d)) return d
  const first = d.split(/\s+/)[0] ?? ''
  return /^[A-Za-z][A-Za-z'.-]{0,30}$/.test(first) ? first : undefined
}

/**
 * 去掉出处标记与自评之后的回答 → 一封完整的回信（称呼 + 回答 + 落款）。
 * 按来信语言：来信是中文就「您好」，否则英文。
 */
export function composeEmailReply(input: {
  /** `scoreAutoAnswer` 回的 `text`（已去标记、去自评）。 */
  answer: string
  question: string
  from_display?: string
  /** 落款（品牌 / 团队名）。不给：中文「客服团队」、英文「Customer Support」。 */
  signature?: string
}): string {
  const zh = hasCjk(input.question)
  const name = greetingName(input.from_display)
  const answer = input.answer.trim()
  if (zh) {
    const sig = input.signature?.trim() || '客服团队'
    return `${name === undefined ? '您好' : `${name}，您好`}：\n\n${answer}\n\n${sig}`
  }
  const sig =
    input.signature?.trim() && !hasCjk(input.signature)
      ? input.signature.trim()
      : 'Customer Support'
  return `${name === undefined ? 'Hi' : `Hi ${name}`},\n\n${answer}\n\nBest regards,\n${sig}`
}

/** 卡标题后面那一句「为什么没直接回」（同聊天 WP428 的理由词）。 */
export const EMAIL_HELD_SHORT: Readonly<Record<string, string>> = {
  money: '涉及钱或改单',
  commitment: '有承诺',
  time_promise: '许了时间',
  personal_info: '回复里带个人信息',
  learned: '同类你说过先给你看',
  no_source: '知识库里没有',
  low_confidence: '把握不够',
  off: '直接回已关',
  excluded_channel: 'Amazon 先不直接回',
  shadow_mode: '只看不动',
  no_recipient: '收件人待定',
  not_autonomous: '要你确认',
  no_model: '没接模型',
  outbound_blocked: '出站门拦下',
}

export function emailHeldShort(kind: string): string {
  return EMAIL_HELD_SHORT[kind] ?? '先给你看'
}

/* ------------------------------------------------------------------ */
/* stub 剧本（演示 / 模拟里没有真模型时，邮件直接回这一封怎么写）            */
/* ------------------------------------------------------------------ */

/** 问句拆成「一件一件」：按问号 / 句号 / 换行切，去掉太短的寒暄。 */
function questionParts(question: string): string[] {
  return question
    .split(/(?<=[?？。！!])|\n+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (s === '') return false
      const zh = (s.match(/[一-鿿]/g) ?? []).length
      const en = (s.match(/[A-Za-z]+/g) ?? []).length
      return zh > 0 ? zh >= 4 : en >= 3
    })
}

/**
 * 认得出「邮件直接回」那一次起草（prompt 里有 `EMAIL_ANSWER_CITE_INSTRUCTION`）才回话，别的一律 `undefined`。
 *
 * 剧本：来信问的每一件，材料里有词面对得上的那一条 → 照它说一句并标出处；
 * 有一件对不上 → 那一件写「这一点我需要跟同事确认」（不标出处，于是整封转人）；
 * 一件都对不上 → 只写那一句、把握 20。涉及退款的那一封根本不会走到这里（计划先转卡）。
 */
export function emailAnswerStubScript(
  messages: readonly { role: string; content: unknown }[],
): string | undefined {
  const user = messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
  // WP471（决策 1549）：出处要求挪进了系统提示（固定在前、命中缓存）；老写法在用户消息里也认
  const all = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  if (!all.includes(EMAIL_ANSWER_CITE_INSTRUCTION)) return undefined
  const at = user.lastIndexOf(EMAIL_QUESTION_MARK)
  const letter = (at < 0 ? '' : user.slice(at + EMAIL_QUESTION_MARK.length)).replace(
    /<\/?external_data>/g,
    '',
  )
  const materials = [...user.matchAll(/^\[([KO]\d+)\]\s*(.+)$/gm)].map((m) => ({
    ref: m[1] as string,
    text: (m[2] as string).trim(),
  }))
  const parts = questionParts(letter)
  const lines: string[] = []
  const used = new Set<string>()
  let missed = 0
  for (const part of parts.length === 0 ? [letter] : parts) {
    const q = chatTokens(part)
    let best: { ref: string; text: string; cov: number } | undefined
    for (const m of materials) {
      const cov = m.ref.startsWith('O') ? 0.99 : chatCoverage(q, chatTokens(m.text))
      if (cov > 0 && (best === undefined || cov > best.cov)) best = { ...m, cov }
    }
    if (best === undefined) {
      missed += 1
      continue
    }
    if (used.has(best.ref)) continue
    used.add(best.ref)
    const first = best.text.split(/(?<=[。！？!?])|(?<=\.)\s+|\n/)[0]?.trim() ?? ''
    const said = best.ref.startsWith('O')
      ? `这一单我查到了：${best.text.slice(0, 160)}`
      : (first === '' ? best.text : first).slice(0, 300)
    lines.push(`${said.replace(/[。.]?\s*$/, '')}[${best.ref}]。`)
  }
  if (lines.length === 0) return '这一点我需要跟同事确认一下，确认后马上回复您。\n把握：20'
  if (missed > 0) lines.push('另外那一点我需要跟同事确认一下，确认后马上回复您。')
  return `${lines.join('\n')}\n把握：${missed > 0 ? 40 : 90}`
}
