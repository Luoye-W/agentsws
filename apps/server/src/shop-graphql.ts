/**
 * WP261：独立站运营工具底下那几条**写死的** Admin GraphQL（接口版本见 `PlatformStoreAdminSpec.api_version`）。
 *
 * 全在这一个文件里：真机首测撞上字段改名时只改这里。每条都有自己的操作名（`Agentsws…`），事件与假 CLI 按它认。
 * 回给模型的形状由 {@link productOut} 这些函数收窄：只留运营要看的字段，没有顾客个人信息（订单只有单号、金额、状态）。
 */

const PRODUCT_ROW = (inventory: boolean) => `
      id title handle status productType vendor updatedAt${inventory ? ' totalInventory' : ''}
      priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
      featuredMedia { preview { image { url } } }
      variantsCount { count }`

export const productsDoc = (
  inventory: boolean,
): string => `query AgentswsProducts($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {${PRODUCT_ROW(inventory)}
    }
  }
}`

export const productDoc = (inventory: boolean): string => `query AgentswsProduct($id: ID!) {
  product(id: $id) {
    id title handle status descriptionHtml productType vendor tags updatedAt onlineStoreUrl${inventory ? ' totalInventory' : ''}
    options { name values }
    variants(first: 100) { nodes { id title sku price compareAtPrice${inventory ? ' inventoryQuantity' : ''} selectedOptions { name value } } }
    media(first: 50) { nodes { id alt mediaContentType status preview { image { url } } } }
    collections(first: 20) { nodes { id title } }
  }
}`

export const PRODUCT_BY_HANDLE = `query AgentswsProductByHandle($query: String!) {
  products(first: 1, query: $query) { nodes { id } }
}`

export const COLLECTIONS = `query AgentswsCollections($first: Int!, $query: String) {
  collections(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes { id title handle updatedAt productsCount { count } ruleSet { appliedDisjunctively } }
  }
}`

export const COLLECTION = `query AgentswsCollection($id: ID!) {
  collection(id: $id) {
    id title handle descriptionHtml updatedAt productsCount { count } ruleSet { appliedDisjunctively }
    products(first: 50) { nodes { id title handle status } }
  }
}`

export const PAGES = `query AgentswsPages($first: Int!, $query: String) {
  pages(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes { id title handle isPublished updatedAt bodySummary }
  }
}`

export const PAGE = `query AgentswsPage($id: ID!) {
  page(id: $id) { id title handle body isPublished publishedAt updatedAt }
}`

const MENU_ITEM_FIELDS = 'id title type url resourceId'
export const MENUS = `query AgentswsMenus {
  menus(first: 25) {
    nodes { id title handle isDefault
      items { ${MENU_ITEM_FIELDS} items { ${MENU_ITEM_FIELDS} items { ${MENU_ITEM_FIELDS} } } }
    }
  }
}`

const CODE_FIELDS =
  'title status summary startsAt endsAt usageLimit asyncUsageCount codes(first: 3) { nodes { code } }'
const AUTO_FIELDS = 'title status summary startsAt endsAt'
export const DISCOUNTS = `query AgentswsDiscounts($first: Int!, $query: String) {
  discountNodes(first: $first, query: $query, reverse: true) {
    nodes { id discount { __typename
      ... on DiscountCodeBasic { ${CODE_FIELDS} }
      ... on DiscountCodeBxgy { ${CODE_FIELDS} }
      ... on DiscountCodeFreeShipping { ${CODE_FIELDS} }
      ... on DiscountAutomaticBasic { ${AUTO_FIELDS} }
      ... on DiscountAutomaticBxgy { ${AUTO_FIELDS} }
      ... on DiscountAutomaticFreeShipping { ${AUTO_FIELDS} }
    } }
  }
}`

export const DISCOUNT_BY_CODE = `query AgentswsDiscountByCode($code: String!) {
  codeDiscountNodeByCode(code: $code) { id codeDiscount { __typename ... on DiscountCodeBasic { title status startsAt endsAt usageLimit } } }
}`

export const RECENT_ORDERS = `query AgentswsRecentOrders($first: Int!) {
  orders(first: $first, sortKey: CREATED_AT, reverse: true) {
    nodes { id name createdAt displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } } currentSubtotalLineItemsQuantity }
  }
}`

// ── WP267（决策 209）：客服回信 / 订单查询那一路（云端一键授权连着店时走云端代发，只读） ──────────────
//
// 与上面 `RECENT_ORDERS` 不同：客服要回一封具体的信，所以带收件人、收件地址、物流单号、退款与退换状态。
// 顾客那几格（`email` / `customer` / `shippingAddress`）是 Shopify 的「受保护的顾客数据」，应用没过审时整条查询会报错——
// 所以每条都有一份不带它们的 `lite`，报这一类错时退一步再查一次（订单状态、物流照样答得上来）。

const SUPPORT_ORDER_FIELDS = (customer: boolean) => `
      id name createdAt processedAt currencyCode${customer ? ' email' : ''}
      displayFinancialStatus displayFulfillmentStatus returnStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }${
        customer
          ? `
      customer { displayName email }
      shippingAddress { name address1 address2 city province zip country }`
          : ''
      }
      lineItems(first: 50) { nodes { id title sku quantity variant { id } product { id }
        originalUnitPriceSet { shopMoney { amount } } originalTotalSet { shopMoney { amount currencyCode } } } }
      fulfillments(first: 10) { status displayStatus createdAt deliveredAt estimatedDeliveryAt
        trackingInfo(first: 5) { company number url } }
      refunds(first: 10) { createdAt totalRefundedSet { shopMoney { amount currencyCode } } }`

export const supportOrderDoc = (
  customer: boolean,
): string => `query AgentswsSupportOrder($id: ID!) {
  order(id: $id) {${SUPPORT_ORDER_FIELDS(customer)}
  }
}`

export const supportOrdersDoc = (
  customer: boolean,
): string => `query AgentswsSupportOrders($first: Int!, $query: String) {
  orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
    nodes {${SUPPORT_ORDER_FIELDS(customer)}
    }
  }
}`

const SUPPORT_PRODUCT_FIELDS = `
      id title handle status vendor productType
      variants(first: 50) { nodes { id sku title price } }`

export const SUPPORT_PRODUCT = `query AgentswsSupportProduct($id: ID!) {
  product(id: $id) {${SUPPORT_PRODUCT_FIELDS}
  }
}`

export const SUPPORT_PRODUCTS = `query AgentswsSupportProducts($first: Int!, $query: String) {
  products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes {${SUPPORT_PRODUCT_FIELDS}
    }
  }
}`

export const PUBLICATIONS = `query AgentswsPublications {
  publications(first: 20) { nodes { id name } }
}`

// ── 改动（只有执行器跑：人批过的卡） ──────────────────────────────────────

const USER_ERRORS = 'userErrors { field message }'

export const PRODUCT_SET = `mutation AgentswsProductSet($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) { product { id title handle status } ${USER_ERRORS} }
}`

export const PRODUCT_UPDATE = `mutation AgentswsProductUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id } ${USER_ERRORS} }
}`

export const PRODUCT_MEDIA = `mutation AgentswsProductMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) { product { id } ${USER_ERRORS} }
}`

export const VARIANTS_UPDATE = `mutation AgentswsVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price compareAtPrice } ${USER_ERRORS} }
}`

export const PUBLISH = `mutation AgentswsPublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { ${USER_ERRORS} }
}`

export const STAGED_UPLOADS = `mutation AgentswsStagedUploads($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } ${USER_ERRORS} }
}`

export const COLLECTION_CREATE = `mutation AgentswsCollectionCreate($input: CollectionInput!) {
  collectionCreate(input: $input) { collection { id title } ${USER_ERRORS} }
}`

export const COLLECTION_UPDATE = `mutation AgentswsCollectionUpdate($input: CollectionInput!) {
  collectionUpdate(input: $input) { collection { id } ${USER_ERRORS} }
}`

export const COLLECTION_ADD = `mutation AgentswsCollectionAdd($id: ID!, $productIds: [ID!]!) {
  collectionAddProducts(id: $id, productIds: $productIds) { collection { id } ${USER_ERRORS} }
}`

export const COLLECTION_REMOVE = `mutation AgentswsCollectionRemove($id: ID!, $productIds: [ID!]!) {
  collectionRemoveProducts(id: $id, productIds: $productIds) { job { id } ${USER_ERRORS} }
}`

export const PAGE_CREATE = `mutation AgentswsPageCreate($page: PageCreateInput!) {
  pageCreate(page: $page) { page { id title handle } ${USER_ERRORS} }
}`

export const PAGE_UPDATE = `mutation AgentswsPageUpdate($id: ID!, $page: PageUpdateInput!) {
  pageUpdate(id: $id, page: $page) { page { id } ${USER_ERRORS} }
}`

export const MENU_CREATE = `mutation AgentswsMenuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
  menuCreate(title: $title, handle: $handle, items: $items) { menu { id } ${USER_ERRORS} }
}`

export const MENU_UPDATE = `mutation AgentswsMenuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, items: $items) { menu { id } ${USER_ERRORS} }
}`

export const DISCOUNT_CREATE = `mutation AgentswsDiscountCreate($input: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } ${USER_ERRORS} }
}`

// ── 收窄形状 ─────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
export const o = (v: unknown): Obj => (v !== null && typeof v === 'object' ? (v as Obj) : {})
export const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : [])
export const nodes = (v: unknown): Obj[] => arr(o(v).nodes)
export const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const money = (v: unknown): string | undefined => {
  const m = o(v)
  return typeof m.amount === 'string' ? `${m.amount} ${s(m.currencyCode) ?? ''}`.trim() : undefined
}
const clip = (v: unknown, n: number): string | undefined => {
  const t = s(v)
  return t === undefined ? undefined : t.length > n ? `${t.slice(0, n)}…` : t
}

/** 去掉 undefined（回给模型的 JSON 干净一点）。 */
export function compact<T extends Obj>(x: T): T {
  return Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as T
}

export function productRow(p: Obj): Obj {
  const range = o(p.priceRangeV2)
  const min = money(range.minVariantPrice)
  const max = money(range.maxVariantPrice)
  return compact({
    id: s(p.id),
    title: s(p.title),
    handle: s(p.handle),
    status: s(p.status)?.toLowerCase(),
    product_type: s(p.productType) || undefined,
    vendor: s(p.vendor) || undefined,
    price: min === undefined ? undefined : min === max ? min : `${min} – ${max}`,
    inventory: typeof p.totalInventory === 'number' ? p.totalInventory : undefined,
    variants: typeof o(p.variantsCount).count === 'number' ? o(p.variantsCount).count : undefined,
    image: s(o(o(o(p.featuredMedia).preview).image).url),
    updated_at: s(p.updatedAt),
  })
}

export function productOut(p: Obj): Obj {
  return compact({
    id: s(p.id),
    title: s(p.title),
    handle: s(p.handle),
    status: s(p.status)?.toLowerCase(),
    description_html: s(p.descriptionHtml),
    product_type: s(p.productType) || undefined,
    vendor: s(p.vendor) || undefined,
    tags: Array.isArray(p.tags) ? p.tags : undefined,
    url: s(p.onlineStoreUrl),
    inventory: typeof p.totalInventory === 'number' ? p.totalInventory : undefined,
    options: arr(p.options).map((x) => ({ name: s(x.name), values: x.values })),
    variants: nodes(p.variants).map((v) =>
      compact({
        id: s(v.id),
        title: s(v.title),
        sku: s(v.sku) || undefined,
        price: s(v.price),
        compare_at_price: s(v.compareAtPrice) ?? undefined,
        inventory: typeof v.inventoryQuantity === 'number' ? v.inventoryQuantity : undefined,
      }),
    ),
    images: nodes(p.media)
      .filter((m) => m.mediaContentType === 'IMAGE')
      .map((m) =>
        compact({ id: s(m.id), alt: s(m.alt) || undefined, url: s(o(o(m.preview).image).url) }),
      ),
    collections: nodes(p.collections).map((c) => ({ id: s(c.id), title: s(c.title) })),
    updated_at: s(p.updatedAt),
  })
}

export function collectionRow(c: Obj): Obj {
  return compact({
    id: s(c.id),
    title: s(c.title),
    handle: s(c.handle),
    products: typeof o(c.productsCount).count === 'number' ? o(c.productsCount).count : undefined,
    kind: c.ruleSet === null || c.ruleSet === undefined ? 'manual' : 'automatic',
    updated_at: s(c.updatedAt),
  })
}

export function collectionOut(c: Obj): Obj {
  return compact({
    ...collectionRow(c),
    description_html: s(c.descriptionHtml),
    product_list: nodes(c.products).map((p) =>
      compact({ id: s(p.id), title: s(p.title), status: s(p.status)?.toLowerCase() }),
    ),
  })
}

export function pageRow(p: Obj): Obj {
  return compact({
    id: s(p.id),
    title: s(p.title),
    handle: s(p.handle),
    published: typeof p.isPublished === 'boolean' ? p.isPublished : undefined,
    summary: clip(p.bodySummary, 160),
    updated_at: s(p.updatedAt),
  })
}

export function pageOut(p: Obj): Obj {
  return compact({
    id: s(p.id),
    title: s(p.title),
    handle: s(p.handle),
    published: typeof p.isPublished === 'boolean' ? p.isPublished : undefined,
    body_html: s(p.body),
    updated_at: s(p.updatedAt),
  })
}

export interface MenuItemOut {
  id?: string
  title: string
  type?: string
  url?: string
  resource_id?: string
  items?: MenuItemOut[]
}

export function menuItemsOut(items: unknown): MenuItemOut[] {
  return arr(items).map((i) => {
    const kids = menuItemsOut(i.items)
    return compact({
      id: s(i.id),
      title: s(i.title) ?? '',
      type: s(i.type),
      url: s(i.url) || undefined,
      resource_id: s(i.resourceId) || undefined,
      items: kids.length === 0 ? undefined : kids,
    }) as unknown as MenuItemOut
  })
}

export function menuOut(m: Obj): Obj {
  return compact({
    id: s(m.id),
    title: s(m.title),
    handle: s(m.handle),
    default: m.isDefault === true ? true : undefined,
    items: menuItemsOut(m.items),
  })
}

export function discountOut(n: Obj): Obj {
  const d = o(n.discount)
  return compact({
    id: s(n.id),
    kind: s(d.__typename),
    title: s(d.title),
    status: s(d.status)?.toLowerCase(),
    summary: s(d.summary),
    codes: nodes(d.codes)
      .map((c) => s(c.code))
      .filter((c): c is string => c !== undefined),
    starts_at: s(d.startsAt),
    ends_at: s(d.endsAt) ?? undefined,
    usage_limit: typeof d.usageLimit === 'number' ? d.usageLimit : undefined,
    used: typeof d.asyncUsageCount === 'number' ? d.asyncUsageCount : undefined,
  })
}

export function orderOut(n: Obj): Obj {
  return compact({
    id: s(n.id),
    name: s(n.name),
    created_at: s(n.createdAt),
    total: money(o(n.currentTotalPriceSet).shopMoney),
    items:
      typeof n.currentSubtotalLineItemsQuantity === 'number'
        ? n.currentSubtotalLineItemsQuantity
        : undefined,
    payment: s(n.displayFinancialStatus)?.toLowerCase(),
    fulfillment: s(n.displayFulfillmentStatus)?.toLowerCase(),
  })
}

/** 菜单项的类型（`MenuItemType`）：指向店里的东西按 gid 判；只有网址按路径判；都不是就是外链。 */
export function menuItemType(item: { url?: string; resource_id?: string; type?: string }): string {
  const known = [
    'FRONTPAGE',
    'COLLECTION',
    'COLLECTIONS',
    'PRODUCT',
    'CATALOG',
    'PAGE',
    'BLOG',
    'ARTICLE',
    'SEARCH',
    'SHOP_POLICY',
    'HTTP',
    'METAOBJECT',
    'CUSTOMER_ACCOUNT_PAGE',
  ]
  const gid = /^gid:\/\/shopify\/(\w+)\//.exec(item.resource_id ?? '')?.[1]
  if (gid !== undefined) {
    const byGid: Record<string, string> = {
      Product: 'PRODUCT',
      Collection: 'COLLECTION',
      Page: 'PAGE',
      Blog: 'BLOG',
      Article: 'ARTICLE',
      ShopPolicy: 'SHOP_POLICY',
      Metaobject: 'METAOBJECT',
    }
    if (byGid[gid] !== undefined) return byGid[gid] as string
  }
  if (
    item.type !== undefined &&
    known.includes(item.type) &&
    item.resource_id === undefined &&
    item.type !== 'HTTP'
  ) {
    // 读回来的老项原样留着它的类型（首页 / 目录 / 搜索这些没有 resource_id）
    return item.type
  }
  const path = (item.url ?? '').replace(/^https?:\/\/[^/]+/, '')
  if (path === '/' || path === '') return 'FRONTPAGE'
  if (path === '/collections/all') return 'CATALOG'
  if (path === '/collections') return 'COLLECTIONS'
  if (path === '/search') return 'SEARCH'
  return 'HTTP'
}

/** userErrors 拼成一句（空 = 没有）。 */
export function userErrorsOf(payload: unknown): string | undefined {
  const errs = arr(o(payload).userErrors)
  if (errs.length === 0) return undefined
  return errs
    .map((e) => {
      const field = Array.isArray(e.field) ? e.field.join('.') : undefined
      return field === undefined || field === '' ? s(e.message) : `${field}：${s(e.message)}`
    })
    .filter((x) => x !== undefined)
    .join('；')
}
