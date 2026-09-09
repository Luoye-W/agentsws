/**
 * 协同服务进程（28 §1「一进程含内核与全部模块」）。
 *
 * 装配顺序：kernel → data → roles → knowledge → skills → model-gateway → txn → identity → api。
 * 只监听 127.0.0.1；一个进程一个端口（`AGENTSWS_PORT`，默认 4317）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAsyncTraceScope,
  createGateway,
  createMemoryIdentity,
  createSqliteIdentity,
  type Gateway,
  type GatewayDeps,
  type GuardrailPort,
  type KnowledgePort,
  type LocalIdentityService,
  type RolesPort,
  type SkillsPort,
  SqliteIdempotencyStore,
  SqliteIdentityService,
  type TraceScope,
} from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  Assignment,
  Clock,
  EventEnvelope,
  ModelRef,
  Person,
  PersonId,
  StartRun,
  Workspace,
  WorkspaceId,
} from '@agentsws/contracts'
import { evaluateGuardrail } from '@agentsws/core'
import { createDataStore, type SqliteDataStore } from '@agentsws/data'
import { createKernel, type Kernel, seededRandom } from '@agentsws/kernel'
import { createKnowledge, type Knowledge } from '@agentsws/knowledge'
import {
  createModelGateway,
  type ModelGatewayApi,
  openaiCompatibleProvider,
  stubProvider,
} from '@agentsws/model-gateway'
import { changeKindOf, createRoleStore, loadBundledRole, type RoleStore } from '@agentsws/roles'
import { createSkills, type Skills } from '@agentsws/skills'
import { createTxn, SqliteTxnStore, type Txn } from '@agentsws/txn'
import { createWork, SqliteWorkStore, type Work } from '@agentsws/work'
import { type ServerType, serve } from '@hono/node-server'
import { MemoryBackend } from './backend.js'
import { type ConnectionsAssembly, createConnections, createMailProbe } from './connections.js'
import { createMeetings, type MeetingsAssembly, seedDemoMeetings } from './meetings.js'
import { mountStatic } from './static.js'
import { createWorkPort } from './work.js'
import {
  createWorkstationPort,
  emptyDataSource,
  type WorkstationDataSource,
} from './workstation.js'

export const DEFAULT_PORT = 4317
export const HOST = '127.0.0.1'
/** v1 自带的职责定义（roles 包 bundled）。 */
export const BUNDLED_ROLES = ['common.owner', 'common.member', 'dtc.aftersales'] as const

/**
 * 36 §5.7 的 demo：把一个已经跑过场景的模拟世界接进同一个进程。
 *
 * 接进来的是**世界的**职责库与审批总线——工作台上看到的卡片就是场景真产生的那几条，
 * 不是照着抄一份。身份的 person_id / workspace_id 也跟着世界走，否则网关一律 404。
 */
export interface MountedWorld {
  workspace_id: WorkspaceId
  workspace_name?: string
  owner: { id: PersonId; email: string; name: string }
  roles: RoleStore
  approvals: ApprovalBus
  data: WorkstationDataSource
}

export interface ServerOptions {
  /**
   * SQLite 目录；不给则全部内存档（测试与一次性任务）。
   * 进程入口按 `AGENTSWS_DATA_DIR`（旧名 `AGENTSWS_DB_DIR` 仍认）取值。
   * 各包各自一个 `.sqlite` 文件，不共享表（35 §2）。
   */
  dbDir?: string
  env?: Record<string, string | undefined>
  port?: number
  /** 时间注入点；不给用系统时钟。 */
  clock?: Clock
  /** 随机注入点（seed 化）；不给用 seed = 当前毫秒。 */
  random?: () => number
  /** 启动时不往 stdout 打字（测试用）。 */
  quiet?: boolean
  /** 工作台构建产物目录；给了就在 `/` 托管（SPA fallback）。 */
  staticDir?: string
  /** demo：把模拟世界接进来（同一进程）。 */
  mount?: MountedWorld
  /**
   * 37 委托与「在事项里说话」都要起 Run；本进程还没装运行时适配器，
   * 由调用方（demo / 桌面壳）注入。不给的话那两条路回 not_implemented，其余照常。
   */
  startRun?: StartRun
}

export interface Bootstrap {
  person: Person
  workspace: Workspace
  ownerAssignment: Assignment
  /** 开发期内部凭据；只在首次启动打印一次。 */
  internalToken: string
}

export interface Server {
  gateway: Gateway
  kernel: Kernel
  data: SqliteDataStore
  roles: RoleStore
  knowledge: Knowledge
  skills: Skills
  models: ModelGatewayApi
  txn: Txn
  /** 37 工作模型：事项 / 目标 / 待办 / 计划 / 复盘 */
  work: Work
  /** 37 §4 会议内核（存储 / 受控原始材料区 / 处理管线 / 端口）。 */
  meetings: MeetingsAssembly
  /** WP20 连接面（连接向导 / 本机加密秘密库 / 连接状态回灌工作台）。 */
  connections: ConnectionsAssembly
  identity: LocalIdentityService
  backend: MemoryBackend
  /** 请求外的后台动作（调度、执行器）可以借它把自己挂进同一条 trace。 */
  traceScope: TraceScope
  bootstrap: Bootstrap
  /** 已监听时的 URL（listen 之后才有）。 */
  url?: string
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>
}

const priceTable = {
  'stub/stub-v1': { in: 0, out: 0, cached: 0 },
  'deepseek/deepseek-chat': { in: 0.27, out: 1.1, cached: 0.07 },
}

export async function createServer(options: ServerOptions = {}): Promise<Server> {
  const env = options.env ?? process.env
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
  const random = options.random ?? seededRandom(Date.parse(clock.now()) % 2147483647)
  const dbDir = options.dbDir
  if (dbDir !== undefined) mkdirSync(dbDir, { recursive: true })
  const file = (name: string): string => (dbDir === undefined ? ':memory:' : join(dbDir, name))

  const kernel = await createKernel({ dbPath: file('events.db'), clock, random, env })
  const traceScope = createAsyncTraceScope()

  // 21 §1：所有模块的事件都进同一条日志；请求内的 trace_id 覆盖模块自造的那个。
  const appendEvent = (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void => {
    const { at: _at, ...rest } = e
    kernel.eventLog.appendSync({
      ...rest,
      schema_version: 1,
      correlation: {
        ...rest.correlation,
        trace_id: traceScope.current() ?? rest.correlation.trace_id,
      },
    })
  }

  const data = createDataStore({ dbPath: file('data.db'), clock, collections: [] })

  const roles =
    options.mount?.roles ??
    createRoleStore({
      clock,
      ...(dbDir === undefined ? {} : { dbPath: join(dbDir, 'roles.db') }),
      roles: BUNDLED_ROLES.map((id) => loadBundledRole(id)),
    })

  const knowledge = createKnowledge({ dbPath: file('knowledge.db'), clock })
  const skills = createSkills({ clock, random })

  const deepseekKey = env.DEEPSEEK_API_KEY
  const useDeepSeek = deepseekKey !== undefined && deepseekKey.trim() !== ''
  const defaultModel: ModelRef = useDeepSeek
    ? { provider: 'deepseek', model: 'deepseek-chat', region: 'cn' }
    : { provider: 'stub', model: 'stub-v1', region: 'cn' }
  const models = createModelGateway({
    providers: [
      useDeepSeek
        ? openaiCompatibleProvider({
            apiKeyEnv: 'DEEPSEEK_API_KEY',
            model: 'deepseek-chat',
            provider: 'deepseek',
            region: 'cn',
            env,
          })
        : stubProvider({ seed: 7 }),
    ],
    policy: { default: defaultModel, data_residency: 'cn', prices: priceTable },
    clock,
    env,
    halt: kernel.halt,
    trace: kernel.trace,
    eventSink: (e) => {
      appendEvent(e)
    },
  })

  const backend = new MemoryBackend()
  // WP18：给了数据目录就整套落盘（审批项 / 账本 / 预占 / unknown 与对账游标）
  const idempotencyStore =
    dbDir === undefined
      ? undefined
      : new SqliteIdempotencyStore({ dbPath: join(dbDir, 'idempotency.sqlite'), clock })
  const txnStore =
    dbDir === undefined
      ? undefined
      : new SqliteTxnStore({ dbPath: join(dbDir, 'txn.sqlite'), clock })
  const txn = createTxn({
    clock,
    random,
    ...(txnStore === undefined ? {} : { store: txnStore }),
    eventSink: (e) => {
      appendEvent(e)
    },
    readRecord: (target) => backend.read(target),
    backendApply: (change, opts) => backend.apply(change, opts),
    deliverOutbound: (item, opts) => backend.deliver(item, opts),
  })

  const identity: LocalIdentityService =
    dbDir === undefined
      ? createMemoryIdentity({ clock, random })
      : createSqliteIdentity({ dbPath: join(dbDir, 'identity.sqlite'), clock, random })

  // 37 工作模型：给了数据目录就落盘（事项 / 时间线 / 目标 / 待办 / 计划 / 复盘）
  const workStore =
    dbDir === undefined
      ? undefined
      : new SqliteWorkStore({ dbPath: join(dbDir, 'work.sqlite'), clock })

  // ── 首次启动：owner + 默认工作区 + 内部凭据（28 §3「内部服务凭据」）
  const mount = options.mount
  const ownerEmail = mount?.owner.email ?? (env.AGENTSWS_OWNER_EMAIL?.trim() || 'owner@localhost')
  const person = await identity.createPerson({
    email: ownerEmail,
    name: mount?.owner.name ?? ownerEmail.split('@')[0] ?? 'owner',
    ...(mount === undefined ? {} : { id: mount.owner.id }),
  })
  // 落盘档会重启：owner 的工作区与 Assignment 只在第一次建，之后接着用同一份；
  // 接进来的世界（mount）用它给的 id，且它已有自己的策略层与分配，不覆盖
  const workspace =
    (await identity.workspacesOf(person.id))[0] ??
    (await identity.createWorkspace({
      name: mount?.workspace_name ?? (env.AGENTSWS_WORKSPACE_NAME?.trim() || 'default'),
      owner_id: person.id,
      kind: 'personal',
      ...(mount === undefined ? {} : { id: mount.workspace_id }),
    }))
  if (mount === undefined) roles.policies.set(workspace.policy)
  const ownerAssignment =
    roles.assignments
      .listByPerson(person.id, { workspace_id: workspace.id, role_id: 'common.owner' })
      .find((a) => a.revoked_at === undefined) ??
    roles.assignments.create({
      person_id: person.id,
      workspace_id: workspace.id,
      role_id: 'common.owner',
      granted_by: person.id,
      ranges: [],
    })
  const internalToken = identity.issue('internal', person.id, workspace.id).token

  const approvals = mount?.approvals ?? txn.approvals
  // WP20 连接面：装配一次，`/v1/connections/*` 与工作台数据源共用同一份连接状态。
  const connections = await createConnections({
    clock,
    workspace_id: workspace.id,
    env,
    random,
    appendEvent,
    mailProbe: createMailProbe(),
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  // 36 §3：数据源接没接从真实连接算——连上 Shopify，首页数字块就不再是「去连接」。
  const workData = connections.wrapDataSource(mount?.data ?? emptyDataSource())
  const work = createWork({
    workspace_id: workspace.id,
    clock,
    random,
    tz_offset_minutes: workData.tz_offset_minutes,
    ...(workStore === undefined ? {} : { store: workStore }),
    ...(options.startRun === undefined ? {} : { startRun: options.startRun }),
  })

  // 37 §4：会议内核。ASR 走同一个模型网关（没装 ASR provider 时管线出系统卡，不炸）；
  // 产出的认领卡进同一条审批队列（14 §1），挂在本人的岗位下，所以装在 txn 与 Assignment 之后。
  const meetings = createMeetings({
    ...(dbDir === undefined ? {} : { dbDir }),
    clock,
    random,
    models,
    appendEvent,
    approvals: options.mount?.approvals ?? txn.approvals,
    role_id: ownerAssignment.role_id,
  })

  // demo：把三份合成会议跑完整管线，工作台上的会议页才有真产出可看
  if (mount !== undefined) {
    await seedDemoMeetings(meetings, {
      workspace_id: workspace.id,
      owner: person.id,
      position_id: ownerAssignment.id,
      clock,
    })
  }

  const rolesPort: RolesPort = {
    can: (id, domain, op, request) => roles.can(id, domain, op, request),
    effectiveConfig: (id) => roles.effectiveConfig(id),
    getAssignment: (id) => roles.assignments.get(id),
    listAssignments: (person_id, filter) => roles.assignments.listByPerson(person_id, filter ?? {}),
  }

  const knowledgePort: KnowledgePort = {
    search: (q) => knowledge.retrieval.search(q),
    cards: (filter, actor) => knowledge.store.list(filter, actor),
    card: (id, actor) => knowledge.store.get(id, actor),
    health: (workspace_id) => knowledge.store.health(workspace_id),
  }

  const skillsPort: SkillsPort = {
    resolve: (name, actor) => skills.registry.resolve(name, actor),
    setOverlay: (overlay) => skills.registry.setOverlay(overlay),
    lessons: (filter) => skills.lessons.list(filter),
  }

  /**
   * 15 §7 `POST /guardrails/evaluate`：只评估不 stage。
   * 额度取该 Assignment 上匹配 change_kind 的动作；累计类事实（窗口计数 / 累计幅度）
   * 属于账本内部状态，预览不读它们——预览是「下限」，真正的判定仍在 stage / apply 两次评估。
   */
  const guardrails: GuardrailPort = {
    evaluate: async (input) => {
      const config = roles.effectiveConfig(input.assignment_id)
      const action = config.actions.find((a) => changeKindOf(a.id) === input.change.kind)
      return evaluateGuardrail(
        input.change,
        action?.mandate ?? { caps: {} },
        { now: input.at, changeSet: [], windowCount: 0 },
        input.phase,
      )
    },
  }

  const deps: GatewayDeps = {
    identity,
    halt: kernel.halt,
    trace: kernel.trace,
    clock,
    eventLog: kernel.eventLog,
    modules: kernel.modules,
    approvals,
    changes: txn.ledger,
    guardrails,
    knowledge: knowledgePort,
    skills: skillsPort,
    roles: rolesPort,
    meetings: meetings.port,
    connections: connections.port,
    workstation: createWorkstationPort({ clock, roles, approvals, data: workData }),
    work: createWorkPort({
      clock,
      work,
      // 只给本人这条队列里的卡（14 §7：别人的 token 与内容不出现在这里）
      approvals: (actor) =>
        approvals.queue({
          workspace_id: actor.workspace_id,
          person_id: actor.person_id,
          lane: 'mine',
        }) as Promise<ApprovalItem[]>,
      orders: () => workData.orders(),
      label: (ref) => workData.label(ref),
    }),
    traceScope,
    options: {
      version: env.AGENTSWS_VERSION ?? '0.1.0',
      ...(idempotencyStore === undefined ? {} : { idempotencyStore }),
      // 本地单机档：一次性登录 token 直接回给调用方，工作台才能自动登录（20 §3）
      exposeMagicLinkToken: true,
    },
  }

  const gateway = createGateway(deps)
  // 静态托管必须在网关路由之后挂（Hono 按注册顺序匹配，`*` 放最后）
  if (options.staticDir !== undefined) {
    mountStatic(gateway.app, {
      dir: options.staticDir,
      bootstrap: { owner_email: person.email, workspace: workspace.id, demo: mount !== undefined },
    })
  }
  let httpServer: ServerType | undefined
  let closed = false

  const server: Server = {
    gateway,
    kernel,
    data,
    roles,
    knowledge,
    skills,
    models,
    txn,
    work,
    meetings,
    connections,
    identity,
    backend,
    traceScope,
    bootstrap: { person, workspace, ownerAssignment, internalToken },
    async listen(port?: number) {
      const wanted =
        port ?? (env.AGENTSWS_PORT === undefined ? DEFAULT_PORT : Number(env.AGENTSWS_PORT))
      if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535)
        throw new Error(`AGENTSWS_PORT 不合法：${String(env.AGENTSWS_PORT)}`)
      const started = await new Promise<ServerType>((resolve) => {
        const s = serve({ fetch: gateway.fetch, port: wanted, hostname: HOST }, () => {
          resolve(s)
        })
      })
      httpServer = started
      const address = started.address()
      const bound = typeof address === 'object' && address !== null ? address.port : wanted
      const url = `http://${HOST}:${bound}`
      server.url = url
      if (options.quiet !== true) {
        // 开发期：健康检查地址与内部凭据只在 stdout 出现一次（21 §5：不进事件日志）。
        process.stdout.write(`agentsws server listening on ${url}\n`)
        process.stdout.write(`health: ${url}/v1/health\n`)
        process.stdout.write(`workspace: ${workspace.id}  owner: ${person.email}\n`)
        process.stdout.write(`internal token: ${internalToken}\n`)
      }
      return { url, port: bound }
    },
    async close() {
      if (closed) return
      closed = true
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer?.close((err) => (err ? reject(err) : resolve()))
        })
        httpServer = undefined
      }
      knowledge.close()
      data.close()
      // 接进来的世界由调用方关（它还持有事件日志与替身）
      if (options.mount === undefined) roles.close()
      meetings.close()
      connections.close()
      txnStore?.close()
      workStore?.close()
      idempotencyStore?.close()
      if (identity instanceof SqliteIdentityService) identity.close()
      await kernel.dispose()
    },
  }
  return server
}
