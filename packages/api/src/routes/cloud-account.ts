/**
 * 49 M1 的**本地**那一半：这台机器上的工作区有没有关联 agentsws 云账号。
 *
 * 四条路由，三条边界：
 *
 * 1. **令牌明文一次都不出这一层**。`GET /v1/cloud/account` 只回邮箱、组织名、
 *    到期时间与动作集；令牌进本机加密库（`secret-store` 的 `cloud.workspace_token`），
 *    之后连这一层都读不到它的值（端口只端"存了哪些字段名"式的元信息）。
 * 2. **网关里不写业务**（28 §2）：怎么发信、怎么换会话、怎么向云侧要令牌，
 *    全在 `apps/server` 装配的 `CloudAccountPort` 里。
 * 3. 关联与解除是**整个工作区**的事（钱从这里出），所以走 `policy.stage@workspace`
 *    ——与换数据后端同一档权限，客服岗位看不到也点不动。
 *
 * 回调那条是 `public`：它是**用户在自己邮箱里点开的那条链接**的落点，浏览器
 * 不会带 Bearer。挡住"别人塞给你一条回调"的不是鉴权，是本地起关联时生成的
 * 一次性 `state`——对不上就当没发生。
 */

import type { CloudScope } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const TAG = 'cloud-account'

// ── 端口类型（apps/server 实现）────────────────────────────────────────

/** 关联状态。**这里没有、也不会有令牌字段。** */
export interface CloudAccountView {
  linked: boolean
  /** 云账号邮箱（关联了才有）。 */
  email?: string
  /** 云侧组织名（界面上叫"账号"，不叫"组织"）。 */
  org_name?: string
  /** 工作区服务令牌的到期时间；到期前界面提示续期。 */
  expires_at?: string
  scopes?: CloudScope[]
  linked_at?: string
  /** 云的地址（`AGENTSWS_CLOUD_BASE_URL`），给"这是连到哪儿"那一行。 */
  cloud_base_url: string
  /** 现在还关联不了的原因（比如这台机器没有秘密库密钥）。能关联时没有这一格。 */
  blocked_reason?: string
}

export interface BeginCloudLinkInput {
  email: string
  workspace_id: string
  person_id: string
}

export interface BeginCloudLinkResult {
  /** 一次性登录链接**只进邮件**，所以这里只有"几点过期"。 */
  expires_at: string
  delivered: 'email'
}

export interface CloudUnlinkResult {
  unlinked: boolean
  /** 云侧那一刀切成功没有。网络不通时是 false——本地照样断开，但要说出来。 */
  revoked_on_cloud: boolean
  reason?: string
}

export interface CloudAccountPort {
  status(workspace_id: string): Promise<CloudAccountView>
  /** 起一次关联：向云侧要一封登录邮件，落点是本机的回调。 */
  begin(input: BeginCloudLinkInput): Promise<BeginCloudLinkResult>
  /** 邮件链接落回本机：验一次性 token → 换会话 → 要工作区令牌 → 进加密库。 */
  complete(input: { token: string; state: string }): Promise<CloudAccountView>
  unlink(input: { workspace_id: string; person_id: string }): Promise<CloudUnlinkResult>
}

const LinkBody = z.object({ email: z.string().min(3).max(320) })

export function cloudAccountRoutes(): Route[] {
  const portOf = (port: CloudAccountPort | undefined): CloudAccountPort => {
    if (port === undefined)
      throw new ApiError('not_implemented', '这个服务进程没有装配云账号（49 M1）')
    return port
  }

  return [
    route(
      {
        method: 'get',
        path: '/v1/cloud/account',
        operationId: 'getCloudAccount',
        summary: '关联状态：邮箱、账号名、令牌到期、动作集（**不含令牌**）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'CloudAccountView',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(c, await portOf(deps.cloudAccount).status(p.workspace_id))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/cloud/account/link',
        operationId: 'linkCloudAccount',
        summary: '关联 agentsws 云账号：发一封登录邮件到这个邮箱',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        // 发信是一次出站动作：`AGENTSWS_HALT=outbound` 时这条也停（28 §4）
        outbound: true,
        body: LinkBody,
        returns: '{ expires_at, delivered: "email" }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, LinkBody)
        return ok(
          c,
          await portOf(deps.cloudAccount).begin({
            email: input.email.trim().toLowerCase(),
            workspace_id: p.workspace_id,
            person_id: p.person_id,
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/cloud/account/callback',
        operationId: 'cloudAccountCallback',
        summary: '邮件链接的落点（浏览器打开；靠一次性 state 认，不靠 Bearer）',
        tag: TAG,
        auth: 'public',
        params: [
          { name: 'token', in: 'query', required: true, description: '云侧的一次性登录 token' },
          { name: 'state', in: 'query', required: true, description: '本地起关联时生成的一次性串' },
        ],
        returns: '一张给浏览器看的 HTML 小页（不是 JSON 信封——这条是给人看的落点）',
      },
      async (c, deps) => {
        const token = c.req.query('token')
        const state = c.req.query('state')
        if (token === undefined || token === '' || state === undefined || state === '')
          return c.html(page('这条链接不完整', '回到工作台重新点一次「发登录邮件」。'), 400)
        try {
          const view = await portOf(deps.cloudAccount).complete({ token, state })
          return c.html(
            page(
              '已关联',
              `${view.email ?? ''} 已经和这台机器上的工作区关联好了。关掉这个页面，回工作台就能看到。`,
            ),
          )
        } catch (err) {
          // 出错也只说人话：链接里那串 token 一个字节都不回显
          const message = err instanceof ApiError ? err.message : '关联没成功，回工作台再试一次。'
          return c.html(page('没关联上', message), 400)
        }
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/cloud/account/unlink',
        operationId: 'unlinkCloudAccount',
        summary: '解除关联：删本机的令牌，并把云侧那条也撤掉',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        returns: '{ unlinked, revoked_on_cloud, reason? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(
          c,
          await portOf(deps.cloudAccount).unlink({
            workspace_id: p.workspace_id,
            person_id: p.person_id,
          }),
        )
      },
    ),
  ]
}

/** 回调页：一句话，没有脚本、没有外链、没有任何参数回显。 */
function page(title: string, detail: string): string {
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (ch) => `&#${String(ch.codePointAt(0) ?? 0)};`)
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#111}
h1{font-size:1.3rem;margin:0 0 .5rem}p{color:#555;margin:0}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(detail)}</p></body></html>`
}
