/**
 * WP261：演示 / 端到端测试用的**进程内假 Shopify CLI**（`store auth` / `store execute`）+ 一家小小的假店。
 *
 * 不起子进程、不联网、不碰任何真店。形状照 4.8.5：授权打一段 JSON（权限、过期时间）；执行读 `--query-file` /
 * `--variable-file`、写 `--output-file`；mutation 没带 `--allow-mutations` 照原文拒。查询 / 改动按**操作名**认
 * （`shop-graphql.ts` 那几条），够演示「读一件商品 → 出卡 → 批了 → 改 → 读回」。真脚本版在测试夹具里
 * （`test/fixtures/fake-shopify-store.ts`）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { SpawnTool, ToolProcess } from './platform-cli-runner.js'
import type { RunCli } from './shopify-theme.js'

type Obj = Record<string, unknown>

interface FakeVariant {
  id: string
  title: string
  sku: string
  price: string
  compareAtPrice: string | null
  inventoryQuantity: number
}
interface FakeProduct {
  id: string
  title: string
  handle: string
  status: string
  descriptionHtml: string
  productType: string
  vendor: string
  tags: string[]
  variants: FakeVariant[]
  media: { id: string; alt: string; url: string }[]
  collections: string[]
  published: boolean
}

export interface FakeShop {
  products: FakeProduct[]
  collections: {
    id: string
    title: string
    handle: string
    descriptionHtml: string
    products: string[]
  }[]
  pages: { id: string; title: string; handle: string; body: string; isPublished: boolean }[]
  menus: { id: string; title: string; handle: string; items: Obj[] }[]
  discounts: {
    id: string
    code: string
    title: string
    status: string
    summary: string
    usageLimit: number | null
  }[]
  /** 授权过的店 → 权限 / 过期。 */
  sessions: Map<string, { scopes: string[]; expiresAt: string }>
  seq: number
  /** WP268：店铺「文件」里的图（`fileCreate` 建的；第一次查状态是 UPLOADED，再查才 READY）。 */
  files?: { id: string; filename: string; url: string; alt?: string; polled: number }[]
}

const NOW = (): string => new Date().toISOString()

export function demoShop(): FakeShop {
  const v = (id: number, title: string, price: string, qty: number): FakeVariant => ({
    id: `gid://shopify/ProductVariant/${id}`,
    title,
    sku: `RO-${id}`,
    price,
    compareAtPrice: null,
    inventoryQuantity: qty,
  })
  return {
    products: [
      {
        id: 'gid://shopify/Product/1001',
        title: 'Rollout 折叠收纳箱',
        handle: 'rollout-storage-box',
        status: 'ACTIVE',
        descriptionHtml: '<p>一只能折起来的收纳箱，放车里、放衣柜都行。</p>',
        productType: '收纳',
        vendor: 'Rollout',
        tags: ['收纳', '新品'],
        variants: [v(2001, '大号', '29.90', 48), v(2002, '小号', '19.90', 120)],
        media: [
          {
            id: 'gid://shopify/MediaImage/3001',
            alt: '收纳箱正面',
            url: 'https://cdn.shopify.test/box.jpg',
          },
        ],
        collections: ['gid://shopify/Collection/4001'],
        published: true,
      },
      {
        id: 'gid://shopify/Product/1002',
        title: 'Rollout 车载挂钩',
        handle: 'rollout-hook',
        status: 'DRAFT',
        descriptionHtml: '<p>挂在头枕上的小挂钩。</p>',
        productType: '车品',
        vendor: 'Rollout',
        tags: [],
        variants: [v(2003, 'Default Title', '9.90', 300)],
        media: [],
        collections: [],
        published: false,
      },
    ],
    collections: [
      {
        id: 'gid://shopify/Collection/4001',
        title: '首页精选',
        handle: 'frontpage',
        descriptionHtml: '',
        products: ['gid://shopify/Product/1001'],
      },
    ],
    pages: [
      {
        id: 'gid://shopify/Page/5001',
        title: '关于我们',
        handle: 'about-us',
        body: '<p>Rollout 做好用的小东西。</p>',
        isPublished: true,
      },
    ],
    menus: [
      {
        id: 'gid://shopify/Menu/6001',
        title: '主菜单',
        handle: 'main-menu',
        items: [
          {
            id: 'gid://shopify/MenuItem/7001',
            title: '首页',
            type: 'FRONTPAGE',
            url: '/',
            resourceId: null,
            items: [],
          },
          {
            id: 'gid://shopify/MenuItem/7002',
            title: '全部商品',
            type: 'CATALOG',
            url: '/collections/all',
            resourceId: null,
            items: [],
          },
        ],
      },
    ],
    discounts: [
      {
        id: 'gid://shopify/DiscountCodeNode/8001',
        code: 'WELCOME10',
        title: '新客 9 折',
        status: 'ACTIVE',
        summary: '10% off',
        usageLimit: 500,
      },
    ],
    sessions: new Map(),
    seq: 9000,
  }
}

const productNode = (p: FakeProduct): Obj => ({
  id: p.id,
  title: p.title,
  handle: p.handle,
  status: p.status,
  descriptionHtml: p.descriptionHtml,
  productType: p.productType,
  vendor: p.vendor,
  tags: p.tags,
  updatedAt: NOW(),
  onlineStoreUrl:
    p.published && p.status === 'ACTIVE' ? `https://rollout.test/products/${p.handle}` : null,
  totalInventory: p.variants.reduce((n, v) => n + v.inventoryQuantity, 0),
  options: [{ name: 'Title', values: p.variants.map((v) => v.title) }],
  variants: {
    nodes: p.variants.map((v) => ({ ...v, selectedOptions: [{ name: 'Title', value: v.title }] })),
  },
  media: {
    nodes: p.media.map((m) => ({
      id: m.id,
      alt: m.alt,
      mediaContentType: 'IMAGE',
      status: 'READY',
      preview: { image: { url: m.url } },
    })),
  },
  collections: { nodes: [] },
  priceRangeV2: {
    minVariantPrice: {
      amount: p.variants.map((v) => v.price).sort()[0] ?? '0.00',
      currencyCode: 'USD',
    },
    maxVariantPrice: {
      amount:
        p.variants
          .map((v) => v.price)
          .sort()
          .at(-1) ?? '0.00',
      currencyCode: 'USD',
    },
  },
  featuredMedia: p.media[0] === undefined ? null : { preview: { image: { url: p.media[0].url } } },
  variantsCount: { count: p.variants.length },
})

/** 按操作名回数据（只认 `shop-graphql.ts` 那几条）。 */
export function resolveFakeShop(shop: FakeShop, op: string, vars: Obj): Obj | undefined {
  const id = (): string => {
    shop.seq += 1
    return String(shop.seq)
  }
  const prod = (pid: unknown) => shop.products.find((p) => p.id === pid)
  switch (op) {
    case 'AgentswsProducts':
      return {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: shop.products.map(productNode),
        },
      }
    case 'AgentswsProduct': {
      const p = prod(vars.id)
      return { product: p === undefined ? null : productNode(p) }
    }
    case 'AgentswsProductByHandle': {
      const h = /handle:'([^']+)'/.exec(String(vars.query))?.[1]
      return {
        products: { nodes: shop.products.filter((p) => p.handle === h).map((p) => ({ id: p.id })) },
      }
    }
    case 'AgentswsCollections':
      return {
        collections: {
          nodes: shop.collections.map((c) => ({
            ...c,
            updatedAt: NOW(),
            productsCount: { count: c.products.length },
            ruleSet: null,
          })),
        },
      }
    case 'AgentswsCollection': {
      const c = shop.collections.find((x) => x.id === vars.id)
      return {
        collection:
          c === undefined
            ? null
            : {
                ...c,
                updatedAt: NOW(),
                ruleSet: null,
                productsCount: { count: c.products.length },
                products: {
                  nodes: c.products
                    .map((pid) => prod(pid))
                    .filter(Boolean)
                    .map((p) => ({
                      id: p?.id,
                      title: p?.title,
                      handle: p?.handle,
                      status: p?.status,
                    })),
                },
              },
      }
    }
    case 'AgentswsPages':
      return {
        pages: {
          nodes: shop.pages.map((p) => ({
            ...p,
            updatedAt: NOW(),
            bodySummary: p.body.replace(/<[^>]+>/g, ''),
          })),
        },
      }
    case 'AgentswsPage': {
      const p = shop.pages.find((x) => x.id === vars.id)
      return { page: p === undefined ? null : { ...p, updatedAt: NOW(), publishedAt: null } }
    }
    case 'AgentswsMenus':
      return {
        menus: { nodes: shop.menus.map((m) => ({ ...m, isDefault: m.handle === 'main-menu' })) },
      }
    case 'AgentswsDiscounts':
      return {
        discountNodes: {
          nodes: shop.discounts.map((d) => ({
            id: d.id,
            discount: {
              __typename: 'DiscountCodeBasic',
              title: d.title,
              status: d.status,
              summary: d.summary,
              startsAt: NOW(),
              endsAt: null,
              usageLimit: d.usageLimit,
              asyncUsageCount: 12,
              codes: { nodes: [{ code: d.code }] },
            },
          })),
        },
      }
    case 'AgentswsDiscountByCode': {
      const d = shop.discounts.find((x) => x.code.toUpperCase() === String(vars.code).toUpperCase())
      return {
        codeDiscountNodeByCode:
          d === undefined
            ? null
            : {
                id: d.id,
                codeDiscount: { __typename: 'DiscountCodeBasic', title: d.title, status: d.status },
              },
      }
    }
    case 'AgentswsRecentOrders':
      return {
        orders: {
          nodes: [
            {
              id: 'gid://shopify/Order/1',
              name: '#1001',
              createdAt: NOW(),
              displayFinancialStatus: 'PAID',
              displayFulfillmentStatus: 'UNFULFILLED',
              currentTotalPriceSet: { shopMoney: { amount: '49.80', currencyCode: 'USD' } },
              currentSubtotalLineItemsQuantity: 2,
            },
          ],
        },
      }
    case 'AgentswsPublications':
      return {
        publications: { nodes: [{ id: 'gid://shopify/Publication/1', name: 'Online Store' }] },
      }
    // ── 改动 ──
    case 'AgentswsProductSet': {
      const input = vars.input as Obj
      const pid = `gid://shopify/Product/${id()}`
      const variants = (Array.isArray(input.variants) ? input.variants : [{}]) as Obj[]
      shop.products.push({
        id: pid,
        title: String(input.title),
        handle: String(input.title)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-'),
        status: String(input.status ?? 'DRAFT'),
        descriptionHtml: String(input.descriptionHtml ?? ''),
        productType: String(input.productType ?? ''),
        vendor: String(input.vendor ?? ''),
        tags: (input.tags as string[]) ?? [],
        variants: variants.map((v) => ({
          id: `gid://shopify/ProductVariant/${id()}`,
          title:
            ((v.optionValues as Obj[]) ?? []).map((x) => x.name).join(' / ') || 'Default Title',
          sku: String((v.inventoryItem as Obj | undefined)?.sku ?? ''),
          price: String(v.price ?? '0.00'),
          compareAtPrice: (v.compareAtPrice as string) ?? null,
          inventoryQuantity: 0,
        })),
        media: [],
        collections: [],
        published: false,
      })
      return {
        productSet: {
          product: { id: pid, title: input.title, handle: '', status: 'DRAFT' },
          userErrors: [],
        },
      }
    }
    case 'AgentswsProductUpdate':
    case 'AgentswsProductMedia': {
      const input = vars.product as Obj
      const p = prod(input.id)
      if (p === undefined)
        return {
          productUpdate: {
            product: null,
            userErrors: [{ field: ['id'], message: 'Product does not exist' }],
          },
        }
      if (typeof input.title === 'string') p.title = input.title
      if (typeof input.descriptionHtml === 'string') p.descriptionHtml = input.descriptionHtml
      if (typeof input.productType === 'string') p.productType = input.productType
      if (typeof input.vendor === 'string') p.vendor = input.vendor
      if (Array.isArray(input.tags)) p.tags = input.tags as string[]
      if (typeof input.status === 'string') p.status = input.status
      for (const m of (vars.media as Obj[] | undefined) ?? [])
        p.media.push({
          id: `gid://shopify/MediaImage/${id()}`,
          alt: String(m.alt ?? ''),
          url: String(m.originalSource),
        })
      return { productUpdate: { product: { id: p.id }, userErrors: [] } }
    }
    case 'AgentswsVariantsUpdate': {
      const p = prod(vars.productId)
      for (const v of (vars.variants as Obj[]) ?? []) {
        const hit = p?.variants.find((x) => x.id === v.id)
        if (hit === undefined)
          return {
            productVariantsBulkUpdate: {
              productVariants: [],
              userErrors: [{ field: ['variants'], message: 'Variant does not exist' }],
            },
          }
        if (typeof v.price === 'string') hit.price = v.price
        if ('compareAtPrice' in v) hit.compareAtPrice = (v.compareAtPrice as string | null) ?? null
      }
      return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } }
    }
    case 'AgentswsPublish': {
      const p = prod(vars.id)
      if (p !== undefined) p.published = true
      return { publishablePublish: { userErrors: [] } }
    }
    case 'AgentswsStagedUploads':
      return {
        stagedUploadsCreate: {
          stagedTargets: [
            {
              url: 'https://uploads.shopify.test/upload',
              resourceUrl: `https://uploads.shopify.test/r/${id()}`,
              parameters: [{ name: 'key', value: 'k' }],
            },
          ],
          userErrors: [],
        },
      }
    // WP268：店铺「文件」与商品图（`shop-files.ts` 那三条）
    case 'AgentswsFileCreate': {
      const list = (vars.files as Obj[] | undefined) ?? []
      shop.files ??= []
      const made = list.map((f) => {
        const wanted = String(f.filename ?? `file-${id()}.png`)
        // 撞名时 Shopify 默认在文件名后面加一段（APPEND_UUID）
        const filename = shop.files?.some((x) => x.filename === wanted)
          ? wanted.replace(/(\.[a-z]+)$/i, `_${id()}$1`)
          : wanted
        const file = {
          id: `gid://shopify/MediaImage/${id()}`,
          filename,
          url: `https://cdn.shopify.com/s/files/1/0000/0001/files/${filename}?v=1`,
          ...(typeof f.alt === 'string' ? { alt: f.alt } : {}),
          polled: 0,
        }
        shop.files?.push(file)
        return { id: file.id, fileStatus: 'UPLOADED', alt: file.alt ?? null, image: null }
      })
      return { fileCreate: { files: made, userErrors: [] } }
    }
    case 'AgentswsFileStatus': {
      const f = shop.files?.find((x) => x.id === vars.id)
      if (f === undefined) return { node: null }
      f.polled += 1
      return {
        node: {
          id: f.id,
          fileStatus: f.polled >= 1 ? 'READY' : 'UPLOADED',
          image: { url: f.url, width: 1536, height: 1024 },
        },
      }
    }
    case 'AgentswsProductImages': {
      const p = prod(vars.id)
      return {
        product:
          p === undefined
            ? null
            : {
                id: p.id,
                title: p.title,
                media: {
                  nodes: p.media.map((m) => ({
                    mediaContentType: 'IMAGE',
                    image: { url: m.url, width: 1000, height: 1000 },
                    preview: { image: { url: m.url } },
                  })),
                },
              },
      }
    }
    case 'AgentswsCollectionCreate': {
      const input = vars.input as Obj
      const cid = `gid://shopify/Collection/${id()}`
      shop.collections.push({
        id: cid,
        title: String(input.title),
        handle: '',
        descriptionHtml: String(input.descriptionHtml ?? ''),
        products: (input.products as string[]) ?? [],
      })
      return { collectionCreate: { collection: { id: cid, title: input.title }, userErrors: [] } }
    }
    case 'AgentswsCollectionUpdate': {
      const input = vars.input as Obj
      const c = shop.collections.find((x) => x.id === input.id)
      if (c !== undefined && typeof input.title === 'string') c.title = input.title
      if (c !== undefined && typeof input.descriptionHtml === 'string')
        c.descriptionHtml = input.descriptionHtml
      return { collectionUpdate: { collection: { id: input.id }, userErrors: [] } }
    }
    case 'AgentswsCollectionAdd': {
      const c = shop.collections.find((x) => x.id === vars.id)
      if (c !== undefined)
        c.products = [...new Set([...c.products, ...((vars.productIds as string[]) ?? [])])]
      return { collectionAddProducts: { collection: { id: vars.id }, userErrors: [] } }
    }
    case 'AgentswsCollectionRemove': {
      const c = shop.collections.find((x) => x.id === vars.id)
      if (c !== undefined)
        c.products = c.products.filter((x) => !((vars.productIds as string[]) ?? []).includes(x))
      return { collectionRemoveProducts: { job: { id: 'gid://shopify/Job/1' }, userErrors: [] } }
    }
    case 'AgentswsPageCreate': {
      const page = vars.page as Obj
      const pid = `gid://shopify/Page/${id()}`
      shop.pages.push({
        id: pid,
        title: String(page.title),
        handle: String(page.handle ?? ''),
        body: String(page.body ?? ''),
        isPublished: page.isPublished === true,
      })
      return {
        pageCreate: { page: { id: pid, title: page.title, handle: page.handle }, userErrors: [] },
      }
    }
    case 'AgentswsPageUpdate': {
      const p = shop.pages.find((x) => x.id === vars.id)
      const page = vars.page as Obj
      if (p !== undefined) {
        if (typeof page.title === 'string') p.title = page.title
        if (typeof page.body === 'string') p.body = page.body
        if (typeof page.isPublished === 'boolean') p.isPublished = page.isPublished
      }
      return { pageUpdate: { page: { id: vars.id }, userErrors: [] } }
    }
    case 'AgentswsMenuCreate':
    case 'AgentswsMenuUpdate': {
      const toItems = (items: Obj[]): Obj[] =>
        items.map((i) => ({
          id: i.id ?? `gid://shopify/MenuItem/${id()}`,
          title: i.title,
          type: i.type,
          url: i.url ?? null,
          resourceId: i.resourceId ?? null,
          items: toItems((i.items as Obj[]) ?? []),
        }))
      if (op === 'AgentswsMenuCreate') {
        const mid = `gid://shopify/Menu/${id()}`
        shop.menus.push({
          id: mid,
          title: String(vars.title),
          handle: String(vars.handle),
          items: toItems(vars.items as Obj[]),
        })
        return { menuCreate: { menu: { id: mid }, userErrors: [] } }
      }
      const m = shop.menus.find((x) => x.id === vars.id)
      if (m !== undefined) {
        m.title = String(vars.title)
        m.items = toItems(vars.items as Obj[])
      }
      return { menuUpdate: { menu: { id: vars.id }, userErrors: [] } }
    }
    case 'AgentswsDiscountCreate': {
      const input = vars.input as Obj
      const did = `gid://shopify/DiscountCodeNode/${id()}`
      shop.discounts.push({
        id: did,
        code: String(input.code),
        title: String(input.title),
        status: 'ACTIVE',
        summary: '',
        usageLimit: (input.usageLimit as number) ?? null,
      })
      return { discountCodeBasicCreate: { codeDiscountNode: { id: did }, userErrors: [] } }
    }
    default:
      return undefined
  }
}

const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}

/** `store execute` 的进程内替身（参数形状与真 CLI 一样；前面的 `<node> <入口>` 不在这里）。 */
export function shopAdminRunStandIn(shop: FakeShop): RunCli {
  return async (args) => {
    const at = args.indexOf('store')
    const rest = at < 0 ? args : args.slice(at)
    if (rest[1] !== 'execute') return { code: 2, stdout: '', stderr: 'unknown' }
    const store = flag(rest, '--store') ?? ''
    const doc = readFileSync(flag(rest, '--query-file') ?? '', 'utf8')
    const vf = flag(rest, '--variable-file')
    const vars = vf === undefined ? {} : (JSON.parse(readFileSync(vf, 'utf8')) as Obj)
    const m = /^\s*(query|mutation)\s+(\w+)/.exec(doc.replace(/#[^\n]*/g, ''))
    if (m?.[1] === 'mutation' && !rest.includes('--allow-mutations'))
      return {
        code: 1,
        stdout: '',
        stderr: 'Mutations are disabled by default for shopify store execute.',
      }
    if (!shop.sessions.has(store))
      return { code: 1, stdout: '', stderr: `No stored app authentication found for ${store}.` }
    const data = resolveFakeShop(shop, m?.[2] ?? '', vars)
    if (data === undefined)
      return {
        code: 1,
        stdout: '',
        stderr: 'GraphQL operation failed.\n{"errors":[{"message":"unknown field"}]}',
      }
    writeFileSync(flag(rest, '--output-file') ?? '', JSON.stringify(data))
    return { code: 0, stdout: '', stderr: '' }
  }
}

/** `store auth` 的进程内替身：过一会儿「浏览器里点了批准」，打出 4.8.5 那一段 JSON。 */
export function shopAuthSpawnStandIn(shop: FakeShop, opts: { delayMs?: number } = {}): SpawnTool {
  return (_command, args) => {
    const listeners: ((line: string) => void)[] = []
    let killed = false
    let finish: (code: number) => void = () => undefined
    const done = new Promise<number>((resolve) => {
      finish = resolve
    })
    const store = flag(args, '--store') ?? ''
    const scopes = (flag(args, '--scopes') ?? '').split(',').filter(Boolean)
    const emit = (line: string): void => {
      for (const cb of listeners) cb(line)
    }
    setTimeout(() => emit('Shopify CLI will open the app authorization page in your browser.'), 10)
    setTimeout(() => {
      if (killed) return
      const before = shop.sessions.get(store)?.scopes ?? []
      const merged = [...new Set([...before, ...scopes])].sort()
      const acquiredAt = new Date()
      const expiresAt = new Date(acquiredAt.getTime() + 86_399_000).toISOString()
      shop.sessions.set(store, { scopes: merged, expiresAt })
      emit('Logged in.')
      for (const line of JSON.stringify(
        {
          store,
          userId: '42',
          scopes: merged,
          acquiredAt: acquiredAt.toISOString(),
          expiresAt,
          hasRefreshToken: false,
        },
        null,
        2,
      ).split('\n'))
        emit(line)
      finish(0)
    }, opts.delayMs ?? 1500)
    const proc: ToolProcess = {
      onLine: (cb) => listeners.push(cb),
      write: () => undefined,
      kill: () => {
        killed = true
        finish(143)
      },
      done,
    }
    return proc
  }
}
