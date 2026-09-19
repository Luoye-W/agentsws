/**
 * 赠送规则（70 §2）。
 *
 * 只有一条纪律值得写在文件头：**金额是数据，幂等键是代码**。
 *
 * 金额放 `bonuses.json`（改 10 → 20 不用碰一行代码）；幂等键的算法留在代码里，
 * 因为它一旦变了，已经发过的那些就会被当成没发过再发一遍。KefuAgent 白送出去
 * 十几万积分就是栽在这一条上（`plans.ts` 文件头那段），所以这里把两件事分开放：
 * 数据文件里**没有任何东西参与幂等键的计算**。
 *
 * 纯函数、无 IO、无时钟：到期日由调用方把 `now` 传进来算。
 */

import bonusesFile from './bonuses.json' with { type: 'json' }

/** 一条赠送规则。`kind` 与 `expires_days` 一起决定它是哪一类积分（49 §3）。 */
export interface BonusRule {
  id: string
  label_zh: string
  label_en: string
  credits: number
  kind: 'granted' | 'purchased'
  /** `granted` 多少天后清零。`purchased` 那一类不该有这个字段。 */
  expires_days?: number
  note_zh?: string
}

export interface BonusesFile {
  version: number
  as_of: string
  note: string
  needs_decision: string
  bonuses: BonusRule[]
}

export const BONUSES_FILE = bonusesFile as unknown as BonusesFile

/** 注册赠送那一条的 id。它同时是幂等键的后半截，所以是个常量不是个字面量。 */
export const SIGNUP_BONUS_ID = 'signup_bonus'

export const bonuses = (file: BonusesFile = BONUSES_FILE): BonusRule[] => file.bonuses

export function bonusById(id: string, file: BonusesFile = BONUSES_FILE): BonusRule | undefined {
  return file.bonuses.find((b) => b.id === id)
}

/** 注册赠送。取不到就是**不送**——宁可不送也不猜一个金额。 */
export function signupBonus(file: BonusesFile = BONUSES_FILE): BonusRule | undefined {
  return bonusById(SIGNUP_BONUS_ID, file)
}

/**
 * 幂等键：`signup_bonus:<account_id>`。
 *
 * **不含时间、不含邮箱、不含金额。** 不含时间的理由见文件头；不含邮箱是因为
 * 邮箱能改，改一次就又能领一份；不含金额是因为把 10 改成 20 之后老用户会被
 * 当成没领过。
 */
export function signupBonusSourceRef(account_id: string): string {
  return `${SIGNUP_BONUS_ID}:${account_id}`
}

/** 这一笔 lot 是注册赠送吗（后台「积分与会员」那张发放流水按它认）。 */
export function isSignupBonusRef(source_ref: string | null | undefined): boolean {
  return typeof source_ref === 'string' && source_ref.startsWith(`${SIGNUP_BONUS_ID}:`)
}

/** 到期日：`now + expires_days`。规则里没写天数就是不过期（返回 undefined）。 */
export function bonusExpiresAt(rule: BonusRule, now: string): string | undefined {
  if (rule.expires_days === undefined) return undefined
  return new Date(Date.parse(now) + rule.expires_days * 24 * 60 * 60 * 1000).toISOString()
}
