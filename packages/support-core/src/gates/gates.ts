/**
 * Extracted from KefuAgent src/lib/support/policy/autonomy-gates.ts
 * （G04 `intent_risk` 的 L3 Tier-1/2、G06 `knowledge_evidence` 的草稿来源判定、
 * G10 `commitment_scan` 的 Tier-3 承诺扫描），rewritten for agentsws contracts。
 *
 * 15 的 guardrail 前置多三道门（48 §4 L3 #3）：
 *
 * | 门 | 问的是 | fail 的意思 |
 * |---|---|---|
 * | `l3_denylist` | 这件事在不在「永不自动发送」的九类里 | 不自主，转人审 |
 * | `draft_origin` | 这份草稿是 AI 写的吗、它自己说缺料了吗 | 不自主，转人审 |
 * | `commitment_scan` | 这封回信里有没有第一人称承诺 / 无依据让步 | 不自主，转人审 |
 *
 * 三条纪律：
 *
 * ① **fail-closed**：门内报错 = 不自主。一个正则写崩了不该变成「那就发吧」。
 * ② **只记录，不改状态**：门的结论进 `PrecheckResult` 与一条事件，卡该去哪还去哪。
 *    它们回答的是「能不能**自主**发」，不是「这张卡合不合法」。
 * ③ **被扫的文本绝不落库**：证据只留规则 id、句序号与长度。
 */

import {
  formatL3Rule,
  GATE_RULESET_HASH,
  type L3Category,
  mapChatIntentToL3,
  mapEmailIntentToL3,
  scanInboundBackstop,
  scanOutboundCommitment,
} from './l3-denylist.js'

/** 三道门的名字。顺序即评估顺序（入站判据在出站判据之前）。 */
export const AUTONOMY_GATE_IDS = ['l3_denylist', 'draft_origin', 'commitment_scan'] as const
export type AutonomyGateId = (typeof AUTONOMY_GATE_IDS)[number]

/**
 * `pass` = 这道门不反对自主发送；`fail` = 不自主；`gate_error` = 门自己炸了，
 * 按 fail-closed 同样**不自主**（但要分得出来，否则修不了）。
 */
export type GateStatus = 'pass' | 'fail' | 'gate_error'

export interface GateResult {
  gate: AutonomyGateId
  status: GateStatus
  /** 机器可读原因（snake_case）。 */
  reason?: string
  /** 合并进审计行的安全片段：只有规则 id、枚举与数值，绝无被扫文本。 */
  evidence?: Record<string, unknown>
  /** 当时用的是哪一版规则集。 */
  ruleset_hash: string
}

export interface AutonomyGateInput {
  channel: 'email' | 'chat'
  /** Tier-1 结构化分类；`source: 'none'` = 分类器没说话，Tier-2 盲扫才跑。 */
  classification: {
    intent?: string | null
    source: 'email_classification' | 'chat_classification' | 'none'
    risk_level: 'normal' | 'high'
    /** 邮件路径还会拿线程类目再查一次表。 */
    category?: string | null
  }
  /** 被回复的入站客户原文。仅 Tier-2 盲扫用；**绝不落库**。 */
  inbound_text: string
  /** 最终拟发回复文本。仅 Tier-3 承诺扫描用；**绝不落库**。 */
  proposed_reply_text: string
  /** 草稿来源。`generated_by !== 'ai'` = 人写的，不能走自主发送。 */
  draft: {
    generated_by: string
    /** AI 自标缺信息 ⇒ 转人工。 */
    missing_info?: string | null
    version_no?: number
    model?: string | null
  }
}

const ok = (gate: AutonomyGateId, evidence?: Record<string, unknown>): GateResult => ({
  gate,
  status: 'pass',
  ruleset_hash: GATE_RULESET_HASH,
  ...(evidence === undefined ? {} : { evidence }),
})

const no = (
  gate: AutonomyGateId,
  reason: string,
  evidence?: Record<string, unknown>,
): GateResult => ({
  gate,
  status: 'fail',
  reason,
  ruleset_hash: GATE_RULESET_HASH,
  ...(evidence === undefined ? {} : { evidence }),
})

/* ------------------------------------------------------------------ */
/* 门一：l3_denylist（KefuAgent G04 的 L3 部分）                          */
/* ------------------------------------------------------------------ */

/**
 * 九类六语的「永不自动发送」黑名单。
 *
 * Tier-1（分类器说了话）：意图 / 类目查表。Tier-2（`source === 'none'`）：入站盲扫，
 * 命中即 fail-closed——盲扫这一层 over-holding 是正确方向。
 *
 * 两者是**互斥**的：分类器一旦正常工作，盲扫就不跑。盲扫的定位是兜底，不是加固。
 */
export function gateL3Denylist(input: AutonomyGateInput): GateResult {
  const gate: AutonomyGateId = 'l3_denylist'
  if (input.classification.source !== 'none') {
    let category: L3Category | undefined
    if (input.channel === 'email') {
      category =
        mapEmailIntentToL3(input.classification.intent) ??
        mapEmailIntentToL3(input.classification.category)
    } else {
      category = mapChatIntentToL3(input.classification.intent, input.classification.risk_level)
    }
    if (category !== undefined) {
      return no(gate, `l3_intent:${category}`, { matched_rules: [formatL3Rule(category, 't1')] })
    }
    return ok(gate, { tier: 't1', matched_rules: [] })
  }
  const hits = scanInboundBackstop(input.inbound_text)
  if (hits.length > 0) {
    return no(gate, `l3_backstop:${hits[0]?.category}`, {
      matched_rules: hits.map((h) => h.rule),
    })
  }
  return ok(gate, { tier: 't2', matched_rules: [] })
}

/* ------------------------------------------------------------------ */
/* 门二：draft_origin（KefuAgent G06 的草稿来源部分）                      */
/* ------------------------------------------------------------------ */

/**
 * 只有 AI 写的、且它自己没说缺料的草稿可以自主发。
 *
 * 人写的草稿走人审不是刁难：自主发送这条路上的每一层（L3 黑名单、承诺扫描、额度）
 * 都是围着「模型可能写错什么」设计的，一份人写的正文经过它们只是**看起来**被检查过。
 * 谁写的谁负责，人写的那份就该由人按发送。
 */
export function gateDraftOrigin(input: AutonomyGateInput): GateResult {
  const gate: AutonomyGateId = 'draft_origin'
  const draft = input.draft
  if (draft.generated_by !== 'ai') {
    return no(gate, 'draft_not_ai', { generated_by: draft.generated_by })
  }
  const missing = draft.missing_info
  if (missing !== undefined && missing !== null && missing.length > 0) {
    return no(gate, 'needs_info', { has_missing_info: true })
  }
  return ok(gate, {
    generated_by: draft.generated_by,
    ...(draft.version_no === undefined ? {} : { draft_version_no: draft.version_no }),
    ...(draft.model === undefined || draft.model === null ? {} : { model: draft.model }),
  })
}

/* ------------------------------------------------------------------ */
/* 门三：commitment_scan（KefuAgent G10）                                */
/* ------------------------------------------------------------------ */

/**
 * 出站草稿里的第一人称承诺（Tier-3）+ 无依据让步（句内共现）。
 *
 * 被子句级否定抵消的命中**不阻断**，但要留痕——「守卫为什么放过这一封」必须能从
 * 审计行读出来，否则放松方向就是不可复核的。
 */
export function gateCommitmentScan(input: AutonomyGateInput): GateResult {
  const gate: AutonomyGateId = 'commitment_scan'
  const scan = scanOutboundCommitment(input.proposed_reply_text)
  const negated =
    scan.negated_hits.length > 0 ? { negated_rules: scan.negated_hits.map((h) => h.rule) } : {}
  if (scan.hits.length > 0) {
    return no(gate, `l3_commitment:${scan.hits[0]?.category}`, {
      matched_rules: scan.hits.map((h) => h.rule),
      ...negated,
    })
  }
  if (scan.unsourced_concession) {
    // 只记句序号与长度，不抄句子原文（证据会落进审计行）。
    return no(gate, 'unsourced_concession', {
      ...(scan.concession_sentence === undefined
        ? {}
        : { concession_sentence: scan.concession_sentence }),
      ...negated,
    })
  }
  return ok(gate, Object.keys(negated).length > 0 ? negated : undefined)
}

/* ------------------------------------------------------------------ */
/* 编排                                                                */
/* ------------------------------------------------------------------ */

export interface AutonomyGateDecision {
  /** 三条全 pass 才算「这封可以自主发」。 */
  autonomous: boolean
  results: GateResult[]
  /** 第一条不放行的门（给人看的一句话从它来）。 */
  blocking_gate?: AutonomyGateId
  ruleset_hash: string
}

const EVALUATORS: Readonly<Record<AutonomyGateId, (input: AutonomyGateInput) => GateResult>> = {
  l3_denylist: gateL3Denylist,
  draft_origin: gateDraftOrigin,
  commitment_scan: gateCommitmentScan,
}

/**
 * 三道门按固定顺序跑完（**不短路**：三条结论都要进审计行，否则事后没法回答
 * 「当时另外两道门怎么说」）。
 *
 * fail-closed 在这一层落实：任何一道门抛异常 → `gate_error` → 不自主。
 */
export function evaluateAutonomyGates(input: AutonomyGateInput): AutonomyGateDecision {
  const results: GateResult[] = []
  for (const gate of AUTONOMY_GATE_IDS) {
    try {
      results.push(EVALUATORS[gate](input))
    } catch (e) {
      results.push({
        gate,
        status: 'gate_error',
        reason: e instanceof Error ? e.message.slice(0, 200) : 'gate threw',
        ruleset_hash: GATE_RULESET_HASH,
      })
    }
  }
  const blocking = results.find((r) => r.status !== 'pass')
  return {
    autonomous: blocking === undefined,
    results,
    ...(blocking === undefined ? {} : { blocking_gate: blocking.gate }),
    ruleset_hash: GATE_RULESET_HASH,
  }
}
