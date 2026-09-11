/**
 * Join 向导（20 §4–§5、45 H2 / H3）：个人工作区并进公司。
 *
 * 20 §5 本来就写了 `POST /join/export`、`POST /join/import`、`POST /join/{id}/complete`
 * 三条路径；WP50 把它们真的建出来，并按 45 H2 补上**三类组织对象**（品牌 / 产品线 /
 * 店铺范围）的逐条对照。
 *
 * 四条边界：
 *
 * 1. **网关里不写业务**（28 §2）：怎么比、怎么合、怎么改别名，全在
 *    `apps/server/src/join.ts`；这一层只做路由声明、权限判定与信封。
 * 2. **导入不改任何东西**：`import` 只建一张 `join_mapping` 审批项（14），
 *    `complete` 才落地。中间那一段 owner 可以逐条改主意。
 * 3. **权限**：导出是本人对自己工作区的读（`policy.read@workspace`）；
 *    导入、落地、退出都是 owner 级的写（`policy.stage@workspace/restricted`）。
 * 4. **凭据不跟着走**（40 §1）：`complete` 只对 `transfer: true` 的连接调
 *    `transferConnection`，而那个开关只能由本人在向导里打开。
 */
import type {
  JoinCompleteResult,
  JoinExportBundle,
  JoinMappingPayload,
  MaybePromise,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = {
  domain: 'policy',
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

const TAG = 'org'

export interface JoinActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

/** 导入回执：卡建好了，等 owner 在卡上逐条过。 */
export interface JoinImportReceipt {
  join_id: string
  /** 14 的审批项 id（首页队列里那张卡）。 */
  approval_item_id: string
  status: 'pending_approval'
  payload: JoinMappingPayload
  summary: string
}

/** owner 在对照卡上逐条改的那些选择。没提到的条目按 `suggested` 走。 */
export interface JoinDecisionInput {
  objects?:
    | {
        unique_key: string
        chosen: string
        name_choice?: 'company' | 'personal' | undefined
      }[]
    | undefined
  connections?: { connection_id: string; transfer: boolean }[] | undefined
}

/** 业务在 `apps/server/src/join.ts`。 */
export interface JoinPort {
  /** 把本工作区的三类组织对象 + 连接清单打成一个包。 */
  export(actor: JoinActor): MaybePromise<JoinExportBundle>
  /** 导入一个包：逐条对照 → 建一张 `join_mapping` 卡。**不改任何东西**。 */
  import(actor: JoinActor, bundle: JoinExportBundle): MaybePromise<JoinImportReceipt>
  /** 还没落地的那几次 Join（公司页「并进来」Tab 打开时先问这一条）。 */
  list(actor: JoinActor): MaybePromise<JoinMappingPayload[]>
  /** 看一眼这次 Join 的对照表（界面刷新用）。 */
  get(actor: JoinActor, join_id: string): MaybePromise<JoinMappingPayload | undefined>
  /** 批准落地：合并 / 新建 / 保留两条 + 别名 + 岗位范围改指 + 交连接。 */
  complete(
    actor: JoinActor,
    join_id: string,
    input: JoinDecisionInput,
  ): MaybePromise<JoinCompleteResult>
  /** 20 §4.4 退出：别名断开，个人那份恢复可编辑。 */
  leave(actor: JoinActor, join_id: string): MaybePromise<{ restored: number; rewrites: number }>
}

const RANGE = z.object({
  kind: z.enum(['store', 'department', 'account', 'market', 'product_line']),
  id: z.string().min(1).max(128),
})

const LINE_RULE = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('shopify'),
    collection_ids: z.array(z.string().min(1).max(128)).max(100).optional(),
    tags: z.array(z.string().min(1).max(128)).max(100).optional(),
    vendors: z.array(z.string().min(1).max(128)).max(100).optional(),
    product_types: z.array(z.string().min(1).max(128)).max(100).optional(),
  }),
  z.object({
    platform: z.literal('amazon'),
    asins: z.array(z.string().min(1).max(32)).max(500).optional(),
    sku_prefixes: z.array(z.string().min(1).max(64)).max(100).optional(),
    brand: z.string().min(1).max(128).optional(),
  }),
  z.object({
    platform: z.literal('manual'),
    product_ids: z.array(z.string().min(1).max(128)).max(1000),
  }),
])

const ISO = z.string().min(1).max(64)

/**
 * 导入包的校验。**只认 45 要的三类 + 连接**：20 §4.2 本来就有的那几类（人、职责、
 * 客户、知识）由别的路径走，包里多带的键这里直接忽略（只加不删）。
 */
const BundleBody = z.object({
  schema_version: z.literal(1),
  workspace_id: z.string().min(1).max(128),
  person_id: z.string().min(1).max(128),
  exported_at: ISO,
  range_groups: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        workspace_id: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        members: z.array(RANGE).max(200),
        created_at: ISO,
        updated_at: ISO,
      }),
    )
    .max(200),
  product_lines: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        workspace_id: z.string().min(1).max(128),
        name: z.string().min(1).max(128),
        parent: RANGE,
        rule: LINE_RULE,
        created_at: ISO,
        updated_at: ISO,
      }),
    )
    .max(200),
  store_ranges: z
    .array(
      z.object({
        range: RANGE,
        platform: z.enum(['shopify', 'amazon', 'other']),
        external_id: z.string().min(1).max(256),
        name: z.string().min(1).max(128),
        connection_id: z.string().min(1).max(128).optional(),
      }),
    )
    .max(200),
  connections: z
    .array(
      z.object({
        connection_id: z.string().min(1).max(128),
        service: z.string().min(1).max(64),
        label: z.string().min(1).max(128),
        transfer: z.boolean(),
      }),
    )
    .max(100),
})

const DecisionBody = z.object({
  objects: z
    .array(
      z.object({
        unique_key: z.string().min(1).max(512),
        chosen: z.enum(['merge_union', 'adopt_company', 'keep_both', 'create_in_company', 'skip']),
        name_choice: z.enum(['company', 'personal']).optional(),
      }),
    )
    .max(500)
    .optional(),
  connections: z
    .array(z.object({ connection_id: z.string().min(1).max(128), transfer: z.boolean() }))
    .max(100)
    .optional(),
})

const portOf = (deps: GatewayDeps): JoinPort => {
  if (deps.join === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配 Join 向导')
  return deps.join
}

function actorOf(c: Parameters<typeof principalOf>[0]): JoinActor {
  const p = principalOf(c)
  const assignment = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignment.id,
    role_id: assignment.role_id,
  }
}

export function joinRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/join/export',
        operationId: 'exportJoinBundle',
        summary: '把本工作区的品牌 / 产品线 / 店铺范围与连接清单打成一个 Join 包',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'JoinExportBundle',
      },
      async (c, deps) => ok(c, await portOf(deps).export(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/join/import',
        operationId: 'importJoinBundle',
        summary:
          '导入一个 Join 包：逐条对照出一样 / 相似 / 没有，建一张 join_mapping 卡（不改任何东西）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: BundleBody,
        returns: 'JoinImportReceipt',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const bundle = (await body(c, BundleBody)) as unknown as JoinExportBundle
        return ok(c, await portOf(deps).import(actor, bundle), 201)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/join',
        operationId: 'listJoins',
        summary: '还没落地的 Join（公司页「并进来」Tab 的清单）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'JoinMappingPayload[]',
      },
      async (c, deps) => ok(c, await portOf(deps).list(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/join/:id',
        operationId: 'getJoinMapping',
        summary: '这次 Join 的对照表（按类分组，界面直接渲染）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: 'Join id' }],
        returns: 'JoinMappingPayload',
      },
      async (c, deps) => {
        const found = await portOf(deps).get(actorOf(c), param(c, 'id'))
        if (found === undefined) throw new ApiError('not_found', '没有这次 Join')
        return ok(c, found)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/join/:id/complete',
        operationId: 'completeJoin',
        summary:
          '批准落地：一样的合并（公司取并集 + 个人那份变别名）、没有的在公司新建、打开了开关的连接才交给公司',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: 'Join id' }],
        body: DecisionBody,
        returns: 'JoinCompleteResult',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, DecisionBody)
        return ok(c, await portOf(deps).complete(actor, param(c, 'id'), input))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/join/:id/leave',
        operationId: 'leaveJoin',
        summary: '退出公司（20 §4.4）：别名断开，个人那份恢复可编辑；公司那份留下',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'id', in: 'path', required: true, description: 'Join id' }],
        returns: '{ restored, rewrites }',
      },
      async (c, deps) => ok(c, await portOf(deps).leave(actorOf(c), param(c, 'id'))),
    ),
  ]
}
