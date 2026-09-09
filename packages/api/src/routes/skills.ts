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

const ExcludeBody = z.object({ excluded: z.boolean() })

const PromoteBody = z.object({
  section_ids: z.array(z.string().min(1)).min(1),
  to_tier: z.enum(['company', 'department']),
})

export function skillRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/skills',
        operationId: 'listSkills',
        summary: '技能列表：当前版本、三层 overlay（人写的 / 学到的）、待审提案数（24 §5）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'department', in: 'query', description: '部门 id（可选）' }],
        returns: 'SkillSummary[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.list === undefined) throw new ApiError('not_implemented', '技能面未装配')
        const department = c.req.query('department')
        return ok(
          c,
          await deps.skills.list({
            person_id: p.person_id,
            workspace_id: p.workspace_id,
            ...(department === undefined ? {} : { department_id: department }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/skills/proposals',
        operationId: 'listSkillProposals',
        summary: '待审的「昨天学到的」提案卡（不批不生效）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'SkillProposalSummary[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.proposals === undefined)
          throw new ApiError('not_implemented', '学习回路未装配')
        return ok(
          c,
          await deps.skills.proposals({ person_id: p.person_id, workspace_id: p.workspace_id }),
        )
      },
    ),
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
        method: 'post',
        path: '/v1/skills/:name/exclude',
        operationId: 'excludeSkill',
        summary: '排除 / 取消排除某个技能（只影响本人，24 §2）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'name', in: 'path', required: true, description: '技能名' }],
        body: ExcludeBody,
        returns: '{ name, excluded }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.exclude === undefined) throw new ApiError('not_implemented', '技能面未装配')
        const input = await body(c, ExcludeBody)
        const name = param(c, 'name')
        await deps.skills.exclude(name, p.person_id, input.excluded)
        return ok(c, { name, excluded: input.excluded })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/skills/:name/promote',
        operationId: 'promoteSkill',
        summary: '把个人层的几段提上去：产出一条 skill_promotion 审批项（不落任何层）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'name', in: 'path', required: true, description: '技能名' }],
        body: PromoteBody,
        returns: '{ accepted, approval_item_id?, reason? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.promote === undefined) throw new ApiError('not_implemented', '技能面未装配')
        const input = await body(c, PromoteBody)
        return ok(
          c,
          await deps.skills.promote({
            skill: param(c, 'name'),
            section_ids: input.section_ids,
            to_tier: input.to_tier,
            actor: { person_id: p.person_id, workspace_id: p.workspace_id },
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
