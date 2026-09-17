/**
 * 版规解析与"这一条发得了发不了"（60 §2 `subreddits.ts`）。
 *
 * 这是 `pr.reddit` / `pr.forums` 两条职责的**全部风险所在**：我们在别人的
 * 地盘上，版主说了算。发错一条的后果不是这条帖子被删，是这个品牌的域名被
 * 加进那个版的自动删除名单——从此我们在那里说的每一句话都不存在。
 *
 * 三条纪律：
 *
 * 1. **版规原文是外部文本**（21 §1）。{@link parseSubredditRules} 只从里面
 *    读出三件结构化的事（禁不禁自我推广、要不要 flair、几小时冷却），
 *    原文原样留在 `raw_rules` 里给人看，一个字不改写。
 * 2. **判不准就当禁**。词表没命中 ≠ 这个版欢迎推广。`no_self_promotion`
 *    的默认值由调用方给（{@link ParseOptions.assume_no_self_promotion}），
 *    默认**为真**——在别人的地盘上，fail-closed 的代价是少发一条，
 *    fail-open 的代价是被永久封禁。
 * 3. **结论带原因**。{@link checkSubredditRules} 回的 `reasons` 直接进
 *    `ExternalPost.rules_checked`，再进 guardrail 的 hit、再进卡面——
 *    人看到的那句话与机器拦下的那条规则**是同一个字符串**。
 */

import type { ExternalPostRuleCheck, Iso8601, SubredditPolicy } from '@agentsws/contracts'

/**
 * "禁自我推广"在版规里的各种写法。**只可加行**（15 §2 对规则集的老规矩）。
 *
 * 收得宽是有意的：漏判一条的代价（被封）比误判一条的代价（少发一条）大得多。
 */
export const SELF_PROMOTION_TERMS: readonly string[] = [
  'no self-promotion',
  'no self promotion',
  'self-promotion is not allowed',
  'no advertising',
  'no ads',
  'no promotional',
  'no marketing',
  'no referral links',
  'no blogspam',
  '禁止自我推广',
  '禁止广告',
  '不得发布广告',
  '禁止软文',
  '禁止引流',
]

/**
 * **明写着欢迎厂商帖**的那几种写法。**只可加行**。
 *
 * 为什么非有这一张不可：文件头第 2 条说"判不准就当禁"，而多数版规里根本没有
 * 一句与推广有关的话——没有这张表的话，`no_self_promotion` 永远是真，
 * 这条职责一条帖子都发不出去，那不是保守，那是坏了。
 *
 * 它比 {@link SELF_PROMOTION_TERMS} **优先级低**：一份既写着"欢迎厂商"
 * 又写着"禁外链广告"的版规，按**禁**处理。
 */
export const SELF_PROMOTION_ALLOWED_TERMS: readonly string[] = [
  'vendors welcome',
  'vendor posts are welcome',
  'self-promotion is allowed',
  'self promotion is allowed',
  'promo thread',
  'promotion thread',
  '欢迎厂商',
  '允许自我推广',
  '厂商帖',
]

/** "必须带 flair"的各种写法。 */
export const FLAIR_TERMS: readonly string[] = [
  'flair required',
  'must use flair',
  'please flair your post',
  'posts must be flaired',
  '必须选择分类',
  '必须带标签',
]

/** 频率那一条：`once per 7 days` / `每 30 天一次` / `one post per week`。 */
const COOLDOWN_PATTERNS: readonly { re: RegExp; hours: (n: number) => number }[] = [
  { re: /once\s+(?:per|every)\s+(\d+)\s*hours?/i, hours: (n) => n },
  { re: /once\s+(?:per|every)\s+(\d+)\s*days?/i, hours: (n) => n * 24 },
  { re: /once\s+(?:per|every)\s+(\d+)\s*weeks?/i, hours: (n) => n * 24 * 7 },
  { re: /(\d+)\s*天(?:内)?(?:最多)?(?:只能)?(?:发)?一(?:条|次|帖)/, hours: (n) => n * 24 },
  { re: /每\s*(\d+)\s*天一(?:条|次|帖)/, hours: (n) => n * 24 },
]

/** `once per day` / `one post per week` 这种不带数字的写法。 */
const NAMED_COOLDOWN: readonly { re: RegExp; hours: number }[] = [
  { re: /once\s+(?:per|a)\s+day|one\s+post\s+per\s+day/i, hours: 24 },
  { re: /once\s+(?:per|a)\s+week|one\s+post\s+per\s+week/i, hours: 24 * 7 },
  { re: /once\s+(?:per|a)\s+month|one\s+post\s+per\s+month/i, hours: 24 * 30 },
  { re: /每周一(?:条|次|帖)/, hours: 24 * 7 },
  { re: /每月一(?:条|次|帖)/, hours: 24 * 30 },
]

export interface ParseOptions {
  /**
   * 版规里一条相关的话都没有时，按禁还是按不禁。
   *
   * 默认 **`true`（按禁）**：文件头第 2 条。要放开得由调用方明确写出来，
   * 而"我明确决定在这个没写规矩的版里发推广"是一句人该说的话。
   */
  assume_no_self_promotion?: boolean
  /** 没有别的信号时的默认冷却（60 §6：72 小时）。 */
  default_cooldown_hours?: number
}

/** 60 §6 的默认值：同一个版 72 小时。 */
export const DEFAULT_COOLDOWN_HOURS = 72

const has = (text: string, terms: readonly string[]): string | undefined =>
  terms.find((t) => text.includes(t.toLowerCase()))

/**
 * 一版规矩（一条一行的原文）→ 结构化的三件事。
 *
 * `flairs` 从形如 `Flair required: Review, Discussion` 的那一行里取；
 * 取不到就只说"要 flair"，不猜有哪些——猜错一个 flair 名，帖子照样被自动删。
 */
export function parseSubredditRules(
  input: { name: string; raw_rules: readonly string[]; observed_at: Iso8601 },
  options: ParseOptions = {},
): SubredditPolicy {
  const joined = input.raw_rules.join('\n')
  const lower = joined.toLowerCase()
  const promo = has(lower, SELF_PROMOTION_TERMS)
  const allowed = has(lower, SELF_PROMOTION_ALLOWED_TERMS)
  const flair = has(lower, FLAIR_TERMS)

  let cooldown: number | undefined
  for (const { re, hours } of COOLDOWN_PATTERNS) {
    const m = joined.match(re)
    if (m?.[1] !== undefined) {
      cooldown = hours(Number(m[1]))
      break
    }
  }
  if (cooldown === undefined) {
    for (const { re, hours } of NAMED_COOLDOWN) {
      if (re.test(joined)) {
        cooldown = hours
        break
      }
    }
  }

  const flairs = flairList(input.raw_rules)
  return {
    name: input.name.replace(/^\/?r\//, ''),
    /*
     * 三档，顺序是硬的：
     *
     * 1. 明写着**禁** → 禁（哪怕同一份版规里也写着"欢迎厂商"——那多半是
     *    "欢迎来答疑，但别发广告"）；
     * 2. 明写着**欢迎厂商** → 不禁；
     * 3. 一句都没写 → 按调用方的默认值，而默认值是**禁**（文件头第 2 条）。
     */
    no_self_promotion:
      promo !== undefined
        ? true
        : allowed !== undefined
          ? false
          : (options.assume_no_self_promotion ?? true),
    flair_required: flair !== undefined,
    ...(flairs.length === 0 ? {} : { flairs }),
    cooldown_per_subreddit_hours:
      cooldown ?? options.default_cooldown_hours ?? DEFAULT_COOLDOWN_HOURS,
    raw_rules: [...input.raw_rules],
    observed_at: input.observed_at,
  }
}

/** 从 `Flair required: A, B, C` 那一行里把 A / B / C 取出来。取不到就空。 */
function flairList(rules: readonly string[]): string[] {
  for (const line of rules) {
    const m = line.match(/flair[^:：]*[:：]\s*(.+)$/i)
    if (m?.[1] === undefined) continue
    const items = m[1]
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter((s) => s !== '' && s.length <= 40)
    if (items.length > 0) return items
  }
  return []
}

export interface RuleCheckInput {
  policy: SubredditPolicy
  /** 这一条打算带的 flair（不带就不给）。 */
  flair?: string
  /** 上一次在**这个版**发帖是什么时候（没发过就不给）。 */
  last_post_at?: Iso8601
  now: Iso8601
}

/**
 * 这一条在这个版发得了发不了（60 §2「可发 / 不可发 + 原因」）。
 *
 * 三条 `reasons`，与 guardrail 那一侧的 hit 名**逐字相同**：
 * `no_self_promotion` / `flair_required` / `cooldown`。卡面上给人看的那句话
 * 与机器拦下的那条规则是同一个字符串，不存在"界面说 A、日志说 B"。
 */
export function checkSubredditRules(input: RuleCheckInput): ExternalPostRuleCheck {
  const reasons: string[] = []
  if (input.policy.no_self_promotion) reasons.push('no_self_promotion')
  if (input.policy.flair_required && (input.flair === undefined || input.flair.trim() === ''))
    reasons.push('flair_required')
  if (
    input.policy.flair_required &&
    input.flair !== undefined &&
    input.policy.flairs !== undefined &&
    input.policy.flairs.length > 0 &&
    !input.policy.flairs.includes(input.flair)
  )
    reasons.push('flair_unknown')
  const hours = hoursSinceLastPost(input)
  const cooldown = input.policy.cooldown_per_subreddit_hours
  if (cooldown !== undefined && hours !== undefined && hours < cooldown) reasons.push('cooldown')
  return {
    ok: reasons.length === 0,
    reasons,
    ...(input.flair === undefined ? {} : { flair: input.flair }),
    checked_at: input.now,
  }
}

/**
 * 距离上一条在这个版发的帖子过了几小时（没发过回 `undefined`）。
 *
 * **没发过不等于 0 小时**：把"没发过"算成 0 会让每一条新版块的第一帖都被
 * 冷却拦下。这一格直接递给 guardrail 的 `hours_since_last_post`，
 * 那边同样是"没算过就不判"。
 */
export function hoursSinceLastPost(input: {
  last_post_at?: Iso8601
  now: Iso8601
}): number | undefined {
  if (input.last_post_at === undefined) return undefined
  const last = Date.parse(input.last_post_at)
  const now = Date.parse(input.now)
  if (Number.isNaN(last) || Number.isNaN(now)) return undefined
  return (now - last) / 3_600_000
}

/** `reasons` → 给人看的一句话（卡面与 block 消息共用这一份）。 */
export function explainRuleCheck(check: ExternalPostRuleCheck, venue: string): string {
  if (check.ok) return `r/${venue} 的版规看过了：这一条发得了。`
  const words: Readonly<Record<string, string>> = {
    no_self_promotion: `r/${venue} 的版规明写着禁自我推广——我们在人家的地盘上，这一条不发。要露出就换个方式：回答别人的问题，不发自己的帖子。`,
    flair_required: `r/${venue} 要求每条帖子带 flair，这一条没带。`,
    flair_unknown: `r/${venue} 不认识这个 flair（它只认：${check.flair ?? ''}）。`,
    cooldown: `我们上一条在 r/${venue} 的帖子还没过冷却期。同一个版连着发，多数版会自动删并警告。`,
  }
  return check.reasons.map((r) => words[r] ?? r).join(' ')
}
