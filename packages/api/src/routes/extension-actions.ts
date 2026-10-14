/**
 * WP313（docs/101 §5.4，决策 550 / 555 / 556 / 557 / 558 / 562）：**插件动作通道**。
 *
 * 两种调用方，判权方式与 `/v1/extension/*` 那一套完全一样：
 *
 * - **插件**（插件令牌 + Origin，scope `ads.act`）：长轮询领活、拿上传表、报进度、交截图、
 *   报下载到哪、回结局；连接广告时记一次「看过风险告知并同意」（562）。
 *   **还是插件主动找本机**：本机服务永远不能直接伸手进浏览器。
 * - **工作台**（Bearer + `X-Assignment`）：看设置（「默认不碰」十个区域放没放开、同意过没有）、
 *   逐项放开 / 收回（557）、看排着和跑着的活、停一件、在卡上点「确认提交」。
 *
 * **进队不在这里**：没有任何一条 HTTP 路由能往队里塞活。进队只由审批执行器在卡批了之后调端口
 * （`ExtensionActionsPort.enqueue`，接线在 WP316），这样「没过审批的活」在协议层就没有入口。
 */

import type {
  ActionDownloadInput,
  ActionEvidenceInput,
  ActionEvidenceReceipt,
  ActionJob,
  ActionJobView,
  ActionNextResponse,
  ActionPlatform,
  ActionProgressInput,
  ActionProgressResponse,
  ActionResultInput,
  ActionSheetResponse,
  AdsActionSettings,
  GuardedZoneId,
} from '@agentsws/browser-action'
import { isGuardedZoneId } from '@agentsws/browser-action'
import type { MaybePromise, WorkspaceId } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { ExtensionSession } from '../extension-store.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { extensionSessionOf } from './extension.js'

/** 进队的入参（审批执行器调；不经 HTTP）。上传表的字节由本机服务存，插件按 id 来取。 */
export interface ActionEnqueueInput {
  job: ActionJob
  /** 要上传的动作必须带：表的原样字节。进队时再算一次指纹，和审批绑的对不上就不进。 */
  sheet_bytes?: Uint8Array
}

export type ActionEnqueueResult = { ok: true; job: ActionJobView } | { ok: false; why: string }

export interface ExtensionActionsPort {
  /* ── 插件 ─────────────────────────────────────────────────────────── */
  next(
    session: ExtensionSession,
    input: { platforms: ActionPlatform[]; wait_ms: number },
  ): Promise<ActionNextResponse>
  sheet(session: ExtensionSession, id: string): MaybePromise<ActionSheetResponse | undefined>
  progress(
    session: ExtensionSession,
    id: string,
    input: ActionProgressInput,
  ): MaybePromise<ActionProgressResponse | undefined>
  evidence(
    session: ExtensionSession,
    id: string,
    input: ActionEvidenceInput,
  ): Promise<ActionEvidenceReceipt | undefined>
  download(
    session: ExtensionSession,
    id: string,
    input: ActionDownloadInput,
  ): MaybePromise<{ recorded: true } | undefined>
  result(
    session: ExtensionSession,
    id: string,
    input: ActionResultInput,
  ): MaybePromise<ActionJobView | undefined>
  /** 插件的连接页上勾了「我看过了，同意」（562）。 */
  consent(
    session: ExtensionSession,
    input: { platform: ActionPlatform; text_version: string },
  ): MaybePromise<AdsActionSettings>

  /* ── 工作台 ───────────────────────────────────────────────────────── */
  settings(workspace_id: WorkspaceId): MaybePromise<AdsActionSettings>
  setZone(
    workspace_id: WorkspaceId,
    zone: GuardedZoneId,
    enabled: boolean,
  ): MaybePromise<AdsActionSettings>
  /** 收回同意（收回后这家后台的活一律不发给插件）。同意只在插件里勾（那一页有告知原文）。 */
  revokeConsent(
    workspace_id: WorkspaceId,
    platform: ActionPlatform,
  ): MaybePromise<AdsActionSettings>
  jobs(workspace_id: WorkspaceId): MaybePromise<ActionJobView[]>
  stop(workspace_id: WorkspaceId, id: string): MaybePromise<ActionJobView | undefined>
  confirm(workspace_id: WorkspaceId, id: string): MaybePromise<ActionJobView | undefined>

  /* ── 审批执行器（不经 HTTP；WP316 接线）──────────────────────────────── */
  enqueue(input: ActionEnqueueInput): Promise<ActionEnqueueResult>
}

const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const MANAGE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

function portOf(deps: GatewayDeps): ExtensionActionsPort {
  const p = deps.extensionActions
  if (p === undefined)
    throw new ApiError('not_implemented', '这个本机服务版本还没有插件动作通道（广告）。')
  return p
}

/** 插件这一侧：令牌 + Origin，再要 `ads.act`。老令牌没有它——重新配一次对就有了。 */
function actorOf(c: Parameters<Route['handler']>[0], deps: GatewayDeps): ExtensionSession {
  const session = extensionSessionOf(c, deps)
  if (!session.scopes.includes('ads.act'))
    throw new ApiError(
      'forbidden',
      '这把配对还没有广告权限。在工作台重新生成配对码、插件里再配一次。',
    )
  return session
}

const PLATFORMS = ['google_ads', 'meta_ads'] as const

const platformSchema = z.enum(PLATFORMS)

const progressSchema = z
  .object({
    step: z.number().int().min(0).max(500),
    of: z.number().int().min(0).max(500),
    label: z.string().max(40),
    waiting_confirm: z.boolean().optional(),
  })
  .strict()

/** 8 MB 的 PNG 编成 base64 大约 11 MB 字符。 */
const evidenceSchema = z
  .object({
    tag: z.enum(['before', 'preview', 'after']),
    png_base64: z.string().min(8).max(11_200_000),
    url: z.string().max(2_000),
    taken_at: z.string().min(1).max(40),
  })
  .strict()

const downloadSchema = z
  .object({
    tag: z.enum(['snapshot', 'report', 'result']),
    path: z.string().min(1).max(2_000),
    name: z.string().min(1).max(300),
    bytes: z.number().int().min(0).optional(),
  })
  .strict()

const resultSchema = z
  .object({
    outcome: z.enum(['done', 'failed', 'handover', 'stopped', 'rejected']),
    message: z.string().max(600),
    step: z.number().int().min(0).max(500),
    reads: z.record(z.string().max(60), z.string().max(600)),
  })
  .strict()

const consentSchema = z
  .object({ platform: platformSchema, text_version: z.string().min(1).max(40) })
  .strict()

const zoneSchema = z.object({ enabled: z.boolean() }).strict()

function parsePlatforms(raw: string | undefined): ActionPlatform[] {
  const out = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ActionPlatform => (PLATFORMS as readonly string[]).includes(s))
  if (out.length === 0)
    throw new ApiError('invalid_input', 'platforms 至少要一家（google_ads / meta_ads）')
  return [...new Set(out)]
}

function waitMs(raw: string | undefined): number {
  const n = Number(raw ?? '0')
  // 最多挂 25 秒（插件那边的超时比它长）
  return Number.isFinite(n) ? Math.max(0, Math.min(25, Math.floor(n))) * 1000 : 0
}

const missing = (): never => {
  throw new ApiError('not_found', '没有这件活，或者它已经结束了。')
}

export function extensionActionRoutes(): Route[] {
  return [
    /* ── 插件 ─────────────────────────────────────────────────────────── */
    route(
      {
        method: 'get',
        path: '/v1/extension/actions/next',
        operationId: 'extensionActionNext',
        summary: '插件长轮询领活（最多挂 25 秒）；同一账户一次一件、每天限额在领的那一刻判',
        tag: 'extension',
        auth: 'public',
        // 急停（outbound）时一件都不发：广告写操作就是对外动作
        outbound: true,
        params: [
          { name: 'platforms', in: 'query', required: true, description: 'google_ads,meta_ads' },
          { name: 'wait', in: 'query', description: '最多挂几秒（0–25）' },
        ],
        returns: 'ActionNextResponse',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const platforms = parsePlatforms(c.req.query('platforms'))
        return ok(
          c,
          await portOf(deps).next(session, { platforms, wait_ms: waitMs(c.req.query('wait')) }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/extension/actions/:id/sheet',
        operationId: 'extensionActionSheet',
        summary: '拿这件活绑定的上传表（插件拿到后自己再算一次指纹）',
        tag: 'extension',
        auth: 'public',
        returns: 'ActionSheetResponse',
      },
      async (c, deps) =>
        ok(c, (await portOf(deps).sheet(actorOf(c, deps), param(c, 'id'))) ?? missing()),
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/actions/:id/progress',
        operationId: 'extensionActionProgress',
        summary: '报进度（第几步）；回执里带「工作台点了停止」「卡上点了确认提交」',
        tag: 'extension',
        auth: 'public',
        body: progressSchema,
        returns: 'ActionProgressResponse',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const input = await body(c, progressSchema)
        const out = await portOf(deps).progress(session, param(c, 'id'), {
          step: input.step,
          of: input.of,
          label: input.label,
          ...(input.waiting_confirm === undefined
            ? {}
            : { waiting_confirm: input.waiting_confirm }),
        })
        return ok(c, out ?? missing())
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/actions/:id/evidence',
        operationId: 'extensionActionEvidence',
        summary: '交一张截图（只截广告后台那个标签页；跟变更账本存 180 天）',
        tag: 'extension',
        auth: 'public',
        body: evidenceSchema,
        returns: 'ActionEvidenceReceipt',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const input = await body(c, evidenceSchema)
        return ok(c, (await portOf(deps).evidence(session, param(c, 'id'), input)) ?? missing())
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/actions/:id/download',
        operationId: 'extensionActionDownload',
        summary: '报一个下载下来的文件存在哪（桌面端去读）',
        tag: 'extension',
        auth: 'public',
        body: downloadSchema,
        returns: '{ recorded: true }',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const input = await body(c, downloadSchema)
        const out = await portOf(deps).download(session, param(c, 'id'), {
          tag: input.tag,
          path: input.path,
          name: input.name,
          ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
        })
        return ok(c, out ?? missing())
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/actions/:id/result',
        operationId: 'extensionActionResult',
        summary: '回结局（做完 / 没做成 / 交给人 / 停了 / 退回）',
        tag: 'extension',
        auth: 'public',
        body: resultSchema,
        returns: 'ActionJobView',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const input = await body(c, resultSchema)
        return ok(c, (await portOf(deps).result(session, param(c, 'id'), input)) ?? missing())
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/extension/ads-consent',
        operationId: 'extensionAdsConsent',
        summary: '插件连接广告时勾了「看过风险告知，同意」（决策 562）',
        tag: 'extension',
        auth: 'public',
        body: consentSchema,
        returns: 'AdsActionSettings',
      },
      async (c, deps) => {
        const session = actorOf(c, deps)
        const input = await body(c, consentSchema)
        return ok(c, await portOf(deps).consent(session, input))
      },
    ),

    /* ── 工作台 ───────────────────────────────────────────────────────── */
    route(
      {
        method: 'get',
        path: '/v1/ads-actions/settings',
        operationId: 'adsActionSettings',
        summary: '插件广告动作的设置：「默认不碰」十个区域放没放开、两家后台同意过没有',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'AdsActionSettings',
      },
      async (c, deps) => ok(c, await portOf(deps).settings(principalOf(c).workspace_id)),
    ),
    route(
      {
        method: 'put',
        path: '/v1/ads-actions/zones/:zone',
        operationId: 'setAdsActionZone',
        summary: '逐项放开 / 收回一个「默认不碰」区域（放开后这类动作一律 L1；决策 557）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: MANAGE,
        body: zoneSchema,
        returns: 'AdsActionSettings',
      },
      async (c, deps) => {
        const zone = param(c, 'zone')
        if (!isGuardedZoneId(zone)) throw new ApiError('invalid_input', '没有这个区域')
        const input = await body(c, zoneSchema)
        return ok(c, await portOf(deps).setZone(principalOf(c).workspace_id, zone, input.enabled))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/ads-actions/consent/:platform/revoke',
        operationId: 'revokeAdsActionConsent',
        summary: '收回对某家后台的同意（之后这家的活一律不发给插件）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: MANAGE,
        returns: 'AdsActionSettings',
      },
      async (c, deps) => {
        const platform = platformSchema.safeParse(param(c, 'platform'))
        if (!platform.success) throw new ApiError('invalid_input', '没有这家后台')
        return ok(c, await portOf(deps).revokeConsent(principalOf(c).workspace_id, platform.data))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/ads-actions/jobs',
        operationId: 'listAdsActionJobs',
        summary: '排着、跑着、刚做完的插件动作',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ jobs: ActionJobView[] }',
      },
      async (c, deps) => ok(c, { jobs: await portOf(deps).jobs(principalOf(c).workspace_id) }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/ads-actions/jobs/:id/stop',
        operationId: 'stopAdsActionJob',
        summary: '停一件（排着的当场作废；跑着的下一步之前停）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'ActionJobView',
      },
      async (c, deps) =>
        ok(c, (await portOf(deps).stop(principalOf(c).workspace_id, param(c, 'id'))) ?? missing()),
    ),
    route(
      {
        method: 'post',
        path: '/v1/ads-actions/jobs/:id/confirm',
        operationId: 'confirmAdsActionJob',
        summary: '平台预览看过了，确认提交（与插件横条上的「确认提交」是同一个按钮）',
        tag: 'ads',
        auth: 'bearer',
        assignment: true,
        authz: MANAGE,
        outbound: true,
        returns: 'ActionJobView',
      },
      async (c, deps) =>
        ok(
          c,
          (await portOf(deps).confirm(principalOf(c).workspace_id, param(c, 'id'))) ?? missing(),
        ),
    ),
  ]
}
