/**
 * 增值服务的月费 → `WalletDO` 的那一条内部路由（WP118 / 67 §3）。
 *
 * 与 WP116 那两条（`kol-wallet.ts`）的差别只有一处，但它是全部理由：**这一笔
 * 不需要两段式**。公共红人库要先预扣再打上游，是因为"要花多少"在打之前不知道；
 * 月费是一个定数（30 积分），所以预扣与结算在同一次调用里做完——钱那一侧全程
 * 同步，中间一个 await 都没有。
 *
 * ```
 * KolTenantDO(org)  ──── charge ────▶  WalletDO(org)   同步 reserve + settle
 *                   ◀──── ok / 没钱 ───
 * ```
 *
 * 为什么是 DO 打 DO 而不是绕回入口 Worker：月费也会由**定时器**（租户对象自己的
 * alarm）触发，那一刻根本没有请求，也就没有入口可以绕。
 *
 * 回 200 + 一个信封，**不回 402**：钱不够是业务里正常的一半，HTTP 层的 4xx 会被
 * 中间任何一层当成"这个对象坏了"（与 `kol-wallet.ts` 的 reserve 逐字同一条）。
 */

import type { SubscriptionChargeOutcome, SubscriptionWallet } from '@agentsws/kol-cloud'
import { type Wallet, WalletError } from '@agentsws/metering'

export const SUBSCRIPTION_WALLET_INTERNAL = {
  /** 扣一期月费（预扣 + 结算，一次做完）。 */
  charge: '/__internal/subscription/charge',
} as const

export interface SubscriptionChargeInput {
  org_id: string
  workspace_id: string
  capability: string
  credits: number
  /** 幂等键（`sub:<service>:<org>:<cycle 起始那一天>`），同时当计量事件的 request_id。 */
  request_id: string
}

/** 在 `WalletDO` 里处理这一条。认不出的路径回 `undefined`（交给别的分支）。 */
export async function handleSubscriptionWallet(
  deps: { wallet: Wallet },
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method !== 'POST') return undefined
  if (url.pathname !== SUBSCRIPTION_WALLET_INTERNAL.charge) return undefined
  const input = (await request.json()) as SubscriptionChargeInput
  return Response.json(chargeOnce(deps.wallet, input))
}

/**
 * 预扣 + 立刻结算。
 *
 * 用 reserve 而不是直接从 lot 里扣：`reserve` 是唯一一处会检查余额并抛
 * `insufficient_credits` 的地方；结算那一步才会记下计量事件，于是这 30 积分
 * 会和别的花费一样出现在用量明细里——用户看得见自己订阅的钱花在哪。
 */
export function chargeOnce(
  wallet: Wallet,
  input: SubscriptionChargeInput,
): SubscriptionChargeOutcome {
  try {
    const reservation = wallet.reserve({
      org_id: input.org_id,
      workspace_id: input.workspace_id,
      capability: input.capability,
      unit: 'month',
      quantity: 1,
      credits: input.credits,
      request_id: input.request_id,
    })
    wallet.settle(reservation, { quantity: 1, credits: input.credits })
    return { ok: true, credits: input.credits }
  } catch (err) {
    if (err instanceof WalletError) return { ok: false, reason: err.message }
    return { ok: false, reason: '这一次扣款没做成（云侧出了点问题），服务照常，我们会自动重试。' }
  }
}

/** 租户对象这一侧：打一条内部路由去那个组织的 `WalletDO`。 */
export function remoteSubscriptionWallet(deps: {
  wallet: { fetch(request: Request): Promise<Response> }
  origin: string
}): SubscriptionWallet {
  return {
    async charge(args): Promise<SubscriptionChargeOutcome> {
      try {
        const res = await deps.wallet.fetch(
          new Request(`${deps.origin}${SUBSCRIPTION_WALLET_INTERNAL.charge}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args),
          }),
        )
        if (!res.ok) return { ok: false, reason: '钱包没应答，这一次没扣成（钱一分没动）。' }
        return (await res.json()) as SubscriptionChargeOutcome
      } catch {
        // 打不通就当"这次没扣成"：订阅进宽限，下一次 alarm 再试。**不删数据**
        return { ok: false, reason: '钱包没应答，这一次没扣成（钱一分没动）。' }
      }
    },
  }
}
