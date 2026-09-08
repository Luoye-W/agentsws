/** 20 §5 身份与工作区路由。 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

const MagicLinkBody = z.object({ email: z.string().min(3) })
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
