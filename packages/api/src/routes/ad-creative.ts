/**
 * WP317（docs/101 §5.1④，决策 559）：**广告素材流水线**的 `/v1` 面。
 *
 * 一条线五步，全部挂在投放那四条职责的 `ad_account` 域上：
 *
 * 1. `POST /v1/ads/creative/imports`：用户上传导出表 → 挑出表现差的；
 * 2. `POST /v1/ads/creative/rounds`：标题、描述两个子 Agent 写新文案（本地按平台硬规矩过一遍）；
 * 3. `GET /v1/ads/creative/rounds/:id/sheet`：可下载的上传表（新建一律暂停，人自己去后台传）；
 * 4. `POST /v1/ads/creative/rounds/:id/design`：给设计岗下批量出图单（L3；设计岗出变体 L2、入库 L1）；
 * 5. `/v1/ads/creative/experiments`：实验记录（假设 / 改了什么 / 结果），按品牌存。
 *
 * **这一面没有一处碰广告平台**：不读后台、不传表、不改在跑的广告。真正动账户是
 * WP316 的插件执行器在卡被批准之后做的事。
 */
import type {
  AdCreativeMetric,
  AdCreativePlatform,
  AdCreativeRound,
  AdCreativeWeakAd,
  AdExperimentEntry,
  AdUploadSheet,
  MaybePromise,
} from '@agentsws/contracts'
import { AD_CREATIVE_PLATFORMS } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import type { AdsChangesView } from './ads.js'
import type { AdsActor } from './ads-types.js'

const READ_ADS = {
  domain: 'ad_account',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_ADS = { ...READ_ADS, op: 'stage' } as const

/** WP316：这一轮交给插件上传——挑哪个广告账户（Meta 还要主页编号与图片哈希）。 */
const StageSheetBody = z.object({
  account_id: z.string().min(1).max(200),
  meta_page_id: z.string().max(100).optional(),
  meta_image_hash: z.string().max(200).optional(),
})

/** 导入之后回来的那一份（行本身不端出去，只给条数与表现差的那几条）。 */
export interface AdCreativeImportView {
  id: string
  platform: AdCreativePlatform
  metric: AdCreativeMetric
  rows: number
  weak: AdCreativeWeakAd[]
  notes: string[]
}

/** 下了批量出图单之后回来的那一份。 */
export interface AdCreativeDesignView {
  /** 出了单（`false` = 没有可上图的标题，或被 guardrail 拦了）。 */
  requested: boolean
  request_id?: string
  /** 那张 `request_design` 卡（L3）的结论。 */
  staged?: { staged: boolean; level?: string; message?: string }
  title: string
  variants: number
  spec_ids: string[]
  /** 额度与「没字可上图」这类话。 */
  notes: string[]
}

export interface AdCreativePort {
  importExport(
    actor: AdsActor,
    input: {
      platform: AdCreativePlatform
      /** 导出表的文字。与 `base64` 二选一。 */
      text?: string | undefined
      /** 导出文件的原始字节（base64）。服务端用 WP314 的 `decodeExportBytes` 解（UTF-16 也认）。 */
      base64?: string | undefined
      metric?: AdCreativeMetric | undefined
    },
  ): MaybePromise<AdCreativeImportView>
  rewrite(
    actor: AdsActor,
    input: { import_id: string; ad_ids?: string[] | undefined },
  ): MaybePromise<AdCreativeRound>
  round(actor: AdsActor, id: string): MaybePromise<AdCreativeRound>
  sheet(
    actor: AdsActor,
    round_id: string,
    input?: { meta_page_id?: string | undefined; meta_image_hash?: string | undefined },
  ): MaybePromise<AdUploadSheet>
  /**
   * WP316：这一轮交给插件上传——拼成改动意图，出一张投放的上传表卡（L1；批了插件在用户自己的后台里传，
   * 平台预览后人再确认一次）。没装插件执行那一半的进程没有它。
   */
  stageSheet?(
    actor: AdsActor,
    round_id: string,
    input: {
      account_id: string
      meta_page_id?: string | undefined
      meta_image_hash?: string | undefined
    },
  ): MaybePromise<AdsChangesView>
  requestDesign(
    actor: AdsActor,
    round_id: string,
    input: {
      variants?: number | undefined
      spec_ids?: string[] | undefined
      goal?: string | undefined
    },
  ): MaybePromise<AdCreativeDesignView>
  experiments(actor: AdsActor): MaybePromise<{ rows: AdExperimentEntry[] }>
  addExperiment(
    actor: AdsActor,
    input: {
      hypothesis: string
      change: string
      result?: string | undefined
      platform?: AdCreativePlatform | undefined
      round_id?: string | undefined
      /** WP452：实验设计那一份（服务端内部给；HTTP 不收）。 */
      plan?: AdExperimentEntry['plan'] | undefined
    },
  ): MaybePromise<AdExperimentEntry>
  updateExperiment(
    actor: AdsActor,
    id: string,
    input: {
      hypothesis?: string | undefined
      change?: string | undefined
      result?: string | undefined
    },
  ): MaybePromise<AdExperimentEntry>
}

function portOf(deps: GatewayDeps): AdCreativePort {
  const p = deps.adCreative
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配素材流水线（GatewayDeps.adCreative）。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): AdsActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const PlatformSchema = z.enum(
  AD_CREATIVE_PLATFORMS as [AdCreativePlatform, ...AdCreativePlatform[]],
)

const ImportBody = z.object({
  platform: PlatformSchema,
  /** 导出表原文（CSV / 制表符分隔）。**外部文本**：只当数据读。与 `base64` 二选一。 */
  text: z.string().min(1).max(2_000_000).optional(),
  /** 导出文件原始字节的 base64（约 4 MB 以内）。 */
  base64: z.string().min(1).max(6_000_000).optional(),
  metric: z.enum(['ctr', 'cvr', 'cpa', 'roas']).optional(),
})

const RoundBody = z.object({
  import_id: z.string().min(1).max(100),
  /** 只写这几条；不给就写表现差的那些（一轮最多 20 条）。 */
  ad_ids: z.array(z.string().min(1).max(300)).max(50).optional(),
})

const DesignBody = z.object({
  /** 要几版；不给 = 收下的标题有几条就几版（封顶 30，决策 559）。 */
  variants: z.number().int().min(1).max(50).optional(),
  spec_ids: z.array(z.string().min(1).max(100)).max(10).optional(),
  goal: z.string().max(200).optional(),
})

const ExperimentBody = z.object({
  hypothesis: z.string().min(1).max(400),
  change: z.string().min(1).max(600),
  result: z.string().max(600).optional(),
  platform: PlatformSchema.optional(),
  round_id: z.string().min(1).max(100).optional(),
})

const ExperimentPatch = z.object({
  hypothesis: z.string().min(1).max(400).optional(),
  change: z.string().min(1).max(600).optional(),
  result: z.string().max(600).optional(),
})

const strip = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

export function adCreativeRoutes(): Route[] {
  const base = { tag: 'ads', auth: 'bearer', assignment: true } as const
  return [
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/ads/creative/imports',
        operationId: 'importAdCreativeExport',
        summary: '传一张广告导出表，挑出表现差的（样本不够的单列，不算差）。不碰广告平台',
        authz: STAGE_ADS,
        body: ImportBody,
        returns: 'AdCreativeImportView',
      },
      async (c, deps) => {
        const input = await body(c, ImportBody)
        if (input.text === undefined && input.base64 === undefined)
          throw new ApiError('invalid_input', '要么给 text，要么给 base64。')
        return ok(c, await portOf(deps).importExport(actorOf(c), strip(input)), 201)
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/ads/creative/rounds',
        operationId: 'rewriteAdCreative',
        summary:
          '标题、描述两个子 Agent 各写一份新文案；本地按平台条数 / 字数 / 禁用词过一遍，挡下的照实列出',
        authz: STAGE_ADS,
        body: RoundBody,
        returns: 'AdCreativeRound',
      },
      async (c, deps) => {
        const input = await body(c, RoundBody)
        return ok(c, await portOf(deps).rewrite(actorOf(c), strip(input)), 201)
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/ads/creative/rounds/:id',
        operationId: 'getAdCreativeRound',
        summary: '一轮新文案（收下的、挡下的、为什么）',
        authz: READ_ADS,
        params: [{ name: 'id', in: 'path', required: true, description: '轮次 id' }],
        returns: 'AdCreativeRound',
      },
      async (c, deps) => ok(c, await portOf(deps).round(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/ads/creative/rounds/:id/sheet',
        operationId: 'getAdCreativeSheet',
        summary:
          '这一轮的上传表（WP314 生成：Google 按官方模板的 CSV、Meta 导入表；新建一律暂停，人自己去后台传）',
        authz: READ_ADS,
        params: [
          { name: 'id', in: 'path', required: true, description: '轮次 id' },
          { name: 'meta_page_id', in: 'query', description: 'Meta：主页编号（纯数字）' },
          { name: 'meta_image_hash', in: 'query', description: 'Meta：图片哈希' },
        ],
        returns: 'AdUploadSheet',
      },
      async (c, deps) => {
        const page = c.req.query('meta_page_id')
        const image = c.req.query('meta_image_hash')
        return ok(
          c,
          await portOf(deps).sheet(actorOf(c), param(c, 'id'), {
            ...(page === undefined || page === '' ? {} : { meta_page_id: page }),
            ...(image === undefined || image === '' ? {} : { meta_image_hash: image }),
          }),
        )
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/ads/creative/rounds/:id/stage',
        operationId: 'stageAdCreativeSheet',
        summary:
          '这一轮交给插件上传（WP316）：出一张投放的上传表卡（L1，新建一律暂停），批了插件在你自己的后台里传、你再确认一次',
        authz: STAGE_ADS,
        params: [{ name: 'id', in: 'path', required: true, description: '轮次 id' }],
        body: StageSheetBody,
        returns: 'AdsChangesView',
      },
      async (c, deps) => {
        const input = await body(c, StageSheetBody)
        const port = portOf(deps)
        if (port.stageSheet === undefined)
          throw new ApiError(
            'not_implemented',
            '这台机器没装插件执行那一半：下载上传表自己去后台传。',
          )
        return ok(
          c,
          await port.stageSheet(actorOf(c), param(c, 'id'), {
            account_id: input.account_id,
            ...(input.meta_page_id === undefined ? {} : { meta_page_id: input.meta_page_id }),
            ...(input.meta_image_hash === undefined
              ? {}
              : { meta_image_hash: input.meta_image_hash }),
          }),
          201,
        )
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/ads/creative/rounds/:id/design',
        operationId: 'requestAdCreativeDesign',
        summary:
          '给设计岗下批量出图单（L3）：标题轮着上图，每单 ≤ 30 版；出变体 L2 给人挑、入库 L1',
        authz: STAGE_ADS,
        params: [{ name: 'id', in: 'path', required: true, description: '轮次 id' }],
        body: DesignBody,
        returns: 'AdCreativeDesignView',
      },
      async (c, deps) => {
        const input = await body(c, DesignBody)
        return ok(
          c,
          await portOf(deps).requestDesign(actorOf(c), param(c, 'id'), strip(input)),
          201,
        )
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/ads/creative/experiments',
        operationId: 'listAdExperiments',
        summary: '这个品牌的广告实验记录（假设 / 改了什么 / 结果），按轮次',
        authz: READ_ADS,
        returns: '{ rows: AdExperimentEntry[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).experiments(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/ads/creative/experiments',
        operationId: 'addAdExperiment',
        summary: '记一笔实验（按品牌存，同步进投放岗记忆；下次出文案带进上下文）',
        authz: STAGE_ADS,
        body: ExperimentBody,
        returns: 'AdExperimentEntry',
      },
      async (c, deps) => {
        const input = await body(c, ExperimentBody)
        return ok(c, await portOf(deps).addExperiment(actorOf(c), strip(input)), 201)
      },
    ),
    route(
      {
        ...base,
        method: 'patch',
        path: '/v1/ads/creative/experiments/:id',
        operationId: 'updateAdExperiment',
        summary: '改一笔实验（多半是回填结果）',
        authz: STAGE_ADS,
        params: [{ name: 'id', in: 'path', required: true, description: '实验 id' }],
        body: ExperimentPatch,
        returns: 'AdExperimentEntry',
      },
      async (c, deps) => {
        const input = await body(c, ExperimentPatch)
        return ok(c, await portOf(deps).updateExperiment(actorOf(c), param(c, 'id'), strip(input)))
      },
    ),
  ]
}
