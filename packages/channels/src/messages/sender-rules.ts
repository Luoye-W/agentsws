/**
 * WP439（docs/108 §5.1.5 / §6）：**发件人规则的命中账**。
 *
 * 分拣按一条发件人规则直达一封信，就在那条规则上记一笔（按天计数，只留最近 30 天）；
 * 规则清单里「最近 30 天命中几次」从这本账现算。命中时间按**信的日期**算——
 * 第一次接邮箱时回填的老信不该把「最近 30 天」撑大，早于 30 天的那几封干脆不记。
 */
import type { DeletedSenderRule, Iso8601, SenderRule } from '@agentsws/contracts'
import { SENDER_RULE_UNDO_DAYS } from '@agentsws/contracts'

/** 「最近 30 天」。 */
export const SENDER_RULE_HIT_WINDOW_DAYS = 30

const DAY_MS = 86_400_000

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** 账里只留窗口里的那几天（以 `now` 为准往回数 30 天）。 */
function prune(days: Record<string, number> | undefined, now: number): Record<string, number> {
  const floor = dayOf(now - (SENDER_RULE_HIT_WINDOW_DAYS - 1) * DAY_MS)
  const out: Record<string, number> = {}
  for (const [day, n] of Object.entries(days ?? {}))
    if (day >= floor && Number.isFinite(n) && n > 0) out[day] = n
  return out
}

/**
 * 记一次命中。`at` 是那封信的日期（取不到就传现在）；早于窗口的不记、原样回。
 * 回一条新规则（不改入参）。
 */
export function recordSenderRuleHit(rule: SenderRule, at: Iso8601, now: Iso8601): SenderRule {
  const nowMs = Date.parse(now)
  const atMs = Math.min(Number.isFinite(Date.parse(at)) ? Date.parse(at) : nowMs, nowMs)
  if (nowMs - atMs >= SENDER_RULE_HIT_WINDOW_DAYS * DAY_MS) return rule
  const days = prune(rule.hit_days, nowMs)
  const day = dayOf(atMs)
  days[day] = (days[day] ?? 0) + 1
  const last = rule.last_hit_at
  const lastAt = last === undefined || Date.parse(last) < atMs ? new Date(atMs).toISOString() : last
  return { ...rule, hit_days: days, last_hit_at: lastAt }
}

/** 最近 30 天命中几次。 */
export function senderRuleHits30d(rule: SenderRule, now: Iso8601): number {
  return Object.values(prune(rule.hit_days, Date.parse(now))).reduce((a, n) => a + n, 0)
}

/** 给清单用的那一份：算好 `hits_30d`、不带账本本身，缺省的 `source` 补成 `user`。 */
export function senderRuleForList(rule: SenderRule, now: Iso8601): SenderRule {
  const { hit_days: _days, ...rest } = rule
  return { ...rest, source: rule.source ?? 'user', hits_30d: senderRuleHits30d(rule, now) }
}

/** 刚删的那几条里还能撤回的（{@link SENDER_RULE_UNDO_DAYS} 天内，新的在前）。 */
export function undoableDeletedRules(
  rows: readonly DeletedSenderRule[],
  now: Iso8601,
): DeletedSenderRule[] {
  const floor = Date.parse(now) - SENDER_RULE_UNDO_DAYS * DAY_MS
  return rows
    .filter((r) => Date.parse(r.deleted_at) >= floor)
    .sort((a, b) => Date.parse(b.deleted_at) - Date.parse(a.deleted_at))
}
