/**
 * Extracted from KefuAgent src/lib/support/email-triage.ts (guessLanguage / includesAny)
 * and src/lib/support/fencing.ts, rewritten for agentsws contracts.
 *
 * 外部文本的入口。围栏不在这里重写：直接用 `@agentsws/core` 的 `EXTERNAL_FENCE`
 * （Commerce Agents 移植版），本文件只负责"清洗后再匹配"这条纪律与语言判定。
 */
import { EXTERNAL_FENCE, sanitizeLabel } from '@agentsws/core'
import type { SupportLanguage } from './types.js'

/** 已经被围栏包过一层的文本（`<external_data>…</external_data>`）。 */
const FENCED = /<external_data>\n?([\s\S]*?)\n?<\/external_data>/g

/**
 * 取出围栏内的正文再清洗一次。
 *
 * 18 §2 说 `InboundEvent.parts.text` 已 fencing，但本包也会被"还没进管线"的调用方用到
 * （SaaS 侧、evals、回放）。两种输入都要得到同一个结果，所以先剥壳再清洗——
 * 清洗是幂等的，重复做一次不改变结果，漏做一次却会让注入词面参与匹配。
 */
export function unfence(text: string): string {
  let out = ''
  let last = 0
  FENCED.lastIndex = 0
  for (;;) {
    const m = FENCED.exec(text)
    if (m === null) break
    out += text.slice(last, m.index)
    out += m[1] ?? ''
    last = m.index + m[0].length
  }
  out += text.slice(last)
  return out
}

/** 外部文本 → 可以拿去做规则匹配的干净文本。所有分类 / 起草的入口都过这里。 */
export function sanitizeExternal(text: string, maxChars?: number): string {
  return EXTERNAL_FENCE.sanitizeText(unfence(text), maxChars)
}

/** 给人看的一行（卡片标题、证据芯片）。 */
export function displayLine(text: unknown, maxChars = 120): string {
  return sanitizeLabel(text, maxChars)
}

/** 把清洗过的文本折成小写 haystack。匹配一律在它上面做。 */
export function haystack(...parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => p !== undefined && p.length > 0)
    .map((p) => sanitizeExternal(p))
    .join('\n')
    .toLowerCase()
}

/** 命中的词面，按词表顺序返回（顺序稳定 → 断言可复现）。 */
export function matchTerms(text: string, terms: readonly string[]): string[] {
  return terms.filter((t) => t.length > 0 && text.includes(t))
}

export function includesAny(text: string, terms: readonly string[]): boolean {
  return terms.some((t) => t.length > 0 && text.includes(t))
}

/**
 * 语言判定（KefuAgent `guessLanguage` 的移植 + ja / pt / it 三档）。
 * 判不出一律 `en`——回信语言宁可保守，也不要用错误的语言写一封信。
 */
export function detectLanguage(...parts: (string | undefined)[]): SupportLanguage {
  const raw = parts.filter((p): p is string => p !== undefined).join('\n')
  const text = sanitizeExternal(raw)
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\u4e00-\u9fa5]/.test(text)) return 'zh'
  // pt 先于 es：两种语言共用 `pedido` / `reembolso`，只有这几个词面是葡语独有的
  if (/\b(ol[áa]|obrigad[oa]|encomenda|entrega)\b/i.test(text)) return 'pt'
  if (/\b(hola|gracias|pedido|env[ií]o|reembolso|devoluci[oó]n)\b/i.test(text)) return 'es'
  if (/\b(bonjour|merci|commande|remboursement|livraison)\b/i.test(text)) return 'fr'
  if (/\b(hallo|danke|bestellung|r[üu]ckerstattung|erstattung|lieferung)\b/i.test(text)) return 'de'
  if (/\b(ciao|grazie|ordine|rimborso|consegna)\b/i.test(text)) return 'it'
  return 'en'
}
