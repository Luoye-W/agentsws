/**
 * WP428（决策 1246 改）：在线客服**按置信度直接答**。
 *
 * 一句起草好的聊天回复，能不能不经人直接发给访客——这里给出判定与理由。全是纯函数，
 * 服务进程（`apps/server/src/chat.ts`）与模拟回路（`packages/simulation/src/chat.ts`）用的是同一份，
 * 三个运行时（stub / direct / dsh）同一个口径。
 *
 * ## 先看「一律转人」，再算分
 *
 * 不管分数多高，碰到下面任何一样都不直接发（`hold.kind`）：
 *
 * | kind | 判据 |
 * |---|---|
 * | `money` | 计划不是 `answer`（涉钱 / 退款 / 改单 / 改地址 / 补发 / 要人工），或三道自主门里的 L3 黑名单不放行 |
 * | `commitment` | 回复里有第一人称承诺或没有出处的让步（`scanOutboundCommitment`，与邮件同一套词表） |
 * | `time_promise` | 回复里许了具体到哪天的时间（「明天发」「保证 3 天内到」「we'll ship today」） |
 * | `personal_info` | **要发出的回复里**带出了个人信息（邮箱 / 电话 / 地址 / 卡号，或订单上的姓名地址）。访客自己在消息里留的邮箱 / 电话不算（决策 1303） |
 * | `learned` | 同类问题人说过「这句不该直接答」 |
 * | `no_source` | 一条出处都没有（知识卡、政策、订单现查结果都没对上） |
 *
 * ## 分数怎么算（0–1）
 *
 * ```text
 * 分数 = 0.30 × 检索命中 + 0.50 × 逐句有出处 + 0.20 × 模型自评
 * ```
 *
 * - **检索命中**：问句和每条出处的词面重合度（中文按两字一组、英文按词）；模型在句子上标了这条出处，
 *   至少算 0.6；订单是按访客报的单号现查的，算 1；过时的知识打七折。取最高的那一条。
 * - **逐句有出处**：回复拆成句子（反问、寒暄不算），每一句要么标了真实存在的出处编号、要么和出处
 *   词面重合过半；**句子里的数字（金额、天数、百分比）必须在出处里原样出现**，否则这一句算没出处。
 *   这是机器能核的那一半：模型标了编号，我们再拿数字去对。
 * - **模型自评**：模型在末尾给的「把握：0–100」。**只能往下拉，不能往上抬**——自评低于这一档的下限直接不发；
 *   没给按 0.5 算。权重只有两成，不靠它定。
 *
 * 三档门槛（设置里只有「严格 / 适中 / 宽松」，不让人填数字；决策 1302 定名）：
 *
 * | 档 | 分数 | 逐句有出处 | 检索命中 | 自评下限 |
 * |---|---|---|---|---|
 * | 严格 `strict` | ≥ 0.80 | 每一句 | ≥ 0.60 | 70 |
 * | 适中 `balanced`（缺省） | ≥ 0.70 | 每一句 | ≥ 0.40 | 50 |
 * | 宽松 `loose` | ≥ 0.60 | ≥ 2/3 | ≥ 0.30 | 30 |
 */
import { maskSensitive } from '@agentsws/core'
import { evaluateAutonomyGates } from '../gates/gates.js'
import { scanOutboundCommitment } from '../gates/l3-denylist.js'
import type { ChatResponsePlan } from './types.js'

/** 「严格 / 适中 / 宽松」（英文 Strict / Balanced / Lenient）。 */
export type ChatAutoAnswerStrictness = 'strict' | 'balanced' | 'loose'

export const CHAT_AUTO_ANSWER_STRICTNESS: readonly ChatAutoAnswerStrictness[] = [
  'strict',
  'balanced',
  'loose',
]

export const DEFAULT_CHAT_AUTO_ANSWER_STRICTNESS: ChatAutoAnswerStrictness = 'balanced'

export function normalizeChatAutoAnswerStrictness(raw: unknown): ChatAutoAnswerStrictness {
  return CHAT_AUTO_ANSWER_STRICTNESS.find((s) => s === raw) ?? DEFAULT_CHAT_AUTO_ANSWER_STRICTNESS
}

export interface ChatAutoAnswerThreshold {
  score: number
  support: number
  retrieval: number
  self_min: number
}

export const CHAT_AUTO_ANSWER_THRESHOLDS: Readonly<
  Record<ChatAutoAnswerStrictness, ChatAutoAnswerThreshold>
> = {
  strict: { score: 0.8, support: 1, retrieval: 0.6, self_min: 70 },
  balanced: { score: 0.7, support: 1, retrieval: 0.4, self_min: 50 },
  loose: { score: 0.6, support: 0.66, retrieval: 0.3, self_min: 30 },
}

/** 没把握、先转给同事时对访客说的那句（「稍等，马上帮你问」）。 */
export const CHAT_HELD_REPLY = '稍等，我马上帮你问一下。'

export const CHAT_AUTO_ANSWER_WEIGHTS = { retrieval: 0.3, support: 0.5, self: 0.2 } as const

/** 一条出处：知识卡 / 政策 / 订单现查结果。 */
export interface ChatAnswerSource {
  /** 给模型看的编号（`K1`、`O1`），回复里按它标出处。 */
  ref: string
  kind: 'fact_card' | 'policy' | 'order'
  /** 知识卡 id / 订单号。 */
  id: string
  /** 给人看的短名（卡上、对话记录里「出处：…」那一格）。 */
  label: string
  /** 出处原文（已脱敏的那一份）。 */
  text: string
  /** 知识过时了（还在用，但打折）。 */
  stale?: boolean
  /** 订单上的个人信息（姓名、地址、邮箱、电话）——回复里出现任何一样都转人。不进日志。 */
  private_values?: string[]
}

export type ChatHoldKind =
  | 'money'
  | 'commitment'
  | 'time_promise'
  | 'personal_info'
  | 'learned'
  | 'no_source'
  | 'low_confidence'

export interface ChatAutoAnswerInput {
  plan: ChatResponsePlan
  /** 访客这一轮说的话（原文）。 */
  turn_text: string
  /** 模型回的原文（可能带 `[K1]` 标记与「把握：」那一行）。 */
  reply: string
  sources: readonly ChatAnswerSource[]
  strictness?: ChatAutoAnswerStrictness
  /** 人说过「这句不该直接答」的那几条（按这一句真用上的出处与问句词面比，见 `matchLearnedHold`）。 */
  learned_holds?: readonly ChatLearnedHold[]
}

export interface ChatSentenceCheck {
  index: number
  /** 这一句算不算内容（反问、寒暄不算）。 */
  content: boolean
  supported: boolean
  /** 这一句标的出处编号（只认真实存在的）。 */
  cited: string[]
  /** 没对上时的原因（人话）。 */
  why?: string
}

export interface ChatAutoAnswerVerdict {
  send: boolean
  /** 0–1，两位小数。 */
  score: number
  strictness: ChatAutoAnswerStrictness
  factors: {
    retrieval: number
    support: number
    /** 模型自评 0–100；没给就没有这一格。 */
    self?: number
    sentences: number
    supported: number
  }
  /** 第一条不放行的理由。 */
  hold?: { kind: ChatHoldKind; reason: string }
  /** 全部理由（卡上列出来；发出去时也留着给人看「凭什么」）。 */
  reasons: string[]
  /** 这句回复用上的出处（标了的、或词面对上的）。 */
  sources_used: ChatAnswerSource[]
  /** 去掉出处标记与自评那一行之后、真正发给访客的那一句。 */
  text: string
  sentence_checks: ChatSentenceCheck[]
}

/* ------------------------------------------------------------------ */
/* 给模型的那段格式要求（服务端与模拟、stub 剧本共用）                       */
/* ------------------------------------------------------------------ */

/** 这一段出现在 prompt 里 = 这是一次「聊天直答」起草（stub 剧本靠它认）。 */
export const CHAT_ANSWER_CITE_INSTRUCTION = [
  '【出处标注】下面每条材料前面有编号（K = 知识，O = 订单现查）。',
  '你写的每一句事实后面用方括号标出它来自哪条材料，例如「满 $50 免邮[K1]。」；材料里找不到出处的事不要写。',
  '最后单独一行写「把握：0-100」——你有多大把握这句话准确、完全由材料支持（没把握就写低分，我们会转给同事）。',
].join('\n')

/** 材料清单（`[K1] …`）。 */
export function formatChatSources(sources: readonly ChatAnswerSource[]): string {
  return sources.map((s) => `[${s.ref}] ${s.text.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')
}

/* ------------------------------------------------------------------ */
/* 词面                                                                */
/* ------------------------------------------------------------------ */

const EN_STOP = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'be',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'it',
  'its',
  'this',
  'that',
  'you',
  'your',
  'we',
  'our',
  'i',
  'my',
  'me',
  'do',
  'does',
  'can',
  'could',
  'will',
  'would',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'much',
  'many',
  'with',
  'at',
  'by',
  'from',
  'as',
  'if',
  'any',
  'have',
  'has',
  'there',
  'yes',
  'no',
  'not',
  'hi',
  'hello',
  'thanks',
  'thank',
  'please',
  'just',
  'so',
  'also',
  'about',
])

const ZH_STOP = new Set([
  '我们',
  '你们',
  '请问',
  '一下',
  '可以',
  '这个',
  '那个',
  '什么',
  '怎么',
  '多少',
])

/** 文本 → 词面集合（中文两字一组、英文按词、数字原样）。 */
export function chatTokens(text: string): Set<string> {
  const out = new Set<string>()
  const norm = text.normalize('NFKC').toLowerCase()
  for (const m of norm.matchAll(/[a-z][a-z'-]*|\d+(?:[.,]\d+)?/g)) {
    const w = m[0].replace(/[.,]$/, '')
    if (w.length < 2 && !/\d/.test(w)) continue
    if (EN_STOP.has(w)) continue
    out.add(w.replace(/,/g, ''))
  }
  for (const m of norm.matchAll(/[一-鿿]+/g)) {
    const run = m[0]
    if (run.length === 1) {
      out.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) {
      const bi = run.slice(i, i + 2)
      if (!ZH_STOP.has(bi)) out.add(bi)
    }
  }
  return out
}

/** `a` 里有多少落在 `b` 里（0–1）。`a` 空 = 0。 */
export function chatCoverage(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0) return 0
  let hit = 0
  for (const t of a) if (b.has(t)) hit += 1
  return hit / a.size
}

/** 句子里的数字（金额、天数、百分比）；`1,299` → `1299`，`6.90` → `6.9`。 */
export function chatNumbers(text: string): string[] {
  const out: string[] = []
  for (const m of text.normalize('NFKC').matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    let n = m[0].replace(/,/g, '')
    if (n.includes('.')) n = n.replace(/0+$/, '').replace(/\.$/, '')
    out.push(n)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 拆回复：出处标记、自评那一行、句子                                       */
/* ------------------------------------------------------------------ */

const SELF_LINE = /^[ \t]*(?:把握|置信度|confidence)\s*[:：]\s*(\d{1,3})\s*%?[ \t]*$/im
const CITE = /[[【]\s*((?:[KO]\d+)(?:\s*[,，、]\s*[KO]\d+)*)\s*[\]】]/g

export interface ParsedChatAnswer {
  text: string
  self?: number
  sentences: { text: string; cited: string[] }[]
}

/** 模型回的原文 → 干净的回复 + 每句标的出处 + 自评。 */
export function parseChatAnswer(raw: string): ParsedChatAnswer {
  let body = raw.trim()
  let self: number | undefined
  const sm = SELF_LINE.exec(body)
  if (sm !== null) {
    self = Math.max(0, Math.min(100, Number(sm[1])))
    body = (body.slice(0, sm.index) + body.slice(sm.index + sm[0].length)).trim()
  }
  const pieces =
    body.match(
      /[^。！？!?；;\n]+?(?:[。！？!?；;]+|\.(?=\s|$|[[【])|\n|$)(?:\s*[[【][^\]】]*[\]】])*/g,
    ) ?? []
  const sentences: { text: string; cited: string[] }[] = []
  for (const piece of pieces) {
    const cited: string[] = []
    for (const m of piece.matchAll(CITE)) {
      for (const id of (m[1] ?? '').split(/[,，、]/)) {
        const ref = id.trim().toUpperCase()
        if (ref !== '' && !cited.includes(ref)) cited.push(ref)
      }
    }
    const text = piece
      .replace(CITE, '')
      .replace(/\s+([。！？!?；;.,，])/g, '$1')
      .trim()
    if (text !== '') sentences.push({ text, cited })
  }
  const text = body
    .replace(CITE, '')
    .replace(/[ \t]+([。！？!?；;.,，])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return { text, ...(self === undefined ? {} : { self }), sentences }
}

/** 反问 / 寒暄 / 太短的不算内容句（不要求出处，也不计分）。 */
function isFiller(sentence: string): boolean {
  if (chatNumbers(sentence).length > 0) return false
  const s = sentence.trim()
  if (/[?？]\s*$/.test(s)) return true
  const zh = (s.match(/[一-鿿]/g) ?? []).length
  const en = (s.match(/[A-Za-z]+/g) ?? []).length
  if (zh > 0 ? zh <= 6 : en <= 3) return true
  return /^(thanks|thank you|you're welcome|happy to help|glad to help|anything else|let me know|好的|不客气|还有别的|有其他|还有什么)/i.test(
    s,
  )
}

/* ------------------------------------------------------------------ */
/* 一律转人的几样                                                         */
/* ------------------------------------------------------------------ */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,4}\d{3,4}/
const STREET_EN =
  /\b\d{1,5}\s+(?:[A-Za-z]+\s){0,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b/i
const ADDRESS_ZH = /[一-鿿]{2,}(?:路|街|大道|巷|弄)\s*\d+\s*号/

/** 文本里有没有个人信息（邮箱、电话、街道地址、卡号 / 验证码这类）。 */
export function hasPersonalInfo(text: string): boolean {
  if (EMAIL.test(text) || STREET_EN.test(text) || ADDRESS_ZH.test(text)) return true
  // 电话：至少 8 位数字（订单号 #1001 这类短号不算）
  for (const m of text.matchAll(new RegExp(PHONE.source, 'g'))) {
    const raw = m[0].trim()
    // 日期（2026-10-19）不是电话
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(raw)) continue
    if ((raw.match(/\d/g) ?? []).length >= 8) return true
  }
  return maskSensitive(text).rules.length > 0
}

const TIME_REL =
  /(今天|今晚|明天|明早|后天|本周|这周|下周|周[一二三四五六日天]|礼拜[一二三四五六日天]|\d+\s*(?:个)?\s*(?:工作)?\s*(?:天|日|小时|周|个月)\s*(?:内|之内|以内)?|\d+\s*号)/
const PROMISE_ZH = /(保证|承诺|一定|肯定|确保|包你)/
const FIRST_FUTURE_ZH = /(我们|我)[^。！？，,]{0,6}(会|将|就|马上|立刻|给你)/
const DELIVERY_ZH = /(发货|发出|寄出|送到|到货|送达|到你|退|处理好|安排|补|回复你)/
const PROMISE_EN =
  /\b(guarantee|guaranteed|promise|promised|make sure|definitely|for sure)\b[^.!?]{0,60}\b(arriv|deliver|ship|reach|refund|today|tomorrow|tonight|within|by\s)/i
const FIRST_FUTURE_EN =
  /\b(i|we)\s*(?:'ll|will|shall|are going to|can)\b[^.!?]{0,60}\b(today|tomorrow|tonight|this week|next week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of)|within \d+|in \d+ (?:hours?|days?|weeks?))\b/i

/** 回复里有没有许具体时间（「明天发」「保证 3 天内到」「we'll ship tomorrow」）。按句判。 */
export function hasTimePromise(reply: string): boolean {
  if (PROMISE_EN.test(reply) || FIRST_FUTURE_EN.test(reply)) return true
  for (const s of reply.split(/[。！？!?；;\n]/)) {
    if (!TIME_REL.test(s)) continue
    if (PROMISE_ZH.test(s)) return true
    if (
      FIRST_FUTURE_ZH.test(s) &&
      DELIVERY_ZH.test(s) &&
      /(今天|今晚|明天|明早|后天|本周|这周|下周|周[一二三四五六日天])/.test(s)
    )
      return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 学习回路：「这句不该直接答」                                            */
/* ------------------------------------------------------------------ */

/** 人点过「这句不该直接答」的那一条（只留问句的词面与出处，不留访客原话以外的东西）。 */
export interface ChatLearnedHold {
  /** 访客当时那句话的词面（`chatTokens`）。 */
  tokens: string[]
  intent: string
  /** 当时用上的出处 id（知识卡 id）。 */
  source_ids: string[]
}

/**
 * 新的一问算不算「同类」：同一意图且用上了同一条知识卡；或者问句词面重合过半（Jaccard ≥ 0.5）。
 */
export function matchLearnedHold(
  holds: readonly ChatLearnedHold[],
  input: { turn_text: string; intent: string; source_ids: readonly string[] },
): boolean {
  const q = chatTokens(input.turn_text)
  for (const h of holds) {
    if (
      h.intent === input.intent &&
      h.source_ids.length > 0 &&
      h.source_ids.some((id) => input.source_ids.includes(id))
    )
      return true
    const t = new Set(h.tokens)
    let inter = 0
    for (const x of q) if (t.has(x)) inter += 1
    const union = q.size + t.size - inter
    if (union > 0 && inter / union >= 0.5) return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => Math.round(n * 100) / 100

const STRICTNESS_NAME: Record<ChatAutoAnswerStrictness, string> = {
  strict: '严格',
  balanced: '适中',
  loose: '宽松',
}

export function scoreChatAutoAnswer(input: ChatAutoAnswerInput): ChatAutoAnswerVerdict {
  const strictness = input.strictness ?? DEFAULT_CHAT_AUTO_ANSWER_STRICTNESS
  const th = CHAT_AUTO_ANSWER_THRESHOLDS[strictness]
  const parsed = parseChatAnswer(input.reply)
  const byRef = new Map(input.sources.map((s) => [s.ref.toUpperCase(), s]))
  const reasons: string[] = []
  const holds: { kind: ChatHoldKind; reason: string }[] = []
  const hold = (kind: ChatHoldKind, reason: string): void => {
    holds.push({ kind, reason })
    reasons.push(reason)
  }

  // ── 一律转人 ───────────────────────────────────────────────
  if (input.plan.action !== 'answer' || input.plan.money_touch) {
    hold('money', '涉及退款、赔偿、改单或要人工，一律转人')
  }
  const gates = evaluateAutonomyGates({
    channel: 'chat',
    classification: {
      intent: input.plan.intent,
      source: 'chat_classification',
      risk_level: input.plan.risk,
    },
    inbound_text: input.turn_text,
    proposed_reply_text: parsed.text,
    draft: { generated_by: 'ai' },
  })
  const scan = scanOutboundCommitment(parsed.text)
  if (gates.blocking_gate === 'l3_denylist' && !holds.some((h) => h.kind === 'money')) {
    hold('money', '这一类（退款 / 赔偿 / 补发 / 取消 / 改地址 / 投诉）一律转人')
  }
  if (scan.hits.length > 0 || scan.unsourced_concession) {
    hold('commitment', '回复里有承诺或让步（退款、赔偿、补发这类），一律转人')
  }
  if (hasTimePromise(parsed.text)) {
    hold('time_promise', '回复里许了具体时间（哪天发、几天到），一律转人')
  }
  const privateValues = input.sources.flatMap((s) => s.private_values ?? [])
  const leaksPrivate = privateValues.some(
    (v) => v.trim().length >= 3 && parsed.text.toLowerCase().includes(v.trim().toLowerCase()),
  )
  // 决策 1303：只看要发出去的这一句——访客自己留的邮箱 / 电话不算（回复里原样带回去了才算）
  if (hasPersonalInfo(parsed.text) || leaksPrivate) {
    hold('personal_info', '回复里带出了个人信息（邮箱、电话、地址、姓名），一律转人')
  }

  // ── 逐句有出处 ─────────────────────────────────────────────
  const sourceTokens = new Map(input.sources.map((s) => [s.ref.toUpperCase(), chatTokens(s.text)]))
  const sourceNumbers = new Map(
    input.sources.map((s) => [s.ref.toUpperCase(), new Set(chatNumbers(s.text))]),
  )
  const allNumbers = new Set<string>()
  for (const set of sourceNumbers.values()) for (const n of set) allNumbers.add(n)

  const used = new Set<string>()
  const checks: ChatSentenceCheck[] = parsed.sentences.map((s, index) => {
    const content = !isFiller(s.text)
    const cited = s.cited.filter((r) => byRef.has(r))
    const invented = s.cited.filter((r) => !byRef.has(r))
    if (!content) return { index, content, supported: true, cited }
    for (const r of cited) used.add(r)
    const nums = chatNumbers(s.text)
    const pool =
      cited.length > 0
        ? new Set(cited.flatMap((r) => [...(sourceNumbers.get(r) ?? [])]))
        : allNumbers
    const badNum = nums.find((n) => !pool.has(n))
    if (badNum !== undefined)
      return { index, content, supported: false, cited, why: `数字 ${badNum} 在出处里找不到` }
    if (invented.length > 0 && cited.length === 0)
      return {
        index,
        content,
        supported: false,
        cited,
        why: `标的出处 ${invented.join('、')} 不存在`,
      }
    const tokens = chatTokens(s.text)
    if (cited.length > 0) return { index, content, supported: true, cited }
    // 没标出处：词面和出处重合过半才算（跨语言的回复必须靠标注）
    let best: string | undefined
    let bestCov = 0
    for (const [ref, set] of sourceTokens) {
      const cov = chatCoverage(tokens, set)
      if (cov > bestCov) {
        bestCov = cov
        best = ref
      }
    }
    if (best !== undefined && bestCov >= 0.5) {
      used.add(best)
      return { index, content, supported: true, cited }
    }
    return { index, content, supported: false, cited, why: '这一句对不上任何出处' }
  })
  const contentChecks = checks.filter((c) => c.content)
  const supportedCount = contentChecks.filter((c) => c.supported).length
  const support = contentChecks.length === 0 ? 0 : supportedCount / contentChecks.length

  // ── 检索命中 ───────────────────────────────────────────────
  const q = chatTokens(input.turn_text)
  let retrieval = 0
  for (const s of input.sources) {
    const ref = s.ref.toUpperCase()
    let rel = s.kind === 'order' ? 1 : chatCoverage(q, sourceTokens.get(ref) ?? new Set())
    if (s.kind !== 'order' && used.has(ref)) rel = Math.max(rel, 0.6)
    if (s.kind === 'order' && !used.has(ref)) rel = 0
    if (s.stale === true) rel *= 0.7
    retrieval = Math.max(retrieval, rel)
  }
  retrieval = round2(Math.min(1, retrieval))

  const self = parsed.self
  const selfScore = self === undefined ? 0.5 : self / 100
  const score = round2(
    CHAT_AUTO_ANSWER_WEIGHTS.retrieval * retrieval +
      CHAT_AUTO_ANSWER_WEIGHTS.support * support +
      CHAT_AUTO_ANSWER_WEIGHTS.self * selfScore,
  )

  // ── 出处与分数门槛 ─────────────────────────────────────────
  const sourcesUsed = input.sources.filter((s) => used.has(s.ref.toUpperCase()))
  if (
    matchLearnedHold(input.learned_holds ?? [], {
      turn_text: input.turn_text,
      intent: input.plan.intent,
      source_ids: sourcesUsed.filter((s) => s.kind !== 'order').map((s) => s.id),
    })
  ) {
    hold('learned', '同类问题你说过「不该直接答」，这次也转你')
  }
  if (input.sources.length === 0 || sourcesUsed.length === 0) {
    hold('no_source', '知识库和订单里都没有能对上的出处')
  } else {
    const firstBad = contentChecks.find((c) => !c.supported)
    if (contentChecks.length === 0) hold('low_confidence', '回复里没有一句实际内容')
    else if (support < th.support && firstBad !== undefined)
      hold('low_confidence', `第 ${firstBad.index + 1} 句${firstBad.why ?? '对不上出处'}`)
    if (retrieval < th.retrieval) hold('low_confidence', '问句和出处对得不够上')
    if (self !== undefined && self < th.self_min)
      hold('low_confidence', `AI 自己说把握不大（${self}/100）`)
    if (score < th.score)
      hold(
        'low_confidence',
        `把握 ${score.toFixed(2)}，没到「${STRICTNESS_NAME[strictness]}」这一档的 ${th.score.toFixed(2)}`,
      )
  }

  const first = holds[0]
  return {
    send: first === undefined,
    score,
    strictness,
    factors: {
      retrieval,
      support: round2(support),
      ...(self === undefined ? {} : { self }),
      sentences: contentChecks.length,
      supported: supportedCount,
    },
    ...(first === undefined ? {} : { hold: first }),
    reasons,
    sources_used: sourcesUsed,
    text: parsed.text,
    sentence_checks: checks,
  }
}

/* ------------------------------------------------------------------ */
/* stub 剧本（演示 / 模拟里没有真模型时，聊天直答这一句怎么写）               */
/* ------------------------------------------------------------------ */

/**
 * 认得出「聊天直答」那一次起草（prompt 里有 `CHAT_ANSWER_CITE_INSTRUCTION`）才回话，别的一律 `undefined`。
 *
 * 剧本：材料里有和访客这句词面对得上的那一条 → 照它说一句并标出处、把握 90；
 * 一条都对不上 → 说「我得跟同事确认一下」、不标出处、把握 20（于是转人）。
 * 涉及退款的那一轮根本不会走到这里（计划先转卡）。
 */
export function chatAnswerStubScript(
  messages: readonly { role: string; content: unknown }[],
): string | undefined {
  const user = messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
  // WP471（决策 1549）：出处要求挪进了系统提示（固定在前、命中缓存）；老写法在用户消息里也认
  const all = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  if (!all.includes(CHAT_ANSWER_CITE_INSTRUCTION)) return undefined
  const visitorAt = user.lastIndexOf('访客说：')
  const visitor = visitorAt < 0 ? '' : user.slice(visitorAt + 4)
  const q = chatTokens(visitor.replace(/<\/?external_data>/g, ''))
  let best: { ref: string; text: string; cov: number } | undefined
  for (const m of user.matchAll(/^\[([KO]\d+)\]\s*(.+)$/gm)) {
    const ref = m[1] as string
    const text = (m[2] as string).trim()
    const cov = ref.startsWith('O') ? 0.99 : chatCoverage(q, chatTokens(text))
    if (cov > 0 && (best === undefined || cov > best.cov)) best = { ref, text, cov }
  }
  if (best === undefined) return '这个我得跟同事确认一下。\n把握：20'
  const first = best.text.split(/(?<=[。！？!?])|(?<=\.)\s+|\n/)[0]?.trim() ?? ''
  const said = best.ref.startsWith('O')
    ? `这一单我查到了：${best.text.slice(0, 160)}`
    : (first === '' ? best.text : first).slice(0, 300)
  return `${said.replace(/[。.]?\s*$/, '')}[${best.ref}]。\n把握：90`
}
