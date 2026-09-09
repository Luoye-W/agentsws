/**
 * Extracted from KefuAgent src/lib/support/knowledge-learning.ts
 * (NO_INFO_ANSWER_RE / POLICY_SENSITIVE_RE / POLICY_COMMITMENT_RE / CATEGORY_KEYWORDS /
 *  publishSafeKnowledgeCandidates 的判据) 与 src/lib/support/standard-distill.ts (PII_PATTERNS)，
 * rewritten for agentsws contracts.
 *
 * 知识引导：从一通对话里挑出"可能成为知识的句子"，做成 19 §1.1 FactCard 的**草稿**。
 * 三条判据决定它能不能自动进知识库：
 *   ① 空答案（"页面未提供…"）→ 直接丢
 *   ② 政策敏感 / 含承诺（天数、金额、比例、"免费/全额"）→ 必须人审
 *   ③ 未脱敏（邮箱、订单号、金额、长数字）→ 必须人审
 * 剩下的才可能自动进；即使自动进，也只是 `proposed`，激活仍由负责人点头（19 §2）。
 */
import type { FactCard, Iso8601, KnowledgeLayer, PersonId, RangeRef } from '@agentsws/contracts'
import { isDeidentified } from './entities.js'
import { displayLine, sanitizeExternal } from './text.js'
import type { Classification, SupportIntent } from './types.js'

/** 空答案：抽出来也不能用，进了知识库就是让 AI 告诉客户"我们不提供这个"。 */
export const NO_INFO_ANSWER_RE =
  /\b(does|do|did)\s+not\s+(provide|contain|mention|include|specify|state|list|offer)|not\s+(provided|available|specified|mentioned|found|stated|listed)\b|no\s+(information|details?|policy|mention)\b|page\s+does\s+not|未(提供|说明|提及|找到|包含)|没有(提供|相关|说明|找到)|无法(提供|找到|确定)/i

export function isNoInfoAnswer(answer: string | undefined): boolean {
  return answer === undefined || answer.trim().length === 0 || NO_INFO_ANSWER_RE.test(answer)
}

/** 政策敏感主题。 */
export const POLICY_SENSITIVE_RE =
  /refund|return|exchange|warrant|guarantee|policy|policies|terms|dispute|charge\s*back|compensat|liabilit|退款|退货|换货|保修|保固|质保|政策|条款|纠纷|赔/i

/** 承诺：数字 + 单位、金额、比例，或"退款/补发/发货"配上"内/免费/全额"。 */
export const POLICY_COMMITMENT_RE =
  /(\b\d+\s*(?:day|days|hour|hours|week|weeks|month|months|business\s*days?)\b|\b\d+\s*%|\$\s*\d+|€\s*\d+|£\s*\d+|¥\s*\d+|\b(?:refund|return|exchange|warranty|guarantee|compensation|compensate|replace|replacement|resend|ship|deliver|delivery)\b.{0,40}\b(?:within|after|before|free|full|partial|days?|hours?|weeks?|months?|%|\$|€|£|¥)\b|(?:退款|退货|换货|保修|保固|质保|赔偿|补偿|补发|重发|发货|送达|配送).{0,40}(?:\d+\s*(?:天|小时|周|个月|个工作日)|免费|全额|部分|比例|%|元|美元))/i

export interface PolicyScan {
  policy_sensitive: boolean
  /** 命中的承诺片段，去重后按出现顺序。 */
  commitments: string[]
}

/**
 * 同时扫原文与 NFKC 归一后的文本——弱覆盖语言下宁可多扣，不可漏扣
 * （KefuAgent scanPolicySensitiveText 的同一条保守取舍）。
 */
export function scanPolicySensitiveText(text: string): PolicyScan {
  const variants = [text, text.normalize('NFKC')]
  let policy_sensitive = false
  const commitments: string[] = []
  const global = new RegExp(POLICY_COMMITMENT_RE.source, 'gi')
  for (const variant of variants) {
    if (POLICY_SENSITIVE_RE.test(variant)) policy_sensitive = true
    global.lastIndex = 0
    for (;;) {
      const m = global.exec(variant)
      if (m === null) break
      policy_sensitive = true
      const hit = m[0].trim()
      if (hit.length > 0 && !commitments.includes(hit)) commitments.push(hit)
      if (m.index === global.lastIndex) global.lastIndex += 1
    }
  }
  return { policy_sensitive, commitments }
}

/* ------------------------------------------------------------------ */
/* 候选                                                                 */
/* ------------------------------------------------------------------ */

export type KnowledgeCandidateSource = 'conversation' | 'human_reply' | 'merchant_instruction'

/** 19 §1.1 FactCard 的草稿。审批通过后由宿主补 workspace / owner 落成事实卡。 */
export interface KnowledgeCandidate {
  /** 稳定的候选键（同一主题重复抽出来时用来去重、当 `dedupe_key` 的分量）。 */
  key: string
  layer: KnowledgeLayer
  subject: { type: string; key: string }
  /** 客户会怎么问。 */
  question: string
  /** 一句话事实，直接进 `FactCard.statement`。 */
  statement: string
  category: SupportIntent
  source: KnowledgeCandidateSource
  /** 0..1。政策敏感与未脱敏都会压低它。 */
  confidence: number
  /** 必须人审的原因；为空才可能自动进。 */
  hold_reasons: string[]
  deidentified: boolean
  commitments: string[]
  provenance: {
    source: 'email' | 'human' | 'agent_inference'
    ref: string
    quote?: string
    at: Iso8601
  }
}

/** 只在"内部人写的话"里挑（人工回复、商家指挥）；客户原话永远不是知识。 */
export interface CandidateInput {
  /** 一句话或一段话。 */
  text: string
  source: KnowledgeCandidateSource
  /** 出处引用（线程 id / 消息 id）。 */
  ref: string
  at: Iso8601
  /** 客户当时问的什么（做 `question`）。 */
  question?: string
  classification?: Classification
}

/** 太短的句子成不了知识（KefuAgent 的 `question.length < 10` 同口径）。 */
export const MIN_CANDIDATE_CHARS = 10
export const MAX_STATEMENT_CHARS = 500

/** 主题分类（KefuAgent CATEGORY_KEYWORDS，首条命中即返回）。 */
export const CATEGORY_KEYWORDS: readonly [SupportIntent, RegExp][] = [
  ['order_tracking', /track|where is|package|parcel|shipment|物流|订单|包裹|到哪/i],
  ['order_tracking', /delay|stuck|customs|late|延迟|清关|卡住/i],
  ['returns_refunds', /refund|return|exchange|退款|退货|换货/i],
  ['warranty', /warranty|guarantee|broken|repair|保修|维修/i],
  ['product_question', /how to|compatible|size|fit|spec|怎么|尺寸|兼容/i],
  ['complaint', /complaint|terrible|angry|投诉|差评/i],
]

export function categorize(text: string): SupportIntent {
  for (const [category, re] of CATEGORY_KEYWORDS) {
    if (re.test(text)) return category
  }
  return 'other'
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'kb'
  )
}

/**
 * 一段内部文本 → 知识候选（可能为空）。
 *
 * 层：含承诺 / 政策主题 → `policy`；语气与结构 → `phrasing`；其余 → `fact`。
 * 策略层永不进学习回路（24 §3），所以 `policy` 层候选的 `hold_reasons` 一定非空。
 */
export function knowledgeCandidate(input: CandidateInput): KnowledgeCandidate | undefined {
  const text = sanitizeExternal(input.text).trim()
  if (text.length < MIN_CANDIDATE_CHARS) return undefined
  if (isNoInfoAnswer(text)) return undefined

  const scan = scanPolicySensitiveText(text)
  const deidentified = isDeidentified(text)
  const category = input.classification?.intent ?? categorize(text)
  const layer: KnowledgeLayer = scan.policy_sensitive ? 'policy' : 'fact'

  const hold_reasons: string[] = []
  if (scan.policy_sensitive) hold_reasons.push('policy_sensitive')
  if (scan.commitments.length > 0) hold_reasons.push('contains_commitment')
  if (!deidentified) hold_reasons.push('not_deidentified')
  if (input.source === 'conversation') hold_reasons.push('source_layer')

  const confidence = Math.max(
    0.3,
    Math.min(0.95, 0.75 - hold_reasons.length * 0.1 + (input.source === 'human_reply' ? 0.1 : 0)),
  )

  const statement = displayLine(text, MAX_STATEMENT_CHARS)
  const question = displayLine(input.question ?? statement, 200)

  return {
    key: `kc_${slug(question)}`,
    layer,
    subject: { type: 'policy', key: `${category}.${slug(question).slice(0, 32)}` },
    question,
    statement,
    category,
    source: input.source,
    confidence,
    hold_reasons,
    deidentified,
    commitments: scan.commitments,
    provenance: {
      source: input.source === 'human_reply' ? 'human' : 'email',
      ref: input.ref,
      quote: statement.slice(0, 200),
      at: input.at,
    },
  }
}

/** 一通对话里的多段内部文本 → 候选列表，按出现顺序，按 `key` 去重。 */
export function knowledgeCandidates(inputs: readonly CandidateInput[]): KnowledgeCandidate[] {
  const out: KnowledgeCandidate[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const candidate = knowledgeCandidate(input)
    if (candidate === undefined || seen.has(candidate.key)) continue
    seen.add(candidate.key)
    out.push(candidate)
  }
  return out
}

/** 能不能自动进（仍然只是 `proposed`）。任何一条 hold 理由都拦下来。 */
export function canAutoPropose(candidate: KnowledgeCandidate, minConfidence = 0.6): boolean {
  return candidate.hold_reasons.length === 0 && candidate.confidence >= minConfidence
}

/** 候选 → 19 §1.1 的事实卡草稿（宿主补 id / status / usage / 时间戳）。 */
export function toFactCardDraft(
  candidate: KnowledgeCandidate,
  ctx: { workspace_id: string; owner: PersonId; scope: RangeRef[]; created_by_id: string },
): Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'> {
  return {
    schema_version: 1,
    workspace_id: ctx.workspace_id,
    layer: candidate.layer,
    domain: 'knowledge',
    scope: ctx.scope,
    sensitivity: 'internal',
    subject: { type: candidate.subject.type, key: candidate.subject.key },
    statement: candidate.statement,
    provenance: [candidate.provenance],
    confidence: { value: candidate.confidence, state: 'unverified' },
    valid: {},
    owner: ctx.owner,
    created_by: { kind: 'agent', id: ctx.created_by_id },
  }
}
