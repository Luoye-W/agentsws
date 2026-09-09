/** 14 §10 审批 API。写路由（decide / retry-apply）属 send / apply 类，受 outbound 急停。 */
import type {
  ApprovalItem,
  ApprovalKind,
  ApprovalState,
  DecideInput,
  Todo,
} from '@agentsws/contracts'
import { projectCard, resolveDecision } from '@agentsws/deck'
import { z } from 'zod'
import { ApiError, normalizeError } from '../errors.js'
import {
  assignmentOf,
  body,
  listParam,
  ok,
  param,
  principalOf,
  redactItem,
  tokenFor,
} from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { fromDeckError } from './workstation.js'

const READ = {
  domain: 'approval',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const
const DECIDE = {
  domain: 'approval',
  op: 'approve',
  range: 'own',
  sensitivity: 'internal',
} as const

const ACTIONS = ['approve', 'approve_edited', 'reject', 'redirect', 'defer', 'withdraw'] as const
/**
 * 36 §2.1 的五动作矩阵：工作台按钮发的是这几个动词，翻译成 14 的状态机动作由
 * `@agentsws/deck` 的 `resolveDecision` 做（选择题裸 approve 拒、instruct 必须带作用域、
 * version 乐观并发都在那里）。`redirect / defer / withdraw / approve_edited` 是 14 的原生动作，
 * 走老路，不经卡片投影。
 */
const DECK_ACTIONS = ['approve', 'reject', 'instruct', 'snooze'] as const
const INSTRUCTION_SCOPES = ['single_reply', 'similar_cases', 'global_rule'] as const
const VIA = ['workstation', 'im_card', 'email', 'api', 'batch'] as const
const RedirectTo = z.object({
  person_id: z.string().optional(),
  role_id: z.string().optional(),
})

const DecideBody = z.object({
  /** 缺省时用本人那张有效投递 token（工作台内不必回传） */
  decision_token: z.string().min(1).optional(),
  action: z.enum([...ACTIONS, 'instruct', 'snooze'] as const),
  reason: z.string().optional(),
  edited_payload: z.unknown().optional(),
  redirect_to: RedirectTo.optional(),
  defer_until: z.string().optional(),
  via: z.enum(VIA).optional(),
  /** 选择题卡必填（36 §2.1；裸 approve 会被 OPTION_REQUIRED 拒） */
  selected_option_id: z.string().min(1).optional(),
  /** 指导抽屉：先选作用域，再一句话 */
  instruction: z.object({ scope: z.enum(INSTRUCTION_SCOPES), text: z.string().min(1) }).optional(),
  /** 乐观并发：与卡片的 version（= revision）不一致即 409 */
  version: z.number().int().nonnegative().optional(),
})

const BatchDecideBody = z.object({
  entries: z
    .array(z.object({ id: z.string().min(1), decision_token: z.string().min(1).optional() }))
    .min(1),
  action: z.enum(ACTIONS),
  reason: z.string().optional(),
  edited_payload: z.unknown().optional(),
  redirect_to: RedirectTo.optional(),
  defer_until: z.string().optional(),
})

async function mustGet(deps: GatewayDeps, id: string, workspace_id: string): Promise<ApprovalItem> {
  const item = await deps.approvals.get(id)
  // 跨工作区不泄漏存在性：一律 404。
  if (!item || item.workspace_id !== workspace_id)
    throw new ApiError('not_found', `审批项不存在：${id}`)
  return item
}

const optional = <T>(v: T | undefined, key: string): Record<string, T> =>
  v === undefined ? {} : ({ [key]: v } as Record<string, T>)

export function approvalRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/approvals',
        operationId: 'listApprovals',
        summary: '审批队列',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'lane', in: 'query', description: 'mine | scope | unclaimed，默认 mine' },
          { name: 'kind', in: 'query', description: '审批项种类（14 §1）' },
          { name: 'role', in: 'query', description: 'role_id' },
          { name: 'state', in: 'query', description: '状态，逗号分隔；默认 pending,in_review' },
        ],
        returns: 'ApprovalItem[]（他人的 decision_token 已抹去）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const lane = c.req.query('lane') ?? 'mine'
        if (lane !== 'mine' && lane !== 'scope' && lane !== 'unclaimed')
          throw new ApiError('invalid_input', 'lane 只能是 mine / scope / unclaimed')
        const kind = c.req.query('kind') as ApprovalKind | undefined
        const role = c.req.query('role')
        const state = listParam(c, 'state') as ApprovalState[] | undefined
        const items = await deps.approvals.queue({
          workspace_id: p.workspace_id,
          person_id: p.person_id,
          lane,
          ...optional(kind, 'kind'),
          ...optional(role, 'role_id'),
          ...optional(state, 'state'),
        })
        return ok(
          c,
          items.map((i) => redactItem(i, p.person_id)),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/approvals/batch/decide',
        operationId: 'decideApprovalsBatch',
        summary: '批量决定（14 §8：同 kind 同 role；一条失败不影响其他）',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: DECIDE,
        outbound: true,
        body: BatchDecideBody,
        returns: '{ results: [{ id, item?, error? }] }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, BatchDecideBody)
        const entries: { id: string; decision_token: string }[] = []
        for (const e of input.entries) {
          const item = await mustGet(deps, e.id, p.workspace_id)
          const token = e.decision_token ?? tokenFor(item, p.person_id)
          if (token === undefined)
            throw new ApiError('forbidden', `没有属于本人的 decision_token：${e.id}`)
          entries.push({ id: e.id, decision_token: token })
        }
        const rest: Omit<DecideInput, 'decision_token' | 'via'> = {
          action: input.action,
          ...optional(input.reason, 'reason'),
          ...optional(input.edited_payload, 'edited_payload'),
          ...optional(input.redirect_to, 'redirect_to'),
          ...optional(input.defer_until, 'defer_until'),
        }
        const results = await deps.approvals.decideBatch(entries, p.person_id, rest)
        return ok(c, {
          results: results.map((r) => {
            const err = r.error === undefined ? undefined : normalizeError(r.error)
            return {
              id: r.id,
              ...(r.item ? { item: redactItem(r.item, p.person_id) } : {}),
              ...(err === undefined ? {} : { error: { code: err.code, message: err.message } }),
            }
          }),
        })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/approvals/:id',
        operationId: 'getApproval',
        summary: '审批项详情',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        returns: 'ApprovalItem',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const item = await mustGet(deps, param(c, 'id'), p.workspace_id)
        return ok(c, redactItem(item, p.person_id))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/approvals/:id/history',
        operationId: 'getApprovalHistory',
        summary: '修订与事件 id',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        returns: '{ revisions, events }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        await mustGet(deps, id, p.workspace_id)
        const history = await deps.approvals.history(id)
        return ok(c, {
          revisions: history.revisions.map((i) => redactItem(i, p.person_id)),
          events: history.events,
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/approvals/:id/decide',
        operationId: 'decideApproval',
        summary: '决定（人 / 卡片回调）',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: DECIDE,
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        body: DecideBody,
        returns: 'ApprovalItem',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        const item = await mustGet(deps, id, p.workspace_id)
        const input = await body(c, DecideBody)
        const token = input.decision_token ?? tokenFor(item, p.person_id)
        if (token === undefined) throw new ApiError('forbidden', '没有属于本人的 decision_token')
        const via = input.via ?? 'workstation'

        // 卡片动词 → 14 的决定。卡片投影是纯函数，网关只是转译层。
        const deckAction = DECK_ACTIONS.find((a) => a === input.action)
        let resolved: {
          action: DecideInput['action']
          reason?: string
          edited_payload?: unknown
          defer_until?: string
          instruction_scope?: string
        }
        if (deckAction !== undefined) {
          const card = projectCard(item, {
            now: deps.clock.now(),
            position_id: c.req.header('X-Assignment') ?? '',
            ...(deps.workstation === undefined ? {} : { label: (r) => deps.workstation?.label(r) }),
          })
          try {
            resolved = resolveDecision(
              card,
              {
                action: deckAction,
                ...optional(input.selected_option_id, 'selected_option_id'),
                ...optional(input.instruction, 'instruction'),
                ...optional(input.reason, 'reason'),
                ...optional(input.edited_payload, 'edited_payload'),
                ...optional(input.defer_until, 'defer_until'),
                ...optional(input.version, 'version'),
              },
              { now: deps.clock.now() },
            )
          } catch (err) {
            return fromDeckError(err)
          }
        } else {
          resolved = {
            action: input.action as DecideInput['action'],
            ...optional(input.reason, 'reason'),
            ...optional(input.edited_payload, 'edited_payload'),
            ...optional(input.defer_until, 'defer_until'),
          }
        }

        const out = await deps.approvals.decide(id, p.person_id, {
          decision_token: token,
          action: resolved.action,
          via,
          ...optional(resolved.reason, 'reason'),
          ...optional(resolved.edited_payload, 'edited_payload'),
          ...optional(input.redirect_to, 'redirect_to'),
          ...optional(resolved.defer_until, 'defer_until'),
        })
        // 37 §4.1：认领卡接下来才形成责任（31 I13）——建一条挂在会议事项上的待办
        let claimed: Todo | undefined
        if (
          out.kind === 'claim' &&
          (resolved.action === 'approve' || resolved.action === 'approve_edited')
        ) {
          claimed = (await deps.work?.acceptClaim?.(
            {
              workspace_id: p.workspace_id,
              person_id: p.person_id,
              assignment_id: assignmentOf(c).id,
            },
            out,
          )) as Todo | undefined
        }
        return ok(c, {
          ...redactItem(out, p.person_id),
          // 指导的作用域决定它之后落到哪（本条回复 / 技能 overlay 提案 / 职责策略变更）；
          // v1 只原样回给调用方，路由到 24 / 05 的机器留给后续 WP（见交付报告）。
          ...optional(resolved.instruction_scope, 'instruction_scope'),
          ...optional(claimed, 'todo'),
        })
      },
    ),
    ...(
      [
        ['claim', 'claimApproval', '认领'],
        ['release', 'releaseApproval', '释放'],
        ['withdraw', 'withdrawApproval', '撤回（提议者）'],
      ] as const
    ).map(([action, operationId, summary]) =>
      route(
        {
          method: 'post',
          path: `/v1/approvals/:id/${action}`,
          operationId,
          summary,
          tag: 'approval',
          auth: 'bearer',
          assignment: true,
          authz: DECIDE,
          params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
          returns: 'ApprovalItem',
        },
        async (c, deps) => {
          const p = principalOf(c)
          assignmentOf(c)
          const id = param(c, 'id')
          await mustGet(deps, id, p.workspace_id)
          const out = await deps.approvals[action](id, p.person_id)
          return ok(c, redactItem(out, p.person_id))
        },
      ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/approvals/:id/retry-apply',
        operationId: 'retryApplyApproval',
        summary: '施行失败后重试（apply 类）',
        tag: 'approval',
        auth: 'bearer',
        assignment: true,
        authz: DECIDE,
        outbound: true,
        params: [{ name: 'id', in: 'path', required: true, description: '审批项 id' }],
        returns: 'ApprovalItem',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const id = param(c, 'id')
        await mustGet(deps, id, p.workspace_id)
        const out = await deps.approvals.retryApply(id, p.person_id)
        return ok(c, redactItem(out, p.person_id))
      },
    ),
  ]
}
