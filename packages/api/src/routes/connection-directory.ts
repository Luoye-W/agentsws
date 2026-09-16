/**
 * 连接目录与岗位连接清单（54（将改号 55）§4 前两层，WP83）的 HTTP 投影。
 *
 * 与 `routes/connections.ts` 的分工说清楚，免得两处越长越像：
 *
 * | | `routes/connections.ts` | 这一份 |
 * |---|---|---|
 * | 问的问题 | "这张卡怎么填、怎么连、连上了没有" | "有哪些东西可以接、这个岗位要接哪几个" |
 * | 键 | provider（`service`） | 职责模板的 `kind` |
 * | 写不写 | 写（凭据经 `submit` 一次） | **只有 MCP 那一条写**，别的全是读 |
 *
 * 凭据边界一个字不让（13 §4.3）：
 * - `GET /v1/connection-directory` 里只有**字段描述**（名字 / 要不要 / 是不是密码），
 *   没有任何值，也没有任何一条真实连接的账号 id。
 * - `POST /v1/connection-directory/mcp-servers` 的 `headers` 是这条路上**唯一**可能
 *   携带凭据的入参（多半是一枚 Bearer token）：处理器原样往下传一次，自己不读、
 *   不记、不回显；返回的 `McpServerRecord` 里只有 `header_names`。
 *
 * 权限与连接面同一档：读走 `store_config.read@workspace`，写走 `policy.stage@workspace`
 * （05 里"连接器授权"是 owner 专属动作）。
 */
import type { ConnectionDirectoryEntry, MaybePromise, McpServerRecord } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import type { ConnectionsActor } from './connections.js'

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

/**
 * 岗位连接清单那一条的准入。
 *
 * **不能跟目录同一档**（`store_config.read@workspace` 是 owner 的连接器授权那条）：
 * 这张卡画在**岗位页**上，而岗位页绑的是那条岗位自己的分配（客服、网站运营），
 * 它没有、也不该有 owner 的连接权限。清单里没有任何凭据、也没有任何一条真实连接的
 * 身份，只有"这个岗位的职责要哪几类连接、连上了没有"——与 `/v1/positions` 已经
 * 端出去的 `missing_connectors` 是同一件事，所以跟岗位面那几条同一个准入。
 */
const POSITION_READ = {
  domain: 'approval',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

const TAG = 'connections'

/** 目录里的一条现在什么状态。 */
export type ConnectionRuntimeState = 'connected' | 'not_connected' | 'error'

/** 目录里的一条 + 运行时状态（静态那半截原样来自契约的 `CONNECTION_DIRECTORY`）。 */
export interface ConnectionDirectoryItemView extends ConnectionDirectoryEntry {
  state: ConnectionRuntimeState
  state_detail?: string
  /** 点"去连接"落到连接页的哪张卡（`?service=`）；没有 = 还没有卡，点不动。 */
  connect_service?: string
}

/** 岗位连接清单里的一条（"连上这 N 个就能开工"）。 */
export interface PositionConnectionItemView {
  kind: string
  name: { zh: string; en: string }
  required: boolean
  connected: boolean
  /** 哪几条职责要它（职责中文名，不出 id）。 */
  needed_by: string[]
  status: 'available' | 'planned'
  connect_service?: string
  note?: { zh: string; en: string }
}

export interface PositionConnectionsView {
  position_id: string
  position_name: string
  ready: boolean
  missing_required: string[]
  items: PositionConnectionItemView[]
}

export interface ConnectionDirectoryPort {
  directory(actor: ConnectionsActor): MaybePromise<ConnectionDirectoryItemView[]>
  positionConnections(actor: ConnectionsActor, id: string): MaybePromise<PositionConnectionsView>
  listMcpServers(actor: ConnectionsActor): MaybePromise<McpServerRecord[]>
  /**
   * 登记一台自定义 MCP 服务器：校验 → 存（请求头进本机加密库）→ 探测一次。
   *
   * **唯一**接触凭据原文的方法。实现必须转发后立即遗忘。
   */
  saveMcpServer(
    actor: ConnectionsActor,
    input: {
      name: string
      transport: 'stdio' | 'streamable-http'
      command?: string
      args?: string[]
      url?: string
      headers?: Record<string, string>
    },
  ): MaybePromise<McpServerRecord>
  probeMcpServer(actor: ConnectionsActor, name: string): MaybePromise<McpServerRecord>
  removeMcpServer(actor: ConnectionsActor, name: string): MaybePromise<boolean>
}

/**
 * 登记一台 MCP 服务器的请求体。
 *
 * `headers` 与连接面的 `fields` 同一条纪律：只允许"名字 → 字符串"、长度封顶，
 * 校验失败时 zod 的 issue 只带 path 与 message——值不会被抄进错误信封。
 */
const McpBody = z.object({
  name: z.string().min(1).max(64),
  transport: z.enum(['stdio', 'streamable-http']),
  command: z.string().min(1).max(512).optional(),
  args: z.array(z.string().max(512)).max(64).optional(),
  url: z.string().min(1).max(2048).optional(),
  headers: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
  // WP86（55 §4 第三层）：这台服务器上哪几个工具是只读的。**原始工具名**，不带
  // `mcp__<serverName>__` 前缀；不勾 = 一个只读的都没有 = 公司端一个都调不动。
  read_tools: z.array(z.string().min(1).max(128)).max(256).optional(),
})

function portOf(deps: GatewayDeps): ConnectionDirectoryPort {
  const p = deps.connectionDirectory
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配连接目录（GatewayDeps.connectionDirectory）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): ConnectionsActor {
  const p = principalOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

const NAME_PARAM = {
  name: 'name',
  in: 'path',
  required: true,
  description: '这台 MCP 服务器的名字（登记时你自己起的那个）',
} as const

export function connectionDirectoryRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/connection-directory',
        operationId: 'getConnectionDirectory',
        summary:
          '连接目录（54 §4 第一层）：所有能接的东西，按职责模板的 kind 登记，附已连 / 未连 / 出错。**只有字段描述，没有任何凭据**',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ entries: ConnectionDirectoryItemView[] }',
      },
      async (c, deps) => ok(c, { entries: await portOf(deps).directory(actorOf(c)) }),
    ),
    route(
      {
        method: 'get',
        path: '/v1/connection-directory/mcp-servers',
        operationId: 'listMcpServers',
        summary: '已登记的自定义 MCP 服务器（**只有请求头的名字，没有值**）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ servers: McpServerRecord[] }',
      },
      async (c, deps) => ok(c, { servers: await portOf(deps).listMcpServers(actorOf(c)) }),
    ),
    route(
      {
        method: 'post',
        path: '/v1/connection-directory/mcp-servers',
        operationId: 'saveMcpServer',
        summary:
          '登记一台自定义 MCP 服务器：校验 → 存（请求头进本机加密库）→ 探测一次并记下它报的工具；`read_tools` 记下哪几个是只读的（门禁按它判读写）。职责模板写 `mcp:<名字>` 即进该职责的 preset',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: McpBody,
        returns: 'McpServerRecord（无请求头的值）',
      },
      async (c, deps) => {
        const input = await body(c, McpBody)
        // 处理器只把值往下传一次，自己不读、不记、不回显。
        return ok(
          c,
          await portOf(deps).saveMcpServer(actorOf(c), {
            name: input.name,
            transport: input.transport,
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.args === undefined ? {} : { args: input.args }),
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            ...(input.read_tools === undefined ? {} : { read_tools: input.read_tools }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/connection-directory/mcp-servers/:name/probe',
        operationId: 'probeMcpServer',
        summary: '再探测一次已登记的那台 MCP 服务器（连一次、列它的工具、断开）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [NAME_PARAM],
        returns: 'McpServerRecord',
      },
      async (c, deps) => ok(c, await portOf(deps).probeMcpServer(actorOf(c), param(c, 'name'))),
    ),
    route(
      {
        method: 'delete',
        path: '/v1/connection-directory/mcp-servers/:name',
        operationId: 'removeMcpServer',
        summary: '删掉一台自定义 MCP 服务器（加密库里那几个请求头一起删）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [NAME_PARAM],
        returns: '{ removed: boolean }',
      },
      async (c, deps) =>
        ok(c, { removed: await portOf(deps).removeMcpServer(actorOf(c), param(c, 'name')) }),
    ),
    route(
      {
        method: 'get',
        path: '/v1/positions/:id/connections',
        operationId: 'getPositionConnections',
        summary:
          '岗位连接清单（54 §4 第二层）：这个岗位所有职责的 connectors[] 并集 − 已连；required 的没连 = 岗位未就绪',
        tag: 'workstation',
        auth: 'bearer',
        assignment: true,
        authz: POSITION_READ,
        params: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: '岗位模板 id；给本人持有的 assignment_id 也认',
          },
        ],
        returns: 'PositionConnectionsView',
      },
      async (c, deps) => ok(c, await portOf(deps).positionConnections(actorOf(c), param(c, 'id'))),
    ),
  ]
}
