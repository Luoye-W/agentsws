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
  type Gateway,
  type GatewayDeps,
  type GuardrailPort,
  type KnowledgePort,
  type MemoryIdentityService,
  type RolesPort,
  type SkillsPort,
  type TraceScope,
} from '@agentsws/api'
import type {
  ApprovalBus,
  Assignment,
  Clock,
  EventEnvelope,
  ModelRef,
  Person,
  PersonId,
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
import { createTxn, type Txn } from '@agentsws/txn'
import { type ServerType, serve } from '@hono/node-server'
import { MemoryBackend } from './backend.js'
import { mountStatic } from './static.js'
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
  /** SQLite 目录；不给则全部内存档（测试与一次性任务）。 */
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
  identity: MemoryIdentityService
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
  const txn = createTxn({
    clock,
    random,
    eventSink: (e) => {
      appendEvent(e)
    },
    readRecord: (target) => backend.read(target),
    backendApply: (change, opts) => backend.apply(change, opts),
    deliverOutbound: (item, opts) => backend.deliver(item, opts),
  })

  const identity = createMemoryIdentity({ clock, random })

  // ── 首次启动：owner + 默认工作区 + 内部凭据（28 §3「内部服务凭据」）
  const mount = options.mount
  const ownerEmail = mount?.owner.email ?? (env.AGENTSWS_OWNER_EMAIL?.trim() || 'owner@localhost')
  const person = await identity.createPerson({
    email: ownerEmail,
    name: mount?.owner.name ?? ownerEmail.split('@')[0] ?? 'owner',
    ...(mount === undefined ? {} : { id: mount.owner.id }),
  })
  const workspace = await identity.createWorkspace({
    name: mount?.workspace_name ?? (env.AGENTSWS_WORKSPACE_NAME?.trim() || 'default'),
    owner_id: person.id,
    kind: 'personal',
    ...(mount === undefined ? {} : { id: mount.workspace_id }),
  })
  // 接进来的世界已经有自己的策略层与分配，不覆盖
  if (mount === undefined) roles.policies.set(workspace.policy)
  const ownerAssignment =
    mount === undefined
      ? roles.assignments.create({
          person_id: person.id,
          workspace_id: workspace.id,
          role_id: 'common.owner',
          granted_by: person.id,
          ranges: [],
        })
      : (roles.assignments
          .listByPerson(person.id, { workspace_id: workspace.id })
          .find((a) => a.revoked_at === undefined) ??
        roles.assignments.create({
          person_id: person.id,
          workspace_id: workspace.id,
          role_id: 'common.owner',
          granted_by: person.id,
          ranges: [],
        }))
  const internalToken = identity.issue('internal', person.id, workspace.id).token

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
    approvals: mount?.approvals ?? txn.approvals,
    changes: txn.ledger,
    guardrails,
    knowledge: knowledgePort,
    skills: skillsPort,
    roles: rolesPort,
    workstation: createWorkstationPort({
      clock,
      roles,
      approvals: mount?.approvals ?? txn.approvals,
      data: mount?.data ?? emptyDataSource(),
    }),
    traceScope,
    options: {
      version: env.AGENTSWS_VERSION ?? '0.1.0',
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
      await kernel.dispose()
    },
  }
  return server
}
