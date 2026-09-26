/**
 * WP154「内容与搜索」的 `/v1/seo/*`（最小一套，三条）。
 *
 * - `GET  /v1/seo/geo-questions`：买家会问的问题清单（自动生成 + 人改过的）；
 * - `PUT  /v1/seo/geo-questions`：在面板里改（关掉、改字、加）——人改过的永远赢；
 * - `POST /v1/seo/run`：现在跑一轮（每日判断 / 周小结），不用等到早上 8 点。
 *
 * 闸：`content` 域（`dtc.content` 的 scopes 里有 read / stage）。别的职责进不来，
 * 路由里一行 if 都不用写（同 `pr.ts` 文件头第 1 条）。判断与出卡全在服务端的
 * `seo-service.ts`，这里只收发。
 */
import type {
  AssignmentId,
  GeoQuestion,
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

export interface SeoPort {
  geoQuestions(actor: SeoActor): MaybePromise<{ questions: GeoQuestion[] }>
  setGeoQuestions(
    actor: SeoActor,
    input: { questions: { id?: string | undefined; text: string; enabled: boolean }[] },
  ): MaybePromise<{ questions: GeoQuestion[] }>
  run(actor: SeoActor, what: 'daily' | 'weekly'): MaybePromise<SeoRunView>
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
    .max(30),
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
        returns: '{ questions: GeoQuestion[] }',
      },
      async (c, deps) => ok(c, await portOf(deps).geoQuestions(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/seo/geo-questions',
        operationId: 'setGeoQuestions',
        summary: '改问题清单（关掉、改字、加）。空字的那一行当删掉',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: QuestionsBody,
        returns: '{ questions: GeoQuestion[] }',
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
  ]
}
