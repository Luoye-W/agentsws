/**
 * WP261：改动工具 → **一张卡的内容**（目标、原来、改成、标题、给人看的几行）。这里一个字节都不改店铺：
 * 「原来」是这一刻现读的（不是模型说的），出卡由 `shop-ops.ts` 经变更账本做。
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import type { ObjectRef } from '@agentsws/contracts'
import type { ShopifyAdminReader } from './shop-admin.js'
import type { ShopAccess } from './shop-auth.js'
import {
  arr,
  DISCOUNT_BY_CODE,
  type MenuItemOut,
  menuItemsOut,
  menuItemType,
  nodes,
  o,
  s,
} from './shop-graphql.js'
import {
  gidOf,
  idList,
  num,
  type ReadLog,
  readCollection,
  readMenus,
  readPage,
  readProduct,
  SHOP_VIA,
  type ShopOp,
  ShopOpsError,
  str,
} from './shop-ops.js'

export interface ShopDraft {
  op: ShopOp
  target: ObjectRef
  field?: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  title: string
  notes: string[]
  /** 新建的东西没有可读的原文：出卡时把这个假目标记成「读过」。 */
  synthetic?: boolean
}

export interface ProposeContext {
  reader: ShopifyAdminReader
  access: ShopAccess
  log: ReadLog
  run_id: string
  fileRoots: string[]
  /**
   * WP267（决策 198）：设计岗素材库里一张图 → 本机文件路径（素材的字节在本机对象存储里，明文、带图片扩展名）。
   * 找不到 / 还没生成 / 被驳回 / 对象存储不在本机 = undefined。路径照样要过 {@link localImage}（目录在 `fileRoots` 里）。
   */
  assetFile?: (asset_id: string) => string | undefined
}

const IMAGE_EXT: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_HTML = 64 * 1024

const short = (t: string | undefined, n = 60): string =>
  t === undefined ? '（空）' : t.length > n ? `${t.slice(0, n)}…` : t
const plain = (html: string | undefined): string | undefined =>
  html
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function mustHaveRead(ctx: ProposeContext, ref: ObjectRef, how: string): void {
  if (!ctx.log.has(ctx.run_id, ref))
    throw new ShopOpsError(
      'must_read_first',
      `改之前先用 ${how} 读一遍（改前必读：卡上的「原来」要是真读到的）。`,
    )
}

/** 本机图片：只许在本品牌的文件夹里、只认真图片（看文件头）、不超过 20 MB。 */
export function localImage(
  raw: string,
  roots: readonly string[],
): { file: string; name: string; mime: string; bytes: number } {
  const ext = extname(raw).toLowerCase()
  const mime = IMAGE_EXT[ext]
  if (mime === undefined)
    throw new ShopOpsError('invalid_input', '只收 jpg / png / webp / gif 图片')
  if (!isAbsolute(raw)) throw new ShopOpsError('invalid_input', '本机图片要给完整路径')
  let real: string
  try {
    real = realpathSync(resolve(raw))
  } catch {
    throw new ShopOpsError('invalid_input', `找不到这个文件：${basename(raw)}`)
  }
  const inside = roots.some((r) => {
    try {
      const rel = relative(realpathSync(r), real)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    } catch {
      return false
    }
  })
  if (!inside) throw new ShopOpsError('invalid_input', '这个文件不在本品牌的文件夹里，不能传')
  const st = statSync(real)
  if (!st.isFile()) throw new ShopOpsError('invalid_input', '这不是一个文件')
  if (st.size > MAX_IMAGE_BYTES) throw new ShopOpsError('invalid_input', '图片超过 20 MB')
  const head = Buffer.alloc(12)
  const fd = openSync(real, 'r')
  try {
    readSync(fd, head, 0, 12, 0)
  } finally {
    closeSync(fd)
  }
  const isImage =
    (head[0] === 0xff && head[1] === 0xd8) ||
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    head.subarray(0, 3).toString('latin1') === 'GIF' ||
    (head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP')
  if (!isImage) throw new ShopOpsError('invalid_input', `${basename(real)} 不是图片文件`)
  return { file: real, name: basename(real), mime, bytes: st.size }
}

function httpsUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ShopOpsError('invalid_input', '图片网址认不出')
  }
  if (u.protocol !== 'https:') throw new ShopOpsError('invalid_input', '图片网址要 https 开头')
  return u.toString()
}

function tagsOf(v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ShopOpsError('invalid_input', '标签要给一个列表')
  const out = v.map((x) => str(x, 255)).filter((x): x is string => x !== undefined)
  if (out.length > 250) throw new ShopOpsError('invalid_input', '标签太多了')
  return [...new Set(out)]
}

const base = (store: string, op: ShopOp) => ({ via: SHOP_VIA, shop_op: op, store })

async function saveProduct(
  ctx: ProposeContext,
  input: Record<string, unknown>,
): Promise<ShopDraft> {
  const id = input.id === undefined ? undefined : gidOf('Product', input.id)
  if (input.id !== undefined && id === undefined)
    throw new ShopOpsError('invalid_input', '商品 id 认不出')
  const fields = {
    title: str(input.title),
    description_html: str(input.description_html, MAX_HTML),
    product_type: str(input.product_type),
    vendor: str(input.vendor),
    tags: tagsOf(input.tags),
  }
  if (id === undefined) {
    if (fields.title === undefined) throw new ShopOpsError('invalid_input', '建新商品要给 title')
    const price = num(input.price)
    if (price !== undefined && price <= 0) throw new ShopOpsError('invalid_input', '价格要大于 0')
    const compare = num(input.compare_at_price)
    const options = arr(input.options).map((x) => ({
      name: str(x.name, 100) ?? '',
      values: (Array.isArray(x.values) ? x.values : [])
        .map((v) => str(v, 100))
        .filter((v): v is string => v !== undefined),
    }))
    if (options.some((x) => x.name === '' || x.values.length === 0))
      throw new ShopOpsError('invalid_input', '每个规格要有名字和至少一个值')
    if (options.length > 3) throw new ShopOpsError('invalid_input', '规格最多 3 个')
    const combos = options.reduce((n, x) => n * x.values.length, 1)
    if (combos > 100) throw new ShopOpsError('invalid_input', '规格组合最多 100 个')
    const after = {
      ...base(ctx.access.store, 'product_create'),
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
      status: 'DRAFT',
      ...(price === undefined ? {} : { price }),
      ...(compare === undefined || compare <= 0 ? {} : { compare_at_price: compare }),
      ...(str(input.sku, 255) === undefined ? {} : { sku: str(input.sku, 255) }),
      ...(options.length === 0 ? {} : { options }),
    }
    const handle = fields.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
    return {
      op: 'product_create',
      target: { type: 'product', id: `new:${handle === '' ? 'product' : handle}:${ctx.run_id}` },
      before: {},
      after,
      synthetic: true,
      title: `新建商品「${short(fields.title, 40)}」（先存草稿）`,
      notes: [
        '建好是草稿：顾客看不到，上架要另批一张卡。',
        ...(price === undefined
          ? ['价格：没给（先是 0，上架前要改）']
          : [
              `价格：${price}${compare !== undefined && compare > 0 ? `（划线价 ${compare}）` : ''}`,
            ]),
        ...(options.length === 0
          ? []
          : [
              `规格：${options.map((x) => `${x.name}（${x.values.join(' / ')}）`).join('，')}，共 ${combos} 个变体`,
            ]),
        ...(fields.description_html === undefined
          ? []
          : [`描述：${short(plain(fields.description_html), 120)}`]),
        ...(fields.tags === undefined ? [] : [`标签：${fields.tags.join('、')}`]),
      ],
    }
  }
  if (input.price !== undefined || input.options !== undefined || input.sku !== undefined)
    throw new ShopOpsError(
      'invalid_input',
      '改已有商品的价格用 shop_set_price；规格与 SKU 这里不改',
    )
  mustHaveRead(ctx, { type: 'product', id }, 'shop_get_product')
  const p = await readProduct(ctx.reader, ctx.access, id)
  const now: Record<string, unknown> = {
    title: s(p.title),
    description_html: s(p.descriptionHtml),
    product_type: s(p.productType),
    vendor: s(p.vendor),
    tags: Array.isArray(p.tags) ? p.tags : [],
  }
  const changed = Object.entries(fields).filter(
    ([k, v]) => v !== undefined && JSON.stringify(v) !== JSON.stringify(now[k]),
  )
  if (changed.length === 0) throw new ShopOpsError('invalid_input', '跟店里现在的一样，没什么可改')
  const NAME: Record<string, string> = {
    title: '标题',
    description_html: '描述',
    product_type: '类型',
    vendor: '品牌',
    tags: '标签',
  }
  const show = (k: string, v: unknown): string =>
    k === 'description_html'
      ? short(plain(v as string), 120)
      : Array.isArray(v)
        ? v.join('、') || '（无）'
        : short(v as string | undefined)
  return {
    op: 'product_update',
    target: { type: 'product', id },
    field: changed.length === 1 ? (changed[0]?.[0] as string) : 'listing',
    before: Object.fromEntries(changed.map(([k]) => [k, now[k] ?? null])),
    after: {
      ...base(ctx.access.store, 'product_update'),
      id,
      product_title: s(p.title),
      ...Object.fromEntries(changed),
    },
    title: `改商品「${short(s(p.title), 40)}」：${changed.map(([k]) => NAME[k]).join('、')}`,
    notes: changed.map(([k, v]) => `${NAME[k]}：${show(k, now[k])} → ${show(k, v)}`),
  }
}

async function setPrice(ctx: ProposeContext, input: Record<string, unknown>): Promise<ShopDraft> {
  const id = gidOf('Product', input.product_id)
  if (id === undefined) throw new ShopOpsError('invalid_input', '要给商品 id')
  const price = num(input.price)
  if (price === undefined || price <= 0) throw new ShopOpsError('invalid_input', '新价格要大于 0')
  mustHaveRead(ctx, { type: 'product', id }, 'shop_get_product')
  const p = await readProduct(ctx.reader, ctx.access, id)
  const variants = nodes(p.variants)
  const wanted =
    input.variant_id === undefined ? undefined : gidOf('ProductVariant', input.variant_id)
  const v =
    wanted !== undefined
      ? variants.find((x) => x.id === wanted)
      : variants.length === 1
        ? variants[0]
        : undefined
  if (v === undefined)
    throw new ShopOpsError(
      'invalid_input',
      wanted === undefined
        ? `这件商品有 ${variants.length} 个变体，要给 variant_id`
        : '这件商品里没有这个变体',
    )
  const before = Number(s(v.price))
  const compareIn = num(input.compare_at_price)
  const pct =
    Number.isFinite(before) && before > 0
      ? Math.round(((price - before) / before) * 1000) / 10
      : undefined
  const label = s(v.title) === 'Default Title' || s(v.title) === undefined ? '' : ` · ${s(v.title)}`
  return {
    op: 'variant_price',
    target: { type: 'product', id },
    field: 'price',
    before: {
      price: before,
      compare_at_price: s(v.compareAtPrice) === undefined ? null : Number(s(v.compareAtPrice)),
    },
    after: {
      ...base(ctx.access.store, 'variant_price'),
      product_id: id,
      variant_id: s(v.id),
      product_title: s(p.title),
      price,
      ...(compareIn === undefined ? {} : { compare_at_price: compareIn <= 0 ? null : compareIn }),
    },
    title: `改价：「${short(s(p.title), 30)}${label}」${s(v.price)} → ${price}${pct === undefined ? '' : `（${pct > 0 ? '+' : ''}${pct}%）`}`,
    notes: [
      `价格：${s(v.price)} → ${price}`,
      ...(compareIn === undefined
        ? []
        : [
            `划线价：${s(v.compareAtPrice) ?? '（无）'} → ${compareIn <= 0 ? '（去掉）' : compareIn}`,
          ]),
    ],
  }
}

const STATUS: Record<string, { api: string; zh: string }> = {
  active: { api: 'ACTIVE', zh: '上架' },
  draft: { api: 'DRAFT', zh: '下架（存草稿）' },
  archived: { api: 'ARCHIVED', zh: '归档' },
}

async function setStatus(ctx: ProposeContext, input: Record<string, unknown>): Promise<ShopDraft> {
  const id = gidOf('Product', input.product_id)
  if (id === undefined) throw new ShopOpsError('invalid_input', '要给商品 id')
  const want = STATUS[String(input.status)]
  if (want === undefined)
    throw new ShopOpsError('invalid_input', 'status 只能是 active / draft / archived')
  const p = await readProduct(ctx.reader, ctx.access, id)
  if (s(p.status) === want.api)
    throw new ShopOpsError('invalid_input', `这件商品已经是「${want.zh}」了`)
  return {
    op: 'product_status',
    target: { type: 'product', id },
    field: 'status',
    before: { status: s(p.status) },
    after: {
      ...base(ctx.access.store, 'product_status'),
      product_id: id,
      product_title: s(p.title),
      status: want.api,
    },
    title: `${want.zh}商品「${short(s(p.title), 40)}」`,
    notes: [
      want.api === 'ACTIVE'
        ? '上架后顾客就能在网店里看到并下单（也会挂到网店渠道）。'
        : want.api === 'DRAFT'
          ? '下架后顾客看不到这件商品，商品资料都还在。'
          : '归档后它从商品列表里收起来（不删），要用再改回草稿。',
      `现在是：${s(p.status)?.toLowerCase() ?? '未知'}`,
    ],
  }
}

async function addImages(ctx: ProposeContext, input: Record<string, unknown>): Promise<ShopDraft> {
  const id = gidOf('Product', input.product_id)
  if (id === undefined) throw new ShopOpsError('invalid_input', '要给商品 id')
  const list = arr(input.images)
  if (list.length === 0 || list.length > 10)
    throw new ShopOpsError('invalid_input', '一次加 1 到 10 张图')
  const images = list.map((x) => {
    const alt = str(x.alt, 512)
    const url = str(x.url, 2048)
    const asset = str(x.asset_id, 128)
    let file = str(x.file, 1024)
    if ([url, file, asset].filter((v) => v !== undefined).length !== 1)
      throw new ShopOpsError('invalid_input', '每张图给 url、file、asset_id 其中一个')
    if (url !== undefined) return { url: httpsUrl(url), ...(alt === undefined ? {} : { alt }) }
    if (asset !== undefined) {
      // WP267（决策 198）：设计岗素材库里的图——按素材 id 找到本机那份文件，再过同一道检查
      file = ctx.assetFile?.(asset)
      if (file === undefined)
        throw new ShopOpsError(
          'invalid_input',
          `素材库里找不到这张图（${asset}）：可能还没生成出来、被驳回了，或素材存在云存储上`,
        )
    }
    const local = localImage(file as string, ctx.fileRoots)
    return { ...local, ...(alt === undefined ? {} : { alt }) }
  })
  mustHaveRead(ctx, { type: 'product', id }, 'shop_get_product')
  const p = await readProduct(ctx.reader, ctx.access, id)
  const count = nodes(p.media).length
  return {
    op: 'product_images',
    target: { type: 'product', id },
    field: 'media',
    before: { images: count },
    after: {
      ...base(ctx.access.store, 'product_images'),
      product_id: id,
      product_title: s(p.title),
      images,
    },
    title: `给商品「${short(s(p.title), 40)}」加 ${images.length} 张图`,
    notes: images.map(
      (x, i) =>
        `第 ${i + 1} 张：${'url' in x ? x.url : `本机文件 ${x.name}`}${x.alt === undefined ? '' : `（${x.alt}）`}`,
    ),
  }
}

async function saveCollection(
  ctx: ProposeContext,
  input: Record<string, unknown>,
): Promise<ShopDraft> {
  const id = input.id === undefined ? undefined : gidOf('Collection', input.id)
  if (input.id !== undefined && id === undefined)
    throw new ShopOpsError('invalid_input', '合集 id 认不出')
  const title = str(input.title)
  const description_html = str(input.description_html, MAX_HTML)
  const add = idList('Product', input.add_product_ids, 20)
  const remove = idList('Product', input.remove_product_ids, 20)
  if (id === undefined) {
    if (title === undefined) throw new ShopOpsError('invalid_input', '建新合集要给 title')
    return {
      op: 'collection_create',
      target: { type: 'collection', id: `new:${ctx.run_id}` },
      synthetic: true,
      before: {},
      after: {
        ...base(ctx.access.store, 'collection_create'),
        title,
        ...(description_html === undefined ? {} : { description_html }),
        products: add,
      },
      title: `新建合集「${short(title, 40)}」${add.length === 0 ? '' : `，放进 ${add.length} 件商品`}`,
      notes: [
        '手动挑选的合集；网店菜单里要不要挂另说。',
        ...(description_html === undefined ? [] : [`描述：${short(plain(description_html), 120)}`]),
      ],
    }
  }
  mustHaveRead(ctx, { type: 'collection', id }, 'shop_get_collection')
  const c = await readCollection(ctx.reader, id)
  if ((add.length > 0 || remove.length > 0) && c.ruleSet !== null && c.ruleSet !== undefined)
    throw new ShopOpsError('invalid_input', '这个合集是按条件自动收商品的，不能手动加减')
  const inside = new Set(nodes(c.products).map((p) => s(p.id)))
  const toAdd = add.filter((x) => !inside.has(x))
  const toRemove = remove.filter((x) => inside.has(x))
  const changes: Record<string, unknown> = {}
  if (title !== undefined && title !== s(c.title)) changes.title = title
  if (description_html !== undefined && description_html !== s(c.descriptionHtml))
    changes.description_html = description_html
  if (Object.keys(changes).length === 0 && toAdd.length === 0 && toRemove.length === 0)
    throw new ShopOpsError('invalid_input', '跟店里现在的一样，没什么可改')
  return {
    op: 'collection_update',
    target: { type: 'collection', id },
    before: {
      title: s(c.title),
      description_html: s(c.descriptionHtml) ?? null,
      count: inside.size,
    },
    after: {
      ...base(ctx.access.store, 'collection_update'),
      id,
      collection_title: s(c.title),
      ...changes,
      add: toAdd,
      remove: toRemove,
      products: [...toAdd, ...toRemove],
    },
    title: `改合集「${short(s(c.title), 40)}」${[toAdd.length > 0 ? `加 ${toAdd.length} 件` : '', toRemove.length > 0 ? `拿掉 ${toRemove.length} 件` : '', changes.title !== undefined ? '改标题' : '', changes.description_html !== undefined ? '改描述' : ''].filter(Boolean).join('、')}`,
    notes: [
      ...(changes.title === undefined ? [] : [`标题：${s(c.title)} → ${changes.title as string}`]),
      ...(changes.description_html === undefined
        ? []
        : [
            `描述：${short(plain(s(c.descriptionHtml)), 80)} → ${short(plain(changes.description_html as string), 80)}`,
          ]),
      ...(toAdd.length === 0 ? [] : [`加进来：${toAdd.length} 件商品`]),
      ...(toRemove.length === 0 ? [] : [`拿掉：${toRemove.length} 件商品（商品本身不删）`]),
    ],
  }
}

async function savePage(ctx: ProposeContext, input: Record<string, unknown>): Promise<ShopDraft> {
  const id = input.id === undefined ? undefined : gidOf('Page', input.id)
  if (input.id !== undefined && id === undefined)
    throw new ShopOpsError('invalid_input', '页面 id 认不出')
  const title = str(input.title)
  const body_html = str(input.body_html, MAX_HTML)
  const published = typeof input.published === 'boolean' ? input.published : undefined
  if (id === undefined) {
    if (title === undefined) throw new ShopOpsError('invalid_input', '建新页面要给 title')
    const handle = str(input.handle, 100)
    if (handle !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(handle))
      throw new ShopOpsError('invalid_input', 'handle 只能是小写字母、数字和短横线')
    return {
      op: 'page_create',
      target: { type: 'page', id: `new:${ctx.run_id}` },
      synthetic: true,
      before: {},
      after: {
        ...base(ctx.access.store, 'page_create'),
        title,
        ...(body_html === undefined ? {} : { body_html }),
        ...(handle === undefined ? {} : { handle }),
        published: published ?? false,
      },
      title: `新建页面「${short(title, 40)}」${published === true ? '（建好就显示）' : '（先不显示）'}`,
      notes: [
        ...(body_html === undefined ? ['正文：空'] : [`正文：${short(plain(body_html), 160)}`]),
        ...(handle === undefined ? [] : [`网址：/pages/${handle}`]),
      ],
    }
  }
  mustHaveRead(ctx, { type: 'page', id }, 'shop_get_page')
  const p = await readPage(ctx.reader, id)
  const changes: Record<string, unknown> = {}
  if (title !== undefined && title !== s(p.title)) changes.title = title
  if (body_html !== undefined && body_html !== s(p.body)) changes.body_html = body_html
  if (published !== undefined && published !== p.isPublished) changes.published = published
  if (Object.keys(changes).length === 0)
    throw new ShopOpsError('invalid_input', '跟店里现在的一样，没什么可改')
  const NAME: Record<string, string> = { title: '标题', body_html: '正文', published: '显示' }
  return {
    op: 'page_update',
    target: { type: 'page', id },
    field: Object.keys(changes).length === 1 ? (Object.keys(changes)[0] as string) : 'page',
    before: { title: s(p.title), body_html: s(p.body) ?? null, published: p.isPublished === true },
    after: { ...base(ctx.access.store, 'page_update'), id, page_title: s(p.title), ...changes },
    title: `改页面「${short(s(p.title), 40)}」：${Object.keys(changes)
      .map((k) => NAME[k])
      .join('、')}`,
    notes: [
      ...(changes.title === undefined ? [] : [`标题：${s(p.title)} → ${changes.title as string}`]),
      ...(changes.body_html === undefined
        ? []
        : [
            `正文：${short(plain(s(p.body)), 80)} → ${short(plain(changes.body_html as string), 120)}`,
          ]),
      ...(changes.published === undefined
        ? []
        : [
            `顾客看不看得到：${p.isPublished === true ? '看得到' : '看不到'} → ${changes.published === true ? '看得到' : '看不到'}`,
          ]),
    ],
  }
}

/** 菜单项：最多三级、一共最多 100 项；类型按指向推（见 `menuItemType`）。 */
export function menuItemsIn(v: unknown, depth = 1, counter = { n: 0 }): MenuItemOut[] {
  if (!Array.isArray(v)) throw new ShopOpsError('invalid_input', '菜单项要给一个列表')
  if (depth > 3) throw new ShopOpsError('invalid_input', '菜单最多三级')
  return v.map((raw) => {
    counter.n += 1
    if (counter.n > 100) throw new ShopOpsError('invalid_input', '菜单项最多 100 个')
    const x = o(raw)
    const title = str(x.title, 255)
    if (title === undefined) throw new ShopOpsError('invalid_input', '每个菜单项要有 title')
    const url = str(x.url, 2048)
    const resource_id = str(x.resource_id, 200)
    if (resource_id !== undefined && !/^gid:\/\/shopify\/\w+\/\d+$/.test(resource_id))
      throw new ShopOpsError('invalid_input', `菜单项「${title}」的 resource_id 认不出`)
    const type = menuItemType({
      ...(url === undefined ? {} : { url }),
      ...(resource_id === undefined ? {} : { resource_id }),
      ...(str(x.type, 40) === undefined ? {} : { type: str(x.type, 40) as string }),
    })
    if (type === 'HTTP' && url === undefined)
      throw new ShopOpsError('invalid_input', `菜单项「${title}」要给 url 或 resource_id`)
    const kids = x.items === undefined ? [] : menuItemsIn(x.items, depth + 1, counter)
    const id = str(x.id, 200)
    return {
      ...(id === undefined ? {} : { id }),
      title,
      type,
      ...(url === undefined ? {} : { url }),
      ...(resource_id === undefined ? {} : { resource_id }),
      ...(kids.length === 0 ? {} : { items: kids }),
    }
  })
}

const flatTitles = (items: readonly MenuItemOut[], prefix = ''): string[] =>
  items.flatMap((i) => [
    `${prefix}${i.title}`,
    ...flatTitles(i.items ?? [], `${prefix}${i.title} › `),
  ])

async function saveMenu(ctx: ProposeContext, input: Record<string, unknown>): Promise<ShopDraft> {
  const items = menuItemsIn(input.items)
  const id = input.id === undefined ? undefined : gidOf('Menu', input.id)
  if (input.id !== undefined && id === undefined)
    throw new ShopOpsError('invalid_input', '菜单 id 认不出')
  const title = str(input.title)
  if (id === undefined) {
    const handle = str(input.handle, 100)
    if (title === undefined || handle === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(handle))
      throw new ShopOpsError(
        'invalid_input',
        '建新菜单要给 title 与 handle（小写字母、数字、短横线）',
      )
    return {
      op: 'menu_create',
      target: { type: 'menu', id: `new:${handle}` },
      synthetic: true,
      before: {},
      after: { ...base(ctx.access.store, 'menu_create'), title, handle, items },
      title: `新建菜单「${short(title, 40)}」（${flatTitles(items).length} 项）`,
      notes: [`菜单项：${flatTitles(items).join('、')}`, '新菜单要在主题里挂上才会显示。'],
    }
  }
  mustHaveRead(ctx, { type: 'menu', id }, 'shop_list_menus')
  const menu = (await readMenus(ctx.reader)).find((m) => s(m.id) === id)
  if (menu === undefined) throw new ShopOpsError('not_found', '店里找不到这个菜单')
  const old = menuItemsOut(menu.items)
  const oldTitles = flatTitles(old)
  const newTitles = flatTitles(items)
  const nextTitle = title ?? s(menu.title) ?? ''
  if (
    JSON.stringify(oldTitles) === JSON.stringify(newTitles) &&
    nextTitle === s(menu.title) &&
    JSON.stringify(stripIds(old)) === JSON.stringify(stripIds(items))
  )
    throw new ShopOpsError('invalid_input', '跟店里现在的一样，没什么可改')
  const gone = oldTitles.filter((t) => !newTitles.includes(t))
  const added = newTitles.filter((t) => !oldTitles.includes(t))
  return {
    op: 'menu_update',
    target: { type: 'menu', id },
    field: 'items',
    before: { title: s(menu.title), items: old },
    after: { ...base(ctx.access.store, 'menu_update'), id, title: nextTitle, items },
    title: `改菜单「${short(s(menu.title), 30)}」${added.length > 0 ? `：加 ${added.length} 项` : ''}${gone.length > 0 ? `${added.length > 0 ? '、' : '：'}去掉 ${gone.length} 项` : ''}${added.length === 0 && gone.length === 0 ? '：调整顺序 / 链接' : ''}`,
    notes: [
      `改之后：${newTitles.join('、') || '（空）'}`,
      ...(added.length === 0 ? [] : [`新加：${added.join('、')}`]),
      ...(gone.length === 0 ? [] : [`去掉：${gone.join('、')}`]),
      '整份替换：卡上没列的项会从菜单里拿掉。',
    ],
  }
}

const stripIds = (items: readonly MenuItemOut[]): unknown =>
  items.map((i) => ({
    title: i.title,
    type: i.type,
    url: i.url,
    resource_id: i.resource_id,
    items: stripIds(i.items ?? []),
  }))

async function createDiscount(
  ctx: ProposeContext,
  input: Record<string, unknown>,
): Promise<ShopDraft> {
  const title = str(input.title)
  const code = str(input.code, 50)
  if (title === undefined || code === undefined || !/^[A-Za-z0-9_-]{3,50}$/.test(code))
    throw new ShopOpsError(
      'invalid_input',
      '要给 title 与 code（3–50 位字母、数字、下划线或短横线）',
    )
  const percent = num(input.percent)
  const amount_off = num(input.amount_off)
  if ((percent === undefined) === (amount_off === undefined))
    throw new ShopOpsError('invalid_input', 'percent（减百分之几）与 amount_off（减多少钱）给一个')
  if (percent !== undefined && (percent <= 0 || percent > 100))
    throw new ShopOpsError('invalid_input', 'percent 要在 0–100 之间')
  if (amount_off !== undefined && amount_off <= 0)
    throw new ShopOpsError('invalid_input', 'amount_off 要大于 0')
  const startsIn = str(input.starts_at, 40)
  const endsIn = str(input.ends_at, 40)
  const starts_at = startsIn === undefined ? undefined : new Date(startsIn)
  const ends_at = endsIn === undefined ? undefined : new Date(endsIn)
  if (starts_at !== undefined && Number.isNaN(starts_at.getTime()))
    throw new ShopOpsError('invalid_input', 'starts_at 认不出')
  if (ends_at !== undefined && Number.isNaN(ends_at.getTime()))
    throw new ShopOpsError('invalid_input', 'ends_at 认不出')
  if (starts_at !== undefined && ends_at !== undefined && ends_at <= starts_at)
    throw new ShopOpsError('invalid_input', '结束时间要晚于开始时间')
  const usage = num(input.usage_limit)
  if (usage !== undefined && (!Number.isInteger(usage) || usage <= 0))
    throw new ShopOpsError('invalid_input', 'usage_limit 要是正整数')
  const minimum = num(input.minimum_subtotal)
  const existing = o(
    o(
      await ctx.reader.query({
        name: 'discount_by_code',
        document: DISCOUNT_BY_CODE,
        variables: { code },
      }),
    ).codeDiscountNodeByCode,
  )
  if (existing.id !== undefined)
    throw new ShopOpsError('invalid_input', `折扣码 ${code} 店里已经有了`)
  const once = input.once_per_customer === true
  const power = percent !== undefined ? `减 ${percent}%` : `每单减 ${amount_off}`
  return {
    op: 'discount_create',
    target: { type: 'discount', id: `code:${code.toUpperCase()}` },
    before: {},
    after: {
      ...base(ctx.access.store, 'discount_create'),
      title,
      code,
      ...(percent === undefined ? {} : { percent }),
      ...(amount_off === undefined ? {} : { amount_off }),
      ...(starts_at === undefined ? {} : { starts_at: starts_at.toISOString() }),
      ...(ends_at === undefined ? {} : { ends_at: ends_at.toISOString() }),
      ...(usage === undefined ? {} : { usage_limit: usage }),
      once_per_customer: once,
      ...(minimum === undefined || minimum <= 0 ? {} : { minimum_subtotal: minimum }),
    },
    title: `新建折扣码 ${code}：${power}${usage === undefined ? '，不限次数' : `，限 ${usage} 次`}`,
    notes: [
      `力度：${power}${minimum !== undefined && minimum > 0 ? `（满 ${minimum} 可用）` : ''}`,
      `时间：${starts_at === undefined ? '批了马上' : starts_at.toISOString().slice(0, 16).replace('T', ' ')} 起，${ends_at === undefined ? '不设结束' : `到 ${ends_at.toISOString().slice(0, 16).replace('T', ' ')}`}`,
      `次数：${usage === undefined ? '不限（会转人审）' : `一共 ${usage} 次`}${once ? '，每位顾客一次' : ''}`,
    ],
  }
}

/** 改动工具 → 卡的内容。 */
export async function draftOf(
  tool: string,
  ctx: ProposeContext,
  input: Record<string, unknown>,
): Promise<ShopDraft> {
  switch (tool) {
    case 'shop_save_product':
      return saveProduct(ctx, input)
    case 'shop_set_price':
      return setPrice(ctx, input)
    case 'shop_set_product_status':
      return setStatus(ctx, input)
    case 'shop_add_product_images':
      return addImages(ctx, input)
    case 'shop_save_collection':
      return saveCollection(ctx, input)
    case 'shop_save_page':
      return savePage(ctx, input)
    case 'shop_save_menu':
      return saveMenu(ctx, input)
    case 'shop_create_discount':
      return createDiscount(ctx, input)
    default:
      throw new ShopOpsError('not_allowed', `不认识的改动：${tool}`)
  }
}
