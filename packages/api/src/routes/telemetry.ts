/**
 * WP476（决策 1590）：匿名使用数据。
 *
 * 设置（登录了才能看 / 改）：
 * - `GET /v1/settings/telemetry`：开关、第一次提示看过没有、匿名设备号，以及**真的会发时**给工作台初始化 SDK
 *   用的配置（地址只有桌面安装包给；key 由云上给，没配就整套不发）；
 * - `PUT /v1/settings/telemetry`：改开关 / 记下提示看过了。
 * 一台机器一份（不分人、不分品牌）：它管的是「这台电脑上的工坊发不发匿名使用数据」。谁登录在这台机器上都能看、
 * 能改——关掉这件事不该要权限。
 *
 * 转发（posthog-js 的 `api_host` 是 `/v1/telemetry`，同源）：
 * - `POST /v1/telemetry/e/`、`/i/v0/e/`、`/batch/`：事件；`POST /v1/telemetry/s/`：录屏（默认关）；
 * - `POST /v1/telemetry/flags/`、`GET /v1/telemetry/array/:token/config`：只在云上开了录屏时有用（录屏要远程配置）。
 * 不要求登录（同 `/v1/client-errors`：SDK 不带我们的令牌）；自己一只限流桶；请求体有上限；
 * 宿主那边**再过一遍白名单**、核对 key，不信前端。没装配就照答不收。
 */
import type { TelemetryIngest, TelemetryPatch, TelemetryView } from '@agentsws/contracts'
import { TELEMETRY_RELAY_PATH } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok } from '../helpers.js'
import { TokenBucketLimiter } from '../rate-limit.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

type MaybePromise<T> = T | Promise<T>

export interface TelemetrySettingsPort {
  get(): MaybePromise<TelemetryView>
  set(patch: TelemetryPatch): MaybePromise<TelemetryView>
  /** posthog-js 经本机转发的一次请求；不给 = 照答不收。 */
  ingest?(input: TelemetryIngest): Promise<{ status: number; body: string }>
}

/** 一次最多收 2 MiB（录屏分块也在这个量级）；突发 60 次、之后每秒 2 次。 */
export const TELEMETRY_INGEST_MAX_BODY = 2 * 1024 * 1024
export const TELEMETRY_INGEST_RATE = { burst: 60, per_second: 2 }

const READ = { domain: 'skill', op: 'read', range: 'workspace', sensitivity: 'internal' } as const

const Body = z.object({
  enabled: z.boolean().optional(),
  notice_seen: z.boolean().optional(),
  /** WP477：工作台当前的界面语言（决策 1600：中文 → GA4 / PostHog 带 `market_region: CN`）。 */
  lang: z.enum(['zh', 'en']).optional(),
})

function portOf(deps: GatewayDeps): TelemetrySettingsPort {
  const p = deps.telemetry
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配使用数据开关（GatewayDeps.telemetry）',
    )
  return p
}

/** 转发的那几条路（posthog-js 自己拼的路径，结尾带斜杠）→ 宿主那边的口子。 */
const INGEST_PATHS: readonly { path: string; kind: TelemetryIngest['kind']; id: string }[] = [
  { path: `${TELEMETRY_RELAY_PATH}/e/`, kind: 'e', id: 'E' },
  { path: `${TELEMETRY_RELAY_PATH}/i/v0/e/`, kind: 'e', id: 'IV0E' },
  { path: `${TELEMETRY_RELAY_PATH}/batch/`, kind: 'batch', id: 'Batch' },
  { path: `${TELEMETRY_RELAY_PATH}/s/`, kind: 's', id: 'Snapshots' },
  { path: `${TELEMETRY_RELAY_PATH}/flags/`, kind: 'flags', id: 'Flags' },
]

export function telemetryRoutes(): Route[] {
  // 改的是这台机器上的一个隐私开关：登录了的谁都能看 / 改
  const own = { auth: 'bearer', assignment: true, authz: READ, authzBypass: () => true } as const
  // 每个网关一只桶（`collectRoutes()` 每建一次网关调一次）
  const limiter = new TokenBucketLimiter({ telemetry: TELEMETRY_INGEST_RATE })

  const relay =
    (kind: TelemetryIngest['kind']) =>
    async (c: Parameters<Parameters<typeof route>[1]>[0], deps: GatewayDeps): Promise<Response> => {
      const reply = (status: number, text: string): Response =>
        new Response(text, { status, headers: { 'content-type': 'application/json' } })
      const declared = Number(c.req.header('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > TELEMETRY_INGEST_MAX_BODY)
        return reply(413, '{"status":0}')
      const wall = deps.options?.wallClockMs ?? ((): number => Date.now())
      if (!limiter.take('local', 'telemetry', wall()).allowed) return reply(429, '{"status":0}')
      const port = deps.telemetry
      if (port?.ingest === undefined) return reply(200, '{"status":1}')
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (bytes.byteLength > TELEMETRY_INGEST_MAX_BODY) return reply(413, '{"status":0}')
      const url = new URL(c.req.url)
      const contentType = c.req.header('content-type')
      const out = await port.ingest({
        kind,
        query: url.search,
        ...(contentType === undefined ? {} : { contentType }),
        body: bytes,
      })
      return reply(out.status, out.body)
    }

  return [
    route(
      {
        method: 'get',
        path: '/v1/settings/telemetry',
        operationId: 'getTelemetrySettings',
        summary: 'WP476「帮助改进工坊（匿名使用数据）」开关与工作台上报配置（没配置就不发）',
        tag: 'settings',
        ...own,
        returns: 'TelemetryView',
      },
      async (c, deps) => {
        assignmentOf(c)
        return ok(c, await portOf(deps).get())
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/telemetry',
        operationId: 'putTelemetrySettings',
        summary: 'WP476 开 / 关匿名使用数据；记下第一次提示看过了；WP477 告诉本机服务界面语言',
        tag: 'settings',
        ...own,
        body: Body,
        returns: 'TelemetryView',
      },
      async (c, deps) => {
        assignmentOf(c)
        const input = await body(c, Body)
        return ok(
          c,
          await portOf(deps).set({
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.notice_seen === undefined ? {} : { notice_seen: input.notice_seen }),
            ...(input.lang === undefined ? {} : { lang: input.lang }),
          }),
        )
      },
    ),
    ...INGEST_PATHS.map(({ path, kind, id }) =>
      route(
        {
          method: 'post',
          path,
          operationId: `telemetryRelay${id}`,
          summary: 'WP476 工作台匿名使用数据经本机转发（宿主再过白名单、核对 key；没配置照答不收）',
          tag: 'kernel',
          auth: 'public',
          returns: '{ status }',
        },
        relay(kind),
      ),
    ),
    route(
      {
        method: 'get',
        path: `${TELEMETRY_RELAY_PATH}/array/:token/config`,
        operationId: 'telemetryRelayConfig',
        summary: 'WP476 录屏回放要的远程配置（只在云上开了录屏时转；默认 404）',
        tag: 'kernel',
        auth: 'public',
        returns: 'PostHog remote config',
      },
      relay('config'),
    ),
  ]
}
