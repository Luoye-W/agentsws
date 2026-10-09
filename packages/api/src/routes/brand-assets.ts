/**
 * WP268（决策 213）：**品牌素材库**的 `/v1` 面——图片的统一来源（AI 出的、人拖进来的、店里商品图）。
 *
 * - `GET /v1/brand-assets`：列（新的在前；可按事项 / 用途标 / 来源 / 状态筛）；
 * - `GET /v1/brand-assets/:id/file`：取原图字节（挑图卡与素材库页的缩略图走它；要登录令牌）；
 * - `POST /v1/brand-assets/upload`：传一张进来（multipart，字段 `file`；可带 `matter_id` = 事项里拖进来的图）。
 *
 * 权限与「看事项」同一把（能看见事项里的挑图卡，就能看见卡上的图）。
 */
import type { DesignAsset, MaybePromise } from '@agentsws/contracts'
import { ApiError } from '../errors.js'
import { assignmentOf, intParam, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

/** 单张上限（与服务端素材库同一条）。 */
export const BRAND_ASSET_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

export interface BrandAssetsActor {
  workspace_id: string
  person_id: string
  assignment_id: string
}

/** 素材库里的一行（素材本身 + 给人看的几格）。 */
export interface BrandAssetRow extends DesignAsset {
  /** 取图地址（本机路由，要带登录令牌）。 */
  file_url: string
  /** 「AI 生成」「AI 改图」「人传的」「事项里拖进来的」「店里商品图」。 */
  source_label: string
}

export interface BrandAssetsPort {
  list(
    actor: BrandAssetsActor,
    filter: {
      matter_id?: string | undefined
      tag?: string | undefined
      source?: 'generated' | 'uploaded' | 'external' | undefined
      picked_only?: boolean | undefined
      limit?: number | undefined
    },
  ): MaybePromise<{ rows: BrandAssetRow[] }>
  file(
    actor: BrandAssetsActor,
    id: string,
  ): MaybePromise<{ bytes: Uint8Array; content_type: string; filename: string } | undefined>
  upload(
    actor: BrandAssetsActor,
    input: { bytes: Uint8Array; filename?: string; matter_id?: string; tags?: string[] },
  ): MaybePromise<{
    asset: BrandAssetRow
    /**
     * WP283（决策 300，只加）：现在的改图型号认不认遮罩——工作台据此在这张图上给不给「圈区域」。
     * 经 Agents 工坊云的型号都不认；不给 = 不知道（当不认）。
     */
    edit_mask?: boolean
  }>
}

function portOf(deps: GatewayDeps): BrandAssetsPort {
  const p = deps.brandAssets
  if (p === undefined) throw new ApiError('not_implemented', '这个服务进程没有装配品牌素材库。')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): BrandAssetsActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id, assignment_id: a.id }
}

const SOURCES = ['generated', 'uploaded', 'external'] as const
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined

export function brandAssetRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/brand-assets',
        operationId: 'listBrandAssets',
        summary: '品牌素材库（WP268）：AI 出的图、人拖进来的图、店里商品图；新的在前',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'matter_id', in: 'query', description: '只看这件事项里的' },
          {
            name: 'tag',
            in: 'query',
            description: '只看这个用途标；不给时不含遮罩（用途 mask，要看就给 tag=mask）',
          },
          { name: 'source', in: 'query', description: 'generated / uploaded / external' },
          { name: 'picked_only', in: 'query', description: '只看选中过的（true / false）' },
          { name: 'limit', in: 'query', description: '最多几行', schema: { type: 'integer' } },
        ],
        returns: '{ rows: BrandAssetRow[] }',
      },
      async (c, deps) => {
        const source = c.req.query('source')
        if (source !== undefined && source !== '' && !SOURCES.includes(source as never))
          throw new ApiError('invalid_input', `不认识这个来源：${source}`)
        const limit = intParam(c, 'limit')
        return ok(
          c,
          await portOf(deps).list(actorOf(c), {
            matter_id: text(c.req.query('matter_id'), 100),
            tag: text(c.req.query('tag'), 40),
            source: source === undefined || source === '' ? undefined : (source as never),
            picked_only: c.req.query('picked_only') === 'true',
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/brand-assets/:id/file',
        operationId: 'getBrandAssetFile',
        summary: '取素材库里一张图的原图字节（挑图卡与素材库页的缩略图）',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '素材 id' }],
        returns: '图片字节（不是本品牌的 / 没有原图 → 404）',
      },
      async (c, deps) => {
        const out = await portOf(deps).file(actorOf(c), param(c, 'id'))
        if (out === undefined) throw new ApiError('not_found', '素材库里没有这张图')
        return c.body(out.bytes as unknown as ArrayBuffer, 200, {
          'content-type': out.content_type,
          'content-length': String(out.bytes.length),
          'cache-control': 'private, max-age=3600',
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/brand-assets/upload',
        operationId: 'uploadBrandAsset',
        summary:
          '传一张图进素材库（multipart，字段 file；可带 matter_id = 事项里拖进来的、tags 逗号分隔）',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns:
          '{ asset: BrandAssetRow; edit_mask?: boolean }（WP283：现在的改图型号能不能圈区域）',
      },
      async (c, deps) => {
        if (!(c.req.header('content-type') ?? '').includes('multipart/form-data'))
          throw new ApiError('invalid_input', '上传要用 multipart/form-data，字段名 file')
        const declared = Number(c.req.header('content-length') ?? '0')
        if (Number.isFinite(declared) && declared > BRAND_ASSET_UPLOAD_MAX_BYTES + 64 * 1024)
          throw new ApiError('invalid_input', '图片太大了（单张最多 20 MB）')
        const form = await c.req.parseBody()
        const file = form.file
        if (!(file instanceof File)) throw new ApiError('invalid_input', 'multipart 里没有 file')
        if (file.size > BRAND_ASSET_UPLOAD_MAX_BYTES)
          throw new ApiError('invalid_input', '图片太大了（单张最多 20 MB）')
        const matter_id = text(form.matter_id, 100)
        const tags = (text(form.tags, 200) ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t !== '')
          .slice(0, 5)
        const out = await portOf(deps).upload(actorOf(c), {
          bytes: new Uint8Array(await file.arrayBuffer()),
          ...(file.name === '' ? {} : { filename: file.name }),
          ...(matter_id === undefined ? {} : { matter_id }),
          ...(tags.length === 0 ? {} : { tags }),
        })
        return ok(c, out, 201)
      },
    ),
  ]
}
