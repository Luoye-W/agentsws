/**
 * 品牌设计规范 `DESIGN.md`（71，WP122）。
 *
 * 六条路由对着设计规范页上的六个动作：**看 → 抓 → 传手册 → 改一格 → 整份替换 → 翻历史**。
 *
 * 四条边界，与 WP121 那一份同一把尺子：
 *
 * 1. **网关里不写业务**（28 §2）。抽取在 `@agentsws/brand-design`，跑与存在
 *    `apps/server/src/brand-design.ts`；这一层只做路由声明、权限判定与信封。
 * 2. **只有「抓」是 `outbound`**。它会去敲用户自己的站要外链样式表，所以急停
 *    开关（`AGENTSWS_HALT=outbound`）对它有效。读、改、翻历史都不是——急停
 *    期间照样看得到、改得动已经抓下来的那一份。
 * 3. **改一格与整份替换是同一级权限**，因为后果一样大：四个岗位出活都吃这份
 *    规范，改错一个色值，下一批图全跟着错。
 * 4. **传手册不在这里**。文件走 WP99 现成的上传链路
 *    （`POST /v1/knowledge/sources/upload`），这边只收那个 `upload_id`——
 *    字节不在我们这一层过第二遍，也就不用在这一层再写一遍那六道校验。
 */
import type {
  BrandDesignDoc,
  BrandDesignRevision,
  BrandDesignRun,
  MaybePromise,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const TAG = 'brand-design'

/** 抓 / 改 / 替换：四个岗位出活都吃这份规范，改错一格下一批活全跟着错。 */
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

/** 看与翻历史：读自己工作区的东西。 */
const READ = {
  domain: 'policy',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

export interface BrandDesignActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

export interface BrandDesignPort {
  /** 这个品牌当前的那一份。没有就回 `undefined`（界面画空状态与「去抓一份」）。 */
  get(actor: BrandDesignActor): MaybePromise<BrandDesignDoc | undefined>
  /**
   * 从官网抓一轮。
   *
   * 不带 `urls` 时**复用 WP121 最近那一次分析抓回来的页面**，一个页面都不重抓
   * （71 §2 第一条）。带了 `urls` 才是真去抓。
   */
  extract(
    actor: BrandDesignActor,
    input: { urls?: string[]; cap_credits?: number },
  ): MaybePromise<BrandDesignRun>
  /** 读一份已经传上来的品牌手册（`upload_id` 来自 WP99 的上传链路）。 */
  ingestFile(actor: BrandDesignActor, input: { upload_id: string }): MaybePromise<BrandDesignRun>
  /** 改一格（色块 / 字号 / 圆角…）。改过的格子重抓时整格不动。 */
  edit(
    actor: BrandDesignActor,
    input: { path: string; value: unknown },
  ): MaybePromise<BrandDesignDoc>
  /** 整份粘贴替换。粘进来什么就是什么。 */
  replace(actor: BrandDesignActor, input: { markdown: string }): MaybePromise<BrandDesignDoc>
  /** 版本历史（可回看、可导出）。 */
  revisions(actor: BrandDesignActor): MaybePromise<BrandDesignRevision[]>
}

const ExtractBody = z.object({
  urls: z.array(z.string().url('这不像一个网址')).max(4).optional(),
  cap_credits: z.number().positive().max(10).optional(),
})

const IngestBody = z.object({
  upload_id: z.string().min(1),
})

/**
 * 改一格。
 *
 * `path` 是令牌路径（`colors.primary`、`typography.h1`、`rounded.md`）。
 * 值给 `null` 表示**这一格我不要**——删掉，而不是留一个空值（与 70 §3.4 同一条：
 * 界面按"在不在"决定画不画，留空值会画出一行空格子）。
 */
const EditBody = z.object({
  path: z.string().min(1).max(120),
  value: z.unknown(),
})

const ReplaceBody = z.object({
  markdown: z.string().max(200_000),
})

function portOf(deps: GatewayDeps): BrandDesignPort {
  const p = deps.brandDesign
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配品牌设计规范面（GatewayDeps.brandDesign）',
    )
  return p
}

type Ctx = Parameters<typeof principalOf>[0]

function actorOf(c: Ctx): BrandDesignActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

export function brandDesignRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/brand-design',
        operationId: 'getBrandDesign',
        summary: '这个品牌当前的 DESIGN.md（令牌 + 出处 + 正文）；还没抓过就回 null',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'BrandDesignDoc | null',
      },
      async (c, deps) => ok(c, (await portOf(deps).get(actorOf(c))) ?? null),
    ),
    route(
      {
        method: 'post',
        path: '/v1/brand-design/extract',
        operationId: 'extractBrandDesign',
        summary:
          '从官网抓一轮设计令牌（不带 urls 时复用 WP121 那一次抓回来的页面，一个页面都不重抓）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        // 会去敲用户自己的站要外链样式表：急停开关对它有效
        outbound: true,
        body: ExtractBody,
        returns: 'BrandDesignRun',
      },
      async (c, deps) => {
        const input = await body(c, ExtractBody)
        return ok(
          c,
          await portOf(deps).extract(actorOf(c), {
            ...(input.urls === undefined ? {} : { urls: input.urls }),
            ...(input.cap_credits === undefined ? {} : { cap_credits: input.cap_credits }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/brand-design/files',
        operationId: 'ingestBrandDesignFile',
        summary:
          '读一份已经传上来的品牌手册（upload_id 来自知识上传）；手册里写的规范优先级高于官网抓到的',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: IngestBody,
        returns: 'BrandDesignRun',
      },
      async (c, deps) => {
        const input = await body(c, IngestBody)
        return ok(c, await portOf(deps).ingestFile(actorOf(c), { upload_id: input.upload_id }), 201)
      },
    ),
    route(
      {
        method: 'patch',
        path: '/v1/brand-design/tokens/:path',
        operationId: 'editBrandDesignToken',
        summary: '改一格（值给 null = 这一格我不要）。改过的格子重抓时整格不动',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [
          {
            name: 'path',
            in: 'path',
            required: true,
            description: '令牌路径（colors.primary / typography.h1 / rounded.md）',
            schema: { type: 'string' },
          },
        ],
        body: EditBody,
        returns: 'BrandDesignDoc',
      },
      async (c, deps) => {
        const input = await body(c, EditBody)
        return ok(
          c,
          await portOf(deps).edit(actorOf(c), { path: param(c, 'path'), value: input.value }),
        )
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/brand-design',
        operationId: 'replaceBrandDesign',
        summary: '整份粘贴替换（从别处拿来的 DESIGN.md 直接贴进来）；旧的进版本历史',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: ReplaceBody,
        returns: 'BrandDesignDoc',
      },
      async (c, deps) => {
        const input = await body(c, ReplaceBody)
        return ok(c, await portOf(deps).replace(actorOf(c), { markdown: input.markdown }))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/brand-design/revisions',
        operationId: 'listBrandDesignRevisions',
        summary: '版本历史（每一版怎么来的、谁改的、一句人话）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'BrandDesignRevision[]',
      },
      async (c, deps) => ok(c, await portOf(deps).revisions(actorOf(c))),
    ),
  ]
}
