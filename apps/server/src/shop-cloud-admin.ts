/**
 * WP265（Fable 追加，接 WP261）：`ShopifyAdmin` 的第二种实现——**云端代发**（私有云 WP263 的 `POST /v1/shopify/graphql`）。
 *
 * - 查询不带 `allow_mutations`；改动（只有执行器——人批过的卡——拿得到 {@link ShopifyAdmin.mutate}）带 `allow_mutations: true`；
 *   文档是 mutation 却走查询那一半：本机先拒（与 CLI 版同一道闸）。
 * - 店铺令牌只在云上（决策 185）；这里只拿这个品牌的工作区令牌开口。
 * - 错误翻成 {@link ShopAdminError} 的同一套码与人话（工具回话、岗位页那一行不用改）。
 *
 * {@link preferCloudShopAdmin}：这个品牌有云端一键授权的连接（`connected`）时**优先用云端**，没有才回退 CLI 授权（WP261）。
 */
import type { ShopAdminView } from '@agentsws/api'
import { expandStoreScopes, SHOPIFY_CLOUD_PATHS } from '@agentsws/contracts'
import type { KolCloudCall, KolCloudCallFn } from './kol-cloud-sync.js'
import {
  type AdminOperation,
  AUTH_PROBLEM_CODES,
  isMutationDocument,
  requiredScopesOf,
  SHOP_ADMIN_TEXT,
  ShopAdminError,
  type ShopifyAdmin,
  type ShopifyAdminReader,
} from './shop-admin.js'
import type { ShopAccess, ShopAdminAssembly } from './shop-auth.js'
import type { CloudShopLink } from './shopify-connect.js'

export interface CloudShopifyAdminOptions {
  store: string
  call: KolCloudCallFn
  timeoutMs?: number
  onAuthProblem?(err: ShopAdminError): void
}

/**
 * WP267：云端那一路的人话。分两头说——**我们这头**（Agents 工坊账号的令牌：缺 `store`、被撤）与
 * **Shopify 那头**（店铺授权失效、权限不够、限流、出错）——前者（WP272：缺动作集平时后台自动补签）去「设置 → 账号」重新登录，
 * 后者去连接页「重新授权」或等一会儿。混成一句「重新登录」用户会白登一次。
 */
export const CLOUD_SHOP_TEXT = {
  /** 我们的工作区令牌缺 `store`（云上 403 `details.required_scope`）。 */
  /** WP272：平时后台自动补签、用户无感；走到这句 = 自动补签也没成（云上没这一条 / 令牌被撤）。 */
  scope_store:
    'Agents 工坊账号需要重新登录一次：到「设置 → 账号」登录（不是 Shopify 账号），再让我接着做。',
  /** 我们的工作区令牌被撤 / 过期（云上 401）。 */
  token:
    'Agents 工坊账号需要重新登录一次：到「设置 → 账号」登录（不是 Shopify 账号），再让我接着做。',
  not_connected: '这家店还没在「连接」页一键授权。',
  revoked:
    '店铺那头的授权失效了（可能卸载了应用或换了店主账号）：到「连接」页 Shopify 卡上点「重新授权」。',
  missing_scope:
    'Shopify 说店铺授权里少了这件事要的权限：到「连接」页 Shopify 卡上点「重新授权」补上。',
  rate_limited: 'Shopify 那头说请求太多，过一会儿再试。',
  shopify_down: 'Shopify 那头这会儿出错了，稍后再试。',
} as const

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Shopify 回的 `errors`（数组 / 对象 / 一句话）里第一句人能看的原话。 */
function firstError(errors: unknown): string | undefined {
  if (typeof errors === 'string') return errors.slice(0, 300)
  if (Array.isArray(errors)) {
    const m = isRecord(errors[0]) ? errors[0].message : errors[0]
    return typeof m === 'string' ? m.slice(0, 300) : undefined
  }
  if (isRecord(errors)) {
    const v = Object.values(errors)[0]
    return typeof v === 'string' ? v.slice(0, 300) : Array.isArray(v) ? firstError(v) : undefined
  }
  return undefined
}

const missingText = (missing: readonly string[]): string =>
  missing.length > 0
    ? `${CLOUD_SHOP_TEXT.missing_scope}（缺：${missing.join('、')}）`
    : CLOUD_SHOP_TEXT.missing_scope

/**
 * 云上那一跳没成 → 与 CLI 版同一套码（WP266 的回包：Shopify 非 2xx 是 `{ code: 'shopify_error' | 'rate_limited',
 * details: { shop, shopify_status, errors? } }`；我们自己的令牌问题是 401 / 403 `details.required_scope`）。
 */
export function cloudShopErrorOf(out: KolCloudCall<unknown>): ShopAdminError {
  if (out.status === 0) return new ShopAdminError('network', SHOP_ADMIN_TEXT.network)
  const details = out.details ?? {}
  const shopifyStatus =
    typeof details.shopify_status === 'number' ? details.shopify_status : undefined
  const fromShopify =
    out.code === 'shopify_error' || out.code === 'rate_limited' || shopifyStatus !== undefined
  if (fromShopify) {
    // Shopify 那头：先看它的原话里缺哪项权限
    const text = `${out.message ?? ''} ${JSON.stringify(details.errors ?? '')}`
    const missing = requiredScopesOf(text)
    const st = shopifyStatus ?? out.status
    if (missing.length > 0 || /ACCESS_DENIED|Access denied/i.test(text) || st === 403)
      return new ShopAdminError('missing_scope', missingText(missing), { missing })
    if (st === 401) return new ShopAdminError('revoked', CLOUD_SHOP_TEXT.revoked)
    if (st === 402 || st === 423)
      return new ShopAdminError('store_unavailable', SHOP_ADMIN_TEXT.store_unavailable)
    if (out.code === 'rate_limited' || st === 429)
      return new ShopAdminError('failed', CLOUD_SHOP_TEXT.rate_limited)
    if (st >= 500) return new ShopAdminError('failed', CLOUD_SHOP_TEXT.shopify_down)
    const said = firstError(details.errors) ?? out.message
    return new ShopAdminError(
      'graphql',
      `${SHOP_ADMIN_TEXT.graphql}${said === undefined ? '' : `（${said}）`}`,
    )
  }
  // 我们这头（Agents 工坊云）：令牌缺动作集 / 被撤
  if (out.status === 403 && typeof details.required_scope === 'string')
    return new ShopAdminError(
      'not_authorized',
      details.required_scope === 'store' ? CLOUD_SHOP_TEXT.scope_store : CLOUD_SHOP_TEXT.token,
    )
  if (out.status === 401) return new ShopAdminError('not_authorized', CLOUD_SHOP_TEXT.token)
  if (out.status === 409 || details.reason === 'reauth_required')
    return new ShopAdminError('revoked', CLOUD_SHOP_TEXT.revoked)
  if (out.status === 404) return new ShopAdminError('not_authorized', CLOUD_SHOP_TEXT.not_connected)
  if (out.status === 403) return new ShopAdminError('not_authorized', CLOUD_SHOP_TEXT.token)
  if (out.status === 504) return new ShopAdminError('timeout', SHOP_ADMIN_TEXT.timeout)
  if (out.status === 400 || out.status === 422)
    return new ShopAdminError(
      'graphql',
      `${SHOP_ADMIN_TEXT.graphql}${out.message === undefined ? '' : `（${out.message}）`}`,
    )
  return new ShopAdminError('failed', out.message ?? SHOP_ADMIN_TEXT.failed)
}

/**
 * 成功的回包（WP266：`{ data: <Shopify 原样 { data, errors? }> }`，本机 `call` 已经剥掉外层）→ Shopify 的 `data`
 * （与 CLI 版 `--output-file` 同一层）。`errors` 非空：缺权限认出来，别的照 Shopify 原话报；`data: null` 不当结果。
 * 老云不套这一层（直接是 Shopify 的 `data`）时原样用。
 */
export function cloudShopDataOf<T>(raw: unknown): T {
  if (!isRecord(raw) || !('data' in raw || 'errors' in raw)) return raw as T
  const errors = raw.errors
  const hasErrors =
    (Array.isArray(errors) && errors.length > 0) ||
    (isRecord(errors) && Object.keys(errors).length > 0) ||
    (typeof errors === 'string' && errors !== '')
  if (hasErrors) {
    const text = JSON.stringify(errors)
    const missing = requiredScopesOf(text)
    if (missing.length > 0 || /ACCESS_DENIED/.test(text))
      throw new ShopAdminError('missing_scope', missingText(missing), { missing })
    const first = firstError(errors)
    throw new ShopAdminError(
      'graphql',
      `${SHOP_ADMIN_TEXT.graphql}${first === undefined ? '' : `（${first}）`}`,
    )
  }
  if (!isRecord(raw.data))
    throw new ShopAdminError('graphql', `${SHOP_ADMIN_TEXT.graphql}（Shopify 没回数据）`)
  return raw.data as T
}

export function createCloudShopifyAdmin(options: CloudShopifyAdminOptions): ShopifyAdmin {
  const exec = async <T>(op: AdminOperation, mutation: boolean): Promise<T> => {
    const isMutation = isMutationDocument(op.document)
    if (isMutation && !mutation)
      throw new ShopAdminError('mutation_refused', SHOP_ADMIN_TEXT.mutation_refused)
    const out = await options.call<unknown>(SHOPIFY_CLOUD_PATHS.graphql, {
      method: 'POST',
      body: {
        shop: options.store,
        query: op.document,
        ...(op.variables === undefined ? {} : { variables: op.variables }),
        ...(isMutation ? { allow_mutations: true } : {}),
      },
      timeout_ms: options.timeoutMs ?? 60_000,
    })
    if (!out.ok) {
      const err = cloudShopErrorOf(out)
      if (AUTH_PROBLEM_CODES.has(err.code)) options.onAuthProblem?.(err)
      throw err
    }
    try {
      return cloudShopDataOf<T>(out.data)
    } catch (err) {
      if (err instanceof ShopAdminError && AUTH_PROBLEM_CODES.has(err.code))
        options.onAuthProblem?.(err)
      throw err
    }
  }
  return {
    via: 'cloud_app',
    store: options.store,
    query: (op) => exec(op, false),
    mutate: (op) => exec(op, true),
  }
}

export interface PreferCloudOptions {
  /** 这个品牌现在的云端连接（`connected` 的那一条；没有 / 要重新授权 = undefined）。 */
  link(): Promise<CloudShopLink | undefined>
  call(): Promise<KolCloudCallFn | undefined>
  /** 云端撞上授权问题（失效 / 缺权限）：让缓存作废，下一次重新问云。 */
  onAuthProblem?(err: ShopAdminError): void
}

/**
 * 有云端连接就用云端（查询 / 改动 / 能做什么 / 岗位页那一行都按云端那一条），没有才用 CLI 授权那一份。
 * 「授权 / 安装 / 取消 / 改店」这几个动作仍是 CLI 那一套（云端的授权在连接页 Shopify 卡上做）。
 */
export function preferCloudShopAdmin(
  cli: ShopAdminAssembly,
  options: PreferCloudOptions,
): ShopAdminAssembly {
  const cloudAdmin = async (): Promise<ShopifyAdmin | undefined> => {
    const link = await options.link()
    if (link === undefined) return undefined
    const call = await options.call()
    if (call === undefined) return undefined
    return createCloudShopifyAdmin({
      store: link.shop,
      call,
      ...(options.onAuthProblem === undefined ? {} : { onAuthProblem: options.onAuthProblem }),
    })
  }
  const overlay = async (v: ShopAdminView): Promise<ShopAdminView> => {
    if (!v.applicable) return v
    const link = await options.link()
    if (link === undefined) return v
    const granted = expandStoreScopes(link.scopes)
    const missing = v.scopes_needed.filter(
      (x) => !expandStoreScopes([x]).every((y) => granted.includes(y)),
    )
    const {
      job: _job,
      problem: _problem,
      expires_at: _e,
      refreshable: _r,
      authorized_at: _a,
      ...rest
    } = v
    return {
      ...rest,
      store: link.shop,
      scopes_granted: granted,
      missing,
      state: missing.length > 0 ? 'missing_scopes' : 'authorized',
      refreshable: true,
      via: 'cloud',
    }
  }
  return {
    view: async (roles) => overlay(await cli.view(roles)),
    run: async (action, roles) => overlay(await cli.run(action, roles)),
    cancel: async (roles) => overlay(await cli.cancel(roles)),
    setStore: async (raw, roles) => overlay(await cli.setStore(raw, roles)),
    async access(): Promise<ShopAccess | undefined> {
      const link = await options.link()
      if (link !== undefined) return { store: link.shop, scopes: expandStoreScopes(link.scopes) }
      return cli.access()
    },
    async reader() {
      const a = await cloudAdmin()
      if (a === undefined) return cli.reader()
      return { via: a.via, store: a.store, query: a.query }
    },
    async admin() {
      return (await cloudAdmin()) ?? cli.admin()
    },
  }
}

/**
 * WP267（决策 209）：只要云端那一路的只读口（客服回信 / 订单查询用）——这个品牌云端连着店、并且授了
 * `need` 里那几项权限才回；否则 `undefined`，调用方照旧走连接器那条 Shopify 连接。**不回退 CLI 授权**：
 * 订单那一路以前就不走 CLI。
 */
export async function cloudShopReader(
  options: PreferCloudOptions,
  need: readonly string[] = [],
): Promise<ShopifyAdminReader | undefined> {
  const link = await options.link()
  if (link === undefined) return undefined
  const granted = expandStoreScopes(link.scopes)
  if (!need.every((x) => granted.includes(x))) return undefined
  const call = await options.call()
  if (call === undefined) return undefined
  const admin = createCloudShopifyAdmin({
    store: link.shop,
    call,
    ...(options.onAuthProblem === undefined ? {} : { onAuthProblem: options.onAuthProblem }),
  })
  return { via: admin.via, store: admin.store, query: admin.query }
}
