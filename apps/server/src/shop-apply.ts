/**
 * WP261：**人批过的卡 → 店里真改**（只有执行器调；带 `--allow-mutations` 的唯一一条路）。
 *
 * 每一类三步：① 改之前再读一次，卡上写的「原来」与店里现在的对不上（有人在后台改过）→ 不改、照实说；
 * ② 跑写死的那一条（或几条）mutation，`userErrors` 不空 → 失败、把 Shopify 的话带上；
 * ③ **读回确认**：对上了才算「好了」，对不上回 `verified: false`（执行器记 `unknown`，不说「好了」）。
 * 本机图片走 Shopify 的「先传到临时地址」（`stagedUploadsCreate` → 按它给的地址 POST 文件 → 拿 `resourceUrl` 挂到商品上）。
 */
import { readFileSync } from 'node:fs'
import type { ObjectRef, StagedChange } from '@agentsws/contracts'
import type { ShopifyAdmin } from './shop-admin.js'
import type { ShopAccess } from './shop-auth.js'
import {
  COLLECTION_ADD,
  COLLECTION_CREATE,
  COLLECTION_REMOVE,
  COLLECTION_UPDATE,
  DISCOUNT_BY_CODE,
  DISCOUNT_CREATE,
  MENU_CREATE,
  MENU_UPDATE,
  type MenuItemOut,
  menuItemsOut,
  nodes,
  o,
  PAGE_CREATE,
  PAGE_UPDATE,
  PRODUCT_MEDIA,
  PRODUCT_SET,
  PRODUCT_UPDATE,
  PUBLICATIONS,
  PUBLISH,
  STAGED_UPLOADS,
  s,
  userErrorsOf,
  VARIANTS_UPDATE,
} from './shop-graphql.js'
import { readCollection, readMenus, readPage, readProduct } from './shop-ops.js'
import { localImage } from './shop-propose.js'

export class ShopApplyError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ShopApplyError'
  }
}

export interface ApplyContext {
  admin: ShopifyAdmin
  access: ShopAccess
  fileRoots: string[]
  fetch: typeof fetch
  now(): string
}

export interface Applied {
  ref: ObjectRef
  verified: boolean
  /** 给人看的补充（读回没对上的是哪一格、没挂到网店渠道…）。 */
  note?: string
}

type Obj = Record<string, unknown>
const plain = (html: string | undefined): string =>
  (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const money = (n: number): string => n.toFixed(2)

async function run(
  ctx: ApplyContext,
  name: string,
  document: string,
  variables: Obj,
  key: string,
): Promise<Obj> {
  const data = o(await ctx.admin.mutate({ name, document, variables }))
  const payload = o(data[key])
  const err = userErrorsOf(payload)
  if (err !== undefined) throw new ShopApplyError(`Shopify 没接受：${err}`)
  return payload
}

function stale(what: string): never {
  throw new ShopApplyError(
    `${what}在卡出来之后被改过（店里现在的与卡上的「原来」不一样），这次没改。让 AI 重新读一遍再出卡。`,
  )
}

const cartesian = (
  options: { name: string; values: string[] }[],
): { optionName: string; name: string }[][] =>
  options.reduce<{ optionName: string; name: string }[][]>(
    (acc, opt) =>
      acc.flatMap((combo) => opt.values.map((v) => [...combo, { optionName: opt.name, name: v }])),
    [[]],
  )

async function productCreate(ctx: ApplyContext, a: Obj): Promise<Applied> {
  const options = (Array.isArray(a.options) ? a.options : []) as {
    name: string
    values: string[]
  }[]
  const price = typeof a.price === 'number' ? money(a.price) : undefined
  const compare = typeof a.compare_at_price === 'number' ? money(a.compare_at_price) : undefined
  const sku = s(a.sku)
  const variantBase = {
    ...(price === undefined ? {} : { price }),
    ...(compare === undefined ? {} : { compareAtPrice: compare }),
  }
  const opts =
    options.length > 0
      ? options
      : price !== undefined || sku !== undefined
        ? [{ name: 'Title', values: ['Default Title'] }]
        : []
  const input: Obj = {
    title: a.title,
    status: 'DRAFT',
    ...(a.description_html === undefined ? {} : { descriptionHtml: a.description_html }),
    ...(a.product_type === undefined ? {} : { productType: a.product_type }),
    ...(a.vendor === undefined ? {} : { vendor: a.vendor }),
    ...(a.tags === undefined ? {} : { tags: a.tags }),
    ...(opts.length === 0
      ? {}
      : {
          productOptions: opts.map((x) => ({
            name: x.name,
            values: x.values.map((v) => ({ name: v })),
          })),
          variants: cartesian(opts).map((optionValues) => ({
            optionValues,
            ...variantBase,
            ...(sku !== undefined && options.length === 0 ? { inventoryItem: { sku } } : {}),
          })),
        }),
  }
  const out = await run(ctx, 'product_set', PRODUCT_SET, { input }, 'productSet')
  const id = s(o(out.product).id)
  if (id === undefined) throw new ShopApplyError('Shopify 没回新商品的 id')
  const p = await readProduct(ctx.admin, ctx.access, id)
  const ok = s(p.title) === a.title && s(p.status) === 'DRAFT'
  return {
    ref: { type: 'product', id },
    verified: ok,
    ...(ok ? {} : { note: '标题或状态读回来对不上' }),
  }
}

async function productUpdate(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const id = s(a.id) as string
  const p = await readProduct(ctx.admin, ctx.access, id)
  const now: Obj = {
    title: s(p.title),
    description_html: s(p.descriptionHtml),
    product_type: s(p.productType),
    vendor: s(p.vendor),
    tags: Array.isArray(p.tags) ? p.tags : [],
  }
  for (const [k, v] of Object.entries(before))
    if (JSON.stringify(v ?? null) !== JSON.stringify(now[k] ?? null)) stale('这件商品')
  const MAP: Record<string, string> = {
    title: 'title',
    description_html: 'descriptionHtml',
    product_type: 'productType',
    vendor: 'vendor',
    tags: 'tags',
  }
  const product: Obj = { id }
  for (const k of Object.keys(before))
    if (MAP[k] !== undefined && a[k] !== undefined) product[MAP[k] as string] = a[k]
  await run(ctx, 'product_update', PRODUCT_UPDATE, { product }, 'productUpdate')
  const back = await readProduct(ctx.admin, ctx.access, id)
  const got: Obj = {
    title: s(back.title),
    description_html: s(back.descriptionHtml),
    product_type: s(back.productType),
    vendor: s(back.vendor),
    tags: Array.isArray(back.tags) ? back.tags : [],
  }
  const off = Object.keys(before).filter((k) =>
    k === 'description_html'
      ? plain(got[k] as string) !== plain(a[k] as string)
      : k === 'tags'
        ? JSON.stringify([...((got[k] as string[]) ?? [])].sort()) !==
          JSON.stringify([...((a[k] as string[]) ?? [])].sort())
        : got[k] !== a[k],
  )
  return {
    ref: { type: 'product', id },
    verified: off.length === 0,
    ...(off.length === 0 ? {} : { note: `读回来对不上：${off.join('、')}` }),
  }
}

async function variantPrice(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const product_id = s(a.product_id) as string
  const variant_id = s(a.variant_id) as string
  const findV = async () =>
    nodes((await readProduct(ctx.admin, ctx.access, product_id)).variants).find(
      (v) => s(v.id) === variant_id,
    )
  const v = await findV()
  if (v === undefined) throw new ShopApplyError('店里找不到这个变体了（可能被删了）')
  if (Number(s(v.price)) !== before.price) stale('这个价格')
  const variant: Obj = { id: variant_id, price: money(a.price as number) }
  if ('compare_at_price' in a)
    variant.compareAtPrice =
      a.compare_at_price === null ? null : money(a.compare_at_price as number)
  await run(
    ctx,
    'variants_update',
    VARIANTS_UPDATE,
    { productId: product_id, variants: [variant] },
    'productVariantsBulkUpdate',
  )
  const back = await findV()
  const ok = back !== undefined && Number(s(back.price)) === a.price
  return {
    ref: { type: 'product', id: product_id },
    verified: ok,
    ...(ok ? {} : { note: '价格读回来对不上' }),
  }
}

async function productStatus(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const id = s(a.product_id) as string
  const p = await readProduct(ctx.admin, ctx.access, id)
  if (s(p.status) !== before.status) stale('这件商品的状态')
  await run(
    ctx,
    'product_update',
    PRODUCT_UPDATE,
    { product: { id, status: a.status } },
    'productUpdate',
  )
  let note: string | undefined
  if (a.status === 'ACTIVE') {
    // 上架 = 状态 ACTIVE + 挂到网店渠道（新建的商品默认不在任何渠道上）
    try {
      const pubs = nodes(
        o(await ctx.admin.query({ name: 'publications', document: PUBLICATIONS })).publications,
      )
      const store = pubs.find((x) => /online store/i.test(s(x.name) ?? ''))
      if (store === undefined) note = '没找到网店渠道，状态已改成上架；去后台看一眼「销售渠道」'
      else
        await run(
          ctx,
          'publish',
          PUBLISH,
          { id, input: [{ publicationId: s(store.id) }] },
          'publishablePublish',
        )
    } catch (e) {
      note = `状态已改成上架，但没挂到网店渠道（${e instanceof Error ? e.message : String(e)}）`
    }
  }
  const back = await readProduct(ctx.admin, ctx.access, id)
  const ok = s(back.status) === a.status
  return {
    ref: { type: 'product', id },
    verified: ok,
    ...(ok ? (note === undefined ? {} : { note }) : { note: '状态读回来对不上' }),
  }
}

/** 本机图片 → Shopify 给的临时地址（`stagedUploadsCreate`）→ `resourceUrl`。 */
async function stage(
  ctx: ApplyContext,
  img: { file: string; name: string; mime: string },
): Promise<string> {
  const local = localImage(img.file, ctx.fileRoots)
  const out = await run(
    ctx,
    'staged_uploads',
    STAGED_UPLOADS,
    {
      input: [
        {
          resource: 'IMAGE',
          filename: local.name,
          mimeType: local.mime,
          httpMethod: 'POST',
          fileSize: String(local.bytes),
        },
      ],
    },
    'stagedUploadsCreate',
  )
  const target = o((out.stagedTargets as unknown[] | undefined)?.[0])
  const url = s(target.url)
  const resourceUrl = s(target.resourceUrl)
  if (url === undefined || resourceUrl === undefined)
    throw new ShopApplyError('Shopify 没给上传地址')
  const form = new FormData()
  for (const p of Array.isArray(target.parameters) ? target.parameters : []) {
    const name = s(o(p).name)
    const value = s(o(p).value)
    if (name !== undefined && value !== undefined) form.append(name, value)
  }
  form.append('file', new Blob([readFileSync(local.file)], { type: local.mime }), local.name)
  const res = await ctx.fetch(url, { method: 'POST', body: form })
  if (!res.ok) throw new ShopApplyError(`图片没传上去（${res.status}）`, true)
  return resourceUrl
}

async function productImages(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const id = s(a.product_id) as string
  const images = (Array.isArray(a.images) ? a.images : []) as Obj[]
  const media: Obj[] = []
  for (const img of images) {
    const source =
      s(img.url) ?? (await stage(ctx, img as { file: string; name: string; mime: string }))
    media.push({
      originalSource: source,
      mediaContentType: 'IMAGE',
      ...(s(img.alt) === undefined ? {} : { alt: s(img.alt) }),
    })
  }
  await run(ctx, 'product_media', PRODUCT_MEDIA, { product: { id }, media }, 'productUpdate')
  const back = await readProduct(ctx.admin, ctx.access, id)
  const count = nodes(back.media).length
  const ok = count >= (before.images as number) + images.length
  return {
    ref: { type: 'product', id },
    verified: ok,
    ...(ok ? {} : { note: `图片读回来是 ${count} 张（Shopify 可能还在处理）` }),
  }
}

async function collectionCreate(ctx: ApplyContext, a: Obj): Promise<Applied> {
  const products = (a.products as string[] | undefined) ?? []
  const out = await run(
    ctx,
    'collection_create',
    COLLECTION_CREATE,
    {
      input: {
        title: a.title,
        ...(a.description_html === undefined ? {} : { descriptionHtml: a.description_html }),
        ...(products.length === 0 ? {} : { products }),
      },
    },
    'collectionCreate',
  )
  const id = s(o(out.collection).id)
  if (id === undefined) throw new ShopApplyError('Shopify 没回新合集的 id')
  const back = await readCollection(ctx.admin, id)
  const inside = new Set(nodes(back.products).map((p) => s(p.id)))
  const ok = s(back.title) === a.title && products.every((p) => inside.has(p))
  return {
    ref: { type: 'collection', id },
    verified: ok,
    ...(ok ? {} : { note: '标题或商品读回来对不上' }),
  }
}

async function collectionUpdate(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const id = s(a.id) as string
  const c = await readCollection(ctx.admin, id)
  if (s(c.title) !== before.title) stale('这个合集')
  if (a.title !== undefined || a.description_html !== undefined)
    await run(
      ctx,
      'collection_update',
      COLLECTION_UPDATE,
      {
        input: {
          id,
          ...(a.title === undefined ? {} : { title: a.title }),
          ...(a.description_html === undefined ? {} : { descriptionHtml: a.description_html }),
        },
      },
      'collectionUpdate',
    )
  const add = (a.add as string[] | undefined) ?? []
  const remove = (a.remove as string[] | undefined) ?? []
  if (add.length > 0)
    await run(
      ctx,
      'collection_add',
      COLLECTION_ADD,
      { id, productIds: add },
      'collectionAddProducts',
    )
  if (remove.length > 0)
    await run(
      ctx,
      'collection_remove',
      COLLECTION_REMOVE,
      { id, productIds: remove },
      'collectionRemoveProducts',
    )
  const back = await readCollection(ctx.admin, id)
  const inside = new Set(nodes(back.products).map((p) => s(p.id)))
  const off = [
    ...(a.title !== undefined && s(back.title) !== a.title ? ['标题'] : []),
    ...(add.some((p) => !inside.has(p)) ? ['加进来的商品'] : []),
  ]
  return {
    ref: { type: 'collection', id },
    verified: off.length === 0,
    ...(off.length === 0
      ? remove.length > 0
        ? { note: '拿掉商品是 Shopify 后台排队做的，过一会儿生效' }
        : {}
      : { note: `读回来对不上：${off.join('、')}` }),
  }
}

async function pageCreate(ctx: ApplyContext, a: Obj): Promise<Applied> {
  const out = await run(
    ctx,
    'page_create',
    PAGE_CREATE,
    {
      page: {
        title: a.title,
        ...(a.body_html === undefined ? {} : { body: a.body_html }),
        ...(a.handle === undefined ? {} : { handle: a.handle }),
        isPublished: a.published === true,
      },
    },
    'pageCreate',
  )
  const id = s(o(out.page).id)
  if (id === undefined) throw new ShopApplyError('Shopify 没回新页面的 id')
  const back = await readPage(ctx.admin, id)
  const ok = s(back.title) === a.title && (back.isPublished === true) === (a.published === true)
  return {
    ref: { type: 'page', id },
    verified: ok,
    ...(ok ? {} : { note: '标题或显示状态读回来对不上' }),
  }
}

async function pageUpdate(ctx: ApplyContext, a: Obj, before: Obj): Promise<Applied> {
  const id = s(a.id) as string
  const p = await readPage(ctx.admin, id)
  if (s(p.title) !== before.title || (p.isPublished === true) !== before.published)
    stale('这个页面')
  if (
    'body_html' in a &&
    plain(s(p.body)) !== plain((before.body_html as string | null) ?? undefined)
  )
    stale('这个页面的正文')
  const page: Obj = {
    ...(a.title === undefined ? {} : { title: a.title }),
    ...(a.body_html === undefined ? {} : { body: a.body_html }),
    ...(a.published === undefined ? {} : { isPublished: a.published }),
  }
  await run(ctx, 'page_update', PAGE_UPDATE, { id, page }, 'pageUpdate')
  const back = await readPage(ctx.admin, id)
  const off = [
    ...(a.title !== undefined && s(back.title) !== a.title ? ['标题'] : []),
    ...(a.published !== undefined && (back.isPublished === true) !== a.published ? ['显示'] : []),
    ...(a.body_html !== undefined && plain(s(back.body)) !== plain(a.body_html as string)
      ? ['正文']
      : []),
  ]
  return {
    ref: { type: 'page', id },
    verified: off.length === 0,
    ...(off.length === 0 ? {} : { note: `读回来对不上：${off.join('、')}` }),
  }
}

function menuInput(items: readonly MenuItemOut[], withIds: boolean): Obj[] {
  return items.map((i) => ({
    ...(withIds && i.id !== undefined ? { id: i.id } : {}),
    title: i.title,
    type: i.type,
    ...(i.url === undefined ? {} : { url: i.url }),
    ...(i.resource_id === undefined ? {} : { resourceId: i.resource_id }),
    ...(i.items === undefined || i.items.length === 0
      ? {}
      : { items: menuInput(i.items, withIds) }),
  }))
}
const titlesOf = (items: readonly MenuItemOut[]): string[] =>
  items.flatMap((i) => [i.title, ...titlesOf(i.items ?? [])])

async function menuSave(ctx: ApplyContext, a: Obj, before: Obj, create: boolean): Promise<Applied> {
  const items = (a.items as MenuItemOut[] | undefined) ?? []
  let id = s(a.id)
  if (create) {
    const out = await run(
      ctx,
      'menu_create',
      MENU_CREATE,
      { title: a.title, handle: a.handle, items: menuInput(items, false) },
      'menuCreate',
    )
    id = s(o(out.menu).id)
    if (id === undefined) throw new ShopApplyError('Shopify 没回新菜单的 id')
  } else {
    const m = (await readMenus(ctx.admin)).find((x) => s(x.id) === id)
    if (m === undefined) throw new ShopApplyError('店里找不到这个菜单了')
    if (
      JSON.stringify(titlesOf(menuItemsOut(m.items))) !==
      JSON.stringify(titlesOf((before.items as MenuItemOut[] | undefined) ?? []))
    )
      stale('这个菜单')
    await run(
      ctx,
      'menu_update',
      MENU_UPDATE,
      { id, title: a.title, items: menuInput(items, true) },
      'menuUpdate',
    )
  }
  const back = (await readMenus(ctx.admin)).find((x) => s(x.id) === id)
  const ok =
    back !== undefined &&
    JSON.stringify(titlesOf(menuItemsOut(back.items))) === JSON.stringify(titlesOf(items))
  return {
    ref: { type: 'menu', id: id as string },
    verified: ok,
    ...(ok ? {} : { note: '菜单项读回来对不上' }),
  }
}

async function discountCreate(ctx: ApplyContext, a: Obj): Promise<Applied> {
  const value =
    typeof a.percent === 'number'
      ? { percentage: Math.round(a.percent * 100) / 10000 }
      : { discountAmount: { amount: money(a.amount_off as number), appliesOnEachItem: false } }
  const input: Obj = {
    title: a.title,
    code: a.code,
    startsAt: a.starts_at ?? ctx.now(),
    ...(a.ends_at === undefined ? {} : { endsAt: a.ends_at }),
    ...(a.usage_limit === undefined ? {} : { usageLimit: a.usage_limit }),
    appliesOncePerCustomer: a.once_per_customer === true,
    context: { all: 'ALL' },
    customerGets: { value, items: { all: true } },
    ...(typeof a.minimum_subtotal === 'number'
      ? {
          minimumRequirement: {
            subtotal: { greaterThanOrEqualToSubtotal: money(a.minimum_subtotal) },
          },
        }
      : {}),
  }
  const out = await run(
    ctx,
    'discount_create',
    DISCOUNT_CREATE,
    { input },
    'discountCodeBasicCreate',
  )
  const id = s(o(out.codeDiscountNode).id)
  const back = o(
    o(
      await ctx.admin.query({
        name: 'discount_by_code',
        document: DISCOUNT_BY_CODE,
        variables: { code: a.code },
      }),
    ).codeDiscountNodeByCode,
  )
  const ok = s(back.id) !== undefined && s(o(back.codeDiscount).title) === a.title
  return {
    ref: { type: 'discount', id: id ?? s(back.id) ?? `code:${String(a.code)}` },
    verified: ok,
    ...(ok ? {} : { note: '折扣读回来对不上' }),
  }
}

/** 批过的那一张 → 真改 + 读回。 */
export async function applyShopChange(ctx: ApplyContext, change: StagedChange): Promise<Applied> {
  const a = o(change.after)
  const before = o(change.before)
  switch (a.shop_op) {
    case 'product_create':
      return productCreate(ctx, a)
    case 'product_update':
      return productUpdate(ctx, a, before)
    case 'variant_price':
      return variantPrice(ctx, a, before)
    case 'product_status':
      return productStatus(ctx, a, before)
    case 'product_images':
      return productImages(ctx, a, before)
    case 'collection_create':
      return collectionCreate(ctx, a)
    case 'collection_update':
      return collectionUpdate(ctx, a, before)
    case 'page_create':
      return pageCreate(ctx, a)
    case 'page_update':
      return pageUpdate(ctx, a, before)
    case 'menu_create':
      return menuSave(ctx, a, before, true)
    case 'menu_update':
      return menuSave(ctx, a, before, false)
    case 'discount_create':
      return discountCreate(ctx, a)
    default:
      throw new ShopApplyError(`卡上的改动认不出：${String(a.shop_op)}`)
  }
}
