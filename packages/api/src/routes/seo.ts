/**
 * WP154「内容与搜索」的 `/v1/seo/*`（最小一套，三条）。
 *
 * - `GET  /v1/seo/geo-questions`：买家会问的问题清单（自动生成 + 人改过的）；
 * - `PUT  /v1/seo/geo-questions`：在面板里改（关掉、改字、加）——人改过的永远赢；
 * - `POST /v1/seo/run`：现在跑一轮（每日判断 / 周小结），不用等到早上 8 点。
 * - WP159 `GET / PATCH /v1/knowledge/claim-rules`：知识库里那张「违规宣称规则」表（按市场分组、
 *   带出处）；闸走**知识库**那一套（读 = knowledge.read，改 = knowledge.stage，工作区范围），
 *   因为这张表就放在知识库里——实现落在内容与搜索那一层（它管质检）。
 *
 * 闸：`content` 域（`dtc.content` 的 scopes 里有 read / stage）。别的职责进不来，
 * 路由里一行 if 都不用写（同 `pr.ts` 文件头第 1 条）。判断与出卡全在服务端的
 * `seo-service.ts`，这里只收发。
 */
import type {
  AssignmentId,
  ClaimMarketGroup,
  ClaimRulesView,
  GeoCostEstimate,
  GeoQuestion,
  GeoSettings,
  MaybePromise,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ_CONTENT = {
  domain: 'content',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_CONTENT = { ...READ_CONTENT, op: 'stage' } as const

export interface SeoActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: AssignmentId
  role_id: RoleId
}

/** 现在跑一轮的结果（数全是服务端算好的）。 */
export interface SeoRunView {
  what: 'daily' | 'weekly'
  /** 报告卡 id（出了才有）。 */
  approval_item_ids: string[]
  /** 没跑的理由（没人持有这条职责……）。 */
  skipped?: string
  picks?: number
}

/**
 * 面板上那一块：问题清单 + 开关与问几个 + 每周大概花多少（WP155 提醒：探测按
 * 「每个问题 × 每个平台一次」计费，要让人看得到、调得动、关得掉）。
 */
export interface GeoQuestionsView {
  questions: GeoQuestion[]
  settings: GeoSettings
  estimate: GeoCostEstimate
}

export interface SeoPort {
  geoQuestions(actor: SeoActor): MaybePromise<GeoQuestionsView>
  setGeoQuestions(
    actor: SeoActor,
    input: {
      questions?: { id?: string | undefined; text: string; enabled: boolean }[] | undefined
      settings?: { enabled?: boolean | undefined; max_questions?: number | undefined } | undefined
    },
  ): MaybePromise<GeoQuestionsView>
  run(actor: SeoActor, what: 'daily' | 'weekly'): MaybePromise<SeoRunView>
  /** WP159：违规宣称规则表。没装 = `/v1/knowledge/claim-rules` 回 not_implemented。 */
  claimRules?(actor: SeoActor): MaybePromise<ClaimRulesView>
  setClaimRules?(actor: SeoActor, input: ClaimRulesPatch): MaybePromise<ClaimRulesView>
}

/** WP159：改规则表（三件事一次给一件就行）。 */
export interface ClaimRulesPatch {
  group?: { id: ClaimMarketGroup; enabled: boolean } | undefined
  rule?:
    | {
        id: string
        enabled?: boolean | undefined
        pattern?: string | undefined
        reason?: string | undefined
      }
    | undefined
  add?: { pattern: string; reason: string; market?: ClaimMarketGroup | undefined } | undefined
}

const READ_KNOWLEDGE = {
  domain: 'knowledge',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const
const WRITE_KNOWLEDGE = { ...READ_KNOWLEDGE, op: 'stage' } as const

const Group = z.enum(['global', 'us', 'eu_uk', 'ca', 'au'])
const ClaimRulesBody = z
  .object({
    group: z.object({ id: Group, enabled: z.boolean() }).optional(),
    rule: z
      .object({
        id: z.string().min(1).max(120),
        enabled: z.boolean().optional(),
        pattern: z.string().max(200).optional(),
        reason: z.string().max(300).optional(),
      })
      .optional(),
    add: z
      .object({
        pattern: z.string().min(1).max(200),
        reason: z.string().max(300),
        market: Group.optional(),
      })
      .optional(),
  })
  .refine((b) => b.group !== undefined || b.rule !== undefined || b.add !== undefined, {
    message: 'group / rule / add 至少给一个',
  })

function claimPortOf(deps: GatewayDeps): Required<Pick<SeoPort, 'claimRules' | 'setClaimRules'>> {
  const p = portOf(deps)
  if (p.claimRules === undefined || p.setClaimRules === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配违规宣称规则表。')
  return { claimRules: p.claimRules.bind(p), setClaimRules: p.setClaimRules.bind(p) }
}

function portOf(deps: GatewayDeps): SeoPort {
  const p = deps.seo
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配内容与搜索那一层（GatewayDeps.seo）。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): SeoActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const QuestionsBody = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(80).optional(),
        text: z.string().max(300),
        enabled: z.boolean(),
      }),
    )
    .max(30)
    .optional(),
  settings: z
    .object({
      enabled: z.boolean().optional(),
      max_questions: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
})

const RunBody = z.object({ what: z.enum(['daily', 'weekly']) })

export function seoRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/seo/geo-questions',
        operationId: 'listGeoQuestions',
        summary: '买家会问的问题（从品牌档案与排名前列的查询自动生成；人改过的永远赢）',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: 'GeoQuestionsView',
      },
      async (c, deps) => ok(c, await portOf(deps).geoQuestions(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/seo/geo-questions',
        operationId: 'setGeoQuestions',
        summary: '改问题清单（关掉、改字、加；空字的那一行当删掉）与每周探测的开关、问几个',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: QuestionsBody,
        returns: 'GeoQuestionsView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).setGeoQuestions(actorOf(c), await body(c, QuestionsBody))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/run',
        operationId: 'runSeo',
        summary:
          '现在跑一轮：daily = 读 Search Console 出「今天值得动的 5 件事」；weekly = 收入与 AI 可见度小结',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: RunBody,
        returns: 'SeoRunView',
      },
      async (c, deps) => ok(c, await portOf(deps).run(actorOf(c), (await body(c, RunBody)).what)),
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/claim-rules',
        operationId: 'listClaimRules',
        summary:
          '违规宣称规则表（WP159）：按市场分组（通用 / 美国 / 欧盟英国 / 加拿大 / 澳大利亚），每条带官方出处与一句人话；按品牌目标市场开组',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ_KNOWLEDGE,
        returns: 'ClaimRulesView',
      },
      async (c, deps) => ok(c, await claimPortOf(deps).claimRules(actorOf(c))),
    ),
    route(
      {
        method: 'patch',
        path: '/v1/knowledge/claim-rules',
        operationId: 'setClaimRules',
        summary: '改违规宣称规则表：拨市场组开关 / 改或关一条（记成知识库里的卡）/ 加一条自己的',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: WRITE_KNOWLEDGE,
        body: ClaimRulesBody,
        returns: 'ClaimRulesView',
      },
      async (c, deps) =>
        ok(c, await claimPortOf(deps).setClaimRules(actorOf(c), await body(c, ClaimRulesBody))),
    ),
  ]
}
