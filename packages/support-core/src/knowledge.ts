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

/* ------------------------------------------------------------------ */
/* WP56（48 §4 #9）：从历史邮件里学                                      */
/* ------------------------------------------------------------------ */

/**
 * Extracted from KefuAgent `src/lib/support/knowledge-learning.ts`
 * （`learnKnowledgeFromHistory` 的聚类口径：≥ 3 条成簇、最多 8 簇、每簇 6 个例子），
 * rewritten for agentsws。
 *
 * 一个刚接进来的工作区，知识库是空的，但它的邮箱里躺着两年的「客户问 → 真人答」。
 * 那就是现成的知识，只是没人整理过。这里做的是**聚类与出题**——
 * 归纳那一步交给模型（经运行时 / 网关，本包不认识模型）。
 *
 * 三条边界：
 * - 只看**内部人写的那一半**（真人回复），客户原话只当"问题长什么样"，永不成为知识；
 * - 聚类是关键词的，不是语义的：一个确定性的、看得懂的规则，比一个说不清为什么
 *   把这两封归到一起的向量更适合让人审；
 * - 归纳出来的一律是**候选**，走 `knowledge_update` 卡。
 */

/** 一对「客户问 → 真人答」。 */
export interface QaPair {
  thread_id: string
  /** 客户当时问的（只用来聚类与出题，不进知识）。 */
  question: string
  /** 真人当时怎么答的——这才是要学的东西。 */
  human_answer: string
  at: Iso8601
}

/** 几条才算一簇。少于这个数的归纳出来只是个案，不是口径。 */
export const MIN_CLUSTER_SIZE = 3
/** 一次最多学几簇。再多就不是"学一遍"，是让人审到崩溃。 */
export const MAX_CLUSTERS = 8
/** 每簇给模型看几个例子。 */
export const EXAMPLES_PER_CLUSTER = 6
/** 每个例子的字数上限（问与答各一份）。 */
export const EXAMPLE_MAX_CHARS = 800

export interface HistoryCluster {
  /** 簇键 = 主题分类（`categorize` 的结果）。 */
  category: SupportIntent
  /** 这一簇有多少对。 */
  size: number
  /** 挑出来给模型看的例子（按时间倒序取前 `EXAMPLES_PER_CLUSTER` 条）。 */
  examples: QaPair[]
  /** 全部线程 id（出处：归纳出来的那条知识是从哪几封信来的）。 */
  thread_ids: string[]
}

/**
 * 按主题关键词聚类。
 *
 * `other` 那一堆不成簇——它就是"没归上类的一堆"，归纳它等于让模型编。
 */
export function clusterHistory(
  pairs: readonly QaPair[],
  opts: { minClusterSize?: number; maxClusters?: number } = {},
): HistoryCluster[] {
  const min = opts.minClusterSize ?? MIN_CLUSTER_SIZE
  const max = opts.maxClusters ?? MAX_CLUSTERS
  const byCategory = new Map<SupportIntent, QaPair[]>()
  for (const pair of pairs) {
    const question = pair.question.trim()
    const answer = pair.human_answer.trim()
    // 太短的问 / 空的答都成不了知识
    if (question.length < MIN_CANDIDATE_CHARS || answer.length < MIN_CANDIDATE_CHARS) continue
    if (isNoInfoAnswer(answer)) continue
    const category = categorize(question)
    if (category === 'other') continue
    byCategory.set(category, [...(byCategory.get(category) ?? []), pair])
  }
  return (
    [...byCategory.entries()]
      .filter(([, list]) => list.length >= min)
      // 大簇优先；同样大的按类别名定序（确定性）
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
      .slice(0, max)
      .map(([category, list]) => {
        const sorted = [...list].sort((a, b) => (a.at < b.at ? 1 : -1))
        return {
          category,
          size: list.length,
          examples: sorted.slice(0, EXAMPLES_PER_CLUSTER),
          thread_ids: sorted.map((p) => p.thread_id),
        }
      })
  )
}

/** 出给模型的题：一段说明 + 几个例子。**模型调用不在本包**。 */
export interface HistoryPrompt {
  /** 要模型干什么。 */
  instruction: string
  /** 例子（已过围栏、已截断）。 */
  examples: { customer_question: string; human_reply: string }[]
  /** 这一簇的主题，回填进候选。 */
  category: SupportIntent
}

/**
 * 组 prompt 的零件。
 *
 * 例子里的每一个字都是**外部文本**（客户写的、同事写的），一律先过围栏再进 prompt
 * ——历史邮件里躺着的注入串，跟今天刚收到的那一封一样有效。
 */
export function historyPrompt(cluster: HistoryCluster): HistoryPrompt {
  return {
    instruction: [
      `下面是 ${cluster.size} 封历史邮件里「客户问题 → 我们同事的真实回复」的例子，主题是「${cluster.category}」。`,
      '请归纳出一条**我们的口径**：客户通常怎么问，我们的标准答案是什么。',
      '只写这些回复里真实出现过的内容；同事之间说法不一致时，写出分歧而不是挑一个。',
      '不要编造天数、金额、比例这类具体数值——例子里没写死的，就说"按具体情况"。',
    ].join('\n'),
    examples: cluster.examples.map((p) => ({
      customer_question: sanitizeExternal(p.question).slice(0, EXAMPLE_MAX_CHARS),
      human_reply: sanitizeExternal(p.human_answer).slice(0, EXAMPLE_MAX_CHARS),
    })),
    category: cluster.category,
  }
}

/** 模型归纳完回来的那一点东西。 */
export interface HistorySummary {
  /** 客户通常怎么问。 */
  question: string
  /** 我们的口径。 */
  answer: string
  confidence?: number
}

/**
 * 归纳结果 → 知识候选。
 *
 * 走的还是 {@link knowledgeCandidate} 那三条判据——从历史邮件学来的东西不比别的
 * 来源更可信：含承诺的照样得人审。出处记的是这一簇的线程 id。
 */
export function historyCandidate(
  cluster: HistoryCluster,
  summary: HistorySummary,
  at: Iso8601,
): KnowledgeCandidate | undefined {
  const candidate = knowledgeCandidate({
    text: summary.answer,
    source: 'human_reply',
    ref: `history:${cluster.category}:${cluster.thread_ids.length}`,
    at,
    question: summary.question,
  })
  if (candidate === undefined) return undefined
  return {
    ...candidate,
    category: cluster.category,
    // 归纳来的东西比单句摘出来的更值得信，但仍然不是"已核实"
    confidence: Math.min(0.9, summary.confidence ?? candidate.confidence),
    provenance: {
      ...candidate.provenance,
      ref: `history:${cluster.thread_ids.slice(0, 20).join(',')}`,
    },
  }
}
