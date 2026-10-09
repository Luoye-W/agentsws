/**
 * WP268（决策 213）：**品牌素材库**——图片的统一来源。
 *
 * 就是设计岗那张素材表（`design.ts` 的 `DesignStore`，`design_asset`）+ 对象存储里的字节，多一层好用的门面：
 *
 * - AI 生图 / 改图出来的图（带来源、提示词、模型、积分）；
 * - 人在事项里拖进来的图、在素材库页上传的图（`uploaded`）；
 * - 从店里某件商品拿来的图（`external`，只认 Shopify 的图片 CDN）。
 *
 * 改图的参考图、挑中后传到店铺「文件」的图、WP267 运营工具「传商品图」的 `asset_id`，都从这里取字节。
 *
 * 三条纪律：
 * 1. **字节不进事件日志、不进卡**：卡上只有本机取图地址（`/v1/brand-assets/:id/file`，要登录令牌）；
 * 2. **只认图片**：看文件头（PNG / JPEG / WebP / GIF），单张 ≤ 20 MB；
 * 3. 内存档（没有对象存储，测试与一次性任务）字节放在进程内存里，形状不变。
 */
import type { BlobStore } from '@agentsws/blob'
import type {
  Clock,
  DesignAsset,
  DesignAssetProvenance,
  DesignDuty,
  WorkspaceId,
} from '@agentsws/contracts'
import { assetBlobKey } from '@agentsws/design-core'
import type { DesignStore } from './design.js'

/** 单张图的上限（与店铺运营「传商品图」同一条）。 */
export const BRAND_ASSET_MAX_BYTES = 20 * 1024 * 1024

/** WP283 / WP289（决策 313）：遮罩图的用途标——素材库默认不显示它（筛「遮罩」才看得到）。 */
export const BRAND_ASSET_MASK_TAG = 'mask'

/** 只认这几种图片（看文件头，不信扩展名）。 */
export function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e)
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 4)) === 'GIF8')
    return 'image/gif'
  return undefined
}

/** 宽高（PNG 看 IHDR、JPEG 找 SOF；认不出回 undefined，不影响入库）。 */
export function imageDims(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (sniffImage(bytes) === 'image/png' && bytes.length >= 24)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  if (sniffImage(bytes) === 'image/jpeg') {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined
      const marker = bytes[i + 1] as number
      const len = view.getUint16(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) }
      i += 2 + len
    }
  }
  return undefined
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
export const extOfImage = (content_type: string | undefined): string =>
  EXT[content_type ?? ''] ?? 'png'

export class BrandAssetError extends Error {
  constructor(
    readonly code: 'not_image' | 'too_big' | 'not_found' | 'no_bytes' | 'bad_url' | 'fetch',
    message: string,
  ) {
    super(message)
    this.name = 'BrandAssetError'
  }
}

export interface SaveAssetInput {
  bytes: Uint8Array
  content_type?: string
  width?: number
  height?: number
  duty: DesignDuty
  spec_id: string
  status?: DesignAsset['status']
  tags?: readonly string[]
  design_note?: string
  provenance: DesignAssetProvenance
}

export interface BrandAssetFilter {
  matter_id?: string
  tag?: string
  /** WP289（决策 313）：不要带这几个用途标的（素材库默认不显示遮罩 `mask`）。 */
  exclude_tags?: readonly string[]
  status?: readonly DesignAsset['status'][]
  /** `generated` / `uploaded` / `external`。 */
  source?: DesignAssetProvenance['source']
  limit?: number
}

export interface BrandAssets {
  readonly workspace_id: WorkspaceId
  save(input: SaveAssetInput): Promise<DesignAsset>
  get(id: string): DesignAsset | undefined
  /** 字节（不是这个品牌的 / 被删的 / 没有字节的 → undefined）。 */
  bytes(
    id: string,
  ): Promise<{ bytes: Uint8Array; content_type: string; filename: string } | undefined>
  list(filter?: BrandAssetFilter): DesignAsset[]
  update(asset: DesignAsset): void
  /** 人拖进来 / 上传的一张（看文件头、≤ 20 MB）。 */
  importUpload(input: {
    bytes: Uint8Array
    filename?: string
    matter_id?: string
    tags?: readonly string[]
    by?: string
  }): Promise<DesignAsset>
  /**
   * 从网址取一张进库（店里商品图那一路）。**只认 https 且主机是 Shopify 的图片 CDN**
   * （`cdn.shopify.com` / `*.myshopify.com`）——模型给的任意网址不去取。同一个网址取过就回那一张。
   */
  importFromUrl(input: {
    url: string
    origin: NonNullable<DesignAssetProvenance['origin']>
    matter_id?: string
    tags?: readonly string[]
    fetch: (
      url: string,
    ) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>
  }): Promise<DesignAsset>
}

export interface BrandAssetsOptions {
  workspace_id: WorkspaceId
  store: DesignStore
  blobs?: BlobStore
  clock: Clock
  random: () => number
  /** 测试 / demo：另外再认哪些图片主机（假店的 `cdn.shopify.test`）。生产不传，只认 Shopify CDN。 */
  extraImageHosts?: RegExp
}

const SHOP_CDN = /^(cdn\.shopify\.com|[a-z0-9-]+\.myshopify\.com)$/i

export function createBrandAssets(options: BrandAssetsOptions): BrandAssets {
  const { workspace_id, store, clock } = options
  /** 内存档：没有对象存储时字节放这里（进程退出就没了，测试与一次性任务用）。 */
  const memory = new Map<string, { bytes: Uint8Array; content_type: string }>()
  let seq = 0
  const nextId = (): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `dasset_${rand}${seq.toString(36)}`
  }

  const save = async (input: SaveAssetInput): Promise<DesignAsset> => {
    const content_type = input.content_type ?? sniffImage(input.bytes) ?? 'image/png'
    const dims = input.width === undefined ? imageDims(input.bytes) : undefined
    const now = clock.now()
    const asset: DesignAsset = {
      id: nextId(),
      workspace_id,
      duty: input.duty,
      spec_id: input.spec_id,
      status: input.status ?? 'variant',
      content_type,
      ...(input.width === undefined
        ? dims === undefined
          ? {}
          : { width: dims.width, height: dims.height }
        : { width: input.width, ...(input.height === undefined ? {} : { height: input.height }) }),
      ...(input.tags === undefined || input.tags.length === 0 ? {} : { tags: [...input.tags] }),
      ...(input.design_note === undefined ? {} : { design_note: input.design_note }),
      provenance: input.provenance,
      created_at: now,
    }
    if (options.blobs !== undefined) {
      const ref = await options.blobs.put(assetBlobKey(asset), input.bytes, {
        content_type,
        workspace_id,
        filename: `${asset.id}.${extOfImage(content_type)}`,
      })
      asset.blob_uri = ref.uri
      asset.bytes = ref.size
    } else {
      memory.set(asset.id, { bytes: input.bytes, content_type })
      asset.blob_uri = `mem://${asset.id}`
      asset.bytes = input.bytes.length
    }
    store.saveAsset(asset)
    return asset
  }

  const get = (id: string): DesignAsset | undefined => {
    const a = store.asset(id)
    return a === undefined || a.workspace_id !== workspace_id ? undefined : a
  }

  const accept = (bytes: Uint8Array): string => {
    if (bytes.length > BRAND_ASSET_MAX_BYTES)
      throw new BrandAssetError('too_big', '图片太大了（单张最多 20 MB）。')
    const type = sniffImage(bytes)
    if (type === undefined)
      throw new BrandAssetError('not_image', '这不是图片（只收 PNG / JPEG / WebP / GIF）。')
    return type
  }

  return {
    workspace_id,
    save,
    get,
    async bytes(id) {
      const a = get(id)
      if (a?.blob_uri === undefined) return undefined
      const content_type = a.content_type ?? 'image/png'
      const filename = `${a.id}.${extOfImage(content_type)}`
      if (a.blob_uri.startsWith('mem://')) {
        const hit = memory.get(a.id)
        return hit === undefined ? undefined : { ...hit, filename }
      }
      if (options.blobs === undefined) return undefined
      const out = await options.blobs.get(a.blob_uri.replace(/^blob:\/\//, ''))
      return out?.bytes === undefined ? undefined : { bytes: out.bytes, content_type, filename }
    },
    list(filter = {}) {
      return store
        .assets()
        .filter((a) => a.workspace_id === workspace_id && a.blob_uri !== undefined)
        .filter(
          (a) => filter.matter_id === undefined || a.provenance.matter_id === filter.matter_id,
        )
        .filter((a) => filter.tag === undefined || (a.tags ?? []).includes(filter.tag))
        .filter(
          (a) =>
            filter.exclude_tags === undefined ||
            !(a.tags ?? []).some((t) => filter.exclude_tags?.includes(t)),
        )
        .filter((a) => filter.status === undefined || filter.status.includes(a.status))
        .filter((a) => filter.source === undefined || a.provenance.source === filter.source)
        .sort((a, b) =>
          a.created_at === b.created_at
            ? b.id.localeCompare(a.id)
            : b.created_at.localeCompare(a.created_at),
        )
        .slice(0, filter.limit ?? 200)
    },
    update(asset) {
      store.saveAsset({ ...asset, updated_at: clock.now() })
    },
    async importUpload(input) {
      const content_type = accept(input.bytes)
      return save({
        bytes: input.bytes,
        content_type,
        duty: 'dtc',
        spec_id: 'upload',
        // 人传的图本来就是人挑过的：直接算「选中」，可以当参考图、可以传店
        status: 'picked',
        tags: input.tags ?? [],
        provenance: {
          source: 'uploaded',
          origin: {
            kind: input.matter_id === undefined ? 'library_upload' : 'matter_upload',
            ...(input.filename === undefined ? {} : { ref: input.filename.slice(0, 200) }),
          },
          ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
          ...(input.by === undefined
            ? {}
            : { picked_by: input.by as never, picked_at: clock.now() }),
        },
      })
    },
    async importFromUrl(input) {
      let url: URL
      try {
        url = new URL(input.url)
      } catch {
        throw new BrandAssetError('bad_url', '图片地址不对。')
      }
      if (
        url.protocol !== 'https:' ||
        !(SHOP_CDN.test(url.hostname) || options.extraImageHosts?.test(url.hostname) === true)
      )
        throw new BrandAssetError('bad_url', '只从店铺的图片地址（cdn.shopify.com）取图。')
      const same = store
        .assets()
        .find(
          (a) =>
            a.workspace_id === workspace_id &&
            a.provenance.origin?.url === input.url &&
            a.blob_uri !== undefined,
        )
      if (same !== undefined) return same
      let res: Awaited<ReturnType<typeof input.fetch>>
      try {
        res = await input.fetch(input.url)
      } catch (e) {
        throw new BrandAssetError(
          'fetch',
          `图片没取下来（${e instanceof Error ? e.message : String(e)}）`,
        )
      }
      if (!res.ok) throw new BrandAssetError('fetch', `图片没取下来（${res.status}）`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      const content_type = accept(bytes)
      return save({
        bytes,
        content_type,
        duty: 'dtc',
        spec_id: 'product',
        status: 'picked',
        tags: input.tags ?? ['product'],
        provenance: {
          source: 'external',
          origin: { ...input.origin, url: input.url },
          ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
        },
      })
    },
  }
}

/** 素材 → 素材库页 / 接口上的一行（多两格：取图地址、来源人话）。 */
export function brandAssetRow(
  a: DesignAsset,
): DesignAsset & { file_url: string; source_label: string } {
  const p = a.provenance
  const source_label =
    p.origin?.kind === 'shop_product'
      ? '店里商品图'
      : p.origin?.kind === 'matter_upload'
        ? '事项里拖进来的'
        : p.source === 'uploaded'
          ? '人传的'
          : p.operation === 'edit'
            ? 'AI 改图'
            : p.source === 'generated'
              ? 'AI 生成'
              : '外部'
  return { ...a, file_url: `/v1/brand-assets/${a.id}/file`, source_label }
}
