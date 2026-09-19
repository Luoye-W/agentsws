/**
 * 钱那一跳的两份实现（67 §3）。
 *
 * 为什么要有这个口子：**钱的读写不能跨 await**（`packages/metering/src/wallet.ts`
 * 的头注释）。两个形态里钱都在自己那一侧同步做完，这个包只拿到一个"成了 / 没成"：
 *
 * - Compose 形态：钱包就在同一个进程里，{@link localSubscriptionWallet} 直接调；
 * - Workers 形态：钱在这个组织的 `WalletDO` 里，`apps/cloud-worker` 那一侧给一个
 *   打内部路由的实现（与 WP116 的 `remoteKolAdminPort` 同一种形状）。
 */
import { Wallet, WalletError } from '@agentsws/metering'
import type { SubscriptionChargeOutcome, SubscriptionWallet } from './types.js'

/**
 * 进程里那个钱包。
 *
 * **预扣 + 立刻结算**，不是直接扣：`reserve` 是唯一一处会检查余额并抛
 * `insufficient_credits` 的地方，而结算那一步才会记下计量事件（于是这笔月费
 * 会和别的花费一样出现在用量明细里，用户看得见自己这 30 积分花在哪）。
 *
 * `request_id` 就是幂等键，所以账上这一笔认得出是哪个 cycle。
 */
export function localSubscriptionWallet(wallet: Wallet): SubscriptionWallet {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- 口子是异步的（Workers 那一侧要打网络），这一份同步做完就回
    async charge(args): Promise<SubscriptionChargeOutcome> {
      try {
        const reservation = wallet.reserve({
          org_id: args.org_id,
          workspace_id: args.workspace_id,
          capability: args.capability,
          unit: 'month',
          quantity: 1,
          credits: args.credits,
          request_id: args.request_id,
        })
        wallet.settle(reservation, { quantity: 1, credits: args.credits })
        return { ok: true, credits: args.credits }
      } catch (err) {
        if (err instanceof WalletError) return { ok: false, reason: err.message }
        return {
          ok: false,
          reason: '这一次扣款没做成（云侧出了点问题），服务照常，我们会自动重试。',
        }
      }
    },
  }
}
