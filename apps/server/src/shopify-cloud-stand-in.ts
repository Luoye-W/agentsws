/**
 * WP265：云端 Shopify 一键授权（私有云 WP263 那五条）的替身。**一个字节都不出网、不碰真店。**
 *
 * demo 的云替身（`cloud-stand-in.ts`）与测试里的本地假云（起一个 127.0.0.1 的 http 服务）
 * 共用这一份：起授权 → 授权单 pending → 过一会儿（默认 1.5 秒，demo 里像店主点了「安装」）
 * 变 connected → 列得出连接、测得通、断得开。授权页地址是 `.invalid` 保留域，点出去也到不了任何地方。
 *
 * 测试要的几种状态有开关：`settle`（失败 / 过期 / 连上）、`reauth`（要重新授权 / 缺权限）、
 * `unsupported`（这家店 501）。
 */

import type { ShopifyCloudConnection, ShopifyOauthAttemptStatus } from '@agentsws/contracts'

/** 授权页的假地址（`.invalid` 保留域，RFC 2606：永远解析不出来）。 */
export const SHOPIFY_STAND_IN_AUTHORIZE_BASE = 'https://shopify.demo.invalid/admin/oauth/authorize'

/** 应用 B（Rollout 指定店铺应用）的那套权限（docs/92 第一步）。 */
export const SHOPIFY_STAND_IN_SCOPES = [
  'read_products',
  'write_products',
  'read_inventory',
  'write_inventory',
  'read_content',
  'write_content',
  'read_online_store_navigation',
  'write_online_store_navigation',
  'read_discounts',
  'write_discounts',
  'read_orders',
  'read_themes',
]

export interface ShopifyCloudStandInOptions {
  now?: () => string
  /** 起授权之后多久自己变 connected（毫秒）；负数 = 不自己变（测试用 `settle` 推）。默认 1500。 */
  autoConnectAfterMs?: number
  /** 这家店回 501（应用的分发范围外）。默认没有。 */
  unsupported?: (shop: string) => boolean
  /** 店主授了哪些权限（默认 = 应用 B 的那一套，docs/92）。 */
  scopes?: readonly string[]
  /** 测试连接时回的店名。 */
  shopName?: (shop: string) => string
  /**
   * 运营工具那几条查询 / 改动的回包（Shopify 的 `{ data, errors? }`）；不给或回 `undefined`
   * 就只认「测试连接」那一条（店名 + 域名）。
   */
  graphql?: (req: { shop: string; query: string; variables?: unknown }) => unknown
}

export interface ShopifyStandInReply {
  status: number
  body: unknown
}

export interface ShopifyCloudStandIn {
  /** 认得的路径回一个结果；不认得回 `undefined`（由外面那一层说 404）。 */
  handle(
    method: string,
    path: string,
    body: Record<string, unknown>,
    ctx?: { workspace?: string },
  ): ShopifyStandInReply | undefined
  /** 把一张授权单推到某个状态（测试用）。 */
  settle(attempt_id: string, status: Exclude<ShopifyOauthAttemptStatus, 'pending'>): void
  /** 某家店变成「要重新授权」或缺几项权限（测试用）。 */
  reauth(shop: string, input: { reason?: string; missing_scopes?: string[] }): void
  attempts(): { id: string; shop: string; brand?: string; status: ShopifyOauthAttemptStatus }[]
  connections(): ShopifyCloudConnection[]
  /** 收到过的代发请求（测试看带没带 `allow_mutations`）。 */
  graphqlCalls(): { shop: string; query: string; allow_mutations: boolean }[]
}

export function shopifyCloudStandIn(options: ShopifyCloudStandInOptions = {}): ShopifyCloudStandIn {
  const now = options.now ?? ((): string => new Date().toISOString())
  const autoAfter = options.autoConnectAfterMs ?? 1500
  const attempts = new Map<
    string,
    { id: string; shop: string; brand?: string; status: ShopifyOauthAttemptStatus }
  >()
  /** `brand|shop` → 绑定。 */
  const bound = new Map<string, ShopifyCloudConnection>()
  let seq = 0
  const gqlCalls: { shop: string; query: string; allow_mutations: boolean }[] = []
  const ok = (data: unknown, status = 200): ShopifyStandInReply => ({ status, body: { data } })
  const fail = (status: number, code: string, message: string): ShopifyStandInReply => ({
    status,
    body: { code, message },
  })

  const connect = (id: string): void => {
    const a = attempts.get(id)
    if (a === undefined || a.status !== 'pending') return
    a.status = 'connected'
    bound.set(`${a.brand ?? ''}|${a.shop}`, {
      shop: a.shop,
      app: 'rollout',
      ...(a.brand === undefined ? {} : { brand: a.brand }),
      status: 'connected',
      scopes: [...(options.scopes ?? SHOPIFY_STAND_IN_SCOPES)],
      missing_scopes: [],
      connected_at: now(),
    })
  }

  return {
    handle(method, path, body, ctx = {}) {
      if (!path.startsWith('/v1/shopify/')) return undefined
      if (method === 'POST' && path === '/v1/shopify/oauth/start') {
        const shop = typeof body.shop === 'string' ? body.shop.trim().toLowerCase() : ''
        if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(shop))
          return fail(400, 'invalid_input', '店铺域名要是 xxx.myshopify.com')
        if (options.unsupported?.(shop) === true)
          return fail(501, 'not_implemented', '这家店暂不支持一键授权，等公开应用上线。')
        seq += 1
        const id = `sha_${String(seq).padStart(6, '0')}`
        const brand = typeof body.brand === 'string' ? body.brand : undefined
        attempts.set(id, { id, shop, ...(brand === undefined ? {} : { brand }), status: 'pending' })
        if (autoAfter >= 0) setTimeout(() => connect(id), autoAfter).unref?.()
        return ok(
          {
            attempt_id: id,
            authorize_url: `${SHOPIFY_STAND_IN_AUTHORIZE_BASE}?shop=${encodeURIComponent(shop)}&state=${id}`,
            app: 'rollout',
            scopes: [...(options.scopes ?? SHOPIFY_STAND_IN_SCOPES)],
            expires_at: new Date(Date.parse(now()) + 10 * 60_000).toISOString(),
          },
          201,
        )
      }
      const attempt = /^\/v1\/shopify\/oauth\/attempts\/([^/]+)$/u.exec(path)
      if (method === 'GET' && attempt !== null) {
        const a = attempts.get(decodeURIComponent(attempt[1] as string))
        if (a === undefined) return fail(404, 'not_found', '没有这张授权单')
        return ok({
          status: a.status,
          shop: a.shop,
          ...(a.status === 'failed' ? { message: '店主在 Shopify 上没点安装。' } : {}),
        })
      }
      if (method === 'GET' && path === '/v1/shopify/connections')
        return ok({ connections: [...bound.values()] })
      const one = /^\/v1\/shopify\/connections\/([^/]+)$/u.exec(path)
      if (method === 'DELETE' && one !== null) {
        const shop = decodeURIComponent(one[1] as string)
        let hit = false
        for (const [key, c] of bound)
          if (c.shop === shop && (ctx.workspace === undefined || c.brand === ctx.workspace)) {
            bound.delete(key)
            hit = true
          }
        return hit ? ok({ disconnected: true }) : fail(404, 'not_found', '没有这条连接')
      }
      if (method === 'POST' && path === '/v1/shopify/graphql') {
        const shop = typeof body.shop === 'string' ? body.shop : ''
        const row = [...bound.values()].find((c) => c.shop === shop)
        if (row === undefined) return fail(404, 'not_found', '这家店还没连上')
        if (row.status === 'reauth_required')
          return fail(409, 'conflict', '店铺授权失效了，重新授权一次。')
        const query = typeof body.query === 'string' ? body.query : ''
        const allow = body.allow_mutations === true
        gqlCalls.push({ shop, query, allow_mutations: allow })
        // 与真云同一道闸：文档是 mutation 却没说要改 → 拒
        if (/^\s*mutation\b/u.test(query.replace(/#[^\n]*/gu, '')) && !allow)
          return fail(400, 'invalid_input', '这一条是改动，没带 allow_mutations')
        const custom = options.graphql?.({ shop, query, variables: body.variables })
        if (custom !== undefined) return ok(custom)
        return ok({
          data: {
            shop: { name: options.shopName?.(shop) ?? shop.split('.')[0], myshopifyDomain: shop },
          },
        })
      }
      return undefined
    },
    settle(id, status) {
      if (status === 'connected') connect(id)
      else {
        const a = attempts.get(id)
        if (a !== undefined && a.status === 'pending') a.status = status
      }
    },
    reauth(shop, input) {
      for (const c of bound.values())
        if (c.shop === shop) {
          if (input.reason !== undefined) {
            c.status = 'reauth_required'
            c.reauth_reason = input.reason
          }
          if (input.missing_scopes !== undefined) c.missing_scopes = [...input.missing_scopes]
        }
    },
    attempts: () => [...attempts.values()].map((a) => ({ ...a })),
    connections: () => [...bound.values()].map((c) => ({ ...c })),
    graphqlCalls: () => gqlCalls.map((c) => ({ ...c })),
  }
}
