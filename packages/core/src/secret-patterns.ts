/**
 * 秘密模式表的**唯一出处**（13 §4.3「凭据永远不进对话、不进模型、不进日志」）。
 *
 * WP13 的合并记录点名了这条遗留：同一张表在 `@agentsws/channels`、`@agentsws/txn`、
 * `@agentsws/stand-ins` 各抄了一份，`apps/desktop` 又另有一套日志形态表。
 * 四份表跑偏就是四套纪律——替身放行的样本真实现照样放行，才是 WP9 那些不变量测得到的东西。
 * 表上移到这里，各包只留 `import`。
 *
 * 两张表，两个用途，**不要混用**：
 *
 * - {@link SECRET_PATTERNS} / {@link scrub}：**内容**脱敏。入站正文、审批载荷、
 *   落进原始材料区之前的文本。命中即换成 `[redacted:<rule>]`，并回报命中了哪几条。
 * - {@link LOG_SECRET_PATTERNS} / {@link createLogRedactor}：**日志**脱敏。子进程 stdout、
 *   壳自己的日志行。这里可以放狠手（长不透明串一律遮），因为日志不需要保真。
 *
 * 所有模式都以 `source` / `flags` 字符串存放、每次用时现造 `RegExp`——
 * 带 `g` 的正则有 `lastIndex` 状态，共享一个实例迟早漏一次匹配。
 */

/** 一条模式：规则名 + 正则的源与标志（不存 RegExp 实例，见文件头）。 */
export interface SecretPattern {
  readonly rule: string
  readonly source: string
  readonly flags: string
}

const p = (rule: string, re: RegExp): SecretPattern => ({
  rule,
  source: re.source,
  flags: re.flags,
})

/**
 * 内容脱敏表。前四条与 WP13 / WP4 原表**逐字一致**（改动会让既有样本的判定漂移）；
 * 后面几条是这次补的：我们自己会碰到的令牌形态。
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  p('api_key', /\b(?:sk|pk|rk)[-_][A-Za-z0-9]{16,}\b/g),
  p('aws_key', /\bAKIA[0-9A-Z]{16}\b/g),
  p('bearer', /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/gi),
  p('card_number', /\b(?:\d[ -]?){13,19}\b/g),
  // OpenConnector 的持久 runtime token（18 §1 / connect-adapter）
  p('connect_token', /\boct_[A-Za-z0-9_-]{8,}\b/g),
  // Shopify 的四种令牌前缀（WP25 实测：自建应用令牌是 shpat_）
  p('shopify_token', /\bshp(?:at|ca|pa|ss)_[A-Za-z0-9_-]{16,}\b/g),
  // 邮箱授权码 / 应用专用密码（WP25 的十家邮箱预设，用户会整段贴进来）
  p(
    'mail_app_password',
    /(?:授权码|应用专用密码|app[ _-]?password|应用密码)\s*[:=：]?\s*["']?[A-Za-z0-9]{12,}["']?/gi,
  ),
]

export interface ScrubResult {
  text: string
  /** 命中的规则名，按表内顺序去重 */
  rules: string[]
}

/** 现造一份带状态的正则（`g` 的 `lastIndex` 不跨调用共享）。 */
function compile(pattern: SecretPattern): RegExp {
  return new RegExp(pattern.source, pattern.flags)
}

/** 只读视图：想自己遍历表的包用这个，别去动 {@link SECRET_PATTERNS} 里的对象。 */
export function secretPatterns(): { rule: string; re: RegExp }[] {
  return SECRET_PATTERNS.map((pattern) => ({ rule: pattern.rule, re: compile(pattern) }))
}

/**
 * 18 §5 用例 3：命中即替换成 `[redacted:<rule>]`，并回报命中了哪几条规则。
 * 这是入站管线与原始材料区落库前走的那一道。
 */
export function scrub(text: string): ScrubResult {
  let out = text
  const rules: string[] = []
  for (const pattern of SECRET_PATTERNS) {
    if (!compile(pattern).test(out)) continue
    rules.push(pattern.rule)
    out = out.replace(compile(pattern), `[redacted:${pattern.rule}]`)
  }
  return { text: out, rules }
}

/** 只问「有没有」，不改文本（日志前置判断、14 §6 密钥扫描）。 */
export function hasSecret(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) if (compile(pattern).test(text)) return true
  return false
}

/**
 * 14 §6 密钥扫描：审批载荷里出现 key / 卡号形态 → blocked。
 * 只回规则名，不回原文——调用方拿它去写 `precheck.secret_scan`。
 */
export function scanSecrets(text: string): string[] {
  const rules: string[] = []
  for (const pattern of SECRET_PATTERNS) if (compile(pattern).test(text)) rules.push(pattern.rule)
  return rules
}

// ── 日志脱敏 ────────────────────────────────────────────────────────────

export const REDACTED = '[redacted]'

/**
 * 日志形态表。比内容表狠：子进程 stdout 里会有什么我们预知不了
 * （`apps/server` 启动就打印 `internal token: …`），所以按
 * `标签: 值` 与「长不透明串」两种形态兜底。
 */
export const LOG_SECRET_PATTERNS: readonly SecretPattern[] = [
  p(
    'labelled',
    /\b(bearer|authorization|admin[-_]?token|session[-_]?key|encryption[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|internal token|token|secret|passwd|password|pwd)\b(\s*[:=]\s*|\s+)(["']?)([^\s"',;{}]{3,})\3/gi,
  ),
  p('connect_token', /\boct_[A-Za-z0-9_-]+/g),
  p('shopify_token', /\bshp(?:at|ca|pa|ss)_[A-Za-z0-9_-]+/g),
  /** 32 位以上的十六进制 / base64url，基本只可能是密钥。 */
  p('opaque', /\b[A-Za-z0-9_-]{32,}\b/g),
]

export type Redactor = (text: string) => string

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 日志脱敏器：**字面量遮罩**（我们自己生成的那几把密钥，逐字替换，永远不会漏）
 * 叠加**形态遮罩**（上面那张表）。
 *
 * @param literals 已知密钥原文；短于 8 个字符的忽略（否则正则会炸成逐字符替换）。
 */
export function createLogRedactor(literals: readonly string[] = []): Redactor {
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
    for (const pattern of LOG_SECRET_PATTERNS) {
      out =
        pattern.rule === 'labelled'
          ? out.replace(compile(pattern), (_m, label: string, sep: string, quote: string) =>
              quote === ''
                ? `${label}${sep}${REDACTED}`
                : `${label}${sep}${quote}${REDACTED}${quote}`,
            )
          : out.replace(compile(pattern), REDACTED)
    }
    return out
  }
}

/** 不带字面量的默认日志脱敏器（还没读出密钥时也要能记日志）。 */
export const defaultLogRedactor: Redactor = createLogRedactor()
