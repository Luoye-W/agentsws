/**
 * Shopify「客户端凭据换令牌」经纪人（WP25 交付 A）。
 *
 * 背景：Shopify 的 Dev Dashboard 建的应用装到自己组织的店之后，后台只给
 * **客户端 ID + 客户端密钥**，不再像老的「自定义应用」那样直接给一串 `shpat_`。
 * 拿它们换 Admin API 令牌要走 client credentials grant：
 *
 * ```
 * POST https://{shop}.myshopify.com/admin/oauth/access_token
 * { client_id, client_secret, grant_type: "client_credentials" }
 * → { access_token, scope, expires_in: 86399 }
 * ```
 *
 * **24 小时过期，同样的请求再发一次就是刷新**（没有 refresh_token 这一说）。
 *
 * 这个模块的四条纪律：
 *
 * 1. **客户端密钥与访问令牌永不进日志 / 事件 / 响应体。** 事件里只有店铺域名、
 *    连接 id 与到期时间；换令牌失败时只回一个原因码与我们自己写的中文，
 *    上游的原文只在 `detail` 里，且 `detail` 先经 {@link scrub} 抹掉任何疑似令牌的串。
 * 2. **密钥只在本机 AES-256-GCM 秘密库里**（`secret-store.ts`，与邮箱口令同一库、
 *    不同 key 前缀）。换令牌时读一次、用一次，出作用域即结束。
 * 3. **令牌不落我们这边**：换到手立刻 `PUT` 进 OpenConnector 的凭据库，本模块
 *    只记 `expires_at`（一个时间戳，不是凭据）。
 * 4. 时间经注入的 `Clock`，网络经注入的 `fetch`——测试全程不联网。
 */
import type { Clock, Iso8601 } from '@agentsws/contracts'

/** 秘密库里 Shopify 应用凭据的 key 前缀（与连接 id、模型 provider 分开）。 */
export const SHOPIFY_APP_PREFIX = 'shopify_app:'

/** 到期前多久就该换一张新的（毫秒）。Shopify 给 24 小时，提前 1 小时换。 */
export const REFRESH_LEAD_MS = 60 * 60 * 1000

/** 换不到令牌时的原因码。界面按它出文案，`detail` 只是补充。 */
export type ShopifyBrokerErrorCode =
  | 'shop_not_permitted'
  | 'invalid_client'
  | 'invalid_shop'
  | 'invalid_grant'
  | 'rate_limited'
  | 'shop_unreachable'
  | 'unexpected_response'
  | 'vault_unavailable'
  | 'not_found'

export class ShopifyBrokerError extends Error {
  readonly code: ShopifyBrokerErrorCode
  readonly detail: string | undefined

  constructor(code: ShopifyBrokerErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'ShopifyBrokerError'
    this.code = code
    this.detail = detail
  }
}

/** 一条已经接管的店：**没有任何凭据字段**，只有身份与到期时间。 */
export interface ShopifyBrokerRecord {
  /** 规范化后的店铺域名（`acme.myshopify.com`），也是秘密库里的 key 后缀。 */
  shop: string
  alias: string
  /** OpenConnector 那边的连接 id。 */
  connection_id: string
  /** 这张令牌什么时候过期（Shopify 给 86399 秒）。 */
  expires_at: Iso8601
  /** 上次换成功的时刻。 */
  refreshed_at: Iso8601
  /** 换到的权限范围（逗号分隔，Shopify 原样回的）；用来提示"权限没勾全"。 */
  scope: string
}

/** 本模块唯一用到的 `fetch` 形状（测试注入）。 */
export type BrokerFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** 秘密库的最小面（`secret-store.ts` 的 `SecretStore` 满足它）。 */
export interface BrokerVault {
  readonly available: boolean
  put(id: string, fields: Record<string, string>): unknown
  get(id: string): Record<string, string> | undefined
  remove(id: string): boolean
}

/** 记录的持久化（由 `connections.ts` 的状态文件提供，和连接元数据同一份）。 */
export interface BrokerRecordStore {
  list(): ShopifyBrokerRecord[]
  put(record: ShopifyBrokerRecord): void
  remove(shop: string): void
}

export interface ShopifyBrokerDeps {
  clock: Clock
  vault: BrokerVault
  records: BrokerRecordStore
  /**
   * 把换到的令牌写进 OpenConnector 的凭据库。
   *
   * **这是令牌唯一的去处**：调用方（`connections.ts`）转发一次 `PUT
   * /api/connections/shopify_admin`，之后谁也不持有它。
   */
  pushToken(input: {
    shop: string
    alias: string
    accessToken: string
  }): Promise<{ connection_id: string; display_name?: string }>
  fetch?: BrokerFetch
  /** 事件汇；payload 里只有店铺域名、连接 id 与到期时间。 */
  appendEvent?: (type: string, payload: Record<string, unknown>) => void
}

export interface ShopifyBroker {
  /** 首次接管一家店：换令牌 → 推进 OpenConnector → 记账。 */
  connect(input: {
    shop: string
    alias: string
    client_id: string
    client_secret: string
  }): Promise<ShopifyBrokerRecord>
  /** 一条连接是不是由本经纪人管的。 */
  recordOf(connection_id: string): ShopifyBrokerRecord | undefined
  /** 到期前 1 小时内的都换一张新的；返回换过的那几条。 */
  refreshDue(): Promise<ShopifyBrokerRecord[]>
  /** 强制换一张（上游 401 时调用）。 */
  refresh(connection_id: string): Promise<ShopifyBrokerRecord>
  /** 断开一家店：秘密库里的应用凭据与本地记录一起删掉。 */
  forget(connection_id: string): void
  list(): ShopifyBrokerRecord[]
}

// ── 店铺域名 ───────────────────────────────────────────────────────────

/**
 * 把用户可能粘进来的各种写法收敛成 `xxx.myshopify.com`。
 *
 * 认这几种：`acme`、`acme.myshopify.com`、`https://acme.myshopify.com/`、
 * `https://admin.shopify.com/store/acme`（新后台的地址栏就是这个样子，
 * 非技术用户最容易直接复制它）。
 */
export function normalizeShopDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\/+$/, '')
  if (trimmed === '') {
    throw new ShopifyBrokerError('invalid_shop', '店铺域名没填')
  }
  const adminMatch = /^(?:https?:\/\/)?admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(
    trimmed,
  )
  const handleFromAdmin = adminMatch?.[1]
  if (handleFromAdmin !== undefined) return `${handleFromAdmin}.myshopify.com`
  const bare = trimmed.replace(/^https?:\/\//, '').split('/')[0] ?? ''
  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(bare)) return bare
  if (/^[a-z0-9][a-z0-9-]*$/.test(bare)) return `${bare}.myshopify.com`
  throw new ShopifyBrokerError(
    'invalid_shop',
    '店铺域名看不懂。填 your-store.myshopify.com，或者直接把后台地址栏那一整串粘进来',
  )
}

// ── 错误映射（上游机器码 → 中文人话）────────────────────────────────

/**
 * Shopify 的 `/admin/oauth/access_token` 出错时回一个 `{ error, error_description }`。
 * 这里把它翻成非技术用户看得懂的一句话——照着这句话就知道下一步该做什么。
 */
export function mapExchangeError(
  status: number,
  body: string,
): { code: ShopifyBrokerErrorCode; message: string } {
  const wire = parseError(body)
  if (wire === 'shop_not_permitted') {
    return {
      code: 'shop_not_permitted',
      message:
        '应用和店铺不在同一个 Dev Dashboard 组织：这个应用没被装到这家店上。' +
        '回 Dev Dashboard 里点 Install app，选中这家店，再回来试一次。',
    }
  }
  if (wire === 'invalid_client' || status === 401) {
    return {
      code: 'invalid_client',
      message:
        '客户端 ID 或密钥不对。回 Dev Dashboard 的应用 Settings 页重新抄一遍——' +
        '密钥容易少复制一位，前后别带空格。',
    }
  }
  if (wire === 'invalid_grant') {
    return {
      code: 'invalid_grant',
      message:
        'Shopify 不接受这种换令牌方式：确认这个应用是在 Dev Dashboard 里建的（自定义分发）。',
    }
  }
  if (status === 404) {
    return {
      code: 'invalid_shop',
      message: '找不到这家店：域名可能写错了，或者这家店已经关了。',
    }
  }
  if (status === 429) {
    return { code: 'rate_limited', message: 'Shopify 说请求太频繁了，等一会儿再点一次。' }
  }
  return {
    code: 'unexpected_response',
    message: `Shopify 拒绝了这次换令牌（HTTP ${status}）。稍后再试一次；一直这样就把这段话截图给我们。`,
  }
}

function parseError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
  } catch {
    // 不是 JSON（Shopify 偶尔回一段 HTML）：按状态码判
  }
  // 有些分支是纯文本 `[API] shop_not_permitted`
  const hit = /(shop_not_permitted|invalid_client|invalid_grant|invalid_request)/.exec(body)
  return hit?.[1]
}

/**
 * 上游原文进 `detail` 之前先抹一遍：任何看起来像令牌 / 密钥的串一律换成 `…`。
 *
 * 这是最后一道保险——正常路径上我们根本不会把带凭据的响应体传进来，
 * 但错误分支太多，宁可在出口再筛一次。
 */
export function scrub(text: string): string {
  return text
    .replace(/shp(at|ca|pa|ss)_[A-Za-z0-9_-]+/g, 'shp**_…')
    .replace(/\b[0-9a-f]{32,}\b/gi, '…')
    .slice(0, 300)
}

// ── 换令牌 ─────────────────────────────────────────────────────────────

export interface ExchangeResult {
  access_token: string
  scope: string
  expires_in: number
}

/**
 * 换一次令牌。**入参里的密钥与返回值里的令牌都不许出这个函数的调用栈以外**。
 */
export async function exchangeClientCredentials(
  input: { shop: string; client_id: string; client_secret: string },
  doFetch: BrokerFetch,
): Promise<ExchangeResult> {
  const url = `https://${input.shop}/admin/oauth/access_token`
  let res: Awaited<ReturnType<BrokerFetch>>
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: input.client_id,
        client_secret: input.client_secret,
        grant_type: 'client_credentials',
      }),
    })
  } catch (e) {
    throw new ShopifyBrokerError(
      'shop_unreachable',
      '连不上 Shopify：检查一下这台电脑的网络，或者店铺域名是不是写错了',
      scrub(e instanceof Error ? e.message : String(e)),
    )
  }
  const body = await res.text().catch(() => '')
  if (!res.ok) {
    const mapped = mapExchangeError(res.status, body)
    throw new ShopifyBrokerError(mapped.code, mapped.message, scrub(body))
  }
  let parsed: { access_token?: unknown; scope?: unknown; expires_in?: unknown }
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    throw new ShopifyBrokerError(
      'unexpected_response',
      'Shopify 回了一段我们看不懂的内容；稍后再试一次',
    )
  }
  const token = parsed.access_token
  if (typeof token !== 'string' || token === '') {
    throw new ShopifyBrokerError('unexpected_response', 'Shopify 没有给出访问令牌')
  }
  const expires = typeof parsed.expires_in === 'number' ? parsed.expires_in : 86_399
  return {
    access_token: token,
    scope: typeof parsed.scope === 'string' ? parsed.scope : '',
    expires_in: expires,
  }
}

// ── 经纪人 ─────────────────────────────────────────────────────────────

export function createShopifyBroker(deps: ShopifyBrokerDeps): ShopifyBroker {
  const doFetch: BrokerFetch = deps.fetch ?? (globalThis.fetch as unknown as BrokerFetch)
  const keyOf = (shop: string): string => `${SHOPIFY_APP_PREFIX}${shop}`

  const emit = (type: string, payload: Record<string, unknown>): void => {
    deps.appendEvent?.(type, payload)
  }

  /** 换一次 + 推一次 + 记一次。凭据只在这个函数体里出现。 */
  const rotate = async (input: {
    shop: string
    alias: string
    client_id: string
    client_secret: string
    connection_id?: string
  }): Promise<ShopifyBrokerRecord> => {
    const issued = await exchangeClientCredentials(
      { shop: input.shop, client_id: input.client_id, client_secret: input.client_secret },
      doFetch,
    )
    const pushed = await deps.pushToken({
      shop: input.shop,
      alias: input.alias,
      accessToken: issued.access_token,
    })
    const now = deps.clock.now()
    const record: ShopifyBrokerRecord = {
      shop: input.shop,
      alias: input.alias,
      connection_id: pushed.connection_id,
      expires_at: new Date(Date.parse(now) + issued.expires_in * 1000).toISOString(),
      refreshed_at: now,
      scope: issued.scope,
    }
    deps.records.put(record)
    // payload 里只有域名 / 连接 id / 到期时间 / 权限范围——没有 ID、密钥、令牌
    emit('connect.shopify_token_issued', {
      shop: record.shop,
      connection_id: record.connection_id,
      expires_at: record.expires_at,
      scope: record.scope,
    })
    return record
  }

  const credentialsOf = (shop: string): { client_id: string; client_secret: string } => {
    const fields = deps.vault.get(keyOf(shop))
    const client_id = fields?.client_id
    const client_secret = fields?.client_secret
    if (client_id === undefined || client_secret === undefined) {
      throw new ShopifyBrokerError(
        'not_found',
        `本机秘密库里没有 ${shop} 的应用凭据；重新填一次客户端 ID 与密钥即可`,
      )
    }
    return { client_id, client_secret }
  }

  return {
    async connect(input) {
      if (!deps.vault.available) {
        throw new ShopifyBrokerError(
          'vault_unavailable',
          '这台机器没有秘密库密钥，客户端密钥无处安全存放；到期后就没法自动换新令牌了',
        )
      }
      const shop = normalizeShopDomain(input.shop)
      const client_id = input.client_id.trim()
      const client_secret = input.client_secret.trim()
      const alias = input.alias.trim() === '' ? 'default' : input.alias.trim()
      // 先换一次：换不到就别把密钥留在本机（用户填错了，存下来只会误导）
      const record = await rotate({ shop, alias, client_id, client_secret })
      deps.vault.put(keyOf(shop), { shop, client_id, client_secret })
      return record
    },

    recordOf(connection_id) {
      return deps.records.list().find((r) => r.connection_id === connection_id)
    },

    async refreshDue() {
      const cutoff = Date.parse(deps.clock.now()) + REFRESH_LEAD_MS
      const out: ShopifyBrokerRecord[] = []
      for (const record of deps.records.list()) {
        if (Date.parse(record.expires_at) > cutoff) continue
        try {
          out.push(await rotate({ ...record, ...credentialsOf(record.shop) }))
        } catch (e) {
          // 一家店换不到不该拖垮别家；界面上那条连接的试连会报出真正的原因
          emit('connect.shopify_token_refresh_failed', {
            shop: record.shop,
            connection_id: record.connection_id,
            reason: e instanceof ShopifyBrokerError ? e.code : 'internal',
          })
        }
      }
      return out
    },

    async refresh(connection_id) {
      const record = deps.records.list().find((r) => r.connection_id === connection_id)
      if (record === undefined) {
        throw new ShopifyBrokerError('not_found', `这条连接不是用客户端凭据接的：${connection_id}`)
      }
      return rotate({ ...record, ...credentialsOf(record.shop) })
    },

    forget(connection_id) {
      const record = deps.records.list().find((r) => r.connection_id === connection_id)
      if (record === undefined) return
      deps.vault.remove(keyOf(record.shop))
      deps.records.remove(record.shop)
    },

    list: () => deps.records.list(),
  }
}
