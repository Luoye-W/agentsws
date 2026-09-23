/** 路由处理器共用的小工具：统一信封、上下文取值、请求体校验。 */
import type { ApprovalItem, Assignment, PersonId } from '@agentsws/contracts'
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { ApiError } from './errors.js'
import type { GatewayEnv, RouteSpec } from './route-spec.js'
import type { Principal, RequestContext } from './types.js'

/** 统一成功信封：`{ data, trace_id }`。 */
export function ok<T>(c: Context<GatewayEnv>, data: T, status = 200): Response {
  const rctx = c.get('rctx')
  return c.json({ data, trace_id: rctx.trace_id }, status as 200)
}

export function ctxOf(c: Context<GatewayEnv>): RequestContext {
  return c.get('rctx')
}

export function principalOf(c: Context<GatewayEnv>): Principal {
  const p = c.get('rctx').principal
  // 中间件已保证 bearer 路由必有 principal；到这里还没有就是装配错误。
  if (!p) throw new ApiError('unauthenticated', '缺少凭据')
  return p
}

export function assignmentOf(c: Context<GatewayEnv>): Assignment {
  const a = c.get('rctx').assignment
  if (!a) throw new ApiError('invalid_input', '缺少 X-Assignment 头')
  return a
}

/** 改公司档案那一级的权限（05：owner 的策略层写）。 */
export const OWNER_WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

/**
 * 「所有者站在随便哪一条分配上」这把尺子（09-17 Luoye 真机打出来的洞）。
 *
 * WP69 / WP71 之后 `X-Assignment` = **当前岗位**，而工作台挑的是本人名下第一条
 * 未撤销的分配。所有者站在那一条上打开首次设置向导，写公司档案就 403——
 * `policy.stage@workspace` 是所有者层的权限，不属于他当下站着的那个岗位。
 *
 * 放行条件：**本人在这个工作区持有任何一条能 `policy.stage@workspace` 的、未撤销
 * 的分配**。不是扩权：只看本人名下的分配，没有所有者层的成员照样 403；请求上的
 * `X-Assignment` 仍按 31 §3.1 绑定与记账。
 *
 * 放在这里而不是各自的路由文件里，是因为要用它的不止一处：向导的
 * `/v1/workspace/profile` 与 `/v1/onboarding/apply`，还有向导第 ② 步那五条
 * `/v1/brand-intake/*`（确认档案卡改的正是同一样东西）。分成两份的话，哪天多一条
 * 同类的路由就会忘了挂，用户又会看见一次 403。
 */
export const holdsOwnerWrite: NonNullable<RouteSpec['authzBypass']> = (_c, rctx, deps) => {
  const p = rctx.principal
  if (!p) return false
  return deps.roles.listAssignments(p.person_id, { workspace_id: p.workspace_id }).some(
    (a) =>
      a.revoked_at === undefined &&
      deps.roles.can(a.id, OWNER_WRITE.domain, OWNER_WRITE.op, {
        range: OWNER_WRITE.range,
        sensitivity: OWNER_WRITE.sensitivity,
      }),
  )
}

/**
 * 四个吃品牌设计规范的岗位域（WP122b，71 §9 第 9 条）。
 *
 * 职责 id 的**第一段**就是岗位域（`packages/roles/roles/<域>/*.yml`）：
 * 设计 / 建站 / 社媒 / 投放。这四类职责的日常动作是照着 `DESIGN.md` 出活，
 * 右栏打开规范面板却拿 403——只读这一份文件不该需要 `policy.read workspace`
 * （那是 owner 一级），所以读的路由挂这条窄放行。
 */
export const DESIGN_READER_ROLE_PREFIXES = ['design.', 'site.', 'social.', 'ads.'] as const

/**
 * 「持四类职责之一 + 同一工作区内」的窄放行（WP122b 交付 ②）。
 *
 * 只看本人名下**在这个工作区**的未撤销分配，不看请求上的 `X-Assignment`——
 * 与 {@link holdsOwnerWrite} 同一条判定纪律（岗位是人的属性，不是请求头的属性；
 * 31 §3.1 的绑定与记账照旧）。改的路由**不挂**它：改错一个色值，下一批活
 * 全跟着错，写永远是 owner 一级。
 */
export const holdsDesignDutyRead: NonNullable<RouteSpec['authzBypass']> = (_c, rctx, deps) => {
  const p = rctx.principal
  if (!p) return false
  return deps.roles
    .listAssignments(p.person_id, { workspace_id: p.workspace_id })
    .some(
      (a) =>
        a.revoked_at === undefined &&
        DESIGN_READER_ROLE_PREFIXES.some((prefix) => a.role_id.startsWith(prefix)),
    )
}

/** zod 校验；失败 → invalid_input（400），details 带字段路径。 */
export async function body<T>(c: Context<GatewayEnv>, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  const text = await c.req.text()
  if (text.trim() === '') raw = {}
  else {
    try {
      raw = JSON.parse(text)
    } catch {
      throw new ApiError('invalid_input', '请求体不是合法 JSON')
    }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    throw new ApiError('invalid_input', '请求体校验失败', {
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  return parsed.data
}

/** 路径参数；路由注册时是动态路径，类型上是 `string | undefined`，缺失即路由装配错误。 */
export function param(c: Context<GatewayEnv>, name: string): string {
  const value = c.req.param(name)
  if (value === undefined || value === '')
    throw new ApiError('invalid_input', `缺少路径参数 ${name}`)
  return value
}

export function listParam(c: Context<GatewayEnv>, name: string): string[] | undefined {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return undefined
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

export function intParam(c: Context<GatewayEnv>, name: string): number | undefined {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new ApiError('invalid_input', `${name} 必须是非负整数`)
  return n
}

/**
 * 14 §7：decision_token 是一次性凭据，只属于收件人本人。
 * 队列 / 详情返回时抹掉别人那份，否则 A 能拿 B 的 token 去决定。
 */
export function redactItem(item: ApprovalItem, person: PersonId): ApprovalItem {
  return {
    ...item,
    deliveries: item.deliveries.map((d) =>
      d.to === person ? d : { ...d, decision_token: '[redacted]' },
    ),
  }
}

/** 取当前人还能用的那张 token（body 没带 decision_token 时用）。 */
export function tokenFor(item: ApprovalItem, person: PersonId): string | undefined {
  const usable = item.deliveries.filter(
    (d) => d.to === person && d.status !== 'expired' && d.status !== 'acted',
  )
  return usable[usable.length - 1]?.decision_token
}
