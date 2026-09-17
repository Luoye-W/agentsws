/**
 * WP76（58 §5）：**设计库的 `/v1` 面**——需求单列表、brief、变体、定稿。
 *
 * 四条纪律，每条都在类型上看得见：
 *
 * 1. **一个对象域一把闸**。`design_request` / `design_brief` / `design_asset`
 *    三条各自判权。这一条不是形式主义：58 §1 定了**下单的岗位读得到自己那张
 *    需求单与交付回来的素材，读不到设计岗的 brief**，而分得开它们的正是这三把闸
 *    （网站运营那条职责的 scopes 里没有 `design_brief`）。
 *    所以 `GET /v1/design/briefs/:id` 对下单那条职责天然是 403，
 *    不用在路由里写一行 if。
 * 2. **写动作永远先出卡**。下单 → `design_request`（L3）、brief →
 *    `design_brief`（L3）、变体 → `design_variant`（L2）、入库 →
 *    `asset_publish`（**L1 硬顶**）。这里一条都不直接改库里的定稿状态。
 * 3. **`picked_by` 不是参数**。`POST /v1/design/assets/:id/publish` 的 body 里
 *    **没有**"谁点的"这一格——服务端按请求人盖。递得进来就等于 Agent 能替人点头，
 *    而 04 §6 那条纪律说的正是这件事不许发生。
 * 4. **需求原文是外部文本**。`need` 原样存、原样端出去，不在这一层改写，
 *    也不当指令读（21 §1 / 39）。
 */
import type {
  DesignAsset,
  DesignBrief,
  DesignDuty,
  DesignRequest,
  DesignRequestStatus,
  Iso8601,
  MaybePromise,
} from '@agentsws/contracts'
import { DESIGN_DUTIES, DESIGN_SPECS } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, intParam, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import type { DesignActor } from './design-types.js'

/* ── 鉴权元组：三个对象域各一把闸（31 §3.1 完整元组） ─────────────────── */

const READ_REQUEST = {
  domain: 'design_request',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_REQUEST = { ...READ_REQUEST, op: 'stage' } as const
/**
 * brief 那一把（文件头第 1 条）。
 *
 * **只有设计岗那五条读得到**：下单的岗位（网站运营 / 社媒 / 红人）的 yml 里
 * 只有 `design_request`，没有这个域。58 §1 那句"下单的岗位读得到自己那张单
 * 与交付回来的素材，读不到设计岗的 brief"就靠这一把闸兑现。
 */
const READ_BRIEF = {
  domain: 'design_brief',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_BRIEF = { ...READ_BRIEF, op: 'stage' } as const
const READ_ASSET = {
  domain: 'design_asset',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_ASSET = { ...READ_ASSET, op: 'stage' } as const

/* ── 视图 ─────────────────────────────────────────────────────────────── */

/** 清单上的一行需求单。多两格给人看的名字——表格上要认得出是哪条职责、谁下的。 */
export interface DesignRequestRow extends DesignRequest {
  duty_name: string
  from_label: string
}

/** 清单上的一份 brief。多一格拼好的正文（brief 卡上那一段）。 */
export interface DesignBriefRow extends DesignBrief {
  duty_name: string
  /** brief 卡上那一段（`design-core` 的 `briefSummaryZh` 拼的）。 */
  summary_zh: string
}

/** 清单上的一张素材。多两格规格的中文名与硬规矩。 */
export interface DesignAssetRow extends DesignAsset {
  spec_name: string
  /** 这条规格的硬规矩，原样显示（"2000×2000px；一个字都不许有；纯白底"）。 */
  spec_note: string
}

/**
 * 提了一条变更之后回来的那一份（照 `SocialStagedView`）。
 *
 * `staged` 为假 = guardrail 拦了，`message` 是那句人话。**不抛异常**：
 * 被拦下来是正常结果之一，界面要照实显示而不是弹一个红框。
 */
export interface DesignStagedView {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  message?: string
  /** 这次提上去时的等级（硬顶按回来的话这里就是 L1）。 */
  level?: string
}

/** 下了一张需求单之后回来的那一份。 */
export interface DesignRequestView {
  request: DesignRequestRow
  staged: DesignStagedView
}

/** 出了一份 brief 之后回来的那一份（58 §3 的 brief 卡）。 */
export interface DesignBriefView {
  brief: DesignBriefRow
  /**
   * 整理不出来的那几件事，人话一条一条。**不是错误**——需求写得糊涂是常态，
   * brief 照样出，这几句原样出现在卡上让下需求的人看到自己漏说了什么。
   */
  questions: string[]
  /** 用的是哪一份品牌系统、为什么（`design-core` 的 `resolveBrandSystem`）。 */
  brand_note: string
  /** 一份都没有时那张「先设品牌系统」卡（58 §3 第四张）。不挡路。 */
  brand_system_missing?: {
    kind: 'brand_system_missing'
    title_zh: string
    title_en: string
    body_zh: string
    skill_name: string
    skill_tier: 'company'
    blocking: false
  }
  staged: DesignStagedView
}

/** 出了一批变体之后回来的那一份（58 §3 的变体挑选卡）。 */
export interface DesignVariantView {
  brief_id: string
  /** 这次打算出的那几条（没有图片模型时**只有这一格有东西**）。 */
  planned: { plan_item_id: string; spec_id: string; size: string }[]
  /** 真出出来的那几张（没有图片模型时是空数组）。 */
  assets: DesignAssetRow[]
  /** 额度这一侧的话（与 guardrail 判的是同一个数）。 */
  quota_notes: string[]
  /**
   * 有没有图片模型（58 §1：没有就明说"只出 brief 与规格，不出图"）。
   *
   * `reason` 是**给人看的那句话**，不是错误码——界面直接显示它，
   * 而不是把"生成失败"四个字摆上去。
   */
  image_model: { available: boolean; reason?: string }
  /** 挑图卡上那一行（"就这张 / 都不行再来"）。 */
  pick_note: string
  staged: DesignStagedView
}

/** 人点了「就这张」之后回来的那一份。 */
export interface DesignAssetView {
  asset: DesignAssetRow
  /** 那张入库卡（`asset_publish` **永远 L1**）。 */
  staged: DesignStagedView
}

/* ── 端口 ─────────────────────────────────────────────────────────────── */

export interface DesignRequestInput {
  /**
   * 路由到哪条设计职责。**不给就按来源职责查**（契约的 `designDutyForSource`）；
   * 查不到就报回去让人定——54 §2 拿不准就问一句，**不猜**。
   */
  duty?: DesignDuty | undefined
  /** 谁下的单。不给就是请求人当前那条职责。 */
  from_role_id?: string | undefined
  matter_id?: string | undefined
  title: string
  /** 需求原文。**外部文本**，原样存（文件头第 4 条）。 */
  need: string
  spec_ids?: string[] | undefined
  due_at?: Iso8601 | undefined
}

export interface DesignAssetInput {
  /** 入库时按用途打的标（素材库按它分组）。 */
  tags?: string[] | undefined
}

export interface DesignPort {
  requests(
    actor: DesignActor,
    filter: {
      duty?: DesignDuty | undefined
      from_role_id?: string | undefined
      status?: DesignRequestStatus | undefined
      limit?: number | undefined
    },
  ): MaybePromise<{ rows: DesignRequestRow[] }>
  /** 别的岗位下一张需求单：开一条 `design_request`（L3）并路由到设计岗。 */
  createRequest(actor: DesignActor, input: DesignRequestInput): MaybePromise<DesignRequestView>
  /** 需求单 → brief（L3 自动）。整理那一跳是 `design-core` 的纯函数。 */
  draftBrief(
    actor: DesignActor,
    request_id: string,
    input: { variants?: number | undefined },
  ): MaybePromise<DesignBriefView>
  /** 出变体初稿（L2，出卡给人挑）。没有图片模型时照出计划并明说。 */
  generateVariants(
    actor: DesignActor,
    brief_id: string,
    input: { plan_item_ids?: string[] | undefined },
  ): MaybePromise<DesignVariantView>
  /**
   * 人点了「就这张」→ 出一张入库卡（`asset_publish`，**L1 硬顶**）。
   *
   * `picked_by` 由实现按**请求人**盖（文件头第 3 条），端口上没有这一格。
   */
  publishAsset(
    actor: DesignActor,
    asset_id: string,
    input: DesignAssetInput,
  ): MaybePromise<DesignAssetView>
  /** 「都不行再来」：这一批否掉，并把"哪儿不对"留给下一轮。 */
  rejectAssets(
    actor: DesignActor,
    input: { asset_ids: string[]; reason?: string | undefined },
  ): MaybePromise<{ rows: DesignAssetRow[] }>
  assets(
    actor: DesignActor,
    filter: {
      duty?: DesignDuty | undefined
      brief_id?: string | undefined
      tag?: string | undefined
      final_only?: boolean | undefined
      limit?: number | undefined
    },
  ): MaybePromise<{ rows: DesignAssetRow[] }>
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

function portOf(deps: GatewayDeps): DesignPort {
  const p = deps.design
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配设计库（GatewayDeps.design）。设计岗位那五条职责要它才动得了。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): DesignActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const DUTY_IDS = DESIGN_DUTIES.map((d) => d.id)
const STATUSES = [
  'queued',
  'briefed',
  'generating',
  'awaiting_pick',
  'delivered',
  'cancelled',
] as const

const dutyQuery = (c: Parameters<typeof param>[0]): DesignDuty | undefined => {
  const raw = c.req.query('duty')
  if (raw === undefined || raw.trim() === '') return undefined
  const found = DUTY_IDS.find((x) => x === raw.trim())
  if (found === undefined) throw new ApiError('invalid_input', `不认识这条设计职责：${raw}`)
  return found
}

const DutySchema = z.enum(DUTY_IDS as [DesignDuty, ...DesignDuty[]])

const RequestBody = z.object({
  duty: DutySchema.optional(),
  from_role_id: z.string().min(1).max(100).optional(),
  matter_id: z.string().min(1).max(100).optional(),
  title: z.string().min(1).max(200),
  /** 需求原文（外部文本，原样存）。 */
  need: z.string().min(1).max(20_000),
  spec_ids: z.array(z.string().min(1).max(100)).max(20).optional(),
  due_at: z.string().min(1).max(40).optional(),
})

const BriefBody = z.object({
  /** 这次要出几版；上限由 guardrail 按 `max_variants_per_brief` 判。 */
  variants: z.number().int().min(1).max(50).optional(),
})

const VariantBody = z.object({
  /** 只重出计划里的这几条（"这个角度再来两张"）。 */
  plan_item_ids: z.array(z.string().min(1).max(200)).max(50).optional(),
})

/** 入库 body 里**没有** `picked_by`：谁点的由服务端按请求人盖（文件头第 3 条）。 */
const PublishBody = z.object({
  tags: z.array(z.string().min(1).max(50)).max(10).optional(),
})

const RejectBody = z.object({
  asset_ids: z.array(z.string().min(1).max(200)).min(1).max(50),
  /** 哪儿不对（下一轮的提示词要带着它改）。 */
  reason: z.string().max(1000).optional(),
})

export function designRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/design/specs',
        operationId: 'listDesignSpecs',
        summary:
          '规格表（58 §2）：屏幕用 px + sRGB，印刷用 mm + dpi + CMYK + 出血。广告那一族的真源在投放包里，这里没有',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: READ_REQUEST,
        returns: '{ rows: DesignSpec[] }',
      },
      (c) => Promise.resolve(ok(c, { rows: DESIGN_SPECS })),
    ),
    route(
      {
        method: 'get',
        path: '/v1/design/requests',
        operationId: 'listDesignRequests',
        summary:
          '需求单队列（58 §3 第一块）：按来源岗位看得出是谁下的单；过期的那些单独标出来——过期是"这件事没做成"，不是"逾期"',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: READ_REQUEST,
        params: [
          { name: 'duty', in: 'query', description: '只看这条设计职责' },
          { name: 'from_role_id', in: 'query', description: '只看这条职责下的单' },
          { name: 'status', in: 'query', description: 'queued / briefed / … / cancelled' },
          { name: 'limit', in: 'query', description: '最多几行', schema: { type: 'integer' } },
        ],
        returns: '{ rows: DesignRequestRow[] }',
      },
      async (c, deps) => {
        const duty = dutyQuery(c)
        const from_role_id = c.req.query('from_role_id')
        const rawStatus = c.req.query('status')
        const status = STATUSES.find((s) => s === rawStatus)
        if (rawStatus !== undefined && rawStatus !== '' && status === undefined)
          throw new ApiError('invalid_input', `不认识这个状态：${rawStatus}`)
        const limit = intParam(c, 'limit')
        return ok(
          c,
          await portOf(deps).requests(actorOf(c), {
            ...(duty === undefined ? {} : { duty }),
            ...(from_role_id === undefined || from_role_id === '' ? {} : { from_role_id }),
            ...(status === undefined ? {} : { status }),
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/design/requests',
        operationId: 'createDesignRequest',
        summary:
          '向设计岗下一张需求单（别的岗位的 `request_design` 动作走这条）：开一件事并按 54 路由到设计岗。`duty` 不给就按来源职责查，查不到就报回来让人定——不猜',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_REQUEST,
        body: RequestBody,
        returns: 'DesignRequestView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).createRequest(actorOf(c), await body(c, RequestBody)), 201),
    ),
    route(
      {
        method: 'post',
        path: '/v1/design/requests/:id/brief',
        operationId: 'draftDesignBrief',
        summary:
          '需求单 → brief（**L3 自动**：它不产生任何外部可见的东西）。整理不出来的那几件事原样进卡面，**不编默认值**',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_BRIEF,
        params: [{ name: 'id', in: 'path', description: '需求单 id' }],
        body: BriefBody,
        returns: 'DesignBriefView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).draftBrief(actorOf(c), param(c, 'id'), await body(c, BriefBody)),
          201,
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/design/briefs/:id/variants',
        operationId: 'generateDesignVariants',
        summary:
          '出变体初稿（**L2**，出一张卡给人挑）。没有图片模型的时候照样出计划并**明说**，而不是回一句"生成失败"',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ASSET,
        params: [{ name: 'id', in: 'path', description: 'brief id' }],
        body: VariantBody,
        returns: 'DesignVariantView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).generateVariants(
            actorOf(c),
            param(c, 'id'),
            await body(c, VariantBody),
          ),
          201,
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/design/assets/:id/publish',
        operationId: 'publishDesignAsset',
        summary:
          '人点了「就这张」→ 一张入库卡（`asset_publish`，**L1 硬顶**，yml 与工作区策略都放宽不了）。body 里没有"谁点的"：服务端按请求人盖',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ASSET,
        params: [{ name: 'id', in: 'path', description: '素材 id' }],
        body: PublishBody,
        returns: 'DesignAssetView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).publishAsset(actorOf(c), param(c, 'id'), await body(c, PublishBody)),
          201,
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/design/assets/reject',
        operationId: 'rejectDesignAssets',
        summary: '「都不行再来」：这一批否掉，并把「哪儿不对」留给下一轮的提示词',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ASSET,
        body: RejectBody,
        returns: '{ rows: DesignAssetRow[] }',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).rejectAssets(actorOf(c), await body(c, RejectBody))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/design/assets',
        operationId: 'listDesignAssets',
        summary:
          '素材库（58 §3 第四块）。`final_only` 的判据是「入库了**而且**人点过」——少判一件就等于让 Agent 自己定了稿',
        tag: 'design',
        auth: 'bearer',
        assignment: true,
        authz: READ_ASSET,
        params: [
          { name: 'duty', in: 'query', description: '只看这条设计职责' },
          { name: 'brief_id', in: 'query', description: '只看这份 brief 出的' },
          { name: 'tag', in: 'query', description: '只看这个用途标' },
          { name: 'final_only', in: 'query', description: '只看定稿的（true / false）' },
          { name: 'limit', in: 'query', description: '最多几行', schema: { type: 'integer' } },
        ],
        returns: '{ rows: DesignAssetRow[] }',
      },
      async (c, deps) => {
        const duty = dutyQuery(c)
        const brief_id = c.req.query('brief_id')
        const tag = c.req.query('tag')
        const final_only = c.req.query('final_only') === 'true'
        const limit = intParam(c, 'limit')
        return ok(
          c,
          await portOf(deps).assets(actorOf(c), {
            ...(duty === undefined ? {} : { duty }),
            ...(brief_id === undefined || brief_id === '' ? {} : { brief_id }),
            ...(tag === undefined || tag === '' ? {} : { tag }),
            ...(final_only ? { final_only } : {}),
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    ),
  ]
}
