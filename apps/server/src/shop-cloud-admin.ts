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
} from './shop-admin.js'
import type { ShopAccess, ShopAdminAssembly } from './shop-auth.js'
import type { CloudShopLink } from './shopify-connect.js'

export interface CloudShopifyAdminOptions {
  store: string
  call: KolCloudCallFn
  timeoutMs?: number
  onAuthProblem?(err: ShopAdminError): void
}

/** 云上那一跳没成 → 与 CLI 版同一套码。 */
function errorOf(out: KolCloudCall<unknown>): ShopAdminError {
  if (out.status === 0) return new ShopAdminError('network', SHOP_ADMIN_TEXT.network)
  const text = `${out.message ?? ''} ${JSON.stringify(out.details ?? {})}`
  const missing = requiredScopesOf(text)
  if (missing.length > 0)
    return new ShopAdminError(
      'missing_scope',
      `${SHOP_ADMIN_TEXT.missing_scope}（缺：${missing.join('、')}）`,
      { missing },
    )
  if (out.status === 401 || out.status === 403)
    // 工作区令牌被撤 / 缺 store：与「没授权」一样要人去连接页
    return new ShopAdminError(
      'not_authorized',
      '店铺的一键授权现在用不了：到「连接」页 Shopify 卡上重新登录或重新授权。',
    )
  if (out.status === 404)
    return new ShopAdminError('not_authorized', '这家店还没在「连接」页一键授权。')
  if (out.status === 409 || out.details?.reason === 'reauth_required')
    return new ShopAdminError('revoked', SHOP_ADMIN_TEXT.revoked)
  if (out.status === 402)
    return new ShopAdminError('store_unavailable', SHOP_ADMIN_TEXT.store_unavailable)
  if (out.status === 504) return new ShopAdminError('timeout', SHOP_ADMIN_TEXT.timeout)
  if (out.status === 400 || out.status === 422)
    return new ShopAdminError(
      'graphql',
      `${SHOP_ADMIN_TEXT.graphql}${out.message === undefined ? '' : `（${out.message}）`}`,
    )
  return new ShopAdminError('failed', out.message ?? SHOP_ADMIN_TEXT.failed)
}

/** GraphQL 回包：`{ data, errors? }`（云上原样转回）→ `data` 那一层（与 CLI 版 `--output-file` 同一层）。 */
function dataOf<T>(raw: unknown): T {
  if (raw !== null && typeof raw === 'object') {
    const r = raw as { data?: unknown; errors?: unknown }
    if (Array.isArray(r.errors) && r.errors.length > 0) {
      const text = JSON.stringify(r.errors)
      const missing = requiredScopesOf(text)
      if (missing.length > 0 || /ACCESS_DENIED/.test(text))
        throw new ShopAdminError(
          'missing_scope',
          missing.length > 0
            ? `${SHOP_ADMIN_TEXT.missing_scope}（缺：${missing.join('、')}）`
            : SHOP_ADMIN_TEXT.missing_scope,
          { missing },
        )
      const first = (r.errors[0] as { message?: unknown }).message
      throw new ShopAdminError(
        'graphql',
        `${SHOP_ADMIN_TEXT.graphql}${typeof first === 'string' ? `（${first.slice(0, 300)}）` : ''}`,
      )
    }
    if ('data' in r && r.data !== null && typeof r.data === 'object') return r.data as T
  }
  return raw as T
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
      const err = errorOf(out)
      if (AUTH_PROBLEM_CODES.has(err.code)) options.onAuthProblem?.(err)
      throw err
    }
    try {
      return dataOf<T>(out.data)
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
