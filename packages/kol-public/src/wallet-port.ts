/**
 * 公共红人库与**钱**之间那一层口（WP116 / 64 §10.2）。
 *
 * ## 为什么要有它
 *
 * `KolPublicService` 做两件事：**取数**（查库、打外部源、算基准）与**记账**
 * （预扣 → 结算 / 释放 → 记一条计量事件）。在自建形态里这两件事住在同一个进程里，
 * 所以 `deps.wallet` 直接就是那个 `Wallet` 实例，一路同步。
 *
 * 官方托管形态（Cloudflare Workers）下它们住在**两个 Durable Object** 里：
 * 红人表是一张全局共享的表（单例 `KolPublicDO`），钱包按组织切开
 * （`WalletDO(org_id)`）。跨对象调用是异步的，而钱包的读写口是**刻意全同步**的
 * （`packages/metering/src/wallet.ts` 的头注释：钱的读写中间不该有一个 await）。
 * 这就是 docs/64 §10.2 那条"公共红人库这一轮不上"的全部技术原因。
 *
 * ## 解法：两段式 + 一个"记账的录音机"
 *
 * 顺序不变，只是把三跳拆开：
 *
 * 1. 入口 Worker 先在 `WalletDO` 里**预扣**（同步，在钱那个对象里）；
 * 2. 把那笔预扣**带着**打 `KolPublicDO`。它里面那个 `KolPublicService`
 *    拿到的 `wallet` 是 {@link deferredWallet} —— 一个**只录不做**的替身：
 *    `reserve()` 把入口做好的那笔递回去，`settle` / `release` / `topup`
 *    只记在一张纸上；
 * 3. 入口拿到那张纸，回 `WalletDO` 里**照单执行**（还是同步，还是在钱那个对象里）。
 *
 * 于是：**服务本身一个字没改**，"钱的读写全同步"也一个字没破——同步性发生在
 * `WalletDO` 里，异步性只发生在两个对象之间的那两跳，而那两跳中间没有任何
 * 读一次钱再写一次钱的动作。
 *
 * ## 为什么 `settle` 在录音机里也跑一次白名单断言
 *
 * `assertMeteringEvent`（49 M6：多一个键就抛）是"入口不存正文"唯一可执行的形式。
 * 如果录音机只是把参数原样记下来、等回到 `WalletDO` 再断言，那么一次
 * "把上游响应 spread 进 meta" 的事故会在**跨对象之后**才被发现——那时错误信息
 * 指向的是钱包，而不是真正写错的那个 handler。所以这里当场跑一遍。
 */

import type { CreditKind, Iso8601, MeteringEvent, WalletLot } from '@agentsws/contracts'
import {
  assertMeteringEvent,
  type SettleMeta,
  settleMetaFields,
  WalletError,
  type WalletReservation,
} from '@agentsws/metering'

/**
 * 公共库要用到的钱包那四件事。
 *
 * `@agentsws/metering` 的 `Wallet` 结构上满足它（自建形态直接传那个实例）。
 * 写成一个口是为了让 Workers 形态塞得进 {@link deferredWallet}——`Wallet` 是一个
 * 带私有字段的类，结构类型塞不进去。
 *
 * **它没有 `balance()`**：公共库从不问余额。余额够不够由 `reserve()` 的成败回答，
 * 多一个读余额的口只会让人写出"先看一眼再扣"那种有竞态的代码。
 */
export interface KolWallet {
  reserve(args: {
    org_id: string
    workspace_id: string
    capability: string
    unit: string
    quantity: number
    credits: number
    request_id: string
  }): WalletReservation
  settle(
    reservation: WalletReservation,
    actual: { quantity: number; credits: number } & SettleMeta,
  ): MeteringEvent
  release(reservation: WalletReservation): void
  topup(args: {
    org_id: string
    credits: number
    kind: CreditKind
    expires_at?: Iso8601 | undefined
    source_ref?: string | undefined
  }): WalletLot
}

/** 录音机记下来的一笔。入口 Worker 拿着它回 `WalletDO` 照单执行。 */
export type KolWalletOp =
  | {
      kind: 'settle'
      reservation: WalletReservation
      actual: { quantity: number; credits: number } & SettleMeta
    }
  | { kind: 'release'; reservation: WalletReservation }
  | {
      kind: 'topup'
      args: {
        org_id: string
        credits: number
        kind: CreditKind
        expires_at?: Iso8601 | undefined
        source_ref?: string | undefined
      }
    }

export interface DeferredWalletOptions {
  /**
   * 入口 Worker 已经做好的预扣，**按服务调用 `reserve()` 的顺序取用**。
   *
   * 公共库的每条路由最多预扣一次（免费那几条一次都不预扣），所以这个数组
   * 实际上长 0 或 1。写成数组而不是单个值，是为了不让"以后有一条路由要扣两次"
   * 变成一次重构。
   */
  reservations: WalletReservation[]
  now: () => Iso8601
}

export interface DeferredWallet {
  wallet: KolWallet
  /** 这一次请求里记下来的全部动作（按发生顺序）。 */
  ops: KolWalletOp[]
}

/**
 * 一个**只录不做**的钱包（官方托管形态用）。
 *
 * 三条纪律：
 *
 * 1. `reserve()` **不自己造预扣**。造得出来就意味着这个对象能凭空放行一次付费调用，
 *    而它根本看不见余额。没有现成的那一笔就抛——入口漏了预扣是一个装配错误，
 *    不该表现成"这次免费送你"。
 * 2. `settle()` 当场跑白名单断言（见文件头注释）。
 * 3. 返回值都是**合成**的：服务本身不看 `settle` / `topup` 的返回值（看了也没意义，
 *    真正的扣款发生在另一个对象里），但类型要对得上，所以给一个形状正确的。
 */
export function deferredWallet(options: DeferredWalletOptions): DeferredWallet {
  const pending = [...options.reservations]
  const ops: KolWalletOp[] = []
  let seq = 0
  const wallet: KolWallet = {
    reserve(args) {
      const next = pending.shift()
      if (next === undefined)
        throw new WalletError(
          'invalid_input',
          `官方托管形态下预扣要由入口先做好，这一次没有为「${args.capability}」准备预扣。` +
            '这是装配错误，不是余额问题。',
        )
      if (next.capability !== args.capability)
        throw new WalletError(
          'invalid_input',
          `预扣对不上：入口准备的是「${next.capability}」，服务要扣的是「${args.capability}」。`,
        )
      return next
    },

    settle(reservation, actual) {
      const event = assertMeteringEvent({
        capability: reservation.capability,
        unit: reservation.unit,
        quantity: actual.quantity,
        credits: actual.credits,
        at: options.now(),
        org_id: reservation.org_id,
        workspace_id: reservation.workspace_id,
        request_id: reservation.request_id,
        ...settleMetaFields(actual),
      })
      ops.push({ kind: 'settle', reservation, actual })
      return event
    },

    release(reservation) {
      ops.push({ kind: 'release', reservation })
    },

    topup(args) {
      if (args.credits <= 0) throw new WalletError('invalid_input', '充值积分必须大于 0')
      ops.push({ kind: 'topup', args })
      seq += 1
      // 合成一笔：真正入账在 `WalletDO` 里，这一份只是把类型填满
      return {
        id: `lot_deferred_${String(seq)}`,
        org_id: args.org_id,
        kind: args.kind,
        credits: args.credits,
        remaining: args.credits,
        granted_at: options.now(),
        ...(args.expires_at === undefined ? {} : { expires_at: args.expires_at }),
        ...(args.source_ref === undefined ? {} : { source_ref: args.source_ref }),
      }
    },
  }
  return { wallet, ops }
}
