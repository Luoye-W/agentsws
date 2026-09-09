/**
 * 19 §6 知识 API。检索按身份过滤下推，网关只转发 actor。
 *
 * WP33 补齐了 §6 里剩下的三件事：导入源（`/knowledge/sources`）、引用计数（`cite`）、
 * 缺口队列（`/knowledge/gaps` 与 `answer`）。**写仍然只经审批项**——
 * `answer` 不是「把答案写进知识库」，是「把答案变成一张 knowledge_update 卡」（19 §4）。
 *
 * 这几条对应的端口方法在 `KnowledgePort` 上是**可选**的：`packages/knowledge` 现在还没有
 * 源表与缺口表（docs/38 §1 列的缺口），没装上时回 `not_implemented`（501），
 * 与 `/v1/schedules`、`/v1/models` 没装配时的做法一致。
 */
import type { DataDomain, FactCard, KnowledgeLayer } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayActor, GatewayDeps, KnowledgeGapStatus, RequestContext } from '../types.js'

const READ = {
  domain: 'knowledge',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

/**
 * 登记导入源 / 开缺口 / 答缺口的准入：**`knowledge.stage`**——这三件事都是
 * 往知识库里**提议**东西。
 *
 * WP33 时职责包一条 `knowledge.stage` 都没有，真按 `stage` 判会让所有人 403，于是暂时
 * 沿用了 `read`；WP35 给三个职责包都补上了（知识库是工作区级的，所以范围也是 workspace），
 * 这里改回该有的那一条。**纪律仍在下游**：19 §4 的写只经审批项——`answer` 产出的是一张
 * `knowledge_update` 卡，不是一条生效的知识。
 */
const WRITE = {
  domain: 'knowledge',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const LAYERS = ['fact', 'phrasing', 'policy'] as const
const STATUSES = ['proposed', 'active', 'retired'] as const
const SOURCE_KINDS = [
  'upload',
  'feishu_doc',
  'shopify_page',
  'website',
  'email_thread',
  'meeting',
] as const
const PARSERS = ['anydoc', 'html', 'transcript'] as const
const GAP_STATUSES = ['open', 'answered', 'dismissed'] as const

const SourceBody = z.object({
  kind: z.enum(SOURCE_KINDS),
  /** 文件路径 / 文档 url / 线程 id——由 kind 决定怎么解释。 */
  ref: z.string().min(1).max(2000),
  parser: z.enum(PARSERS),
  /** 19 §1.3：飞书文档一类的源默认继承上游 ACL。 */
  acl_inherit: z.boolean().optional(),
})

const CiteBody = z.object({ run_id: z.string().min(1) })

const GapBody = z.object({
  question: z.string().min(1).max(1000),
  subject: z.object({
    type: z.string().min(1),
    id: z.string().min(1).optional(),
    key: z.string().min(1),
  }),
  domain: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
})

const GapAnswerBody = z.object({
  answer: z.string().min(1).max(2000),
  /** 答案该落到哪一层（19 §2）；不给由实现按 subject 判。 */
  layer: z.enum(LAYERS).optional(),
})

/** 没装配那几个可选方法时的统一说法。 */
function needs<T>(fn: T | undefined, what: string): NonNullable<T> {
  if (fn === undefined || fn === null)
    throw new ApiError('not_implemented', `这个服务进程的知识模块还没有${what}`)
  return fn as NonNullable<T>
}

const SearchBody = z.object({
  text: z.string().min(1),
  domains: z.array(z.string().min(1)).optional(),
  scope: z
    .array(
      z.object({
        kind: z.enum(['store', 'department', 'account', 'market']),
        id: z.string().min(1),
      }),
    )
    .optional(),
  layers: z.array(z.enum(LAYERS)).optional(),
  k: z.number().int().positive().max(50).optional(),
  precheck: z.boolean().optional(),
})

/** 19 §3：授权（grants / ranges）来自本次 Assignment 的 EffectiveConfig，不做并集。 */
function actorOf(
  deps: GatewayDeps,
  rctx: Required<Pick<RequestContext, 'principal' | 'assignment'>>,
): GatewayActor {
  const config = deps.roles.effectiveConfig(rctx.assignment.id)
  return {
    person_id: rctx.principal.person_id,
    workspace_id: rctx.principal.workspace_id,
    assignment_id: rctx.assignment.id,
    role_id: rctx.assignment.role_id,
    grants: config.scopes,
    ranges: config.ranges,
  }
}

export function knowledgeRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/knowledge/search',
        operationId: 'searchKnowledge',
        summary: '事实卡检索（19 §3 过滤下推）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: SearchBody,
        returns: '{ hits, relevant, matched, missing }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const input = await body(c, SearchBody)
        return ok(
          c,
          await deps.knowledge.search({
            text: input.text,
            actor: actorOf(deps, { principal: p, assignment: a }),
            ...(input.domains === undefined
              ? {}
              : { domains: input.domains as (DataDomain | 'company')[] }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.layers === undefined ? {} : { layers: [...input.layers] }),
            ...(input.k === undefined ? {} : { k: input.k }),
            ...(input.precheck === undefined ? {} : { precheck: input.precheck }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/cards',
        operationId: 'listKnowledgeCards',
        summary: '事实卡列表',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'domain', in: 'query', description: '数据域' },
          { name: 'layer', in: 'query', description: 'fact | phrasing | policy' },
          { name: 'status', in: 'query', description: 'proposed | active | retired' },
        ],
        returns: 'FactCard[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const domain = c.req.query('domain')
        const layer = c.req.query('layer')
        const status = c.req.query('status')
        if (layer !== undefined && !(LAYERS as readonly string[]).includes(layer))
          throw new ApiError('invalid_input', 'layer 不合法')
        if (status !== undefined && !(STATUSES as readonly string[]).includes(status))
          throw new ApiError('invalid_input', 'status 不合法')
        return ok(
          c,
          await deps.knowledge.cards(
            {
              workspace_id: p.workspace_id,
              ...(domain === undefined ? {} : { domain }),
              ...(layer === undefined ? {} : { layer: layer as KnowledgeLayer }),
              ...(status === undefined ? {} : { status: status as FactCard['status'] }),
            },
            actorOf(deps, { principal: p, assignment: a }),
          ),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/sources',
        operationId: 'listKnowledgeSources',
        summary: '导入源清单（19 §1.3）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'KnowledgeSource[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const sources = needs(deps.knowledge.sources, '导入源清单')
        return ok(
          c,
          await sources.call(deps.knowledge, actorOf(deps, { principal: p, assignment: a })),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/knowledge/sources',
        operationId: 'addKnowledgeSource',
        summary: '登记一个导入源（文档 / 飞书 / 网页 / 会议）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: SourceBody,
        returns: 'KnowledgeSource',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const input = await body(c, SourceBody)
        const add = needs(deps.knowledge.addSource, '导入源登记')
        const created = await add.call(
          deps.knowledge,
          actorOf(deps, { principal: p, assignment: a }),
          {
            kind: input.kind,
            ref: input.ref,
            parser: input.parser,
            ...(input.acl_inherit === undefined ? {} : { acl_inherit: input.acl_inherit }),
          },
        )
        return ok(c, created, 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/gaps',
        operationId: 'listKnowledgeGaps',
        summary: '缺口队列（19 §4：Agent 答不了的问题）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'status', in: 'query', description: 'open | answered | dismissed' }],
        returns: 'KnowledgeGap[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const status = c.req.query('status')
        if (status !== undefined && !(GAP_STATUSES as readonly string[]).includes(status))
          throw new ApiError('invalid_input', 'status 只能是 open / answered / dismissed')
        const gaps = needs(deps.knowledge.gaps, '缺口队列')
        return ok(
          c,
          await gaps.call(deps.knowledge, actorOf(deps, { principal: p, assignment: a }), {
            ...(status === undefined ? {} : { status: status as KnowledgeGapStatus }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/knowledge/gaps',
        operationId: 'openKnowledgeGap',
        summary: '开一个缺口（答不上来的问题进队列，等人答）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: GapBody,
        returns: 'KnowledgeGap',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const input = await body(c, GapBody)
        const open = needs(deps.knowledge.openGap, '缺口队列')
        const gap = await open.call(
          deps.knowledge,
          actorOf(deps, { principal: p, assignment: a }),
          {
            question: input.question,
            subject: {
              type: input.subject.type,
              key: input.subject.key,
              ...(input.subject.id === undefined ? {} : { id: input.subject.id }),
            },
            ...(input.domain === undefined
              ? {}
              : { domain: input.domain as DataDomain | 'company' }),
            ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
          },
        )
        return ok(c, gap, 201)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/knowledge/gaps/:id/answer',
        operationId: 'answerKnowledgeGap',
        summary: '答一个缺口 → 自动变一张 knowledge_update 审批项（19 §4）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: '缺口 id' }],
        body: GapAnswerBody,
        returns: '{ gap, approval_item_id? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const input = await body(c, GapAnswerBody)
        const answer = needs(deps.knowledge.answerGap, '缺口队列')
        return ok(
          c,
          await answer.call(
            deps.knowledge,
            actorOf(deps, { principal: p, assignment: a }),
            param(c, 'id'),
            {
              answer: input.answer,
              ...(input.layer === undefined ? {} : { layer: input.layer }),
            },
          ),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/cards/:id',
        operationId: 'getKnowledgeCard',
        summary: '事实卡详情（无权 → 404，不返回脱敏后的存在性）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '事实卡 id' }],
        returns: 'FactCard',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const card = await deps.knowledge.card(
          param(c, 'id'),
          actorOf(deps, { principal: p, assignment: a }),
        )
        if (!card || card.workspace_id !== p.workspace_id)
          throw new ApiError('not_found', '事实卡不存在')
        return ok(c, card)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/knowledge/cards/:id/cite',
        operationId: 'citeKnowledgeCard',
        summary: '记一次引用（19 §3 `usage.cited`；高召回低认可靠它算）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '事实卡 id' }],
        body: CiteBody,
        returns: '{ cited: true }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const a = assignmentOf(c)
        const id = param(c, 'id')
        const actor = actorOf(deps, { principal: p, assignment: a })
        // 先按本人身份取一次：无权看见的卡不该能被「引用」（否则 cite 成了存在性探测）
        const card = await deps.knowledge.card(id, actor)
        if (!card || card.workspace_id !== p.workspace_id)
          throw new ApiError('not_found', '事实卡不存在')
        const input = await body(c, CiteBody)
        const cite = needs(deps.knowledge.cite, '引用计数')
        await cite.call(deps.knowledge, actor, id, input.run_id)
        return ok(c, { cited: true, fact_card_id: id, run_id: input.run_id })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/health',
        operationId: 'knowledgeHealth',
        summary: '知识健康度（总量 / 沉默 / 过期 / 冲突）',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ total, silent, stale, conflicts }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(c, await deps.knowledge.health(p.workspace_id))
      },
    ),
  ]
}
