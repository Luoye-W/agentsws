/**
 * 注册赠送 10 积分（70 §2，WP121）。
 *
 * **在哪一刻送**：点开登录信、`/v1/cloud/auth/verify` 过了的那一刻，不是发信的
 * 那一刻。发信那一刻只证明有人在输入框里打了一串字；点开链接证明这个邮箱是真的、
 * 而且这个人拿得到它。（账号本身仍然在发信时就建——那是 WP58 的既有行为，
 * 不改；`limiter` 在建账号之前挡着。）
 *
 * **三道闸，各挡一种**：
 *
 * 1. `source_ref = signup_bonus:<account_id>` → 钱包那头 `(org_id, source_ref)`
 *    的唯一索引挡住"同一个账号反复点登录信"；
 * 2. `signup_bonuses.alias_sha256` → 挡住"换个 `+tag` 再注册一个账号"
 *    （`normalizeEmailAlias`，WP115）；
 * 3. `emailBanned` → 黑名单上的邮箱一分不送（删号封邮箱之后又回来的那种）。
 *
 * **绝不抛**。送积分失败不该让登录失败——用户是来登录的，积分是我们送的。
 * 送不出去就如实记一条 `failed` 审计，界面上那句"到账 10 积分"也就不会出现。
 */

import type { Clock } from '@agentsws/contracts'
import type { BonusRule } from '@agentsws/metering'
import { bonusExpiresAt, signupBonus, signupBonusSourceRef } from '@agentsws/metering'

/**
 * 发积分那一下需要的最小口。
 *
 * 故意**不是** `WalletAdminPort`：那个口上还有 `revoke` / `anonymize` /
 * `balance`，注册赠送一个都用不上。要的动作越少，两个形态各自能塞进来的东西
 * 就越多（Compose 传的是进程内钱包，Workers 传的是跨 DO 那一跳）。
 */
export interface SignupBonusPort {
  grant(args: {
    org_id: string
    credits: number
    kind: 'granted' | 'purchased'
    expires_at?: string | undefined
    source_ref?: string | undefined
  }): Promise<{ lot_id: string }>
}

/** 别名台账那一半（`AdminStore` 的三个方法；测试可以塞一个 Map）。 */
export interface SignupBonusLedger {
  signupBonusOf(
    email: string,
  ): { account_id: string; credits: number; granted_at: string } | undefined
  recordSignupBonus(input: {
    email: string
    account_id: string
    org_id: string
    credits: number
    lot_id?: string | undefined
  }): void
  emailBanned(email: string): boolean
  audit(entry: {
    action: 'signup.bonus'
    actor_account_id: string
    actor_role: string
    target_kind: string
    target_id: string
    outcome: 'intent' | 'done' | 'failed'
    details?: Record<string, unknown>
  }): void
}

/**
 * 装配方交进来的**取值函数**，不是值。
 *
 * 理由与 `apps/cloud/src/index.ts` 里那几个 `() => …` 一样：路由声明在建服务器
 * 时就得交出去（OpenAPI 与中间件读的是同一份），而钱包要等 `mountEntry` 装完。
 * 两个都取不到就是"这个节点不送"——如实回 `unavailable`，不静默当成送过了。
 */
export interface SignupBonusHooks {
  port?: (() => SignupBonusPort | undefined) | undefined
  ledger?: (() => SignupBonusLedger | undefined) | undefined
  /** 覆盖规则（测试用）。不给就读 `bonuses.json`。 */
  rule?: BonusRule | undefined
  warn?: ((line: string) => void) | undefined
}

/** 没送成的原因。**每一种都对用户说得出口**，所以它进响应而不只进日志。 */
export type SignupBonusSkip =
  /** 这个邮箱（规范化别名）已经领过了 */
  | 'already'
  /** 黑名单 */
  | 'blocked'
  /** 这个节点没装钱包 / 没装后台库——不是用户的问题 */
  | 'unavailable'
  /** `bonuses.json` 里没有这一条，或金额 ≤ 0：这个部署不送 */
  | 'disabled'
  /** 发的时候上游炸了 */
  | 'failed'

export interface SignupBonusOutcome {
  granted: boolean
  credits: number
  expires_at?: string
  lot_id?: string
  skip?: SignupBonusSkip
}

const NOT_GRANTED = (skip: SignupBonusSkip): SignupBonusOutcome => ({
  granted: false,
  credits: 0,
  skip,
})

/**
 * 送一次（幂等）。
 *
 * 返回值是给界面用的：`granted: true` → 向导第 ① 步显示"到账 10 积分"；
 * `already` → 显示"这个邮箱已经领过了"（照实说，不装作送了）；其余几种
 * 一律不提积分——用户本来也没被承诺过什么。
 */
export async function grantSignupBonus(
  deps: { clock: Clock; hooks: SignupBonusHooks },
  input: { account_id: string; org_id: string; email: string },
): Promise<SignupBonusOutcome> {
  const rule = deps.hooks.rule ?? signupBonus()
  if (rule === undefined || rule.credits <= 0) return NOT_GRANTED('disabled')

  const ledger = deps.hooks.ledger?.()
  const port = deps.hooks.port?.()
  if (ledger === undefined || port === undefined) return NOT_GRANTED('unavailable')

  const warn = deps.hooks.warn ?? ((line: string) => process.stderr.write(line))
  const audit = (outcome: 'done' | 'failed', details: Record<string, unknown>): void => {
    ledger.audit({
      action: 'signup.bonus',
      actor_account_id: 'system',
      actor_role: 'system',
      target_kind: 'org',
      target_id: input.org_id,
      outcome,
      // 邮箱一个字都不进审计（21 §1）：这里只有账号 id 与金额
      details: { account_id: input.account_id, bonus: rule.id, ...details },
    })
  }

  try {
    if (ledger.emailBanned(input.email)) {
      audit('failed', { reason: 'blocked' })
      return NOT_GRANTED('blocked')
    }
    // 第二道：换个 `+tag` 也算领过
    if (ledger.signupBonusOf(input.email) !== undefined) return NOT_GRANTED('already')
  } catch (err) {
    warn(`[signup-bonus] 查台账出错：${String(err)}\n`)
    return NOT_GRANTED('unavailable')
  }

  const expires_at = bonusExpiresAt(rule, deps.clock.now())
  try {
    // 第一道（真正挡住重复入账的那一道）在钱包里：同一个 source_ref 只入一次
    const lot = await port.grant({
      org_id: input.org_id,
      credits: rule.credits,
      kind: rule.kind,
      ...(expires_at === undefined ? {} : { expires_at }),
      source_ref: signupBonusSourceRef(input.account_id),
    })
    ledger.recordSignupBonus({
      email: input.email,
      account_id: input.account_id,
      org_id: input.org_id,
      credits: rule.credits,
      lot_id: lot.lot_id,
    })
    audit('done', { credits: rule.credits, ...(expires_at === undefined ? {} : { expires_at }) })
    return {
      granted: true,
      credits: rule.credits,
      ...(expires_at === undefined ? {} : { expires_at }),
      lot_id: lot.lot_id,
    }
  } catch (err) {
    /*
     * 送不出去**只影响积分那一件事**：登录照样成功。所以这里吞掉异常、
     * 记一条 failed，让人事后查得到"那天为什么没到账"。
     */
    warn(`[signup-bonus] 发放失败 account=${input.account_id}：${String(err)}\n`)
    audit('failed', { reason: 'grant_error' })
    return NOT_GRANTED('failed')
  }
}
