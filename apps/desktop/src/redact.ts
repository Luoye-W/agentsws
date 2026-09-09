/**
 * 日志脱敏（13 §4.3「凭据永远不进对话、不进模型、不进日志」）。
 *
 * 两层：**字面量遮罩**（我们自己生成的三把密钥，逐字替换，永远不会漏）与
 * **形态遮罩**（子进程 stdout 里的东西我们没法预知——`apps/server` 启动就会打印
 * `internal token: …`——所以按 `标签: 值` 与长不透明串两种形态兜底）。
 */

export const REDACTED = '[redacted]'

/** `标签: 值` / `Bearer 值`。 */
const LABELLED =
  /\b(bearer|authorization|admin[-_]?token|session[-_]?key|encryption[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|internal token|token|secret|passwd|password|pwd)\b(\s*[:=]\s*|\s+)(["']?)([^\s"',;{}]{3,})\3/gi

/** OpenConnector 的持久 token 前缀（18 §1 / connect-adapter）。 */
const OCT = /\boct_[A-Za-z0-9_-]+/g

/** 长不透明串：32 位以上的十六进制 / base64url，基本只可能是密钥。 */
const OPAQUE = /\b[A-Za-z0-9_-]{32,}\b/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type Redactor = (text: string) => string

/**
 * @param literals 已知密钥原文；空串会被忽略（否则正则会炸成逐字符替换）。
 */
export function createRedactor(literals: readonly string[] = []): Redactor {
  const wanted = literals.filter((s) => s.length >= 8)
  const literalRe =
    wanted.length === 0
      ? undefined
      : new RegExp(
          wanted
            .map(escapeRegExp)
            .sort((a, b) => b.length - a.length)
            .join('|'),
          'g',
        )

  return (text: string): string => {
    let out = text
    if (literalRe !== undefined) out = out.replace(literalRe, REDACTED)
    out = out.replace(LABELLED, (_m, label: string, sep: string, quote: string) =>
      quote === '' ? `${label}${sep}${REDACTED}` : `${label}${sep}${quote}${REDACTED}${quote}`,
    )
    out = out.replace(OCT, REDACTED)
    out = out.replace(OPAQUE, REDACTED)
    return out
  }
}

/** 不带字面量的默认脱敏器（还没读出密钥时也要能记日志）。 */
export const defaultRedactor: Redactor = createRedactor()
