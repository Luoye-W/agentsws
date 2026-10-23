/**
 * WP475（决策 1591、1592）：左下角「反馈」——本机这一侧的四条路。
 *
 * - `GET  /v1/feedback/draft?route=&locale=&app_version=&shell=`：打开反馈框时先要的——联系方式默认值、
 *   勾着「附上诊断信息」时会发出去的那一份（已脱敏，给人展开看）；
 * - `POST /v1/feedback`：交一条。宿主先存本机队列，再试着发到云；发不出去回 `delivered: false`
 *   （界面说「已保存，联网后自动发出」），之后自己补发；
 * - `GET  /v1/feedback?refresh=1`：「我的反馈」——本机记的每一条 + 云上的状态与回复；
 * - `POST /v1/feedback/seen`：看过了（回复的未读数清零）。
 *
 * 都是本人自己的东西：只看得到、交得了自己那一份。诊断信息由宿主自己收、自己脱敏——页面只报它知道的
 * 几样（路径、语言、桌面壳版本），路径在这里先去一遍查询串。
 */
import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_SCREENSHOT_TYPES,
  type FeedbackDraftView,
  type FeedbackScreenshotType,
  type LocalFeedbackList,
  type LocalFeedbackSubmit,
  type LocalFeedbackSubmitted,
  type MaybePromise,
  type PersonId,
  type WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const TAG = 'feedback'

/** 截图 base64 之后的长度上限（4 MiB 原图 → 约 5.6 MB 文本）。 */
const SCREENSHOT_B64_MAX = Math.ceil((FEEDBACK_SCREENSHOT_MAX_BYTES * 4) / 3) + 4
/** 整个请求体上限（截图 + 一句话 + 几格小字段）。 */
export const FEEDBACK_LOCAL_MAX_BODY = SCREENSHOT_B64_MAX + 64 * 1024

export interface FeedbackActor {
  workspace_id: WorkspaceId
  person_id: PersonId
}

/** 页面报给宿主的那几样（宿主据此出诊断信息）。 */
export interface FeedbackPageContext {
  route: string
  locale: string
  app_version?: string
  shell?: 'desktop' | 'browser'
}

export interface FeedbackPort {
  draft(actor: FeedbackActor, page: FeedbackPageContext): MaybePromise<FeedbackDraftView>
  submit(actor: FeedbackActor, input: LocalFeedbackSubmit): MaybePromise<LocalFeedbackSubmitted>
  mine(actor: FeedbackActor, opts: { refresh: boolean }): MaybePromise<LocalFeedbackList>
  seen(actor: FeedbackActor): MaybePromise<{ unread: number }>
}

/** 只留路径：去掉查询串与 `#…`、截长（`?token=` 这类一律不出门）。 */
export function routeOnly(raw: string): string {
  const path = raw.replace(/[?#].*$/, '').trim()
  const clean = path.startsWith('/') ? path : `/${path}`
  return clean.length <= 200 ? clean : clean.slice(0, 200)
}

const short = (max: number) => z.string().max(max)

const SubmitBody = z.object({
  kind: z.enum(FEEDBACK_KINDS as unknown as [string, ...string[]]),
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX),
  contact: short(FEEDBACK_CONTACT_MAX).optional(),
  include_diagnostics: z.boolean(),
  route: short(2000),
  locale: short(40),
  app_version: short(80).optional(),
  shell: z.enum(['desktop', 'browser']).optional(),
  screenshot: z
    .object({
      content_type: z.enum(FEEDBACK_SCREENSHOT_TYPES as unknown as [string, ...string[]]),
      data_base64: z
        .string()
        .min(1)
        .max(SCREENSHOT_B64_MAX)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .optional(),
})

function portOf(deps: GatewayDeps): FeedbackPort {
  const p = deps.feedback
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配反馈（GatewayDeps.feedback）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): FeedbackActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

export function feedbackRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/feedback/draft',
        operationId: 'feedbackDraft',
        summary: 'WP475 打开反馈框：联系方式默认值 + 将要附上的诊断信息（已脱敏）',
        tag: TAG,
        auth: 'bearer',
        params: [
          { name: 'route', in: 'query', description: '当前页面路径（查询串会被去掉）' },
          { name: 'locale', in: 'query', description: '界面语言' },
          { name: 'app_version', in: 'query', description: '桌面壳版本（有桥才有）' },
          { name: 'shell', in: 'query', description: 'desktop | browser' },
        ],
        returns: 'FeedbackDraftView',
      },
      async (c, deps) => {
        const shell = c.req.query('shell')
        const app_version = c.req.query('app_version')
        const page: FeedbackPageContext = {
          route: routeOnly(c.req.query('route') ?? '/'),
          locale: (c.req.query('locale') ?? '').slice(0, 40),
          ...(app_version === undefined || app_version === ''
            ? {}
            : { app_version: app_version.slice(0, 80) }),
          ...(shell === 'desktop' || shell === 'browser' ? { shell } : {}),
        }
        return ok(c, await portOf(deps).draft(actorOf(c), page))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/feedback',
        operationId: 'submitFeedback',
        summary: 'WP475 交一条反馈（先存本机，发不出去就联网后自动补发）',
        tag: TAG,
        auth: 'bearer',
        body: SubmitBody,
        returns: 'LocalFeedbackSubmitted',
      },
      async (c, deps) => {
        const declared = Number(c.req.header('content-length') ?? '0')
        if (Number.isFinite(declared) && declared > FEEDBACK_LOCAL_MAX_BODY)
          throw new ApiError('invalid_input', '截图太大了，换一张小一点的')
        const input = await body(c, SubmitBody)
        const submit: LocalFeedbackSubmit = {
          kind: input.kind as LocalFeedbackSubmit['kind'],
          message: input.message,
          ...(input.contact === undefined ? {} : { contact: input.contact.trim() }),
          include_diagnostics: input.include_diagnostics,
          route: routeOnly(input.route),
          locale: input.locale,
          ...(input.app_version === undefined ? {} : { app_version: input.app_version }),
          ...(input.shell === undefined ? {} : { shell: input.shell }),
          ...(input.screenshot === undefined
            ? {}
            : {
                screenshot: {
                  content_type: input.screenshot.content_type as FeedbackScreenshotType,
                  data_base64: input.screenshot.data_base64,
                },
              }),
        }
        return ok(c, await portOf(deps).submit(actorOf(c), submit))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/feedback',
        operationId: 'listMyFeedback',
        summary: 'WP475 我的反馈：本机记的每一条 + 云上的状态与回复',
        tag: TAG,
        auth: 'bearer',
        params: [
          {
            name: 'refresh',
            in: 'query',
            description: '1 = 先去云上查一遍进度（有节流）',
          },
        ],
        returns: 'LocalFeedbackList',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).mine(actorOf(c), { refresh: c.req.query('refresh') === '1' })),
    ),
    route(
      {
        method: 'post',
        path: '/v1/feedback/seen',
        operationId: 'markFeedbackSeen',
        summary: 'WP475 我的反馈看过了（回复的未读数清零）',
        tag: TAG,
        auth: 'bearer',
        returns: '{ unread }',
      },
      async (c, deps) => ok(c, await portOf(deps).seen(actorOf(c))),
    ),
  ]
}
