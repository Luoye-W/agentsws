/**
 * 入站秘密检测与脱敏（13 §4.3、31 §4「不留秘密 vs raw_ref 留原文」的定案）。
 *
 * 模式表与 `packages/stand-ins/src/inbound.ts` 的 `SECRET_PATTERNS` 逐条对齐——
 * 替身与真实现必须在同一批样本上给出同样的判定，否则 WP9 的不变量测不到真管线。
 * （契约建议：这张表应上移到 `@agentsws/core`，见报告 §4。）
 */

export interface ScrubResult {
  text: string
  /** 命中的规则名，按表内顺序去重 */
  rules: string[]
}

const SECRET_PATTERNS: readonly { rule: string; re: RegExp }[] = [
  { rule: 'api_key', re: /\b(?:sk|pk|rk)[-_][A-Za-z0-9]{16,}\b/g },
  { rule: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'bearer', re: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/gi },
  { rule: 'card_number', re: /\b(?:\d[ -]?){13,19}\b/g },
]

/** 18 §5 用例 3：命中即替换成占位符，并回报命中了哪几条规则。 */
export function scrubSecrets(text: string): ScrubResult {
  let out = text
  const rules: string[] = []
  for (const { rule, re } of SECRET_PATTERNS) {
    const probe = new RegExp(re.source, re.flags)
    if (!probe.test(out)) continue
    rules.push(rule)
    out = out.replace(new RegExp(re.source, re.flags), `[redacted:${rule}]`)
  }
  return { text: out, rules }
}

/** 只问「有没有」，不改文本（用于日志前置判断）。 */
export function hasSecret(text: string): boolean {
  return scrubSecrets(text).rules.length > 0
}
