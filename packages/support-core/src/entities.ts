/**
 * Extracted from KefuAgent src/lib/support/service.ts (deriveRiskLevel /
 * deriveMissingInfoSummary / derivePolicyBoundaryRiskTerms) and
 * src/lib/support/standard-distill.ts (PII_PATTERNS), rewritten for agentsws contracts.
 *
 * 证据芯片（36 §2.1）：金额、期限、承诺、风险词、订单号。
 * 全部靠正则从**清洗过的**外部文本里取，只用来给人看与给规则用——
 * 起草时真正写进信里的数字来自订单事实，不来自这里（29 原则 ③）。
 */
import {
  COMMITMENT_PATTERNS,
  DEADLINE_PATTERNS,
  MISSING_INFO_RULES,
  RISK_TERMS,
} from './lexicon.js'
import { displayLine, sanitizeExternal } from './text.js'
import type { SupportEntities } from './types.js'

/** `#1001` / `order 1001` / `订单号 1001`。取第一个，不猜第二个。 */
const ORDER_REF_PATTERNS: readonly RegExp[] = [
  /#(\d{3,})/,
  /\border\s*(?:no\.?|number|#)?\s*[:：]?\s*(\d{4,})\b/i,
  /订单\s*(?:号|编号)?\s*[:：]?\s*#?(\d{3,})/,
]

/** `$129` / `129 USD` / `€25.50` / `12.5 元`。 */
const AMOUNT_PATTERNS: readonly { re: RegExp; currency?: string }[] = [
  { re: /\$\s?(\d+(?:[.,]\d{1,2})?)/, currency: 'USD' },
  { re: /€\s?(\d+(?:[.,]\d{1,2})?)/, currency: 'EUR' },
  { re: /£\s?(\d+(?:[.,]\d{1,2})?)/, currency: 'GBP' },
  { re: /¥\s?(\d+(?:[.,]\d{1,2})?)/, currency: 'CNY' },
  { re: /\b(\d+(?:[.,]\d{1,2})?)\s?(USD|EUR|GBP|CNY|JPY)\b/i },
  { re: /(\d+(?:\.\d{1,2})?)\s*元/, currency: 'CNY' },
]

const CURRENCY_GROUP = /\b(USD|EUR|GBP|CNY|JPY)\b/i

function firstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(text)
    if (m?.[0] !== undefined) return m[0]
  }
  return undefined
}

export function extractOrderRef(text: string): string | undefined {
  for (const re of ORDER_REF_PATTERNS) {
    const m = re.exec(text)
    if (m?.[1] !== undefined) return `#${m[1]}`
  }
  return undefined
}

export function extractAmount(text: string): { value: number; currency?: string } | undefined {
  for (const { re, currency } of AMOUNT_PATTERNS) {
    const m = re.exec(text)
    if (m?.[1] === undefined) continue
    const value = Number.parseFloat(m[1].replace(',', '.'))
    if (!Number.isFinite(value)) continue
    const named = currency ?? CURRENCY_GROUP.exec(m[0])?.[1]?.toUpperCase()
    return named === undefined ? { value } : { value, currency: named }
  }
  return undefined
}

/** 风险词：小写子串命中（与 KefuAgent deriveRiskLevel 同口径），按词表顺序返回。 */
export function extractRiskTerms(text: string): string[] {
  const lower = text.toLowerCase()
  return RISK_TERMS.filter((t) => lower.includes(t))
}

/** 缺什么资料。首条命中即返回（与 deriveMissingInfoSummary 同口径的"第一条命中"）。 */
export function deriveNeeds(text: string): string[] {
  const lower = text.toLowerCase()
  for (const rule of MISSING_INFO_RULES) {
    if (rule.terms.some((t) => lower.includes(t))) return [rule.need]
  }
  return []
}

/** 一次把五种证据都取出来。传进来的可以是没清洗过的原文。 */
export function extractEntities(...parts: (string | undefined)[]): SupportEntities {
  const text = sanitizeExternal(parts.filter((p): p is string => p !== undefined).join('\n'))
  const order_ref = extractOrderRef(text)
  const amount = extractAmount(text)
  const deadline = firstMatch(text, DEADLINE_PATTERNS)
  const commitment = firstMatch(text, COMMITMENT_PATTERNS)
  return {
    risk_terms: extractRiskTerms(text),
    ...(order_ref === undefined ? {} : { order_ref }),
    ...(amount === undefined ? {} : { amount }),
    ...(deadline === undefined ? {} : { deadline: displayLine(deadline, 80) }),
    ...(commitment === undefined ? {} : { commitment: displayLine(commitment, 160) }),
  }
}

/**
 * 去标识化自检（KefuAgent standard-distill.ts `PII_PATTERNS` 的移植）。
 * 知识候选要跨工作区复用之前必须过这一关：任何一条命中就不算已脱敏。
 */
export const PII_PATTERNS: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /\b\d{1,3}(?:[.,]\d{3})+(?:\.\d{2})?\b/,
  /[$€£¥]\s?\d/,
  /#\d{4,}/,
  /\b\d{10,}\b/,
]

export function isDeidentified(text: string): boolean {
  return !PII_PATTERNS.some((re) => re.test(text))
}
