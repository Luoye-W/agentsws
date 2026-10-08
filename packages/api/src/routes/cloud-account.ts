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

import type { CloudAuthConfig, CloudAuthLocale, CloudScope } from '@agentsws/contracts'
import { CLOUD_PASSWORD_MAX, CLOUD_PASSWORD_MIN, LEGAL_TERMS_VERSION } from '@agentsws/contracts'
import { type ZodType, z } from 'zod'
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
  /**
   * WP265（决策 186）：这把令牌比现在的默认动作集少了哪几项（老令牌签发时还没有 `store`）。
   * 只在关联了、且能读出签发时的动作集时才有；补上的办法是重新登录一次（`refresh: true`）。
   */
  missing_scopes?: CloudScope[]
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

/** WP231：验证码发出去了（登录 / 忘记密码对没注册的邮箱静默不发，回包一样）。 */
export interface CloudCodeSentView {
  expires_at: string
  delivered: 'email'
}

/** WP231：注册 / 登录成了——关联状态，外加这一下是不是刚注册、送了多少积分。 */
export interface CloudAuthDoneView extends CloudAccountView {
  registered?: boolean
  bonus_credits?: number
}

/**
 * WP231：注册与登录（密码 + 邮箱验证码）。**密码与验证码只经这一跳转发到云（HTTPS）**：
 * 不落盘、不进事件、不进日志、不经 AI。老的 `begin` / `complete`（邮件链接）保留给老客户端。
 */
export interface CloudAuthPort {
  authConfig(): Promise<CloudAuthConfig>
  signup(input: {
    name: string
    email: string
    password: string
    locale: CloudAuthLocale
    terms_version: string
  }): Promise<CloudCodeSentView>
  verifySignup(input: { email: string; code: string }): Promise<CloudAuthDoneView>
  sendLoginCode(input: {
    email: string
    locale: CloudAuthLocale
    refresh?: boolean
  }): Promise<CloudCodeSentView>
  /**
   * `refresh`（WP265）：已经关联了、再登录一次**同一个账号**换新令牌（老令牌缺新动作集时用）；
   * 新的存好了才撤旧的，登录没成什么都不动。
   */
  verifyLoginCode(input: {
    email: string
    code: string
    refresh?: boolean
  }): Promise<CloudAuthDoneView>
  passwordLogin(input: {
    email: string
    password: string
    refresh?: boolean
  }): Promise<CloudAuthDoneView>
  forgotPassword(input: { email: string; locale: CloudAuthLocale }): Promise<CloudCodeSentView>
  resetPassword(input: {
    email: string
    code: string
    new_password: string
  }): Promise<CloudAuthDoneView>
}

export interface CloudAccountPort {
  /** WP231：注册 / 登录那几条（没装配就 501，老的邮件链接照旧）。 */
  auth?: CloudAuthPort
  status(workspace_id: string): Promise<CloudAccountView>
  /** 起一次关联：向云侧要一封登录邮件，落点是本机的回调。 */
  begin(input: BeginCloudLinkInput): Promise<BeginCloudLinkResult>
  /** 邮件链接落回本机：验一次性 token → 换会话 → 要工作区令牌 → 进加密库。 */
  complete(input: { token: string; state: string }): Promise<CloudAccountView>
  unlink(input: { workspace_id: string; person_id: string }): Promise<CloudUnlinkResult>
}

const LinkBody = z.object({ email: z.string().min(3).max(320) })

// ── WP231 的几张表单（密码长度在这里先挡一道，云上再挡一道）─────────────
const Email = z.string().trim().toLowerCase().min(3).max(320)
const Locale = z.enum(['zh', 'en']).default('zh')
const Password = z.string().min(CLOUD_PASSWORD_MIN).max(CLOUD_PASSWORD_MAX)
const Code = z
  .string()
  .trim()
  .regex(/^\d{6}$/u)
const SignupBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: Email,
  password: Password,
  /** 没勾「我已阅读并同意」就不许发。 */
  accept_terms: z.literal(true),
  terms_version: z.string().min(1).max(40).default(LEGAL_TERMS_VERSION),
  locale: Locale,
})
const CodeBody = z.object({ email: Email, code: Code })
/** WP265：登录那两条多一个 `refresh`（已关联时同一账号再登录一次，换一把带新动作集的令牌）。 */
const LoginCodeBody = CodeBody.extend({ refresh: z.boolean().optional() })
const EmailBody = z.object({ email: Email, locale: Locale })
const LoginEmailBody = EmailBody.extend({ refresh: z.boolean().optional() })
const PasswordLoginBody = z.object({
  email: Email,
  password: z.string().min(1).max(CLOUD_PASSWORD_MAX),
  refresh: z.boolean().optional(),
})
const ResetBody = z.object({ email: Email, code: Code, new_password: Password })

export function cloudAccountRoutes(): Route[] {
  const portOf = (port: CloudAccountPort | undefined): CloudAccountPort => {
    if (port === undefined)
      throw new ApiError('not_implemented', '这个服务进程没有装配云账号（49 M1）')
    return port
  }

  /** WP231：注册 / 登录那几条要的口；老节点没装配就 501（老的邮件链接照旧能用）。 */
  const authOf = (port: CloudAccountPort | undefined): CloudAuthPort => {
    const auth = portOf(port).auth
    if (auth === undefined)
      throw new ApiError('not_implemented', '这个服务进程没有装配注册 / 登录（WP231）')
    return auth
  }

  /**
   * WP231 的一条 POST：关联是整个工作区的事（`policy.stage@workspace`），而且是一次出站。
   * 请求体里的密码 / 验证码只在这一次调用里，**不进任何日志与事件**。
   */
  const authRoute = <T, R>(
    path: string,
    operationId: string,
    summary: string,
    schema: ZodType<T>,
    run: (port: CloudAuthPort, input: T) => Promise<R>,
    returns: string,
  ): Route =>
    route(
      {
        method: 'post',
        path,
        operationId,
        summary,
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        body: schema,
        returns,
      },
      async (c, deps) => {
        assignmentOf(c)
        const input = await body(c, schema)
        return ok(c, await run(authOf(deps.cloudAccount), input))
      },
    )

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
    // ── WP231：注册与登录（密码 + 邮箱验证码）。密码与验证码只转发到云，不落盘、不进事件 ──
    route(
      {
        method: 'get',
        path: '/v1/cloud/account/auth-config',
        operationId: 'getCloudAuthConfig',
        summary: '注册 / 登录界面要知道的几样（密码最短几位、验证码几位、条款版本）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        outbound: true,
        returns: 'CloudAuthConfig',
      },
      async (c, deps) => {
        assignmentOf(c)
        return ok(c, await authOf(deps.cloudAccount).authConfig())
      },
    ),
    authRoute(
      '/v1/cloud/account/signup',
      'cloudSignup',
      '注册：名字 + 邮箱 + 密码 + 同意条款 → 云发一封 6 位注册验证码',
      SignupBody,
      (port, input) =>
        port.signup({
          name: input.name,
          email: input.email,
          password: input.password,
          locale: input.locale,
          terms_version: input.terms_version,
        }),
      '{ expires_at, delivered: "email" }',
    ),
    authRoute(
      '/v1/cloud/account/signup/verify',
      'cloudSignupVerify',
      '注册验证码 → 建号、送注册积分、关联这台机器',
      CodeBody,
      (port, input) => port.verifySignup(input),
      'CloudAuthDoneView',
    ),
    authRoute(
      '/v1/cloud/account/code',
      'cloudLoginCode',
      '登录：发一封 6 位登录验证码（没注册的邮箱云上静默不发；`refresh` 见验码那条）',
      LoginEmailBody,
      (port, input) =>
        port.sendLoginCode({
          email: input.email,
          locale: input.locale,
          ...(input.refresh === true ? { refresh: true } : {}),
        }),
      '{ expires_at, delivered: "email" }',
    ),
    authRoute(
      '/v1/cloud/account/code/verify',
      'cloudLoginCodeVerify',
      '登录验证码 → 关联这台机器（`refresh: true`：已关联时同一账号换一把新令牌）',
      LoginCodeBody,
      (port, input) =>
        port.verifyLoginCode({
          email: input.email,
          code: input.code,
          ...(input.refresh === true ? { refresh: true } : {}),
        }),
      'CloudAuthDoneView',
    ),
    authRoute(
      '/v1/cloud/account/password-login',
      'cloudPasswordLogin',
      '密码登录 → 关联这台机器（`refresh: true`：已关联时同一账号换一把新令牌）',
      PasswordLoginBody,
      (port, input) =>
        port.passwordLogin({
          email: input.email,
          password: input.password,
          ...(input.refresh === true ? { refresh: true } : {}),
        }),
      'CloudAuthDoneView',
    ),
    authRoute(
      '/v1/cloud/account/password/forgot',
      'cloudPasswordForgot',
      '忘记密码：发一封重置验证码',
      EmailBody,
      (port, input) => port.forgotPassword(input),
      '{ expires_at, delivered: "email" }',
    ),
    authRoute(
      '/v1/cloud/account/password/reset',
      'cloudPasswordReset',
      '验证码 + 新密码 → 设好新密码（别的会话全部失效）并关联这台机器',
      ResetBody,
      (port, input) => port.resetPassword(input),
      'CloudAuthDoneView',
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
