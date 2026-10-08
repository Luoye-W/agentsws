/**
 * WP268（决策 213）：**店铺「文件」**与**商品图**那几条写死的 Admin GraphQL，以及「传一张图到店铺文件」的三步。
 *
 * 单独一个文件（不进 `shop-graphql.ts`）：WP267 同时在改那一份，两单各管各的。
 *
 * 传图（只在人挑中、批过之后由执行器调；`ShopifyAdmin.mutate` 只给执行器）：
 * 1. `stagedUploadsCreate`（`resource: IMAGE`）拿临时地址与表单参数；
 * 2. 我们的服务进程按它给的参数把字节 POST 过去（签名地址，不带任何令牌）；
 * 3. `fileCreate(originalSource: resourceUrl, contentType: IMAGE, filename)` → 轮询 `fileStatus` 到 `READY` 拿 CDN 地址。
 *
 * 主题 JSON 里引用店铺文件图片的写法是 `shopify://shop_images/<文件名>`（真店主题文件里就是这样存的）。
 * 文件名撞了 Shopify 默认会在后面加一段（`APPEND_UUID`），所以**以读回来的 CDN 地址里的文件名为准**。
 */
import { shopImageRef } from '@agentsws/contracts'
import type { ShopifyAdmin, ShopifyAdminReader } from './shop-admin.js'
import { STAGED_UPLOADS } from './shop-graphql.js'

type Obj = Record<string, unknown>
const o = (v: unknown): Obj => (v !== null && typeof v === 'object' ? (v as Obj) : {})
const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const USER_ERRORS = 'userErrors { field message }'

export const FILE_CREATE = `mutation AgentswsFileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) { files { id fileStatus alt ... on MediaImage { image { url } } } ${USER_ERRORS} }
}`

export const FILE_STATUS = `query AgentswsFileStatus($id: ID!) {
  node(id: $id) { id ... on MediaImage { fileStatus image { url width height } } ... on GenericFile { fileStatus url } }
}`

export const PRODUCT_IMAGES = `query AgentswsProductImages($id: ID!) {
  product(id: $id) { id title media(first: 10) { nodes { mediaContentType ... on MediaImage { image { url width height } } preview { image { url } } } } }
}`

export class ShopFileError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ShopFileError'
  }
}

/** 店里某件商品的图（最多 `max` 张；只读，经 `ShopifyAdmin.query`）。 */
export async function productImageUrls(
  reader: Pick<ShopifyAdminReader, 'query'>,
  product_id: string,
  max = 2,
): Promise<{ title?: string; urls: string[] }> {
  const data = o(
    await reader.query({
      name: 'product_images',
      document: PRODUCT_IMAGES,
      variables: { id: product_id },
    }),
  )
  const product = o(data.product)
  if (s(product.id) === undefined) throw new ShopFileError(`店里没找到这件商品（${product_id}）`)
  const nodes = Array.isArray(o(product.media).nodes) ? (o(product.media).nodes as unknown[]) : []
  const urls: string[] = []
  for (const n of nodes) {
    const url = s(o(o(n).image).url) ?? s(o(o(o(n).preview).image).url)
    if (url !== undefined && o(n).mediaContentType !== 'VIDEO') urls.push(url)
    if (urls.length >= max) break
  }
  const title = s(product.title)
  return { ...(title === undefined ? {} : { title }), urls }
}

/** CDN 地址里的文件名（去掉查询串）。 */
export function filenameOfUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').pop()
    return last === undefined || last === '' ? undefined : decodeURIComponent(last)
  } catch {
    return undefined
  }
}

export interface UploadedShopFile {
  id: string
  filename: string
  theme_ref: string
  url?: string
}

export type UploadFetch = (
  url: string,
  init: { method: string; body: FormData },
) => Promise<{ ok: boolean; status: number }>

/**
 * 一张图 → 店铺「文件」。`waitMs` 内等到 `READY` 就带 CDN 地址回来；等不到也回（Shopify 还在处理，
 * 文件名按我们给的那个算）。
 */
export async function uploadShopFile(
  ctx: {
    admin: Pick<ShopifyAdmin, 'mutate' | 'query'>
    fetch: UploadFetch
    sleep?: (ms: number) => Promise<void>
  },
  file: { bytes: Uint8Array; content_type: string; filename: string; alt?: string },
  opts: { polls?: number; intervalMs?: number } = {},
): Promise<UploadedShopFile> {
  const staged = o(
    o(
      await ctx.admin.mutate({
        name: 'staged_uploads',
        document: STAGED_UPLOADS,
        variables: {
          input: [
            {
              resource: 'IMAGE',
              filename: file.filename,
              mimeType: file.content_type,
              httpMethod: 'POST',
              fileSize: String(file.bytes.length),
            },
          ],
        },
      }),
    ).stagedUploadsCreate,
  )
  const errs = userErrorsOf(staged)
  if (errs !== undefined) throw new ShopFileError(`Shopify 没给上传地址：${errs}`)
  const target = o((staged.stagedTargets as unknown[] | undefined)?.[0])
  const url = s(target.url)
  const resourceUrl = s(target.resourceUrl)
  if (url === undefined || resourceUrl === undefined)
    throw new ShopFileError('Shopify 没给上传地址', true)
  const form = new FormData()
  for (const p of Array.isArray(target.parameters) ? target.parameters : []) {
    const name = s(o(p).name)
    const value = s(o(p).value)
    if (name !== undefined && value !== undefined) form.append(name, value)
  }
  form.append(
    'file',
    new Blob([new Uint8Array(file.bytes)], { type: file.content_type }),
    file.filename,
  )
  const res = await ctx.fetch(url, { method: 'POST', body: form })
  if (!res.ok) throw new ShopFileError(`图片没传上去（${res.status}）`, true)

  const created = o(
    o(
      await ctx.admin.mutate({
        name: 'file_create',
        document: FILE_CREATE,
        variables: {
          files: [
            {
              originalSource: resourceUrl,
              contentType: 'IMAGE',
              filename: file.filename,
              ...(file.alt === undefined ? {} : { alt: file.alt.slice(0, 500) }),
            },
          ],
        },
      }),
    ).fileCreate,
  )
  const errs2 = userErrorsOf(created)
  if (errs2 !== undefined) throw new ShopFileError(`Shopify 没收下这张图：${errs2}`)
  const made = o((created.files as unknown[] | undefined)?.[0])
  const id = s(made.id)
  if (id === undefined) throw new ShopFileError('Shopify 没回文件 id', true)
  let cdn = s(o(made.image).url)
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  for (let i = 0; cdn === undefined && i < (opts.polls ?? 10); i += 1) {
    await sleep(opts.intervalMs ?? 1500)
    const node = o(
      o(await ctx.admin.query({ name: 'file_status', document: FILE_STATUS, variables: { id } }))
        .node,
    )
    if (node.fileStatus === 'FAILED')
      throw new ShopFileError('Shopify 处理这张图失败了（文件状态 FAILED）')
    if (node.fileStatus === 'READY') cdn = s(o(node.image).url) ?? s(node.url)
  }
  const filename = (cdn === undefined ? undefined : filenameOfUrl(cdn)) ?? file.filename
  return {
    id,
    filename,
    theme_ref: shopImageRef(filename),
    ...(cdn === undefined ? {} : { url: cdn }),
  }
}

function userErrorsOf(payload: Obj): string | undefined {
  const list = Array.isArray(payload.userErrors) ? payload.userErrors : []
  const msgs = list.map((e) => s(o(e).message)).filter((m): m is string => m !== undefined)
  return msgs.length === 0 ? undefined : msgs.join('；')
}
