/**
 * 后台 → `WalletDO` 的那几条内部路由（WP115 / 65 §9）。
 *
 * 为什么钱那几件事不放在后台那一侧做：**钱只能在钱的对象里动**。撤回一笔积分
 * 与那条负向流水必须落在同一个事务里；余额的真值只有那个对象自己知道。所以
 * 后台那一层握的是一个 {@link WalletAdminPort}，Workers 形态下它就是"按组织
 * 敲一扇门"。
 *
 * 这几条与 `/__internal/*` 的其余部分一样：**在公网上打不到**（DO 没有地址，
 * 而入口 Worker 对 `/__internal/` 开头的路径一律回 404）。
 */

import type { WalletLot } from '@agentsws/contracts'
import type { WalletAdminPort } from '@agentsws/metering'

/** 路由名。请求体是 JSON，响应也是——形状与 `WalletAdminPort` 的签名一一对应。 */
export const WALLET_ADMIN_INTERNAL = {
  balance: '/__internal/admin/balance',
  lots: '/__internal/admin/lots',
  grant: '/__internal/admin/grant',
  revoke: '/__internal/admin/revoke',
  anonymize: '/__internal/admin/anonymize',
} as const

/** 在一个 `WalletDO` 里处理这几条。认不出的路径回 `undefined`（交给别的分支）。 */
export async function handleWalletAdmin(
  port: WalletAdminPort,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method !== 'POST') return undefined
  switch (url.pathname) {
    case WALLET_ADMIN_INTERNAL.balance: {
      const { org_id } = (await request.json()) as { org_id: string }
      return Response.json(await port.balance(org_id))
    }
    case WALLET_ADMIN_INTERNAL.lots: {
      const { org_id } = (await request.json()) as { org_id: string }
      return Response.json(await port.lots(org_id))
    }
    case WALLET_ADMIN_INTERNAL.grant: {
      const args = (await request.json()) as Parameters<WalletAdminPort['grant']>[0]
      return Response.json(await port.grant(args))
    }
    case WALLET_ADMIN_INTERNAL.revoke: {
      const args = (await request.json()) as Parameters<WalletAdminPort['revoke']>[0]
      // 找不到那一笔时回 `null`：调用方翻成 `undefined`，路由再翻成 404
      return Response.json((await port.revoke(args)) ?? null)
    }
    case WALLET_ADMIN_INTERNAL.anonymize: {
      const { org_id, tombstone } = (await request.json()) as {
        org_id: string
        tombstone: string
      }
      return Response.json({ changed: await port.anonymize(org_id, tombstone) })
    }
    default:
      return undefined
  }
}

/** 一个按组织敲门的 namespace（`env.WALLET` 那个形状）。 */
export interface WalletNamespaceLike {
  idFromName(name: string): { toString(): string }
  get(id: { toString(): string }): { fetch(request: Request): Promise<Response> }
}

/**
 * Workers 形态的 {@link WalletAdminPort}：**每一次调用都先算出该敲哪一扇门**。
 *
 * 所以这个口的每个方法都必须知道 `org_id`——这也是 `revoke` 的参数里有
 * `org_id` 的原因（Compose 形态下它是可选的，那边一张表按 lot_id 就找得到）。
 */
export function remoteWalletAdminPort(
  namespace: WalletNamespaceLike,
  origin = 'https://do.internal',
): WalletAdminPort {
  const call = async <T>(org_id: string, path: string, body: unknown, fallback: T): Promise<T> => {
    const stub = namespace.get(namespace.idFromName(org_id))
    const res = await stub.fetch(
      new Request(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    if (!res.ok) return fallback
    return (await res.json()) as T
  }
  return {
    balance: (org_id) =>
      call(org_id, WALLET_ADMIN_INTERNAL.balance, { org_id }, { granted: 0, purchased: 0 }),
    lots: (org_id) => call<WalletLot[]>(org_id, WALLET_ADMIN_INTERNAL.lots, { org_id }, []),
    async grant(args) {
      const out = await call<{ lot_id: string } | null>(
        args.org_id,
        WALLET_ADMIN_INTERNAL.grant,
        args,
        null,
      )
      // 发不出去就抛：批量发积分那一条按收件人逐个 try，这一抛会落进 `skipped`
      if (out === null) throw new Error(`发积分失败：${args.org_id}`)
      return out
    },
    async revoke(args) {
      if (args.org_id === '')
        // Workers 形态下不知道组织就不知道敲哪扇门。说清楚，别静默回"没找到"
        throw new Error('撤回时必须给 org_id（官方托管形态下钱按组织分开放）')
      return (
        (await call<{ revoked: number } | null>(
          args.org_id,
          WALLET_ADMIN_INTERNAL.revoke,
          args,
          null,
        )) ?? undefined
      )
    },
    async anonymize(org_id, tombstone) {
      const out = await call<{ changed: number }>(
        org_id,
        WALLET_ADMIN_INTERNAL.anonymize,
        { org_id, tombstone },
        { changed: 0 },
      )
      return out.changed
    },
  }
}
