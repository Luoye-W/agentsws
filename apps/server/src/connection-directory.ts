/**
 * 连接目录与岗位连接清单的装配（54（将改号 55）§4 前两层，WP83）。
 *
 * 三件事，一件也不多：
 *
 * 1. **连接目录**（`directory()`）= 契约里那张静态登记表
 *    （`@agentsws/contracts` 的 `CONNECTION_DIRECTORY`）+ **少量运行时状态**
 *    （已连 / 未连 / 出错）。登记表本身一个字都不在这个文件里——那是契约的事，
 *    四处（岗位清单、向导清单、连接页、面板的"去连接"）读的必须是同一份。
 * 2. **岗位连接清单**（`positionConnections()`）= 这个岗位所有职责的 `connectors[]`
 *    并集 − 已连。`required` 的没连 = 岗位"未就绪"（判定仍然是
 *    `packages/roles` 的 `effectiveConfig`，这里只是把同一件事说成人话）。
 * 3. **自定义 MCP 服务器**（`listMcp` / `saveMcp` / `removeMcp`）：保存、校验、探测。
 *    **不接进运行时**——把 MCP 服务器挂到 Agent 上是官方 `mcp-client` 按 preset 的事
 *    （54（将改号 55）§2 / §4 第三层），那要等官方 Agent 层引进来。
 *
 * 凭据这条线与连接面同一条纪律（13 §4.3）：MCP 的请求头**值**当凭据看——
 * 只经这个模块转手一次进本机加密库，`McpServerRecord` 里只留**名字**；
 * 不进事件、不进响应体、不进任何模型上下文。
 *
 * 36 §2：目录条目里不出现任何原始店铺 id / 账号 id——目录说的是"哪一类东西"。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  Clock,
  ConnectionDirectoryEntry,
  McpProbeResult,
  McpServerInput,
  McpServerRecord,
  McpTransport,
  PersonId,
  Position,
  RoleId,
  RunConnection,
  StorefrontPlatform,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  CONNECTION_DIRECTORY,
  canonicalConnectionKind,
  connectionDirectoryEntry,
  customMcpServerOfKind,
  mcpServerNameFor,
  storefrontUsableService,
  validateMcpServer,
} from '@agentsws/contracts'
import type { RoleStore } from '@agentsws/roles'
import { catalogEntry, ROLE_CONNECTOR_KIND } from './catalog.js'
import type { SecretStore } from './secret-store.js'

/** 加密库里 MCP 请求头的 key 前缀（与 `conn:` / `model:` / `storage:` 并列）。 */
const MCP_SECRET_PREFIX = 'mcp:'

/** 探测一次最多等多久。等太久的服务器等于连不上——用户要的是一个答案，不是一个转圈。 */
export const MCP_PROBE_TIMEOUT_MS = 10_000

/** 一条连接现在的样子（目录上那个小圆点）。 */
export type ConnectionRuntimeState = 'connected' | 'not_connected' | 'error'

/** 目录里的一条 + 运行时状态。静态那半截原样来自契约，这里只往上贴状态。 */
export interface ConnectionDirectoryItem extends ConnectionDirectoryEntry {
  state: ConnectionRuntimeState
  /** 出错时给人看的那一句（"要重新授权"）。 */
  state_detail?: string
  /**
   * 现在点"去连接"该落到哪张卡上（连接页的 `?service=`）。
   *
   * 与 {@link ConnectionDirectoryEntry.service} 的区别只有平台中立的 `shop`：
   * 那一条要按公司档案解析（51 §1 N0），解析不出来就没有（点不动）。
   */
  connect_service?: string
}

/** 岗位连接清单里的一条。 */
export interface PositionConnectionItem {
  kind: string
  name: { zh: string; en: string }
  /** 这个岗位下有任何一条职责把它标成必需，就是必需。 */
  required: boolean
  connected: boolean
  /** 哪几条职责要它（职责中文名，不出 id——36 §2）。 */
  needed_by: string[]
  status: ConnectionDirectoryEntry['status']
  connect_service?: string
  note?: { zh: string; en: string }
}

export interface PositionConnectionsView {
  position_id: string
  position_name: string
  /** 必需的都连上了没有。 */
  ready: boolean
  /** 还缺的**必需**连接（kind）。 */
  missing_required: string[]
  /** 并集 − 已连；连上一个就少一条（连上全部 = 空数组 = 卡自己消失）。 */
  items: PositionConnectionItem[]
}

/** 一条真实连接的最小样子（目录只看 service 与状态，看不到别的）。 */
export interface ConnectionStateLike {
  service: string
  status: 'active' | 'reauth_required' | 'disabled'
}

/** 探测一台 MCP 服务器。测试注入假的；缺省用 `@modelcontextprotocol/sdk` 的 client。 */
export type McpProbe = (input: {
  transport: McpTransport
  command?: string
  args?: readonly string[]
  url?: string
  headers?: Readonly<Record<string, string>>
}) => Promise<{ ok: boolean; tools: { name: string; description?: string }[]; detail?: string }>

export interface ConnectionDirectoryOptions {
  clock: Clock
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录；不给就全内存（测试与一次性任务）。 */
  dir?: string
  /** 这个品牌那一段加密库（MCP 请求头存这里）。 */
  secrets: SecretStore
  roles: RoleStore
  /** 岗位模板（制度层，只读）。 */
  positions(): Position[]
  /** 现在接上了哪些职责连接器 kind（**按品牌**——52 O1）。 */
  connectedKinds(): readonly string[]
  /** 现在有哪几条真实连接、各是什么状态（只用来把"出错"标出来）。 */
  connections?(): readonly ConnectionStateLike[]
  /** 公司档案里的「网站是用什么搭的」（`shop` 按它解析）。 */
  storefrontPlatform?(): StorefrontPlatform | undefined
  probeMcp?: McpProbe
}

export interface ConnectionDirectoryAssembly {
  /** 连接目录（静态登记表 + 运行时状态）。 */
  directory(): ConnectionDirectoryItem[]
  /** 岗位连接清单：并集 − 已连。 */
  positionConnections(person_id: PersonId, id: string): PositionConnectionsView
  /** 已登记的自定义 MCP 服务器（**没有请求头的值**）。 */
  listMcp(): McpServerRecord[]
  /** 登记一台：校验 → 存（请求头进加密库）→ 探测一次。 */
  saveMcp(input: McpServerInput): Promise<McpServerRecord>
  /** 再探测一次已登记的那一台。 */
  probeMcp(name: string): Promise<McpServerRecord>
  /** 删掉一台（加密库里那几个请求头一起删）。 */
  removeMcp(name: string): boolean
  /**
   * WP86（55 §4 第三层）：**这条职责挂哪几台 MCP 服务器**（`RunRequest.connections`）。
   *
   * 职责模板的 `connectors[]` ∩ 已登记的 MCP 服务器。里面**没有任何凭据值**——
   * 请求头只有"名字 → 凭据引用名"，值由运行时经 `ctx.credentials` 解析（13 §4）。
   */
  roleConnections(role_id: string): RunConnection[]
}

/**
 * 一个 MCP 请求头在 `ctx.credentials` 里的**引用名**（一个 POSIX 环境变量名）。
 *
 * 生成的 preset 文件里出现的就是这个名字（`!!js process.env.<REF> ?? ''`），
 * 值一个字节都不进文件。名字本身不是秘密：它说的是"这台服务器的这个头"，
 * 不是"这个头的值是什么"。
 */
export function mcpHeaderRef(server_name: string, header: string): string {
  const seg = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `AGENTSWS_MCP_${seg(server_name)}_${seg(header)}`
}

/** 这个模块自己的错误（网关把 code 翻成 HTTP 状态）。 */
export class ConnectionDirectoryError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_input' | 'conflict',
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ConnectionDirectoryError'
  }
}

interface McpStateFile {
  version: 1
  servers: McpServerRecord[]
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 默认探测实现：用 `@modelcontextprotocol/sdk` 的 client 连一次，把它报的 tools 列出来。
 *
 * **只连一次，连完就断**：这里不持有会话、不缓存客户端、不把工具挂给任何 Agent——
 * 那是 WP81 引进官方 Agent 层之后 `mcp-client` 按 preset 的事。
 */
export async function probeMcpServer(input: {
  transport: McpTransport
  command?: string
  args?: readonly string[]
  url?: string
  headers?: Readonly<Record<string, string>>
}): Promise<{ ok: boolean; tools: { name: string; description?: string }[]; detail?: string }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'agentsws', version: '1' }, { capabilities: {} })
  try {
    const transport =
      input.transport === 'stdio'
        ? new (await import('@modelcontextprotocol/sdk/client/stdio.js')).StdioClientTransport({
            command: input.command ?? '',
            args: [...(input.args ?? [])],
            // 子进程的 stderr 不该喷进服务进程的日志（里面可能有它自己的密钥）
            stderr: 'ignore',
          })
        : new (
            await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
          ).StreamableHTTPClientTransport(new URL(input.url ?? ''), {
            ...(input.headers === undefined
              ? {}
              : { requestInit: { headers: { ...input.headers } } }),
          })
    /*
     * `as unknown as` 这一处是有意的，理由写清楚（35 §2 不许 `any`，这里也没有用）：
     * 我们全仓开着 `exactOptionalPropertyTypes`，而上游 SDK 的 `Transport` 接口把
     * `sessionId?: string` 声明成"可选但不可为 undefined"，它自己的两个实现却把它
     * 声明成 `string | undefined`——上游自己对不上。换成 `any` 会把整个 `connect`
     * 的入参检查一起关掉；这里只在**这一个已知不兼容的接口**上转一次。
     */
    await withTimeout(
      client.connect(transport as unknown as Parameters<typeof client.connect>[0]),
      '连接超时',
    )
    const listed = await withTimeout(
      client.listTools(undefined, { timeout: MCP_PROBE_TIMEOUT_MS }),
      '列工具超时',
    )
    return {
      ok: true,
      tools: listed.tools.map((t) => ({
        name: t.name,
        ...(typeof t.description === 'string' && t.description !== ''
          ? { description: t.description }
          : {}),
      })),
    }
  } catch (e) {
    return { ok: false, tools: [], detail: messageOf(e) }
  } finally {
    // 关不掉也不该让整次探测变成异常——结果已经有了
    await client.close().catch(() => undefined)
  }
}

async function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what}（超过 ${MCP_PROBE_TIMEOUT_MS / 1000} 秒）`))
        }, MCP_PROBE_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 一行 `名字: 值` 的请求头文本 → 对象。界面允许用户整段粘，所以解析放在服务端。 */
export function parseHeaderLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf(':')
    if (at <= 0) continue
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return out
}

export function createConnectionDirectory(
  options: ConnectionDirectoryOptions,
): ConnectionDirectoryAssembly {
  const { clock, roles, secrets } = options
  const stateFile = options.dir === undefined ? undefined : join(options.dir, 'mcp-servers.json')
  const probe = options.probeMcp ?? probeMcpServer

  let state: McpStateFile = { version: 1, servers: [] }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as McpStateFile
      state = { version: 1, servers: parsed.servers ?? [] }
    } catch {
      // 第一次跑，或者文件坏了：从空开始；加密库里的请求头不受影响
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /** 已连的 kind（两边都归一化：`gsc` 与 `search_console` 是同一条）。 */
  const connectedSet = (): Set<string> =>
    new Set([...options.connectedKinds()].map((k) => canonicalConnectionKind(k)))

  /** 这个 kind 点"去连接"落到哪张卡上。 */
  const connectServiceOf = (entry: ConnectionDirectoryEntry): string | undefined => {
    if (entry.resolved_by_profile === true) {
      // 51 §1 N0：`shop` 按公司档案解析；解析出来的那一个还得在连接目录里真有卡
      const service = storefrontUsableService(options.storefrontPlatform?.())
      return service === undefined || catalogEntry(service) === undefined ? undefined : service
    }
    return entry.service
  }

  /** 这一条现在什么状态。 */
  const stateOf = (entry: ConnectionDirectoryEntry): ConnectionDirectoryItem => {
    const connect_service = connectServiceOf(entry)
    const connected = connectedSet().has(entry.kind)
    // 自定义 MCP 那一条不走连接表：探测成功过就是"已连"，探测失败就是"出错"
    if (entry.mode === 'mcp_server') {
      const rows = state.servers
      const bad = rows.find((s) => s.probe?.ok === false)
      const good = rows.find((s) => s.probe?.ok === true)
      const item: ConnectionDirectoryItem = {
        ...entry,
        state: bad !== undefined ? 'error' : good !== undefined ? 'connected' : 'not_connected',
        ...(bad === undefined
          ? {}
          : { state_detail: bad.probe?.detail ?? `「${bad.name}」上次没连上` }),
        ...(connect_service === undefined ? {} : { connect_service }),
      }
      return item
    }
    // 连上了、但那条连接报"要重新授权 / 已停用" = 出错（比"已连"更该让人看见）
    const broken = (options.connections?.() ?? []).find(
      (c) =>
        c.status !== 'active' &&
        canonicalConnectionKind(catalogKindOf(c.service) ?? c.service) === entry.kind,
    )
    return {
      ...entry,
      state: broken !== undefined ? 'error' : connected ? 'connected' : 'not_connected',
      ...(broken === undefined
        ? {}
        : {
            state_detail: broken.status === 'reauth_required' ? '要重新授权' : '这条连接被停用了',
          }),
      ...(connect_service === undefined ? {} : { connect_service }),
    }
  }

  const directory = (): ConnectionDirectoryItem[] => CONNECTION_DIRECTORY.map(stateOf)

  // ── 岗位连接清单 ────────────────────────────────────────────────────

  const activeOf = (person_id: PersonId) =>
    roles.assignments
      .listByPerson(person_id, { workspace_id: options.workspace_id })
      .filter((a) => a.revoked_at === undefined)

  /**
   * `:id` 两种都收：岗位模板 id，或者本人持有的一条分配 id。
   *
   * 与 `positionPortFor` 的 `resolveId` 同一条规矩（server.ts）——两处都收，
   * 界面才不用先查一次模板 id。
   */
  const resolve = (
    person_id: PersonId,
    id: string,
  ): { position_id: string; position_name: string; role_ids: RoleId[] } => {
    const held = activeOf(person_id)
    const template = options.positions().find((p) => p.id === id)
    if (template !== undefined) {
      const inTemplate = template.roles.map((r) => r.role)
      // 他自己持有的那几条优先；一条都没持有就按整个岗位算（还没上岗的人也该看得见要连什么）
      const mine = inTemplate.filter((r) => held.some((a) => a.role_id === r))
      return {
        position_id: template.id,
        position_name: template.name.zh,
        role_ids: mine.length > 0 ? mine : inTemplate,
      }
    }
    const assignment = roles.assignments.get(id)
    if (assignment === undefined || assignment.person_id !== person_id)
      throw new ConnectionDirectoryError('not_found', `没有这个岗位：${id}`)
    const hit = options.positions().find((p) => p.roles.some((r) => r.role === assignment.role_id))
    if (hit === undefined) {
      // 这条职责不在任何岗位模板里：清单就只算它自己那一条（比报错有用）
      const def = roles.roles.get(assignment.role_id)
      return {
        position_id: id,
        position_name: def?.name.zh ?? assignment.role_id,
        role_ids: [assignment.role_id],
      }
    }
    const inTemplate = hit.roles.map((r) => r.role)
    const mine = inTemplate.filter((r) => held.some((a) => a.role_id === r))
    return {
      position_id: hit.id,
      position_name: hit.name.zh,
      role_ids: mine.length > 0 ? mine : inTemplate,
    }
  }

  const positionConnections = (person_id: PersonId, id: string): PositionConnectionsView => {
    const { position_id, position_name, role_ids } = resolve(person_id, id)
    const connected = connectedSet()
    const merged = new Map<
      string,
      { required: boolean; needed_by: string[]; entry?: ConnectionDirectoryEntry }
    >()
    for (const role_id of role_ids) {
      const def = roles.roles.get(role_id)
      if (def === undefined) continue
      for (const dep of def.connectors) {
        const entry = connectionDirectoryEntry(dep.kind)
        const kind = entry?.kind ?? dep.kind
        const existing = merged.get(kind)
        if (existing === undefined)
          merged.set(kind, {
            required: dep.required,
            needed_by: [def.name.zh],
            ...(entry === undefined ? {} : { entry }),
          })
        else {
          existing.required = existing.required || dep.required
          if (!existing.needed_by.includes(def.name.zh)) existing.needed_by.push(def.name.zh)
        }
      }
    }

    const items: PositionConnectionItem[] = []
    const missing_required: string[] = []
    for (const [kind, row] of merged) {
      const isConnected = connected.has(kind)
      if (row.required && !isConnected) missing_required.push(kind)
      // "连上这 N 个就能开工"：已连的那几条**不出现在卡上**（连上就少一条）
      if (isConnected) continue
      const entry = row.entry
      const connect_service = entry === undefined ? undefined : connectServiceOf(entry)
      items.push({
        kind,
        name: entry?.name ?? { zh: kind, en: kind },
        required: row.required,
        connected: false,
        needed_by: row.needed_by,
        status: entry?.status ?? 'planned',
        ...(connect_service === undefined ? {} : { connect_service }),
        ...(entry?.note === undefined ? {} : { note: entry.note }),
      })
    }
    // 必需的排在前面；同档按目录顺序（界面上不会因为一次刷新就换位置）
    const order = new Map(CONNECTION_DIRECTORY.map((e, i) => [e.kind, i]))
    items.sort(
      (a, b) =>
        Number(b.required) - Number(a.required) ||
        (order.get(a.kind) ?? 999) - (order.get(b.kind) ?? 999),
    )
    return {
      position_id,
      position_name,
      ready: missing_required.length === 0,
      missing_required,
      items,
    }
  }

  // ── 自定义 MCP 服务器 ───────────────────────────────────────────────

  const findMcp = (name: string): McpServerRecord | undefined =>
    state.servers.find((s) => s.name === name)

  const runProbe = async (row: McpServerRecord): Promise<McpProbeResult> => {
    // 请求头的值只在这一个调用栈里活一次：取出来 → 交给探测 → 出作用域即结束
    const headers = row.header_names.length === 0 ? undefined : secrets.get(secretIdOf(row.name))
    const outcome = await probe({
      transport: row.transport,
      ...(row.command === undefined ? {} : { command: row.command }),
      ...(row.args === undefined ? {} : { args: row.args }),
      ...(row.url === undefined ? {} : { url: row.url }),
      ...(headers === undefined ? {} : { headers }),
    })
    return {
      ok: outcome.ok,
      at: clock.now(),
      tools: outcome.tools,
      ...(outcome.ok ? {} : { reason: 'probe_failed' }),
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    }
  }

  /**
   * WP86（55 §4 第三层）：这条职责挂哪几台 MCP 服务器。
   *
   * 两处来源，都从**职责模板**出发（55 §4：preset 由模板生成、用户不手编）：
   *
   * 1. `connectors[].kind` 写成 `mcp:<名字>` —— 指名一台已登记的自定义服务器；
   * 2. `connectors[].kind` 对上的目录条目 `mode === 'mcp_server'` 且**同名**有一台
   *    已登记的服务器 —— 给将来"官方 MCP 服务器"那些条目留的口子（目录里那条
   *    通用的 `mcp_server` 不算：它说的是"可以接自定义服务器"这件事本身）。
   *
   * 探测失败过的不挂：`probe.ok !== true` 说明上一次连不上，它报的工具清单也不可信。
   */
  const roleConnections = (role_id: string): RunConnection[] => {
    const def = roles.roles.get(role_id)
    if (def === undefined) return []
    const out: RunConnection[] = []
    const seen = new Set<string>()
    for (const dep of def.connectors) {
      const custom = customMcpServerOfKind(dep.kind)
      const entry = custom === undefined ? connectionDirectoryEntry(dep.kind) : undefined
      const serverName =
        custom ??
        (entry?.mode === 'mcp_server' && entry.kind !== 'mcp_server' ? entry.kind : undefined)
      if (serverName === undefined || seen.has(serverName)) continue
      const row = findMcp(serverName)
      if (row === undefined || row.probe?.ok !== true) continue
      seen.add(serverName)
      const header_refs = Object.fromEntries(
        row.header_names.map((h) => [h, mcpHeaderRef(row.name, h)]),
      )
      out.push({
        kind: dep.kind,
        // 全局唯一：一个进程装得下多个品牌，不带 workspace 会撞名（52 O1）
        server_name: mcpServerNameFor(options.workspace_id, row.name),
        transport: row.transport,
        ...(row.command === undefined ? {} : { command: row.command }),
        ...(row.args === undefined ? {} : { args: [...row.args] }),
        ...(row.url === undefined ? {} : { url: row.url }),
        ...(Object.keys(header_refs).length === 0 ? {} : { header_refs }),
        read_tools: [...(row.read_tools ?? [])],
        tools: (row.probe?.tools ?? []).map((t) => t.name),
      })
    }
    return out.sort((a, b) => a.server_name.localeCompare(b.server_name))
  }

  return {
    directory,
    positionConnections,
    roleConnections,
    listMcp: () =>
      state.servers.map((s) => ({
        ...s,
        header_names: [...s.header_names],
        ...(s.read_tools === undefined ? {} : { read_tools: [...s.read_tools] }),
      })),
    async saveMcp(input) {
      const problems = validateMcpServer(input)
      if (problems.length > 0)
        throw new ConnectionDirectoryError('invalid_input', problems.join('；'), {
          problems,
        })
      const existingRow = findMcp(input.name)
      /*
       * WP86：**不传 `headers` ≠ 清空**。
       *
       * 只改"哪几个工具只读"的那一次提交不会把 token 再发一遍（界面上也不该让人
       * 为了勾一个复选框重新粘一次 Bearer token）。所以 `undefined` = 沿用，
       * `{}` = 明确清空。这两件事以前是同一个意思，现在分开了。
       */
      const keepHeaders = input.headers === undefined && existingRow !== undefined
      const headers = input.headers ?? {}
      const header_names = keepHeaders
        ? [...(existingRow?.header_names ?? [])]
        : Object.keys(headers).sort()
      if (Object.keys(headers).length > 0 && !secrets.available)
        throw new ConnectionDirectoryError(
          'invalid_input',
          '这台电脑还没有秘密库密钥，带请求头的 MCP 服务器暂时存不了',
        )
      const now = clock.now()
      const existing = existingRow
      const row: McpServerRecord = {
        name: input.name,
        transport: input.transport,
        ...(input.transport === 'stdio'
          ? {
              command: input.command ?? '',
              ...(input.args === undefined ? {} : { args: [...input.args] }),
            }
          : { url: input.url ?? '' }),
        header_names,
        // WP86：只读清单是**人勾的**，没勾就沿用上一次勾过的那份（改个请求头不该
        // 把"哪些工具只读"清空——清空 = 这台服务器在公司端一个工具都调不动）
        ...(input.read_tools === undefined
          ? existing?.read_tools === undefined
            ? {}
            : { read_tools: [...existing.read_tools] }
          : { read_tools: [...new Set(input.read_tools)].sort() }),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      }
      // 值进加密库、名字留在这张表上——两者从这一行起就分开了
      if (!keepHeaders) {
        if (header_names.length > 0) secrets.put(secretIdOf(row.name), { ...headers })
        else secrets.remove(secretIdOf(row.name))
      }
      state.servers = [...state.servers.filter((s) => s.name !== row.name), row].sort((a, b) =>
        a.name.localeCompare(b.name),
      )
      flush()
      const result = await runProbe(row)
      row.probe = result
      flush()
      return { ...row, header_names: [...row.header_names] }
    },
    async probeMcp(name) {
      const row = findMcp(name)
      if (row === undefined)
        throw new ConnectionDirectoryError('not_found', `没有这台 MCP 服务器：${name}`)
      row.probe = await runProbe(row)
      flush()
      return { ...row, header_names: [...row.header_names] }
    },
    removeMcp(name) {
      const before = state.servers.length
      state.servers = state.servers.filter((s) => s.name !== name)
      if (state.servers.length === before) return false
      secrets.remove(secretIdOf(name))
      flush()
      return true
    },
  }
}

/** 加密库里这台 MCP 服务器请求头的 key。 */
function secretIdOf(name: string): string {
  return `${MCP_SECRET_PREFIX}${name}`
}

/**
 * 连接页的 provider id → 职责连接器 kind。
 *
 * 只在"这条连接坏了、该把目录上哪一行标红"时用得到。先查 `catalog.ts` 那张
 * service → kind 的表（真源），查不到再让契约的目录按别名认一次（替身上报的
 * `shopify` 与真适配器的 `shopify_admin` 就是这么对上的）。都认不出来回
 * `undefined`，调用方按原名兜底——**不编一条出来**。
 */
export function catalogKindOf(service: string): string | undefined {
  const mapped = ROLE_CONNECTOR_KIND[service]
  if (mapped !== undefined) return canonicalConnectionKind(mapped)
  return connectionDirectoryEntry(service)?.kind
}
