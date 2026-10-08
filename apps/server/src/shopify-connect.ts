/**
 * WP265：连接页 Shopify 卡的一键授权，本机这一头（接私有云 WP263）。
 *
 * 一次连店走这么几跳（**店铺令牌从头到尾没进过这台机器**，决策 185）：
 *
 * ```
 * 卡上「连接 Shopify」（店铺域名自动带上）
 *   → 本地 POST 云 /v1/shopify/oauth/start { shop, brand }   ← 用这个品牌的工作区令牌（动作集 store）
 *   → 系统浏览器打开 Shopify 授权页，店主点「安装」
 *   → Shopify 回调云（/v1/shopify/oauth/callback），云换令牌、加密存
 *   → 卡上轮询 GET 云 /v1/shopify/oauth/attempts/{id} 直到 connected
 * ```
 *
 * 三条纪律：
 *
 * 1. **按品牌**（WP252）：令牌是这个品牌那一把（`cloudOf(ws)`），起授权带 `brand: ws`，
 *    列连接只认 `brand` 是这个品牌的；云上没记 `brand` 的老绑定只算启动品牌的。
 * 2. **照实说**：没关联账号、老令牌缺 `store`、云上 501、连不上——各一句人话 + `details.reason`，
 *    界面按 reason 给下一步，不编状态。
 * 3. 测试连接只发一次**只读**查询（店名 + 域名），不改店里任何东西。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ShopifyConnectActor,
  ShopifyConnectAttemptView,
  ShopifyConnectBlockedReason,
  ShopifyConnectPort,
  ShopifyConnectRow,
  ShopifyConnectStarted,
  ShopifyConnectTestResult,
  ShopifyConnectView,
  ShopifyShopSource,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  Clock,
  ShopifyCloudConnection,
  ShopifyOauthAttempt,
  ShopifyOauthStart,
  WorkspaceId,
} from '@agentsws/contracts'
import { SHOPIFY_CLOUD_PATHS, SHOPIFY_CLOUD_TEST_QUERY } from '@agentsws/contracts'
import type { KolCloudCall, KolCloudCallFn } from './kol-cloud-sync.js'
import { normalizeShopDomain } from './shopify-broker.js'

/** 没登录 Agents 工坊账号。 */
export const SHOPIFY_CONNECT_NOT_LINKED = '先登录 Agents 工坊账号，再一键连 Shopify。'
/** 老令牌缺 `store`。 */
export const SHOPIFY_CONNECT_SCOPE_MISSING =
  '账号授权要更新一下才能连店：重新登录一次 Agents 工坊账号就好。'
/** 云上 501（应用没配齐 / 这家店不在应用的分发范围）。 */
export const SHOPIFY_CONNECT_UNSUPPORTED = '这家店暂不支持一键授权，等公开应用上线。'
/** 连不上云。 */
export const SHOPIFY_CONNECT_OFFLINE =
  '网络不通，这一下没连上 Agents 工坊云。检查一下网络再试一次。'

/** 授权等多久（云上 attempt 自己也会过期；这里只管本机记的那张表别无限长）。 */
const ATTEMPT_KEEP_MS = 30 * 60_000

export interface ShopifyConnectCloud {
  call: KolCloudCallFn
  linked(): boolean
}

export interface ShopifyConnectOptions {
  clock: Clock
  /** 这个品牌的云客户端（令牌是这个品牌那一把）。 */
  cloudOf: (ws: WorkspaceId) => Promise<ShopifyConnectCloud | undefined>
  /** 这个品牌的账号邮箱（重新登录时预填）。 */
  emailOf?: (ws: WorkspaceId) => Promise<string | undefined> | string | undefined
  /**
   * 自动带店铺域名的几处来源，**按先后**：品牌档案 `shopify_domain` → 建站找到 / 选定的店 →
   * Shopify CLI 店铺清单 → 老的客户端凭据连接。取不到就空，卡上让人填一格。
   */
  shopHints: (
    ws: WorkspaceId,
  ) =>
    | Promise<{ shop: string; source: ShopifyShopSource }[]>
    | { shop: string; source: ShopifyShopSource }[]
  /** 启动品牌（云上没记 `brand` 的老绑定只算它的，与 WP252 同一条）。 */
  startupBrand: WorkspaceId
  /** 连上 / 断开之后（首页、岗位面板跟着刷新）。 */
  onChange?: (ws: WorkspaceId) => void
  /** 云端连接的缓存（运营工具 / 岗位就绪按它认「云端已连」）；卡上每看一次、连上 / 断开都顺手更新。 */
  links?: CloudShopLinks
}

/** 云上那一跳的失败 → 本机网关的错误（带 `details.reason`）。 */
function failure(out: KolCloudCall<unknown>, fallback: string): ApiError {
  if (out.status === 0)
    return new ApiError('provider_unavailable', SHOPIFY_CONNECT_OFFLINE, {
      details: { reason: 'offline' },
    })
  const required = out.details?.required_scope
  if (out.status === 403 && (required === 'store' || out.details?.reason === 'scope_missing'))
    return new ApiError('forbidden', SHOPIFY_CONNECT_SCOPE_MISSING, {
      details: { reason: 'scope_missing' },
    })
  if (out.status === 401)
    // 令牌被撤 / 过期：与没关联一样，重新登录一次
    return new ApiError('forbidden', SHOPIFY_CONNECT_NOT_LINKED, {
      details: { reason: 'not_linked' },
    })
  if (out.status === 501)
    return new ApiError('not_implemented', out.message ?? SHOPIFY_CONNECT_UNSUPPORTED, {
      details: { reason: 'unsupported' },
    })
  if (out.status === 404) return new ApiError('not_found', out.message ?? fallback)
  if (out.status === 400 || out.status === 409 || out.status === 422)
    return new ApiError('invalid_input', out.message ?? fallback, {
      ...(out.details === undefined ? {} : { details: out.details }),
    })
  return new ApiError('provider_error', out.message ?? fallback, {
    ...(out.details === undefined ? {} : { details: out.details }),
  })
}

/** 这个品牌的那几条（云上没记 `brand` 的老绑定只算启动品牌的，与 WP252 同一条）。 */
function brandRows(
  ws: string,
  startup: string,
  rows: ShopifyCloudConnection[],
): ShopifyCloudConnection[] {
  return rows.filter((r) =>
    typeof r.brand !== 'string' || r.brand === '' ? ws === startup : r.brand === ws,
  )
}

function rowOf(c: ShopifyCloudConnection, name: string | undefined): ShopifyConnectRow {
  const shopName = c.shop_name ?? name
  return {
    shop: c.shop,
    ...(shopName === undefined ? {} : { name: shopName }),
    ...(c.app === undefined ? {} : { app: c.app }),
    status: c.status === 'reauth_required' ? 'reauth_required' : 'connected',
    ...(c.reauth_reason === undefined ? {} : { reauth_reason: c.reauth_reason }),
    scopes: Array.isArray(c.scopes) ? c.scopes : [],
    missing_scopes: Array.isArray(c.missing_scopes) ? c.missing_scopes : [],
    ...(c.expires_at === undefined ? {} : { expires_at: c.expires_at }),
  }
}

/** 云回的连接清单：`{ connections: [...] }` 或直接一个数组都认。 */
function connectionsOf(data: unknown): ShopifyCloudConnection[] {
  const rows = Array.isArray(data)
    ? data
    : data !== null &&
        typeof data === 'object' &&
        Array.isArray((data as { connections?: unknown }).connections)
      ? (data as { connections: unknown[] }).connections
      : []
  return rows.filter(
    (r): r is ShopifyCloudConnection =>
      r !== null && typeof r === 'object' && typeof (r as { shop?: unknown }).shop === 'string',
  )
}

/** GraphQL 回包里的 `shop`（云上可能原样包一层 `data`）。 */
function shopOf(data: unknown): { name?: string; myshopifyDomain?: string } | undefined {
  let cur: unknown = data
  for (let i = 0; i < 3 && cur !== null && typeof cur === 'object'; i += 1) {
    const shop = (cur as { shop?: unknown }).shop
    if (shop !== null && typeof shop === 'object') return shop as { name?: string }
    cur = (cur as { data?: unknown }).data
  }
  return undefined
}

function errorsOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const errs = (data as { errors?: unknown }).errors
  if (!Array.isArray(errs) || errs.length === 0) return undefined
  const first = errs[0] as { message?: unknown }
  return typeof first.message === 'string' ? first.message : 'Shopify 回了一个错误'
}

export function createShopifyConnect(options: ShopifyConnectOptions): ShopifyConnectPort {
  /** 测过的店名（云上没记店名时卡上也能显示；只在内存里）。 */
  const names = new Map<string, string>()
  /** 起过的授权 → 哪个品牌、哪家店（轮询时补 `shop`；过期的顺手清）。 */
  const attempts = new Map<string, { ws: string; shop: string; at: number }>()
  const now = (): number => Date.parse(options.clock.now())

  const cloudFor = async (ws: string): Promise<ShopifyConnectCloud> => {
    const cloud = await options.cloudOf(ws as WorkspaceId)
    if (cloud === undefined || !cloud.linked())
      throw new ApiError('forbidden', SHOPIFY_CONNECT_NOT_LINKED, {
        details: { reason: 'not_linked' },
      })
    return cloud
  }

  const mineOf = (ws: string, rows: ShopifyCloudConnection[]): ShopifyCloudConnection[] =>
    brandRows(ws, options.startupBrand, rows)

  const shopInput = (raw: string): string => {
    try {
      return normalizeShopDomain(raw)
    } catch (err) {
      throw new ApiError(
        'invalid_input',
        err instanceof Error ? err.message : '店铺域名看不懂，填 your-store.myshopify.com',
        { details: { reason: 'invalid_shop' } },
      )
    }
  }

  const candidatesOf = async (
    ws: string,
    connected: string[],
  ): Promise<{ shop: string; source: ShopifyShopSource }[]> => {
    let hints: { shop: string; source: ShopifyShopSource }[] = []
    try {
      hints = await options.shopHints(ws as WorkspaceId)
    } catch {
      hints = []
    }
    const seen = new Set<string>(connected)
    const out: { shop: string; source: ShopifyShopSource }[] = []
    for (const h of hints) {
      let shop: string
      try {
        shop = normalizeShopDomain(h.shop)
      } catch {
        continue
      }
      if (!shop.endsWith('.myshopify.com') || seen.has(shop)) continue
      seen.add(shop)
      out.push({ shop, source: h.source })
    }
    return out
  }

  const view = async (actor: ShopifyConnectActor): Promise<ShopifyConnectView> => {
    const ws = actor.workspace_id
    const cloud = await options.cloudOf(ws as WorkspaceId)
    const linked = cloud?.linked() === true
    const email = linked ? await options.emailOf?.(ws as WorkspaceId) : undefined
    let rows: ShopifyCloudConnection[] = []
    let blocked: { reason: ShopifyConnectBlockedReason; message: string } | undefined
    if (!linked || cloud === undefined) {
      blocked = { reason: 'not_linked', message: SHOPIFY_CONNECT_NOT_LINKED }
    } else {
      const out = await cloud.call<unknown>(SHOPIFY_CLOUD_PATHS.connections)
      if (out.ok) {
        rows = mineOf(ws, connectionsOf(out.data))
        options.links?.remember(ws as WorkspaceId, rows)
      } else {
        const err = failure(out, '这一下没取到连接状态')
        const reason = (err.details as { reason?: string } | undefined)?.reason
        if (reason === 'scope_missing' || reason === 'not_linked' || reason === 'offline')
          blocked = { reason, message: err.message }
        // 其余（云上还没这几条 / 偶发错）：当没连过，点按钮时再照实说
      }
    }
    const connections = rows.map((r) => rowOf(r, names.get(`${ws}:${r.shop}`)))
    const candidates = await candidatesOf(
      ws,
      connections.map((c) => c.shop),
    )
    const suggested = candidates[0]?.shop
    return {
      linked,
      ...(email === undefined ? {} : { email }),
      ...(blocked === undefined ? {} : { blocked }),
      connections,
      ...(suggested === undefined ? {} : { suggested_shop: suggested }),
      candidates,
    }
  }

  const start = async (
    actor: ShopifyConnectActor,
    input: { shop?: string },
  ): Promise<ShopifyConnectStarted> => {
    const ws = actor.workspace_id
    const cloud = await cloudFor(ws)
    let shop: string | undefined =
      input.shop === undefined || input.shop.trim() === '' ? undefined : shopInput(input.shop)
    if (shop === undefined) shop = (await candidatesOf(ws, []))[0]?.shop
    if (shop === undefined)
      throw new ApiError('invalid_input', '填一下店铺域名（your-store.myshopify.com）', {
        details: { reason: 'need_shop' },
      })
    const out = await cloud.call<ShopifyOauthStart>(SHOPIFY_CLOUD_PATHS.start, {
      method: 'POST',
      body: { shop, brand: ws },
    })
    if (!out.ok || out.data === undefined) throw failure(out, '这一下没起成授权，再试一次')
    const started = out.data
    if (typeof started.authorize_url !== 'string' || !/^https:\/\//.test(started.authorize_url))
      throw new ApiError('provider_error', '云上回的授权地址不对，再试一次')
    for (const [id, a] of attempts) if (now() - a.at > ATTEMPT_KEEP_MS) attempts.delete(id)
    attempts.set(started.attempt_id, { ws, shop, at: now() })
    return {
      attempt_id: started.attempt_id,
      authorize_url: started.authorize_url,
      shop,
      expires_at: started.expires_at,
    }
  }

  const attempt = async (
    actor: ShopifyConnectActor,
    id: string,
  ): Promise<ShopifyConnectAttemptView> => {
    const ws = actor.workspace_id
    const cloud = await cloudFor(ws)
    const out = await cloud.call<ShopifyOauthAttempt>(SHOPIFY_CLOUD_PATHS.attempt(id))
    if (!out.ok || out.data === undefined) {
      // 云上这张授权单已经没了：当它过期了（界面上是「再点一次」）
      if (out.status === 404) return { status: 'expired' }
      throw failure(out, '这一下没问到授权进度')
    }
    const known = attempts.get(id)
    const status = out.data.status
    const shop = out.data.shop ?? known?.shop
    if (status === 'connected' || status === 'failed' || status === 'expired') {
      attempts.delete(id)
      if (status === 'connected') {
        options.links?.invalidate(ws as WorkspaceId)
        options.onChange?.(ws as WorkspaceId)
      }
    }
    return {
      status:
        status === 'connected' || status === 'failed' || status === 'expired' ? status : 'pending',
      ...(shop === undefined ? {} : { shop }),
      ...(out.data.message === undefined ? {} : { message: out.data.message }),
    }
  }

  const test = async (
    actor: ShopifyConnectActor,
    rawShop: string,
  ): Promise<ShopifyConnectTestResult> => {
    const ws = actor.workspace_id
    const shop = shopInput(rawShop)
    const cloud = await cloudFor(ws)
    const checked_at = options.clock.now()
    const out = await cloud.call<unknown>(SHOPIFY_CLOUD_PATHS.graphql, {
      method: 'POST',
      body: { shop, query: SHOPIFY_CLOUD_TEST_QUERY },
      timeout_ms: 20_000,
    })
    if (!out.ok) {
      const err = failure(out, '这一下没测成')
      const reason = (err.details as { reason?: string } | undefined)?.reason
      // 没关联 / 缺动作集 / 连不上：整张卡的事，抛给界面换状态；店这头的问题记成「没通」
      if (reason === 'not_linked' || reason === 'scope_missing' || reason === 'offline') throw err
      return { ok: false, shop, message: err.message, checked_at }
    }
    const problem = errorsOf(out.data)
    const found = shopOf(out.data)
    if (problem !== undefined || found === undefined)
      return { ok: false, shop, message: problem ?? 'Shopify 没回店铺信息', checked_at }
    if (typeof found.name === 'string' && found.name !== '') names.set(`${ws}:${shop}`, found.name)
    return {
      ok: true,
      shop,
      ...(typeof found.name === 'string' ? { name: found.name } : {}),
      ...(typeof found.myshopifyDomain === 'string' ? { domain: found.myshopifyDomain } : {}),
      checked_at,
    }
  }

  const disconnect = async (
    actor: ShopifyConnectActor,
    rawShop: string,
  ): Promise<{ disconnected: boolean }> => {
    const ws = actor.workspace_id
    const shop = shopInput(rawShop)
    const cloud = await cloudFor(ws)
    const out = await cloud.call<unknown>(SHOPIFY_CLOUD_PATHS.connection(shop), {
      method: 'DELETE',
    })
    // 云上本来就没有这条：当断开了（按钮按的就是「不要它了」）
    if (!out.ok && out.status !== 404) throw failure(out, '这一下没断开，再试一次')
    names.delete(`${ws}:${shop}`)
    options.links?.invalidate(ws as WorkspaceId)
    options.onChange?.(ws as WorkspaceId)
    return { disconnected: true }
  }

  return { view, start, attempt, test, disconnect }
}

/** 云端一键授权连上的那一家店（只有店与权限，没有令牌）。 */
export interface CloudShopLink {
  shop: string
  /** 已授、且没被标成缺的权限（原名，未展开）。 */
  scopes: string[]
}

/**
 * WP265（Fable 追加）：每个品牌「云端连着哪家店」的缓存——运营工具（优先云端、没有才回退 CLI）、
 * 岗位就绪（「还缺必需的连接：店铺后台」）按它认。`peek` 是同步的（就绪算法是同步读），
 * 只回上一次问到的；`link` 过期（默认 60 秒）就现问一次云。
 */
export interface CloudShopLinks {
  link(ws: WorkspaceId): Promise<CloudShopLink | undefined>
  peek(ws: WorkspaceId): CloudShopLink | undefined
  remember(ws: WorkspaceId, rows: readonly ShopifyCloudConnection[]): void
  invalidate(ws: WorkspaceId): void
}

export function createCloudShopLinks(options: {
  cloudOf: (ws: WorkspaceId) => Promise<ShopifyConnectCloud | undefined>
  startupBrand: WorkspaceId
  clock: Clock
  ttlMs?: number
  /** 某个品牌的「云端连着没有」变了（就绪、工具面跟着重算）。 */
  onChange?: (ws: WorkspaceId) => void
  /**
   * 落盘的那一份（只有店与权限名，没有令牌）：重启之后不打云也知道「上次连着哪家」，
   * 就绪算法（同步读）开机就对；不给 = 只在内存里。
   */
  file?: string
}): CloudShopLinks {
  const ttl = options.ttlMs ?? 60_000
  const cache = new Map<string, { at: number; link: CloudShopLink | undefined }>()
  if (options.file !== undefined && existsSync(options.file))
    try {
      const saved = JSON.parse(readFileSync(options.file, 'utf8')) as {
        links?: Record<string, CloudShopLink>
      }
      // at = 0：开机先用存的，第一次有人现问就去云上核一遍
      for (const [ws, link] of Object.entries(saved.links ?? {}))
        if (typeof link?.shop === 'string') cache.set(ws, { at: 0, link })
    } catch {
      // 坏文件当没有
    }
  const save = (): void => {
    if (options.file === undefined) return
    const links: Record<string, CloudShopLink> = {}
    for (const [ws, v] of cache) if (v.link !== undefined) links[ws] = v.link
    try {
      mkdirSync(dirname(options.file), { recursive: true })
      writeFileSync(options.file, `${JSON.stringify({ version: 1, links }, null, 2)}\n`)
    } catch {
      // 写不下去：下次开机现问
    }
  }
  const now = (): number => Date.parse(options.clock.now())
  const pick = (rows: readonly ShopifyCloudConnection[]): CloudShopLink | undefined => {
    const row = rows.find((r) => r.status === 'connected')
    if (row === undefined) return undefined
    const missing = new Set(Array.isArray(row.missing_scopes) ? row.missing_scopes : [])
    const scopes = (Array.isArray(row.scopes) ? row.scopes : []).filter((x) => !missing.has(x))
    return { shop: row.shop, scopes }
  }
  const set = (ws: WorkspaceId, link: CloudShopLink | undefined): void => {
    const before = cache.get(ws)?.link
    cache.set(ws, { at: now(), link })
    if (JSON.stringify(before ?? null) !== JSON.stringify(link ?? null)) save()
    if ((before?.shop ?? '') !== (link?.shop ?? '')) options.onChange?.(ws)
  }
  return {
    async link(ws) {
      const hit = cache.get(ws)
      if (hit !== undefined && now() - hit.at < ttl) return hit.link
      const cloud = await options.cloudOf(ws)
      if (cloud === undefined || !cloud.linked()) {
        set(ws, undefined)
        return undefined
      }
      const out = await cloud.call<unknown>(SHOPIFY_CLOUD_PATHS.connections)
      // 云上一时没回（断网 / 偶发错）：沿用上一次的，不把正在用的连接当成断了
      if (!out.ok) return hit?.link
      const link = pick(brandRows(ws, options.startupBrand, connectionsOf(out.data)))
      set(ws, link)
      return link
    },
    peek: (ws) => cache.get(ws)?.link,
    remember(ws, rows) {
      set(ws, pick(rows))
    },
    invalidate(ws) {
      const hit = cache.get(ws)
      if (hit !== undefined) cache.set(ws, { at: 0, link: hit.link })
    },
  }
}
