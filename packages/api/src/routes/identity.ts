/** 20 §5 身份与工作区路由（WP33 补：`GET /v1/auth/session`、`POST /v1/auth/logout`）。 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ctxOf, ok, param, principalOf } from '../helpers.js'
import { SESSION_COOKIE, secretEquals, sessionCookie } from '../identity.js'
import { type Route, route } from '../route-spec.js'
import { hasTokenInfo } from '../types.js'

const MagicLinkBody = z.object({ email: z.string().min(3) })
const SessionBody = z.object({ key: z.string().min(8), email: z.string().min(3).optional() })
/** 会话 cookie 的有效期；与内存 / SQLite 身份服务的会话 token 默认一致（12h）。 */
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60
const VerifyBody = z.object({ token: z.string().min(1) })
const CreateWorkspaceBody = z.object({
  name: z.string().min(1),
  kind: z.enum(['personal', 'shared']).optional(),
  tz: z.string().optional(),
  base_currency: z.string().optional(),
})
const AddMemberBody = z.object({
  person_id: z.string().min(1),
  role: z.enum(['owner', 'manager', 'member']),
  ranges: z
    .array(
      z.object({
        kind: z.enum(['store', 'department', 'account', 'market']),
        id: z.string().min(1),
      }),
    )
    .optional(),
})

export function identityRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/auth/magic-link',
        operationId: 'issueMagicLink',
        summary: '签发一次性登录 token（本地档直接返回；托管档由邮件投递）',
        tag: 'identity',
        auth: 'public',
        body: MagicLinkBody,
        returns: '{ expires_at, token? }（token 只在本地单机档回传）',
      },
      async (c, deps) => {
        const input = await body(c, MagicLinkBody)
        const issued = await deps.identity.issueLogin(input.email)
        // 托管档不把一次性 token 放进 HTTP 响应，只经邮件投递（20 §3）。
        return deps.options?.exposeMagicLinkToken === false
          ? ok(c, { expires_at: issued.expires_at, delivered: 'email' })
          : ok(c, issued)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/auth/verify',
        operationId: 'verifyMagicLink',
        summary: '验证一次性 token，换会话 token',
        tag: 'identity',
        auth: 'public',
        body: VerifyBody,
        returns: '{ person, session_token }',
      },
      async (c, deps) => {
        const input = await body(c, VerifyBody)
        const out = await deps.identity.verifyLogin(input.token)
        if (!out) throw new ApiError('unauthenticated', '登录 token 无效或已用过')
        return ok(c, out)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/auth/session',
        operationId: 'exchangeSession',
        summary: '用桌面壳的会话密钥换一个 HttpOnly cookie（13 §5）',
        tag: 'identity',
        auth: 'public',
        body: SessionBody,
        returns: '{ person, workspace_id }（**不回 token**：它只在 Set-Cookie 里）',
      },
      async (c, deps) => {
        const expected = deps.options?.sessionKey
        if (expected === undefined || expected.trim() === '')
          throw new ApiError('not_implemented', '这个服务进程没有配 AGENTSWS_SESSION_KEY')
        const input = await body(c, SessionBody)
        if (!secretEquals(input.key, expected))
          throw new ApiError('unauthenticated', '会话密钥不对')
        const email = input.email ?? deps.options?.sessionOwnerEmail
        if (email === undefined) throw new ApiError('invalid_input', '不知道该换成谁的会话')
        // 一次性 token 在**服务端内部**生成并立刻兑换：它从头到尾没出过这个进程，
        // 所以不会出现在 URL、不会出现在日志、也不会留在浏览器历史里。
        const issued = await deps.identity.issueLogin(email)
        const verified = await deps.identity.verifyLogin(issued.token)
        if (!verified) throw new ApiError('unauthenticated', '一次性 token 兑换失败')
        const person = verified.person
        const name = deps.options?.sessionCookieName ?? SESSION_COOKIE
        c.header(
          'Set-Cookie',
          sessionCookie(name, verified.session_token, {
            maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
          }),
        )
        const workspace = (await deps.identity.workspacesOf?.(person.id))?.[0]
        return ok(c, {
          person: { id: person.id, email: person.email, name: person.name },
          ...(workspace === undefined ? {} : { workspace_id: workspace.id }),
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/auth/session',
        operationId: 'getSession',
        summary: '当前会话：是谁、哪个工作区、哪种凭据、什么时候到期',
        tag: 'identity',
        auth: 'bearer',
        returns: '{ person, workspace_id, kind, expires_at?, expires_in_seconds? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const person = await deps.identity.getPerson(p.person_id)
        if (!person) throw new ApiError('not_found', '人不存在')
        const token = ctxOf(c).token
        // 到期时间是可选面：换一个只实现契约 `IdentityService` 的身份服务时这两个键不出，
        // 客户端照旧能用（它本来就该在 401 时去重新登录，而不是靠倒计时）。
        const info =
          token === undefined || !hasTokenInfo(deps.identity)
            ? undefined
            : await deps.identity.tokenInfo(token)
        const expires_at = info?.expires_at
        const remaining =
          expires_at === undefined
            ? undefined
            : Math.max(
                0,
                Math.floor((Date.parse(expires_at) - Date.parse(deps.clock.now())) / 1000),
              )
        return ok(c, {
          person: { id: person.id, email: person.email, name: person.name },
          workspace_id: p.workspace_id,
          kind: p.kind,
          ...(expires_at === undefined ? {} : { expires_at }),
          ...(remaining === undefined ? {} : { expires_in_seconds: remaining }),
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/auth/logout',
        operationId: 'logout',
        summary: '注销：撤销**这一张** token 并清掉会话 cookie',
        tag: 'identity',
        auth: 'bearer',
        returns: '{ revoked: boolean }',
      },
      async (c, deps) => {
        const token = ctxOf(c).token
        // 撤销的是本次请求用的那一张，不是这个人的全部——同一个人在别的设备 / CLI 上的会话
        // 不该被一次退出登录连坐（20 §3「所有 token 绑 workspace，可撤销」）。
        if (token !== undefined) await deps.identity.revoke(token)
        // 不管调用方用的是 cookie 还是 bearer 都把 cookie 抹掉：空值 + Max-Age=0。
        const name = deps.options?.sessionCookieName ?? SESSION_COOKIE
        c.header('Set-Cookie', sessionCookie(name, '', { maxAgeSeconds: 0 }))
        return ok(c, { revoked: token !== undefined })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/me',
        operationId: 'getMe',
        summary: '当前主体：人、工作区、成员身份、名下 Assignment',
        tag: 'identity',
        auth: 'bearer',
        returns: '{ person, workspace, membership, assignments, kind }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const person = await deps.identity.getPerson(p.person_id)
        if (!person) throw new ApiError('not_found', '人不存在')
        const workspace = await deps.identity.getWorkspace(p.workspace_id)
        const members = await deps.identity.members(p.workspace_id)
        return ok(c, {
          person,
          workspace,
          membership: members.find((m) => m.person_id === p.person_id && m.left_at === undefined),
          assignments: deps.roles.listAssignments(p.person_id, { workspace_id: p.workspace_id }),
          kind: p.kind,
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/workspaces',
        operationId: 'createWorkspace',
        summary: '创建工作区（创建者即 owner）',
        tag: 'identity',
        auth: 'bearer',
        body: CreateWorkspaceBody,
        returns: 'Workspace',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const input = await body(c, CreateWorkspaceBody)
        const workspace = await deps.identity.createWorkspace({
          name: input.name,
          owner_id: p.person_id,
          kind: input.kind ?? 'personal',
          ...(input.tz === undefined ? {} : { tz: input.tz }),
          ...(input.base_currency === undefined ? {} : { base_currency: input.base_currency }),
        })
        return ok(c, workspace, 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/workspaces/:id/memberships',
        operationId: 'addMembership',
        summary: '加成员（只有本工作区的策略层写权限可调）',
        tag: 'identity',
        auth: 'bearer',
        assignment: true,
        authz: { domain: 'policy', op: 'stage', range: 'workspace', sensitivity: 'restricted' },
        params: [{ name: 'id', in: 'path', required: true, description: '工作区 id' }],
        body: AddMemberBody,
        returns: 'Membership',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        // 20 §3：token 绑工作区，跨工作区一律显式切换，不在这条路由上放行。
        if (id !== p.workspace_id) throw new ApiError('forbidden', '凭据不属于该工作区')
        const input = await body(c, AddMemberBody)
        const membership = await deps.identity.addMember({
          workspace_id: id,
          person_id: input.person_id,
          role: input.role,
          ranges: input.ranges ?? [],
        })
        return ok(c, membership, 201)
      },
    ),
  ]
}
