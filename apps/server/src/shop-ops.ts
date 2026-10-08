/**
 * WP261（决策 175 第 1 步）：**独立站运营**的服务端那一半（一个品牌一份）——查询、出卡、批了之后执行并读回。
 *
 * 三条纪律：
 *
 * 1. **AI 只拿得到固定的那几样**（`@agentsws/stand-ins` 的 `runtime/shop.ts`）：查询走 `ShopifyAdmin.query`
 *    （文档是 `shop-graphql.ts` 里写死的，CLI 不带 `--allow-mutations`）；**改动只出卡**——{@link ShopOps.propose}
 *    只经变更账本 `ledger.stage`，一个字节都不碰店铺。
 * 2. **店铺只有一条路会变**：人批过的卡 → 执行器 `backendApply` → {@link ShopOps.apply} → `ShopifyAdmin.mutate`
 *    （带 `--allow-mutations`）→ **读回确认**：读回来对不上记 `unknown`（「改了但没核对上」），不说「好了」。
 * 3. **改前必读、改时核对**：改商品 / 合集 / 页面 / 菜单之前这次运行必须读过它（`read_full`，guardrail 也按这条拦）；
 *    执行前再读一次，卡上写的「原来」与店里现在的对不上（有人在后台改过）就不改、照实说。
 *
 * 删除类不做：要「下架 / 归档」用改状态。
 */
import type { EffectiveConfig, Mandate, ObjectRef, RunRequest } from '@agentsws/contracts'
import { SHOP_TOOLS_BY_ROLE } from '@agentsws/stand-ins'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type { ShopAdminError, ShopifyAdmin, ShopifyAdminReader } from './shop-admin.js'
import type { ShopAccess } from './shop-auth.js'
import {
  arr,
  COLLECTION,
  COLLECTIONS,
  collectionOut,
  collectionRow,
  DISCOUNTS,
  discountOut,
  MENUS,
  menuItemsOut,
  menuOut,
  nodes,
  o,
  orderOut,
  PAGE,
  PAGES,
  PRODUCT_BY_HANDLE,
  pageOut,
  pageRow,
  productDoc,
  productOut,
  productRow,
  productsDoc,
  RECENT_ORDERS,
  s,
} from './shop-graphql.js'

export type ShopOp =
  | 'product_create'
  | 'product_update'
  | 'variant_price'
  | 'product_status'
  | 'product_images'
  | 'collection_create'
  | 'collection_update'
  | 'page_create'
  | 'page_update'
  | 'menu_create'
  | 'menu_update'
  | 'discount_create'

/** 卡上 `after.via` 写这个，执行器才认（别的来路的同一类卡不归这里）。 */
export const SHOP_VIA = 'shop_admin'

export class ShopOpsError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'not_allowed' | 'must_read_first',
    message: string,
  ) {
    super(message)
    this.name = 'ShopOpsError'
  }
}

export interface ShopOpsOptions {
  workspace_id: string
  clock: { now(): string }
  access(): Promise<ShopAccess | undefined>
  reader(): Promise<ShopifyAdminReader>
  admin(): Promise<ShopifyAdmin>
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  effectiveConfig(assignment_id: string): EffectiveConfig
  /** 谁批（按 yml 的 `route_to`）；不给 = 提的人自己（role_holder）或老板（别的都按老板）。 */
  recipient?(input: {
    route_to: string
    role_id: string
    person_id: string
  }): Promise<{ person: string; via: 'role_holder' | 'scope_manager' | 'owner' }>
  /** 本机图片只许从这几个目录里拿（本品牌的文件夹）。 */
  fileRoots(): string[]
  /** 已经执行过的卡记在哪（防同一张卡重放两次）；不给 = 只在内存里。 */
  stateFile?: string
  /** 传本机图片到 Shopify 给的临时地址（测试注入）。 */
  fetch?: typeof fetch
  appendEvent?(type: string, payload: Record<string, unknown>): void
}

/** 每条职责的每个改动工具落到 yml 里哪一条动作（kind = 去掉 `stage_` 的那一段）。 */
const ACTION_OF: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'dtc.store': {
    shop_save_product: 'stage_listing_edit',
    shop_set_price: 'stage_price_change',
    shop_add_product_images: 'stage_listing_edit',
    shop_save_collection: 'stage_collection_edit',
    shop_save_page: 'stage_listing_edit',
    shop_save_menu: 'stage_listing_edit',
    shop_create_discount: 'stage_discount_code',
  },
  'site.shopify-build': {
    shop_save_page: 'stage_store_setup',
    shop_save_menu: 'stage_store_setup',
  },
}

export interface ShopOps {
  read(tool: string, input: Record<string, unknown>, request: RunRequest): Promise<unknown>
  propose(
    tool: string,
    input: Record<string, unknown>,
    request: RunRequest,
  ): Promise<{
    status: 'staged' | 'blocked'
    message: string
    change_id?: string
    approval_item_id?: string
  }>
  apply(
    change: import('@agentsws/contracts').StagedChange,
  ): Promise<import('@agentsws/txn').BackendResult | undefined>
}

// ── 输入 ─────────────────────────────────────────────────────────────────

export const str = (v: unknown, max = 255): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t === '') return undefined
  if (t.length > max) throw new ShopOpsError('invalid_input', `太长了（最多 ${max} 个字）`)
  return t
}
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined
const first = (v: unknown, dflt = 20): number => {
  const n = Math.floor(num(v) ?? dflt)
  return Math.min(50, Math.max(1, n))
}

/** `123` / `gid://shopify/Product/123` → gid；别的形状不认。 */
export function gidOf(type: string, raw: unknown): string | undefined {
  const t = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (/^\d{1,20}$/.test(t)) return `gid://shopify/${type}/${t}`
  const m = new RegExp(`^gid://shopify/${type}/(\\d{1,20})$`).exec(t)
  return m === null ? undefined : t
}

export function idList(type: string, v: unknown, max = 50): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new ShopOpsError('invalid_input', '商品 id 要给一个列表')
  const out = v.map((x) => gidOf(type, x))
  if (out.some((x) => x === undefined))
    throw new ShopOpsError('invalid_input', `有一个不是${type} id`)
  if (out.length > max) throw new ShopOpsError('invalid_input', `一次最多 ${max} 个`)
  return [...new Set(out as string[])]
}

// ── 查询 ─────────────────────────────────────────────────────────────────

/** 这次运行读过全文的东西（`product:gid…`），出卡时证明「改前读过」。 */
class ReadLog {
  private runs = new Map<string, Set<string>>()
  mark(run_id: string, ref: ObjectRef): void {
    let set = this.runs.get(run_id)
    if (set === undefined) {
      set = new Set()
      this.runs.set(run_id, set)
      if (this.runs.size > 200) this.runs.delete(this.runs.keys().next().value as string)
    }
    set.add(`${ref.type}:${ref.id}`)
  }
  has(run_id: string, ref: ObjectRef): boolean {
    return this.runs.get(run_id)?.has(`${ref.type}:${ref.id}`) === true
  }
}

export interface ShopReadContext {
  reader: ShopifyAdminReader
  access: ShopAccess
  log: ReadLog
}

export async function readProduct(reader: ShopifyAdminReader, access: ShopAccess, id: string) {
  const inventory = access.scopes.includes('read_inventory')
  const data = o(
    await reader.query({ name: 'product', document: productDoc(inventory), variables: { id } }),
  )
  const p = o(data.product)
  if (p.id === undefined) throw new ShopOpsError('not_found', '店里找不到这件商品')
  return p
}

export async function readCollection(reader: ShopifyAdminReader, id: string) {
  const c = o(
    o(await reader.query({ name: 'collection', document: COLLECTION, variables: { id } }))
      .collection,
  )
  if (c.id === undefined) throw new ShopOpsError('not_found', '店里找不到这个合集')
  return c
}

export async function readPage(reader: ShopifyAdminReader, id: string) {
  const p = o(o(await reader.query({ name: 'page', document: PAGE, variables: { id } })).page)
  if (p.id === undefined) throw new ShopOpsError('not_found', '店里找不到这个页面')
  return p
}

export async function readMenus(reader: ShopifyAdminReader) {
  return nodes(o(await reader.query({ name: 'menus', document: MENUS })).menus)
}

async function runRead(
  ctx: ShopReadContext,
  tool: string,
  input: Record<string, unknown>,
  run_id: string,
): Promise<unknown> {
  const { reader, access, log } = ctx
  const query = str(input.query, 200)
  switch (tool) {
    case 'shop_list_products': {
      const inventory = access.scopes.includes('read_inventory')
      const after = str(input.after, 400)
      const data = o(
        await reader.query({
          name: 'products',
          document: productsDoc(inventory),
          variables: {
            first: first(input.first),
            ...(after === undefined ? {} : { after }),
            ...(query === undefined ? {} : { query }),
          },
        }),
      )
      const page = o(o(data.products).pageInfo)
      return {
        products: nodes(data.products).map(productRow),
        ...(page.hasNextPage === true && s(page.endCursor) !== undefined
          ? { next_cursor: s(page.endCursor) }
          : {}),
      }
    }
    case 'shop_get_product': {
      let id = gidOf('Product', input.id)
      const handle = str(input.handle, 255)
      if (id === undefined && handle !== undefined) {
        const hit = nodes(
          o(
            await reader.query({
              name: 'product_by_handle',
              document: PRODUCT_BY_HANDLE,
              variables: { query: `handle:'${handle.replace(/'/g, '')}'` },
            }),
          ).products,
        )[0]
        id = s(hit?.id)
      }
      if (id === undefined) throw new ShopOpsError('invalid_input', '要给商品 id 或 handle')
      const p = await readProduct(reader, access, id)
      log.mark(run_id, { type: 'product', id })
      return productOut(p)
    }
    case 'shop_list_collections': {
      const data = o(
        await reader.query({
          name: 'collections',
          document: COLLECTIONS,
          variables: { first: first(input.first), ...(query === undefined ? {} : { query }) },
        }),
      )
      return { collections: nodes(data.collections).map(collectionRow) }
    }
    case 'shop_get_collection': {
      const id = gidOf('Collection', input.id)
      if (id === undefined) throw new ShopOpsError('invalid_input', '要给合集 id')
      const c = await readCollection(reader, id)
      log.mark(run_id, { type: 'collection', id })
      return collectionOut(c)
    }
    case 'shop_list_pages': {
      const data = o(
        await reader.query({
          name: 'pages',
          document: PAGES,
          variables: { first: first(input.first), ...(query === undefined ? {} : { query }) },
        }),
      )
      return { pages: nodes(data.pages).map(pageRow) }
    }
    case 'shop_get_page': {
      const id = gidOf('Page', input.id)
      if (id === undefined) throw new ShopOpsError('invalid_input', '要给页面 id')
      const p = await readPage(reader, id)
      log.mark(run_id, { type: 'page', id })
      return pageOut(p)
    }
    case 'shop_list_menus': {
      const menus = await readMenus(reader)
      for (const m of menus) {
        const id = s(m.id)
        if (id !== undefined) log.mark(run_id, { type: 'menu', id })
      }
      return { menus: menus.map(menuOut) }
    }
    case 'shop_list_discounts': {
      const data = o(
        await reader.query({
          name: 'discounts',
          document: DISCOUNTS,
          variables: { first: first(input.first), ...(query === undefined ? {} : { query }) },
        }),
      )
      return { discounts: nodes(data.discountNodes).map(discountOut) }
    }
    case 'shop_recent_orders': {
      const data = o(
        await reader.query({
          name: 'orders',
          document: RECENT_ORDERS,
          variables: { first: first(input.first) },
        }),
      )
      return { orders: nodes(data.orders).map(orderOut) }
    }
    default:
      throw new ShopOpsError('not_allowed', `不认识的查询：${tool}`)
  }
}

export { arr, menuItemsOut }

/** 执行器 / 工具共用：这一类错误是不是「授权有问题」（工具回 `needs: authorize`）。 */
export const isAdminError = (e: unknown): e is ShopAdminError =>
  e instanceof Error && e.name === 'ShopAdminError'

/** 这条职责能不能用这个工具（职责表 × 授权里的权限，见 `shopToolsFor`）。 */
export function roleHasTool(role_id: string, tool: string): boolean {
  return (SHOP_TOOLS_BY_ROLE[role_id] ?? []).includes(tool)
}

export function actionFor(
  role_id: string,
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  if (tool === 'shop_set_product_status')
    return role_id === 'dtc.store'
      ? input.status === 'active'
        ? 'stage_publish_product'
        : 'stage_unpublish_product'
      : undefined
  return ACTION_OF[role_id]?.[tool]
}

export interface MandateOf {
  mandate: Mandate
  level: 'L1' | 'L2' | 'L3'
  route_to: string
}

export function mandateOf(config: () => EffectiveConfig, action: string): MandateOf | undefined {
  try {
    const c = config()
    const spec = c.actions.find((a) => a.id === action)
    if (spec === undefined) return undefined
    const route = spec.route_to as unknown
    return {
      mandate: spec.mandate ?? { caps: {} },
      level: c.automation[action]?.level ?? 'L1',
      route_to: typeof route === 'string' ? route : 'role_holder',
    }
  } catch {
    return undefined
  }
}

export { ReadLog, runRead }
