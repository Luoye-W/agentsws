/**
 * 15 §7 变更账本 API 的读侧 + withdraw / reverse + guardrails/evaluate。
 * `stage` / `approve` / `apply` 只有执行器与审批总线能发起，不在网关上暴露。
 */
import type { ChangeKind, ChangeStatus, ObjectRef, StagedChange } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, listParam, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/**
 * 变更是通过审批队列露面的（31 §1 I8 把账本并进交易控制模块），
 * 因此鉴权走 `approval` 域：读 = read，撤回 / 反向 = approve。
 */
const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const WRITE = { domain: 'approval', op: 'approve', range: 'own', sensitivity: 'internal' } as const

const ObjectRefSchema = z.object({ type: z.string().min(1), id: z.string().min(1) })

const EvaluateBody = z.object({
  kind: z.string().min(1),
  target: ObjectRefSchema,
  field: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  amount_base: z.number().optional(),
  margin_after_pct: z.number().optional(),
  phase: z.enum(['stage', 'apply']).optional(),
})

async function mustGet(deps: GatewayDeps, id: string, workspace_id: string): Promise<StagedChange> {
  const change = await deps.changes.get(id)
  if (!change || change.workspace_id !== workspace_id)
    throw new ApiError('not_found', `变更不存在：${id}`)
  return change
}

export function changeRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/changes',
        operationId: 'listChanges',
        summary: '变更账本查询',
        tag: 'change',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'target_type', in: 'query', description: '目标对象类型' },
          { name: 'target_id', in: 'query', description: '目标对象 id' },
          { name: 'kind', in: 'query', description: '变更种类（15 §2）' },
          { name: 'status', in: 'query', description: '状态，逗号分隔' },
          { name: 'run', in: 'query', description: 'run_id' },
          { name: 'since', in: 'query', description: 'ISO8601 起点' },
        ],
        returns: 'StagedChange[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const type = c.req.query('target_type')
        const id = c.req.query('target_id')
        if ((type === undefined) !== (id === undefined))
          throw new ApiError('invalid_input', 'target_type 与 target_id 必须同时给')
        const target: ObjectRef | undefined =
          type === undefined || id === undefined ? undefined : { type, id }
        const kind = c.req.query('kind') as ChangeKind | undefined
        const status = listParam(c, 'status') as ChangeStatus[] | undefined
        const run = c.req.query('run')
        const since = c.req.query('since')
        return ok(
          c,
          await deps.changes.list({
            workspace_id: p.workspace_id,
            ...(target === undefined ? {} : { target }),
            ...(kind === undefined ? {} : { kind }),
            ...(status === undefined ? {} : { status }),
            ...(run === undefined ? {} : { run_id: run }),
            ...(since === undefined ? {} : { since }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/changes/:id',
        operationId: 'getChange',
        summary: '变更详情（含两次 guardrail）',
        tag: 'change',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '变更 id' }],
        returns: 'StagedChange',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(c, await mustGet(deps, param(c, 'id'), p.workspace_id))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/changes/:id/withdraw',
        operationId: 'withdrawChange',
        summary: '撤回（staged 时）',
        tag: 'change',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '变更 id' }],
        returns: 'StagedChange',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        await mustGet(deps, id, p.workspace_id)
        return ok(c, await deps.changes.withdraw(id, p.person_id))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/changes/:id/reverse',
        operationId: 'reverseChange',
        summary: '生成反向 StagedChange（仍需走完整审批）',
        tag: 'change',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '变更 id' }],
        returns: 'StagedChange',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        await mustGet(deps, id, p.workspace_id)
        return ok(c, await deps.changes.reverse(id, p.person_id), 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/guardrails/evaluate',
        operationId: 'evaluateGuardrail',
        summary: '预检 / 模拟 / 界面预览：只评估不 stage',
        tag: 'change',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: EvaluateBody,
        returns: 'GuardrailResult',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const input = await body(c, EvaluateBody)
        return ok(
          c,
          await deps.guardrails.evaluate({
            workspace_id: p.workspace_id,
            assignment_id: assignment.id,
            at: deps.clock.now(),
            phase: input.phase ?? 'stage',
            change: {
              kind: input.kind as ChangeKind,
              target: input.target,
              before: input.before ?? null,
              after: input.after ?? null,
              ...(input.field === undefined ? {} : { field: input.field }),
              ...(input.amount_base === undefined ? {} : { amount_base: input.amount_base }),
              ...(input.margin_after_pct === undefined
                ? {}
                : { margin_after_pct: input.margin_after_pct }),
            },
          }),
        )
      },
    ),
  ]
}
