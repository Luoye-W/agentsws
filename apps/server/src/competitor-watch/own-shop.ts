/**
 * WP393（docs/104 C8）：自家店铺的商品与价（从**已连店铺**读，和竞品对标款比价用）。
 *
 * 走的是店铺管理已有的那条只读口（`ShopAdminAssembly.reader()`：云端一键授权优先、没有才回退本机授权），
 * 只读商品列表里的标题 / handle / 最低价 / 币种 / 品类，不读订单、不读顾客。没连店 = `connected: false`，
 * 方案卡与简报照实说「连上你的店才能比价」。
 */
import type { OwnShopProduct } from '@agentsws/contracts'
import type { ShopAdminAssembly } from '../shop-auth.js'
import { nodes, o, productsDoc } from '../shop-graphql.js'

/** 最多读几页（一页 100 件）。 */
export const OWN_SHOP_MAX_PAGES = 5

export interface OwnShopRead {
  connected: boolean
  products: OwnShopProduct[]
  /** 连着但这次没读成的那一句。 */
  error?: string
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 一个商品节点 → 自家商品（只要上架中的；没有 handle 的不要）。 */
export function ownProductOf(node: Record<string, unknown>): OwnShopProduct | undefined {
  const handle = str(node.handle)
  const title = str(node.title)
  if (handle === undefined || title === undefined) return undefined
  const status = str(node.status)?.toLowerCase()
  if (status !== undefined && status !== 'active') return undefined
  const min = o(o(node.priceRangeV2).minVariantPrice)
  const amount = typeof min.amount === 'string' ? Number(min.amount) : Number.NaN
  const currency = str(min.currencyCode)?.toUpperCase()
  const type = str(node.productType)
  return {
    key: handle,
    title,
    ...(Number.isFinite(amount) && amount > 0 ? { price: Math.round(amount * 100) / 100 } : {}),
    ...(currency === undefined ? {} : { currency }),
    ...(type === undefined ? {} : { product_type: type }),
  }
}

export async function readOwnShopProducts(
  auth: Pick<ShopAdminAssembly, 'access' | 'reader'> | undefined,
): Promise<OwnShopRead> {
  if (auth === undefined) return { connected: false, products: [] }
  const access = await auth.access().catch(() => undefined)
  if (access === undefined) return { connected: false, products: [] }
  try {
    const reader = await auth.reader()
    const products: OwnShopProduct[] = []
    let after: string | undefined
    for (let page = 0; page < OWN_SHOP_MAX_PAGES; page += 1) {
      const data = o(
        await reader.query({
          name: 'products',
          document: productsDoc(false),
          variables: { first: 100, ...(after === undefined ? {} : { after }) },
        }),
      )
      for (const n of nodes(data.products)) {
        const p = ownProductOf(n)
        if (p !== undefined) products.push(p)
      }
      const info = o(o(data.products).pageInfo)
      after = info.hasNextPage === true ? str(info.endCursor) : undefined
      if (after === undefined) break
    }
    return { connected: true, products }
  } catch (e) {
    return {
      connected: true,
      products: [],
      error: `你的店这次没读到：${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
    }
  }
}
