/**
 * 公共红人库 → `WalletDO` 的那两条内部路由（WP116 / 64 §10.2）。
 *
 * 两段式的第一步与第三步都在**钱那个对象里**跑，所以"钱的读写全同步"这条纪律
 * （`packages/metering/src/wallet.ts` 的头注释）一个字没破：
 *
 * ```
 * 入口 Worker                WalletDO(org)              KolPublicDO（单例）
 *    │  ① reserve  ─────────────▶  同步预扣
 *    │  ◀──────────────────────── 一笔 WalletReservation
 *    │  ② 带着那一笔打库  ──────────────────────────────▶  取数（钱包是录音机）
 *    │  ◀──────────────────────────────────────────────  响应 + 记下来的那几笔
 *    │  ③ apply    ─────────────▶  同步结算 / 释放 / 返额度
 * ```
 *
 * `apply` 里有一条**兜底**：入口给了的预扣，凡是没被结算也没被释放的，一律释放。
 * 库那一头抛了（404、上游挂了、代码 bug）就走这条——不然那笔钱要等一个小时的
 * 孤儿预扣清扫才回来，而用户会以为自己被扣了。
 */

import type { Pricing } from '@agentsws/contracts'
import type { KolWalletOp } from '@agentsws/kol-public'
import { creditsFor, type Wallet, WalletError, type WalletReservation } from '@agentsws/metering'

/** 路由名。 */
export const KOL_WALLET_INTERNAL = {
  /** ① 预扣一笔（入口在碰库之前打这一条）。 */
  reserve: '/__internal/kol/reserve',
  /** ③ 照单执行库那一头记下来的那几笔。 */
  apply: '/__internal/kol/apply',
} as const

export interface KolReserveInput {
  org_id: string
  workspace_id: string
  capability: string
  unit: string
  quantity: number
  request_id: string
}

/** 预扣不成时回的那一份（入口翻成 402 / 400，与 Compose 形态同一句话）。 */
export interface KolReserveFailure {
  code: 'insufficient_credits' | 'invalid_input'
  message: string
  details?: Record<string, unknown> | undefined
}

export interface KolApplyInput {
  ops: KolWalletOp[]
  /** 入口这一次做好的全部预扣（兜底释放要用）。 */
  reservations: WalletReservation[]
}

export interface KolApplyResult {
  settled: number
  released: number
  topups: number
}

/** 在 `WalletDO` 里处理这两条。认不出的路径回 `undefined`（交给别的分支）。 */
export async function handleKolWallet(
  deps: { wallet: Wallet; pricing: Pricing },
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method !== 'POST') return undefined
  switch (url.pathname) {
    case KOL_WALLET_INTERNAL.reserve: {
      const input = (await request.json()) as KolReserveInput
      try {
        // 价钱在这一侧算：入口不认识价目表，库那一头也不该认识余额
        const credits = creditsFor(deps.pricing, input.capability, input.quantity)
        if (credits === undefined)
          // 价目表里没有这一条：**不猜一个数**，也不白送（与服务那一侧同一句话）
          throw new WalletError(
            'invalid_input',
            `云侧的价目表里没有「${input.capability}」这一条，这一次没有扣积分。`,
          )
        return Response.json(deps.wallet.reserve({ ...input, credits }))
      } catch (err) {
        const failure: KolReserveFailure =
          err instanceof WalletError
            ? {
                code: err.code === 'insufficient_credits' ? 'insufficient_credits' : 'invalid_input',
                message: err.message,
                ...(err.details === undefined ? {} : { details: err.details }),
              }
            : {
                code: 'invalid_input',
                message:
                  err instanceof Error && err.message !== '' ? err.message : '这一次预扣没做成',
              }
        // 200 + 一个信封：**这不是 HTTP 层的错**，是业务上的"钱不够"。
        // 回 402 会被中间任何一层当成"这个对象坏了"，而它好得很
        return Response.json({ error: failure })
      }
    }
    case KOL_WALLET_INTERNAL.apply: {
      const input = (await request.json()) as KolApplyInput
      return Response.json(applyKolOps(deps.wallet, input))
    }
    default:
      return undefined
  }
}

/**
 * 照单执行。**每一笔自己一个 try**：一笔记不上不该把另外几笔也带走
 * （尤其是"贡献返额度"与"这一次的结算"混在一趟里的时候）。
 */
export function applyKolOps(wallet: Wallet, input: KolApplyInput): KolApplyResult {
  const out: KolApplyResult = { settled: 0, released: 0, topups: 0 }
  const done = new Set<string>()
  for (const op of input.ops ?? []) {
    try {
      if (op.kind === 'settle') {
        wallet.settle(op.reservation, op.actual)
        done.add(op.reservation.id)
        out.settled += 1
      } else if (op.kind === 'release') {
        wallet.release(op.reservation)
        done.add(op.reservation.id)
        out.released += 1
      } else {
        wallet.topup(op.args)
        out.topups += 1
      }
    } catch {
      // 记不上就算了：钱在这一侧是权威，少记一条计量事件比把请求带走好
    }
  }
  // 兜底：库那一头没用上的预扣一律释放（它抛了、或者根本没走到收费那一步）
  for (const reservation of input.reservations ?? []) {
    if (done.has(reservation.id)) continue
    try {
      wallet.release(reservation)
      out.released += 1
    } catch {
      /* 同上 */
    }
  }
  return out
}
