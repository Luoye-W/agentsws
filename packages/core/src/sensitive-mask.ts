/**
 * WP125（72 §P0-2 第一条）：**敏感标识进 prompt 前打码**。
 *
 * 移植自 KefuAgent `src/lib/support/fencing.ts:212,252,261,293`（卡号 + Luhn、CVV、
 * OTP、密码四类上下文规则），rewritten for agentsws contracts。
 *
 * 与同目录的 {@link SECRET_PATTERNS} 分工要说清楚，**两张表不要混用**：
 *
 * | 表 | 管什么 | 用在哪 |
 * |---|---|---|
 * | `SECRET_PATTERNS` / `scrub` | **我们自己的**凭据形态（api key、connect token、shopify token） | 出站正文、原始材料区落库前、审批载荷的密钥扫描 |
 * | 本文件 `maskSensitive` | **客户贴进来的**支付与身份标识（卡号 / CVV / 验证码 / 密码） | 入站文本**进模型上下文之前** |
 *
 * 三条纪律：
 *
 * ① **打码先于围栏**。围栏（`EXTERNAL_FENCE`）会做 NFKC、删控制符、截断——先围栏
 *    再打码就会出现「截断把卡号切成两半，于是一半漏进 prompt」。调用方拿的是
 *    `packages/support-core` 的 `sanitizeForPrompt`，那一处的顺序被测试钉住。
 * ② **卡号必须过 Luhn**。订单号 / 跟踪号 / 运单号全都是 13–19 位数字串，不过 Luhn
 *    就打码等于把客服最需要的那个号码抹掉——那是比漏卡号更常见的故障。
 * ③ **原文不丢**。本函数只产出"给模型看的那一份"；原文仍在受控原始材料区里，
 *    界面上对有权限的人照常可见（72 §1.A）。这个模块里没有任何落库调用。
 */

/** 打码后的标记：`[redacted:card]` / `[redacted:cvv]` / `[redacted:otp]` / `[redacted:password]`。 */
export type SensitiveRule = 'card' | 'cvv' | 'otp' | 'password'

export const SENSITIVE_RULES: readonly SensitiveRule[] = ['card', 'cvv', 'otp', 'password']

/** 进 prompt 的那一句：模型不许提、不许复述、不许索取。fence 段会拼上它。 */
export const SENSITIVE_PROMPT_NOTICE =
  '正文里形如 [redacted:card] / [redacted:cvv] / [redacted:otp] / [redacted:password] 的标记，' +
  '是客户贴进来的支付或身份标识，已经被系统遮掉。不要提及它们、不要试图复述或还原，' +
  '也不要向客户索取卡号、安全码、验证码或密码——任何情况下都不要。'

export interface MaskResult {
  text: string
  /** 命中的规则名，按 {@link SENSITIVE_RULES} 顺序去重。 */
  rules: SensitiveRule[]
}

const mark = (rule: SensitiveRule): string => `[redacted:${rule}]`

/* ------------------------------------------------------------------ */
/* 卡号：13–19 位 + Luhn                                                */
/* ------------------------------------------------------------------ */

/**
 * 候选卡号：13–19 位数字，允许空格或连字符分组（`4111 1111 1111 1111`）。
 *
 * 边界用 `(?<![\d-])` / `(?![\d-])` 而不是 `\b`：`\b` 在 `-1234...` 这种前面有连字符
 * 的串上会从中间起匹配，切出一个长度刚好合法、Luhn 又恰好通过的子串。
 */
const CARD_CANDIDATE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g

/** Luhn 校验（只看数字，调用方先剥掉分隔符）。 */
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const code = digits.charCodeAt(i)
    if (code < 48 || code > 57) return false
    let d = code - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** 只打**过 Luhn 的**那几段；订单号、跟踪号原样留着。 */
function maskCards(text: string): { text: string; hit: boolean } {
  let hit = false
  const out = text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '')
    if (!luhnValid(digits)) return match
    hit = true
    return mark('card')
  })
  return { text: out, hit }
}

/* ------------------------------------------------------------------ */
/* 上下文规则：CVV / OTP / 密码                                          */
/* ------------------------------------------------------------------ */

/**
 * 上下文规则一律是「标签 + 可选连接词 + 值」，**只替换值**。
 *
 * 留着标签是有意的：模型看到 `CVV: [redacted:cvv]` 才知道客户贴过安全码、
 * 才可能按纪律回一句"这些信息我们不需要，也请不要再发"。整段抹掉等于把
 * 这条线索一起删了。
 */
interface ContextRule {
  rule: SensitiveRule
  re: RegExp
}

/** 连接词：`is` / `=` / `:` / `：` / `是` / `为`，可有可无。 */
const LINK = '(?:\\s*(?:is|=|:|：|为|是)\\s*|\\s+)'

const CONTEXT_RULES: readonly ContextRule[] = [
  {
    rule: 'cvv',
    re: new RegExp(
      `(\\b(?:cvv2?|cvc2?|cid|security\\s*code)\\b|安全码|背面三位|卡背码)${LINK}(\\d{3,4})(?!\\d)`,
      'gi',
    ),
  },
  {
    rule: 'otp',
    re: new RegExp(
      `(\\b(?:otp|verification\\s*code|one[-\\s]?time\\s*(?:code|password|passcode)|auth\\s*code|` +
        `sms\\s*code)\\b|验证码|动态码|短信码|校验码)${LINK}([0-9]{4,8})(?!\\d)`,
      'gi',
    ),
  },
  {
    rule: 'password',
    re: new RegExp(`(\\b(?:password|passwd|pwd|passphrase)\\b|密码|口令)${LINK}(\\S{4,64})`, 'gi'),
  },
]

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 给模型看的那一份：卡号（Luhn）、CVV、验证码、密码 → `[redacted:*]`。
 *
 * 顺序固定：**卡号先**。否则 `card number is 4111 1111 1111 1111` 里的
 * `number is …` 不会被别的规则吃掉，但 `password: 4111111111111111` 这种
 * 两条都命中的输入，结果会随规则顺序漂——固定顺序才能被测试钉住。
 */
export function maskSensitive(text: string): MaskResult {
  const rules: SensitiveRule[] = []
  const card = maskCards(text)
  if (card.hit) rules.push('card')
  let out = card.text
  for (const { rule, re } of CONTEXT_RULES) {
    let hit = false
    out = out.replace(new RegExp(re.source, re.flags), (_m, label: string) => {
      hit = true
      return `${label}: ${mark(rule)}`
    })
    if (hit) rules.push(rule)
  }
  return { text: out, rules }
}

/** 只问「有没有」，不改文本（要不要在界面上挂「含支付信息」这个标）。 */
export function hasSensitive(text: string): boolean {
  return maskSensitive(text).rules.length > 0
}
