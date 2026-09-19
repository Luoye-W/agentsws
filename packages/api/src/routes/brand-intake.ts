/**
 * 贴一个网址，自动填品牌档案（70 §3，WP121）。
 *
 * 五条路由对着向导第 ② 步的五个动作：**发起 → 看进度 → 拿结果 → 确认 → 重新分析**。
 *
 * 四条边界：
 *
 * 1. **网关里不写业务**（28 §2）。抓取与解析在 `@agentsws/brand-intake`，跑与存在
 *    `apps/server/src/brand-intake.ts`；这一层只做路由声明、权限判定与信封。
 * 2. **发起是 `outbound`**。它真的会去敲别人的服务器，所以急停开关
 *    （`AGENTSWS_HALT=outbound`）对它有效——与发信、下单同一类。看进度与拿结果
 *    不是，急停期间照样读得到上一次的结果。
 * 3. **确认是写公司档案那一级的权限**，与首次设置第 ① 步同一把尺子：这一下会
 *    改组织名、工作区名、平台、币种，还会往知识库里塞一批条目。
 * 4. **重新分析不是"再发起一次"**。它带着上一次的结果进去，用户改过的格子整格
 *    不动（70 §3.4）。所以它是一条独立的路由，不是 `start` 的一个参数——两个
 *    动作的后果不一样，就不该共用一个入口。
 */
import type { BrandIntakeRun, MaybePromise } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const TAG = 'brand-intake'

/** 发起与确认：会改公司档案、会花钱、会往知识库写。与首次设置同一级。 */
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

/** 看进度与看结果：读自己工作区的东西。 */
const READ = {
  domain: 'policy',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

export interface BrandIntakeActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

export interface BrandIntakePort {
  /** 发起一次。回一条刚排上队的 `queued` / `running`。 */
  start(actor: BrandIntakeActor, input: { urls: string[]; cap_credits?: number }): MaybePromise<BrandIntakeRun>
  /** 这一次跑到哪儿了（界面用呼吸标记表示"Agent 在干活"，36 §12）。 */
  get(actor: BrandIntakeActor, run_id: string): MaybePromise<BrandIntakeRun>
  /** 这个工作区最近的那一次（向导回来的时候按它恢复现场）。 */
  latest(actor: BrandIntakeActor): MaybePromise<BrandIntakeRun | undefined>
  /** 「看着没问题」：把档案写进组织 / 工作区 / 知识库 / persona 上下文。 */
  confirm(
    actor: BrandIntakeActor,
    input: { run_id: string; edits?: Record<string, unknown> },
  ): MaybePromise<BrandIntakeRun>
  /** 重新分析：带着上一次的结果重跑，**用户改过的格子不动**。 */
  reanalyze(actor: BrandIntakeActor, input: { run_id: string; urls?: string[] }): MaybePromise<BrandIntakeRun>
}

/**
 * 发起的入参。
 *
 * `urls` 至少一条、最多三条：一个官网 + 一两条 Amazon 链接已经够画出第一版
 * 档案了，再多只会把那 10 积分烧光（70 §3.1）。
 */
const StartBody = z.object({
  urls: z.array(z.string().url('这不像一个网址')).min(1).max(3),
  cap_credits: z.number().positive().max(10).optional(),
})

/**
 * 确认的入参。
 *
 * `edits` 是**只带改过的那几格**，值的形状与 `BrandIntakeProfile` 对应那一格的
 * `value` 相同。没带的按分析结果走。
 */
const ConfirmBody = z.object({
  edits: z.record(z.string(), z.unknown()).optional(),
})

const ReanalyzeBody = z.object({
  urls: z.array(z.string().url('这不像一个网址')).min(1).max(3).optional(),
})

function portOf(deps: GatewayDeps): BrandIntakePort {
  const p = deps.brandIntake
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配品牌接入面（GatewayDeps.brandIntake）',
    )
  return p
}

type Ctx = Parameters<typeof principalOf>[0]

function actorOf(c: Ctx): BrandIntakeActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

export function brandIntakeRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/brand-intake/runs',
        operationId: 'startBrandIntake',
        summary:
          '贴一个官网或 Amazon 链接，后台跑第一轮基础分析（只抓公开页、遵 robots、积分封顶 2）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        // 它真的会去敲别人的服务器：急停开关对它有效
        outbound: true,
        body: StartBody,
        returns: 'BrandIntakeRun',
      },
      async (c, deps) => {
        const input = await body(c, StartBody)
        return ok(
          c,
          await portOf(deps).start(actorOf(c), {
            urls: input.urls,
            ...(input.cap_credits === undefined ? {} : { cap_credits: input.cap_credits }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/brand-intake/runs/latest',
        operationId: 'latestBrandIntake',
        summary: '这个工作区最近的那一次分析（向导回来时按它恢复现场）；没有就回 null',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'BrandIntakeRun | null',
      },
      async (c, deps) => ok(c, (await portOf(deps).latest(actorOf(c))) ?? null),
    ),
    route(
      {
        method: 'get',
        path: '/v1/brand-intake/runs/:id',
        operationId: 'getBrandIntake',
        summary: '一次分析的进度与结果（每个页面的成败都如实在 pages 里）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'id', in: 'path', required: true, description: '分析 id', schema: { type: 'string' } },
        ],
        returns: 'BrandIntakeRun',
      },
      async (c, deps) => ok(c, await portOf(deps).get(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/brand-intake/runs/:id/confirm',
        operationId: 'confirmBrandIntake',
        summary:
          '「看着没问题」：写进组织 / 工作区 / 知识库（标「自动分析，待核」）/ persona 上下文；带上用户改过的那几格',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [
          { name: 'id', in: 'path', required: true, description: '分析 id', schema: { type: 'string' } },
        ],
        body: ConfirmBody,
        returns: 'BrandIntakeRun',
      },
      async (c, deps) => {
        const input = await body(c, ConfirmBody)
        return ok(
          c,
          await portOf(deps).confirm(actorOf(c), {
            run_id: param(c, 'id'),
            ...(input.edits === undefined ? {} : { edits: input.edits }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/brand-intake/runs/:id/reanalyze',
        operationId: 'reanalyzeBrandIntake',
        summary: '重新分析（改了网址或换了新品时用）：**用户手改过的格子整格不动**',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        params: [
          { name: 'id', in: 'path', required: true, description: '分析 id', schema: { type: 'string' } },
        ],
        body: ReanalyzeBody,
        returns: 'BrandIntakeRun',
      },
      async (c, deps) => {
        const input = await body(c, ReanalyzeBody)
        return ok(
          c,
          await portOf(deps).reanalyze(actorOf(c), {
            run_id: param(c, 'id'),
            ...(input.urls === undefined ? {} : { urls: input.urls }),
          }),
          201,
        )
      },
    ),
  ]
}
