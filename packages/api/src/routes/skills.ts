/** 24 §5 技能与学习回路 API（v1 只开 resolved / personal overlay / lessons）。 */
import type { LessonRecord } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

const READ = { domain: 'skill', op: 'read', range: 'workspace', sensitivity: 'internal' } as const
const WRITE = { domain: 'skill', op: 'stage', range: 'workspace', sensitivity: 'internal' } as const

const LESSON_STATUS = ['pooled', 'proposed', 'accepted', 'ignored', 'refuted'] as const

const OverlayBody = z.object({
  ops: z
    .array(
      z.object({
        op: z.enum(['replace', 'append', 'remove']),
        section_id: z.string().min(1),
        body: z.string().optional(),
        origin: z.enum(['authored', 'learned']).optional(),
      }),
    )
    .min(1),
  base_version: z.string().min(1),
  version: z.number().int().nonnegative(),
})

export function skillRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/skills/:name/resolved',
        operationId: 'getResolvedSkill',
        summary: '按 actor 解析后的技能（包 → 公司 → 部门 → 个人，同段冲突不自动合）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'name', in: 'path', required: true, description: '技能名' },
          { name: 'department', in: 'query', description: '部门 id（可选）' },
        ],
        returns: 'ResolvedSkill',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const department = c.req.query('department')
        const resolved = await deps.skills.resolve(param(c, 'name'), {
          person_id: p.person_id,
          workspace_id: p.workspace_id,
          ...(department === undefined ? {} : { department_id: department }),
        })
        if (!resolved) throw new ApiError('not_found', '技能不存在或已被本人排除')
        return ok(c, resolved)
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/skills/:name/overlay',
        operationId: 'putPersonalOverlay',
        summary: '写个人层 overlay（24 §5：这条路由只开个人层，tier / owner 由服务端定）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'name', in: 'path', required: true, description: '技能名' }],
        body: OverlayBody,
        returns: 'Overlay',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, OverlayBody)
        return ok(
          c,
          await deps.skills.setOverlay({
            skill: param(c, 'name'),
            tier: 'personal',
            owner: p.person_id,
            ops: input.ops.map((o) => ({
              op: o.op,
              section_id: o.section_id,
              ...(o.body === undefined ? {} : { body: o.body }),
              ...(o.origin === undefined ? {} : { origin: o.origin }),
            })),
            base_version: input.base_version,
            version: input.version,
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/lessons',
        operationId: 'listLessons',
        summary: '教训池（只读；提议不自动写 overlay）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'status', in: 'query', description: LESSON_STATUS.join(' | ') }],
        returns: 'LessonRecord[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const status = c.req.query('status')
        if (status !== undefined && !(LESSON_STATUS as readonly string[]).includes(status))
          throw new ApiError('invalid_input', 'status 不合法')
        return ok(
          c,
          await deps.skills.lessons({
            workspace_id: p.workspace_id,
            ...(status === undefined ? {} : { status: status as LessonRecord['status'] }),
          }),
        )
      },
    ),
  ]
}
