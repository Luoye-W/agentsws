/**
 * 协同服务进程（28 §1「一进程含内核与全部模块」）。
 *
 * 装配顺序：kernel → data → roles → knowledge → skills → model-gateway → txn → identity → api。
 * 只监听 127.0.0.1；一个进程一个端口（`AGENTSWS_PORT`，默认 4317）。
 */
import { mkdirSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import {
  ApiError,
  createAsyncTraceScope,
  createGateway,
  createMemoryIdentity,
  createSqliteIdentity,
  type EventLogPort,
  type Gateway,
  type GatewayDeps,
  type GuardrailPort,
  type KnowledgePort,
  type LocalIdentityService,
  parseSubprotocols,
  type RolesPort,
  readCookie,
  SESSION_COOKIE,
  type SkillsPort,
  SqliteIdempotencyStore,
  SqliteIdentityService,
  type TraceScope,
  WS_SUBPROTOCOL,
  WsSession,
} from '@agentsws/api'
import { openBlobStore } from '@agentsws/blob'
import type { ResolveMx } from '@agentsws/channels'
import type {
  ApprovalBus,
  ApprovalItem,
  Assignment,
  Clock,
  EventEnvelope,
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
  type FetchLike,
  type ModelGatewayApi,
  type PageFetch,
  stubProvider,
} from '@agentsws/model-gateway'
import { changeKindOf, createRoleStore, loadBundledRole, type RoleStore } from '@agentsws/roles'
import { createSkills, type Skills } from '@agentsws/skills'
import { createTxn, SqliteTxnStore, type Txn } from '@agentsws/txn'
import { createWork, SqliteWorkStore, type Work } from '@agentsws/work'
import { type ServerType, serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { createAskPort } from './ask.js'
import { MemoryBackend } from './backend.js'
import { type BackupRunResult, backupDirOf, backupKeepOf, runBackup } from './backup.js'
import { createCatalogIndex } from './catalog-index.js'
import { type ChannelsAssembly, type ChannelsOptions, createChannels } from './channels.js'
import { connectBaseUrl } from './connect-url.js'
import { type ConnectionsAssembly, createConnections, createMailProbe } from './connections.js'
import { createPrivacyErase } from './erase.js'
import { createApprovalDirectory } from './housekeeping.js'
import { createLearningAssembly, type LearningAssembly, seedDefaultSkill } from './learning.js'
import { createMeetings, type MeetingsAssembly, seedDemoMeetings } from './meetings.js'
import { createModels, type ModelsAssembly, STUB_REF } from './models.js'
import { createOffboard, type Offboard } from './offboard.js'
import { createOrg, type OrgAssembly } from './org.js'
import {
  createReconcileGuard,
  type ReconcileGuard,
  type ReconcileGuardOptions,
} from './reconcile.js'
import { createRuntime, type MatterRecordSource, type RuntimeAssembly } from './runtime.js'
import {
  createScheduleAssembly,
  createSchedulePort,
  DEFAULT_RAW_RETENTION_DAYS,
  ensureSystemTasks,
  offsetToTz,
  registerApprovalHousekeeping,
  registerBackup,
  registerDailyPlan,
  registerIdempotencySweep,
  registerLearning,
  registerMailPoll,
  registerMeetingPoll,
  registerPlanRelay,
  registerPricingRefresh,
  registerRawPrune,
  registerReview,
  registerSkillsWeekly,
  registerTokenRefresh,
  type ScheduleAssembly,
  type SchedulePosition,
} from './schedule.js'
import { createSecretStore, type SecretStore, SecretStoreError } from './secret-store.js'
import { createSecretaryAssembly, type SecretaryAssembly } from './secretary.js'
import type { BrokerFetch } from './shopify-broker.js'
import { mountStatic } from './static.js'
import { createStorage } from './storage.js'
import { createWorkPort, periodQueryRunner } from './work.js'
import {
  createWorkstationPort,
  emptyDataSource,
  type WorkstationDataSource,
} from './workstation.js'

/** 战报要数「今天处理掉的」，所以取队列时状态放全（等待类计数在 work 端自己过滤）。 */
const QUEUE_STATES = [
  'pending',
  'in_review',
  'approved',
  'approved_edited',
  'auto_approved',
  'rejected',
  'deferred',
  'applying',
  'applied',
  'apply_failed',
  'blocked',
  'expired',
  'withdrawn',
] as const

/** 队列上还等着人的状态（战报与计划里的「还有几张等你定」都用它）。 */
const WAITING_QUEUE_STATES = new Set(['pending', 'in_review'])

export const DEFAULT_PORT = 4317
/**
 * 默认只监听回环（13 §5：桌面壳的 sidecar，别人连不上）。
 *
 * WP40 加了一个开关 `AGENTSWS_BIND_HOST`，**唯一的用途是容器里**：
 * 在容器里 `127.0.0.1` 的意思是「连自己都只有容器里能连」，
 * 端口映射出去也是空的。容器档下真正的暴露控制在两处，都比这一行更靠外：
 * compose 的端口绑定（默认 `127.0.0.1:4317`，见 docker-compose.yml）与 NAS 的防火墙。
 *
 * 换句话说：**不在容器里就别设它**。默认值一个字没变。
 */
export const HOST = '127.0.0.1'
export const BIND_HOST_ENV = 'AGENTSWS_BIND_HOST'

/** 只接受回环与「全部网卡」两种——写别的地址多半是配错了，不如报出来。 */
export function bindHost(env: Record<string, string | undefined>): string {
  const raw = env[BIND_HOST_ENV]?.trim()
  if (raw === undefined || raw === '') return HOST
  if (raw === '0.0.0.0' || raw === '::' || raw === '127.0.0.1' || raw === '::1') return raw
  throw new Error(
    `${BIND_HOST_ENV} 只接受 127.0.0.1 / ::1 / 0.0.0.0 / ::（拿到的是 ${raw}）。` +
      '要限制谁能连，用 compose 的端口绑定或 NAS 防火墙，不要在这里写内网地址。',
  )
}
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
  /**
   * 世界自己的事件日志。接进来之后 `/v1/events` 与今日战报读的是**合一**的那一条：
   * 服务进程的日志 + 世界的日志按 id 归并。不给的话首页四格全是零——
   * 世界里的 `approval.created` / `run.completed` 根本不在服务进程的日志里（WP21 遗留）。
   */
  eventLog?: EventLogPort
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
   * 37 委托与「在事项里说话」都要起 Run。缺省由 `./runtime.ts` 自己装一个运行时适配器
   * （有模型 provider 配置就走 direct-llm，否则 stub）；调用方也可以自己塞一个进来。
   * 显式给 `false` 就是「这个进程不跑运行时」——那两条路回 not_implemented，其余照常。
   */
  startRun?: StartRun | false
  /** 事项现场的记录来源（订单 / 客户 / 联系人 / 工具执行器）；demo 由合成世界提供。 */
  records?: MatterRecordSource
  /**
   * WP25 的三个测试注入点。生产路径一个都不传，各自走真实现：Shopify 换令牌用
   * `globalThis.fetch`、MX 用 `node:dns/promises`、模型试跑用网关自己的 fetch。
   *
   * 之所以从这里穿下去而不是让测试自己拼一套：**端到端要跑的就是这条真装配线**
   * （路由 → 端口 → 加密库 → 网关），只把最外面那一跳换成回放，别处一行不动。
   */
  shopifyFetch?: BrokerFetch
  /** WP25：邮箱识别用的 MX 查询（测试注入）。 */
  resolveMx?: ResolveMx
  /** WP25：模型试跑用的 fetch（测试注入 →「测试」按钮全程不联网）。 */
  modelFetch?: FetchLike
  /** WP42：抓各家价目页用的 fetch（测试回放固定页面 → 价目刷新全程不联网）。 */
  pricingFetch?: PageFetch
  /**
   * WP25：Shopify 令牌到期巡检的间隔（毫秒）。
   *
   * **WP27 起缺省 0**：巡检改由调度器那条 `connect.shopify_refresh` 任务驱动
   * （到期前一小时换新，不再是 15 分钟一遍的 `setInterval`）。显式传一个正数
   * 仍会起旧的 `setInterval`——只给不想装调度器的嵌入式用法留个后门。
   */
  tokenRefreshIntervalMs?: number
  /**
   * 25 §4 调度循环的巡检间隔（毫秒）；缺省 30 秒。传 `0` = 不起后台定时器
   * （测试与模拟回路自己调 `scheduler.runDue`）。
   */
  scheduleIntervalMs?: number
  /**
   * WP34 渠道的测试注入：收信端与发信端。
   * 生产路径一个都不传，各自走真实现（imapflow / nodemailer）。
   */
  mailSource?: ChannelsOptions['makeSource']
  mailer?: ChannelsOptions['makeMailer']
  /**
   * 15 §5.8 对账时的「这条到底写进去没有」回查。
   *
   * 缺省问后端自己（`MemoryBackend.verify`）。真接了平台之后这里换成按
   * `execution_id` / 平台对象的查询。答不上来回 `undefined`——**不许猜**。
   */
  verifyChange?: ReconcileGuardOptions['verify']
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
  /** OpenConnector 本地 runtime 的地址（`AGENTSWS_CONNECT_URL`；全仓唯一真源）。 */
  connectUrl: string
  kernel: Kernel
  data: SqliteDataStore
  roles: RoleStore
  knowledge: Knowledge
  skills: Skills
  /** WP29 学习回路（lesson 池 / 次日提案 / 采纳落 overlay）。 */
  learning: LearningAssembly
  models: ModelGatewayApi
  txn: Txn
  /** 37 工作模型：事项 / 目标 / 待办 / 计划 / 复盘 */
  work: Work
  /** 37 §4 会议内核（存储 / 受控原始材料区 / 处理管线 / 端口）。 */
  meetings: MeetingsAssembly
  /** WP20 连接面（连接向导 / 本机加密秘密库 / 连接状态回灌工作台）。 */
  connections: ConnectionsAssembly
  /** WP34 渠道面（IMAP 轮询 / 入站管线 / 受控原始材料区 / 出站发信）。 */
  channels: ChannelsAssembly
  /** WP25 模型面（provider 配置 / 热更新 / 按 purpose 记账）。 */
  modelSettings: ModelsAssembly
  /** WP28 制度面（职责 / 岗位 / 分配 / 策略层 / 成员与邀请）。 */
  org: OrgAssembly
  /** 41 §1 秘书 Agent（profile / 代答 / 日程 / 路由）。 */
  secretary: SecretaryAssembly
  /** WP36 离职编排（撤权限 → 真交接 → 个人层归档 / 销毁 → 个人记忆迁移 / 擦除 → 报告）。 */
  offboard: Offboard
  /** 本机加密秘密库：邮箱口令、Shopify 应用密钥、模型 key 都在这一个库里（前缀分开）。 */
  secrets: SecretStore
  /** 25 定时与流程：调度器 + 流程引擎 + 各个消费者的登记。 */
  schedule: ScheduleAssembly
  /**
   * 15 §5.8「备份恢复后先跑对账再放开出站」。
   *
   * `createServer` 里只 `engage()`（该挂档就挂上，不做 IO）；真正跑对账在
   * `listen()` 里，或者由调用方自己 `await server.reconcile.run()`。
   */
  reconcile: ReconcileGuard
  /** 17 §4 运行时适配器 + `startRun`；`startRun: false` 时没有。 */
  runtime?: RuntimeAssembly
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

/**
 * 21 §1「所有模块的事件都进同一条日志」。demo 里世界与服务进程各有一份内核，
 * 所以读的时候按 id 归并成一条：`/v1/events` 的 `since` 续传与今日战报都靠它。
 *
 * 归并是**读侧**的：两边各自 append-only，谁也不改谁；id 是 ulid，按字典序即时间序。
 */
export function mergeEventLogs(base: EventLogPort, extra?: EventLogPort): EventLogPort {
  if (extra === undefined) return base
  return {
    async *read(filter) {
      const all: EventEnvelope[] = []
      for await (const e of base.read(filter)) all.push(e)
      for await (const e of extra.read(filter)) all.push(e)
      all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const since = filter.since
      const limit = filter.limit
      let n = 0
      for (const e of all) {
        if (since !== undefined && e.id <= since) continue
        if (limit !== undefined && n >= limit) return
        n += 1
        yield e
      }
    },
  }
}

/** `/v1/ws` 的路径（网关那边的路由声明与这里必须是同一个字面量）。 */
const WS_PATH = '/v1/ws'

/**
 * 28 §2 WebSocket 事件流的**传输层**：在 `@hono/node-server` 返回的 `http.Server` 的
 * `upgrade` 事件上握手，成了就把这条连接交给 `WsSession`（协议逻辑全在 `@agentsws/api`）。
 *
 * 为什么不走 `hono/ws`：网关的中间件链（急停 → 鉴权限流 → 出站急停 → 绑 Assignment → 幂等）
 * 全部以 `Response` 为结果，拿不到底层 socket；而 Node 档下 `@hono/node-ws` 本来也是
 * `ws` 的一层包装。这样分：协议逻辑可单测、换宿主只换这一个函数。
 *
 * 鉴权与 REST 完全同一套（`IdentityService.authenticate`）：
 * - 浏览器同源：HttpOnly 会话 cookie，握手请求自带；
 * - 其他调用方：`Sec-WebSocket-Protocol: agentsws.v1, agentsws.bearer.<token>`。
 *   **token 一次都不进 URL**（20 §3 / 21 §5：URL 会进历史、进代理日志、进 Referer）。
 */
function mountEventStream(input: {
  httpServer: ServerType
  deps: GatewayDeps
  cookieName: string
}): () => Promise<void> {
  const { deps, cookieName } = input
  const wss = new WebSocketServer({
    noServer: true,
    // 浏览器要求服务端回一个**它提过的**子协议，否则连接直接失败
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  })
  const timers = new Set<NodeJS.Timeout>()

  const deny = (socket: Duplex, status: number, text: string): void => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // `req.url` 只用来认路径；凭据不从这里读
    const path = (req.url ?? '').split('?')[0]
    if (path !== WS_PATH) return
    void (async () => {
      const { token } = parseSubprotocols(req.headers['sec-websocket-protocol'])
      const cookie = readCookie(
        Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie,
        cookieName,
      )
      const credential = token ?? cookie
      if (credential === undefined) return deny(socket, 401, 'Unauthorized')
      const principal = await deps.identity.authenticate(credential)
      if (!principal) return deny(socket, 401, 'Unauthorized')
      wss.handleUpgrade(req, socket, head, (ws) => {
        const session = new WsSession(deps, principal, {
          send: (text) => {
            if (ws.readyState === ws.OPEN) ws.send(text)
          },
          close: (code, reason) => {
            ws.close(code, reason)
          },
        })
        // 巡检：事件日志没有推送口，这里按固定间隔读增量（间隔进 CONTROL/ready，客户端知道）
        const timer = setInterval(() => {
          void session.pump()
        }, session.pollIntervalMs)
        timer.unref?.()
        timers.add(timer)
        ws.on('message', (raw: unknown) => {
          void session.handle(String(raw))
        })
        const stop = (): void => {
          clearInterval(timer)
          timers.delete(timer)
        }
        ws.on('close', stop)
        ws.on('error', stop)
      })
    })().catch(() => {
      deny(socket, 500, 'Internal Server Error')
    })
  }

  input.httpServer.on('upgrade', onUpgrade)
  return async () => {
    input.httpServer.off('upgrade', onUpgrade)
    for (const t of timers) clearInterval(t)
    timers.clear()
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve()
      })
    })
  }
}

export async function createServer(options: ServerOptions = {}): Promise<Server> {
  const env = options.env ?? process.env
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
  const random = options.random ?? seededRandom(Date.parse(clock.now()) % 2147483647)
  const dbDir = options.dbDir
  if (dbDir !== undefined) mkdirSync(dbDir, { recursive: true })
  const file = (name: string): string => (dbDir === undefined ? ':memory:' : join(dbDir, name))

  // 08 / 18：OpenConnector 的地址只在这一处解析（桌面壳读同名环境变量）
  const connectUrl = connectBaseUrl(env)

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

  // WP40 / 41 §2：大文件（会议录音、邮件附件）住对象存储——本地目录（默认，NAS 就是
  // 把它指到共享目录）或 S3 兼容（阿里 OSS / 腾讯 COS / R2 / MinIO）。
  // 加密接同一个主体密钥环：销毁一个主体的密钥，他的每一个对象当场读不出来（21 §4）。
  //
  // **内存档（没有 dbDir）不开对象存储**：那一档的意思就是「什么都不落盘」，
  // 开了它会在当前工作目录里长出一个 `blobs/`——测试跑一遍就在仓库根上留一堆文件。
  // 这一档下附件与录音仍在内存 store 里，与 WP40 之前一模一样。
  const blobs =
    dbDir === undefined
      ? undefined
      : await openBlobStore({
          clock,
          cipher: data.keyring,
          env,
          defaultRoot: join(dbDir, 'blobs'),
        })

  const knowledge = createKnowledge({ dbPath: file('knowledge.db'), clock })
  const skills = createSkills({ clock, random })

  // WP25：本机加密秘密库建**一次**，连接面（邮箱口令 / Shopify 应用密钥）与
  // 模型面（API key）共用同一个库，靠 key 前缀分开。谁建的谁关——这里建，这里关。
  const secrets = createSecretStore({ dbPath: file('secrets.sqlite'), clock, env })

  // 网关先按 stub 起来，`createModels` 装配好之后立刻 `reconfigure` 成真配置。
  // 之所以不在这里判断有没有 key：**有没有模型这件事现在由模型面说了算**
  // （加密库里的配置 + 环境变量兜底），不再是"看一个环境变量在不在"。
  const models = createModelGateway({
    providers: [stubProvider({ seed: 7 })],
    policy: { default: STUB_REF, data_residency: 'cn', prices: priceTable },
    clock,
    env,
    halt: kernel.halt,
    trace: kernel.trace,
    eventSink: (e) => {
      appendEvent(e)
    },
  })
  const modelSettings = createModels({
    clock,
    gateway: models,
    secrets,
    env,
    // WP42：价目刷新是一次普通出站 HTTP GET，照 28 §1 的 outbound 档管
    halt: kernel.halt,
    appendEvent: (e) => {
      appendEvent(e)
    },
    workspace_id: () => bootstrapWorkspace,
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(options.modelFetch === undefined ? {} : { fetch: options.modelFetch }),
    ...(options.pricingFetch === undefined ? {} : { pageFetch: options.pricingFetch }),
  })

  // 14 §7 升级链要问的两件事（范围管理者是谁 / owner 是谁）。取值函数，不是值——
  // 审批总线排在身份之前，owner 与工作区要等下面那一段装完才知道。
  let bootstrapOwner: PersonId | undefined
  let bootstrapWorkspace: WorkspaceId | undefined
  const approvalDirectory = createApprovalDirectory({
    roles,
    owner: () => bootstrapOwner,
    workspace_id: () => bootstrapWorkspace,
  })

  // 渠道排在 txn 之后装（它要 work / connections / startRun），但执行器的出站回调
  // 现在就要指向它——所以先留一个空壳引用，装到那一步再填。
  let channels: ChannelsAssembly | undefined

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
    directory: approvalDirectory,
    ...(txnStore === undefined ? {} : { store: txnStore }),
    eventSink: (e) => {
      appendEvent(e)
    },
    readRecord: (target) => backend.read(target),
    backendApply: (change, opts) => backend.apply(change, opts),
    // 18 §3：批准了的对外草稿真发出去。渠道接不住的（不是邮件 / 没装邮箱）
    // 才回落到内存桩——demo 与没连邮箱的机器照样跑得完整条链路。
    deliverOutbound: async (item, opts) =>
      (await channels?.deliver(item, opts)) ?? backend.deliver(item, opts),
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
  // 空壳填上：从这一刻起升级链知道该找谁（39 待办 A）
  bootstrapOwner = person.id
  bootstrapWorkspace = workspace.id

  const rawApprovals = mount?.approvals ?? txn.approvals
  // WP29 学习回路：技能库空着的话先铺一份自带技能（学到的东西得有段落可落），
  // 再把审批总线包一层——每张卡被决定之后抽 lesson，技能 / 知识类卡批了就施行。
  await seedDefaultSkill(skills, workspace.id)
  const learning = createLearningAssembly({
    workspace_id: workspace.id,
    clock,
    random,
    skills,
    knowledge,
    roles,
    approvals: rawApprovals,
    owner: person.id,
    ownerAssignment,
    appendEvent,
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  /**
   * 40 §2 工具箱：把定时任务、流程、技能投影成同一张卡片，供"建之前先查"与工具箱页用。
   *
   * 装在审批总线**之前**——它要包一层总线（晋升卡批准了才真的升层）。调度器与流程引擎
   * 要到后面才起来，所以那两个来源是惰性的：真正取值发生在请求到来时。
   */
  const catalog = createCatalogIndex({
    workspace_id: workspace.id,
    clock,
    ...(dbDir === undefined ? {} : { dbDir }),
    scheduler: () => schedule.scheduler,
    workflows: () => schedule.workflows,
    // 整个工作区的岗位（不是本人那几个）：算"哪些岗位在用"要全的
    positions: () =>
      roles.roles
        .list()
        .flatMap((r) => roles.assignments.listByRole(r.id, { workspace_id: workspace.id }))
        .filter((a) => a.revoked_at === undefined)
        .map((a) => ({
          id: a.id,
          person_id: a.person_id,
          role_id: a.role_id,
          skills: (roles.roles.get(a.role_id)?.skills ?? []).map((sk) => sk.name),
        })),
    skillNames: () => skills.registry.listSkillNames(),
    // 有人写过个人层 overlay 的技能算"个人副本"，其余算公司在用的
    skillOwner: (name) => {
      const personal = skills.registry
        .listOverlays(name)
        .find((o) => o.tier === 'personal' && o.ops.length > 0)
      return personal === undefined
        ? { owner: 'package' as PersonId, layer: 'company' as const }
        : { owner: String(personal.owner) as PersonId, layer: 'personal' as const }
    },
  })

  // 两层包装：学习回路先落 overlay / 知识卡，目录再看是不是一张晋升卡
  const approvals = catalog.wrap(learning.wrap(rawApprovals))
  // WP20 连接面：装配一次，`/v1/connections/*` 与工作台数据源共用同一份连接状态。
  const connections = await createConnections({
    clock,
    workspace_id: workspace.id,
    env,
    random,
    appendEvent,
    mailProbe: createMailProbe(),
    secrets,
    // WP27：巡检交给调度器（`connect.shopify_refresh`，到期前一小时换新）；
    // 这里默认不起 setInterval，除非调用方显式要旧行为
    refreshIntervalMs: options.tokenRefreshIntervalMs ?? 0,
    ...(options.shopifyFetch === undefined ? {} : { shopifyFetch: options.shopifyFetch }),
    ...(options.resolveMx === undefined ? {} : { resolveMx: options.resolveMx }),
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  // 36 §3：数据源接没接从真实连接算——连上 Shopify，首页数字块就不再是「去连接」。
  const workData = connections.wrapDataSource(mount?.data ?? emptyDataSource())

  // 17 §4：换运行时只换这一处。`startRun: false` = 这个进程不跑运行时（老行为）。
  const runtime: RuntimeAssembly | undefined =
    options.startRun === false || typeof options.startRun === 'function'
      ? undefined
      : createRuntime({
          workspace_id: workspace.id,
          clock,
          random,
          env,
          models,
          approvals,
          roles,
          appendEvent,
          // WP25：有没有模型问模型面（加密库里的配置 + 环境变量兜底），不再只看环境变量
          hasModel: () => modelSettings.configured(),
          modelRef: () => modelSettings.defaultRef(),
          // WP29：解析后的技能正文进 prompt——采纳过的 overlay 下一次运行就生效
          skills: skills.registry,
          ...(options.records === undefined ? {} : { source: options.records }),
        })
  const startRun = typeof options.startRun === 'function' ? options.startRun : runtime?.startRun

  const work = createWork({
    workspace_id: workspace.id,
    clock,
    random,
    tz_offset_minutes: workData.tz_offset_minutes,
    ...(workStore === undefined ? {} : { store: workStore }),
    ...(startRun === undefined ? {} : { startRun }),
    // WP35：待办 / 事项变化发一条摘要进同一条事件日志（WS 与工作台失效映射已就位）
    emit: appendEvent,
  })
  runtime?.bind(work)

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
    // 18 §2.1 受控原始材料区的第一条纪律：加密。密钥环是数据层的（21 §4，
    // 每主体一把独立随机密钥，销毁即不可读），录音库只拿这个端口——两个库不共享表（35 §2）。
    cipher: data.keyring,
    // WP40：录音与视频落对象存储，受控区里只留一句 `blob://…`（18 §2.1）
    ...(blobs === undefined ? {} : { blobs }),
  })
  // 37 §2.2b：会议处理完开一个 `meeting` 类事项，产出挂它的时间线上（要先有工作模型）
  meetings.bind(work)

  // demo：把三份合成会议跑完整管线，工作台上的会议页才有真产出可看
  if (mount !== undefined) {
    await seedDemoMeetings(meetings, {
      workspace_id: workspace.id,
      owner: person.id,
      position_id: ownerAssignment.id,
      clock,
    })
  }

  // ── 18 渠道：IMAP 轮询 + 入站管线 + 出站发信（39 待办 C）────────────────
  // 位置有讲究：要在 connections（拿邮箱参数与口令来源）、work（入站落成事项）、
  // runtime（起 Run）之后；在调度器之前，因为轮询是调度器的一个消费者。
  channels = createChannels({
    clock,
    workspace_id: workspace.id,
    appendEvent,
    halt: kernel.halt,
    // 18 §2.1 第一条纪律：受控原始材料区加密。与会议档共用同一个密钥环，
    // **但不共用它的表**（35 §2）。漏了这一行，邮件原文就是明文落盘。
    cipher: data.keyring,
    // WP40：附件字节落对象存储；邮件原文是文本，照旧留库加密
    ...(blobs === undefined ? {} : { blobs }),
    accounts: () => connections.mailAccounts(),
    credentials: connections.credentialSource(),
    work,
    // 入站事项挂谁名下：本人现在持有的第一条岗位（v1 单人单工作区）。
    // 每次取一次，不缓存——岗位撤销 / 新增之后下一封信就落到对的地方。
    position: () => {
      const first = roles.assignments
        .listByPerson(person.id, { workspace_id: workspace.id })
        .find((a) => a.revoked_at === undefined)
      return first === undefined
        ? undefined
        : { person_id: first.person_id, assignment_id: first.id, role_id: first.role_id }
    },
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(startRun === undefined ? {} : { startRun }),
    ...(options.mailSource === undefined ? {} : { makeSource: options.mailSource }),
    ...(options.mailer === undefined ? {} : { makeMailer: options.mailer }),
  })
  // 连接页新增 / 断开邮箱 → 下一轮轮询就换成新的那一份，不必重启
  connections.onMailChange(() => {
    channels?.refresh()
  })

  // 21 §4「删这个人」的跨库编排（39 待办 I）：数据层 + 邮件原始区 + 会议原始区
  const privacy = createPrivacyErase({
    workspace_id: workspace.id,
    clock,
    appendEvent,
    data,
    channels,
    meetings,
  })

  // WP40 / 41 §2.4：数据后端面。凭据进本机加密库（与连接面、模型面同一个库，
  // 靠 key 前缀分开）；`GET /v1/storage` 端出去的永远是脱敏后的描述。
  const storage = createStorage({
    clock,
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(blobs === undefined ? {} : { blobs }),
    secrets,
    env,
  })

  // ── 25 定时与流程：调度器 + 各个消费者 ───────────────────────────────
  // 装配的位置有讲究：要在 work / meetings / connections / skills 都起来之后，
  // 因为七个消费者就是它们；但在网关之前，因为 `/v1/schedules` 要用它。
  const schedule = createScheduleAssembly({
    workspace_id: workspace.id,
    clock,
    random,
    appendEvent,
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(options.scheduleIntervalMs === undefined ? {} : { intervalMs: options.scheduleIntervalMs }),
  })
  const scheduleTz = offsetToTz(workData.tz_offset_minutes)
  const positionsOf = (): SchedulePosition[] =>
    roles.assignments
      .listByPerson(person.id, { workspace_id: workspace.id })
      .filter((a) => a.revoked_at === undefined)
      .map((a) => ({ assignment_id: a.id, person_id: a.person_id, role_id: a.role_id }))
  const cardsOfPosition = async (p: SchedulePosition): Promise<ApprovalItem[]> =>
    (await approvals.queue({
      workspace_id: workspace.id,
      person_id: p.person_id,
      lane: 'mine',
      state: [...QUEUE_STATES],
    })) as ApprovalItem[]
  const planDeps = {
    workspace_id: workspace.id,
    work,
    approvals,
    positions: positionsOf,
    tz: scheduleTz,
    goals: async (p: SchedulePosition) =>
      work.progress(
        periodQueryRunner(
          () => workData.orders(),
          () => [],
          'USD',
        ),
        { position_id: p.assignment_id, status: ['active'] },
      ),
    cardsWaiting: async (p: SchedulePosition) =>
      (await cardsOfPosition(p)).filter((i) => WAITING_QUEUE_STATES.has(i.state)).length,
  }
  // ① 每日计划、② 复盘（day / week / month）、⑦ 复盘 → 次日计划草案的接力
  registerDailyPlan(schedule.scheduler, planDeps)
  const relay = registerPlanRelay({
    workspace_id: workspace.id,
    scheduler: schedule.scheduler,
    work,
    tz: scheduleTz,
  })
  registerReview(schedule.scheduler, {
    ...planDeps,
    cards: cardsOfPosition,
    lessons: () =>
      skills.lessons
        .list({ workspace_id: workspace.id, status: 'pooled' })
        .map((l) => ({ id: l.id, text: l.text })),
    relay: (review) => relay(review),
    // 40 §2.2：周复盘报"疑似重复"，并把过了 Wilson 门槛的好东西往上浮
    catalog: {
      duplicates: (limit) => catalog.duplicates(limit),
      proposePromotions: (deps, named) => catalog.proposePromotions(deps, named),
    },
  })
  // ③ 会议记录源轮询
  registerMeetingPoll(schedule.scheduler, {
    workspace_id: workspace.id,
    clock,
    meetings,
    actor: person.id,
  })
  // ④ 幂等表清理（内存档的那份归网关自己管，这里只扫落盘那份）
  if (idempotencyStore !== undefined) {
    registerIdempotencySweep(schedule.scheduler, { clock, store: idempotencyStore })
  }
  // ⑤ Shopify 令牌刷新：到期前一小时
  registerTokenRefresh({
    clock,
    scheduler: schedule.scheduler,
    refreshTokens: () => connections.refreshTokens(),
    expiries: () => connections.shopify.list().map((r) => r.expires_at),
  })
  // ⑥ 技能周合并
  registerSkillsWeekly(schedule.scheduler, {
    workspace_id: workspace.id,
    clock,
    weeklyConsolidate: (ws, now) => learning.weeklyConsolidate(ws, now),
  })
  // ⑧ 学习回路：每天 07:30 把昨天学到的整理成一张选择题卡
  registerLearning(schedule.scheduler, { clock, proposeDaily: (now) => learning.proposeDaily(now) })
  // ⑧ 审批过期与升级（39 待办 A）：模拟回路每 tick 调一次，真机器每分钟调一次。
  //    预占的「过期释放」也挂在这条上——15 §3.2 (d) 的释放是跟着审批项过期走的。
  registerApprovalHousekeeping(schedule.scheduler, { approvals })
  // ⑨ 邮箱轮询 + 入站管线的重试推进（39 待办 C）
  registerMailPoll(schedule.scheduler, { poll: () => (channels as ChannelsAssembly).poll() })
  // ⑩ 受控原始材料区的保留期（39 待办 H）：两个库各清各的，表不共享（35 §2）
  registerRawPrune(schedule.scheduler, {
    clock,
    // 保留天数进策略层：显式的 `raw_retention_days`（WP35 进契约），
    // 回落 WP34 用过的 `global_caps.raw_retention_days`，最后才是默认的 90 天
    retentionDays: () => {
      const policy = roles.policies.get(workspace.id)
      return (
        policy?.raw_retention_days ??
        policy?.global_caps?.raw_retention_days ??
        DEFAULT_RAW_RETENTION_DAYS
      )
    },
    channels: (retentionMs) => (channels as ChannelsAssembly).prune(retentionMs, clock.now()),
    meetings: (retentionMs, now) => meetings.raw.prune(retentionMs, now),
  })
  // ⑫ WP36 40 §1.3：每天一份备份。**只有落盘档有**——内存档没有可导的库文件。
  const runWorkspaceBackup = (): BackupRunResult => {
    if (dbDir === undefined) throw new Error('这个服务进程没有数据目录，没有可导的东西')
    return runBackup({
      dataDir: dbDir,
      workspace_id: workspace.id,
      outDir: backupDirOf(env, dbDir),
      clock,
      keep: backupKeepOf(env),
      release: env.AGENTSWS_VERSION ?? '0.1.0',
    })
  }
  if (dbDir !== undefined) registerBackup(schedule.scheduler, { run: runWorkspaceBackup })

  // WP42：每周一 05:00 去各家官网看一眼模型价（抓不到就保留内置价，不算失败）
  registerPricingRefresh(schedule.scheduler, {
    run: async () => {
      const result = await modelSettings.port.refreshPricing({
        workspace_id: workspace.id,
        person_id: person.id,
        assignment_id: ownerAssignment.id,
        role_id: ownerAssignment.role_id,
      })
      return { vendors: result.vendors, updated_providers: result.updated_providers }
    },
  })

  await ensureSystemTasks(schedule.scheduler, {
    workspace_id: workspace.id,
    owner: person.id,
    role_id: ownerAssignment.role_id,
    assignment_id: ownerAssignment.id,
    tz: scheduleTz,
    positions: positionsOf(),
    has: {
      work: true,
      meetings: true,
      idempotency: idempotencyStore !== undefined,
      shopify: true,
      skills: true,
      learning: true,
      approvals: true,
      mail: true,
      raw: true,
      backup: dbDir !== undefined,
      pricing: true,
    },
  })

  // ── 15 §5.8：备份恢复后先对账再放开出站（39 待办 B）─────────────────
  // 这一步要**排在网关之前**：`/v1/health` 要端出 reconcile 那一格；
  // 而 `engage()` 里挂的 outbound 档要在进程开始接活之前就生效。
  const reconcile = createReconcileGuard({
    clock,
    halt: kernel.halt,
    txn,
    workspace_id: workspace.id,
    appendEvent,
    verify: options.verifyChange ?? ((change) => backend.verify(change)),
  })
  reconcile.engage()

  const rolesPort: RolesPort = {
    can: (id, domain, op, request) => roles.can(id, domain, op, request),
    effectiveConfig: (id) => roles.effectiveConfig(id),
    getAssignment: (id) => roles.assignments.get(id),
    listAssignments: (person_id, filter) => roles.assignments.listByPerson(person_id, filter ?? {}),
  }

  // WP28 制度面：职责 / 岗位 / 分配 / 策略层 / 成员与邀请（业务全在 ./org.ts，这里只装配）
  const org = createOrg({
    clock,
    identity,
    roles,
    approvals,
    workspace_id: workspace.id,
    appendEvent,
    ...(dbDir === undefined ? {} : { dbDir }),
  })

  // WP36 离职编排（40 §1.2）：装在 org 之后——它要撤分配、真转事项、动个人层与个人记忆。
  const offboard = createOffboard({
    workspace_id: workspace.id,
    clock,
    appendEvent,
    identity,
    roles,
    approvals,
    work,
    skills: skills.registry,
    lessons: learning.learning.pool,
    memory: knowledge.memory,
    schedule: schedule.store,
    ...(dbDir === undefined ? {} : { dbDir }),
  })

  const knowledgePort: KnowledgePort = {
    search: (q) => knowledge.retrieval.search(q),
    cards: (filter, actor) => knowledge.store.list(filter, actor),
    card: (id, actor) => knowledge.store.get(id, actor),
    health: (workspace_id) => knowledge.store.health(workspace_id),
    // WP33 / 19 §3：引用计数
    cite: (_actor, fact_card_id, run_id) => knowledge.retrieval.cite(fact_card_id, run_id),
    // WP35：19 §1.3 导入源与 §4 缺口队列有表了（`knowledge.intake`），四条路由不再 501
    sources: (actor) => knowledge.intake.sources(actor.workspace_id),
    addSource: (actor, input) =>
      knowledge.intake.addSource({ ...input, workspace_id: actor.workspace_id }),
    gaps: (actor, filter) => knowledge.intake.gaps(actor.workspace_id, filter),
    openGap: (actor, input) =>
      knowledge.intake.openGap({
        ...input,
        workspace_id: actor.workspace_id,
        asked_by: { kind: 'person', id: actor.person_id },
      }),
    // 19 §4：答案**不直接进知识库**，先变一张 knowledge_update 卡（批了才由 learning 施行）
    answerGap: async (actor, id, input) => {
      const gap = knowledge.intake.requireGap(id)
      const card = await approvals.create({
        workspace_id: actor.workspace_id,
        schema_version: 1,
        kind: 'knowledge_update',
        role_id: actor.role_id,
        subject: { object: { type: 'knowledge_gap', id: gap.id } },
        dedupe_key: `${actor.workspace_id}:knowledge_update:gap:${gap.id}`,
        title: `补一条知识：${gap.question.slice(0, 40)}`,
        summary: '有人答了缺口队列里的一条。批准后写进知识库并激活（19 §4）。',
        payload: {
          layer: input.layer ?? 'fact',
          statement: input.answer,
          candidate_key: gap.subject.key,
          gap_id: gap.id,
        },
        evidence: {
          source_events: [],
          provenance: { seen: [{ type: 'knowledge_gap', id: gap.id }] },
          diff: { before: null, after: input.answer, summary: '知识库新增一条' },
          precheck: {},
        },
        proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
        automation: { level_at_creation: 'L1' },
        routing: {
          recipients: [{ person: actor.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 72,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
      })
      return knowledge.intake.answerGap(id, {
        answer: input.answer,
        by: actor.person_id,
        ...(card.state === 'blocked' ? {} : { approval_item_id: card.id }),
      })
    },
  }

  const skillsPort: SkillsPort = {
    resolve: (name, actor) => skills.registry.resolve(name, actor),
    setOverlay: (overlay) => skills.registry.setOverlay(overlay),
    // WP29：池的真源是学习回路那一份（`skills.lessons` 是 WP6 的内存池，只留给周合并的老接口）
    lessons: (filter) => learning.lessons(filter),
    // WP29 技能页与学习回路
    list: (actor) => learning.summaries(actor),
    exclude: (name, person_id, excluded) => skills.registry.exclude(name, person_id, excluded),
    proposals: () => learning.proposalSummaries(),
    promote: (input) =>
      learning.promote({
        skill: input.skill,
        section_ids: input.section_ids,
        to_tier: input.to_tier,
        by: input.actor.person_id,
      }),
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

  // 21 §1：读是合一的那一条（服务进程 + 接进来的世界）；写只写自己的
  const merged = mergeEventLogs(kernel.eventLog, mount?.eventLog)
  const eventLogPort: EventLogPort = {
    read: (filter) => merged.read(filter),
    append: appendEvent,
  }

  // 13 §5 浏览器会话：桌面壳生成、经环境变量交给服务进程；不设就没有 cookie 那条路
  const sessionKey = env.AGENTSWS_SESSION_KEY?.trim() === '' ? undefined : env.AGENTSWS_SESSION_KEY
  let boundPort: number | undefined

  /**
   * 41 §1 秘书 Agent。装在最后：它要用到工作模型、会议、工具箱、审批总线与调度器，
   * 自己不被任何人依赖——秘书是**加分项**，拆掉它工作台照常能用。
   */
  const secretary = createSecretaryAssembly({
    workspace_id: workspace.id,
    clock,
    random,
    appendEvent,
    tz_offset_minutes: workData.tz_offset_minutes,
    ...(dbDir === undefined ? {} : { dbDir }),
    identity: {
      members: (ws) => identity.members(ws),
      getPerson: (id) => identity.getPerson(id),
    },
    roles,
    work,
    approvals,
    meetings: {
      list: (filter) => meetings.store.listMeetings(filter),
      get: (id) => meetings.store.getMeeting(id),
      create: (input) => meetings.store.createMeeting(input),
    },
    catalog: catalog.port,
    // 25：本人的定时任务也占日程（37 §2 表第四行）
    scheduledTasks: (person_id) =>
      schedule.scheduler
        .list({ workspace_id: workspace.id, owner: person_id })
        // 还没算出下一次触发时刻的（暂停 / 一次性已跑完）不占日程
        .flatMap((t) =>
          t.next_fire_at === undefined
            ? []
            : [
                {
                  id: t.id,
                  state: t.state,
                  next_fire_at: t.next_fire_at,
                  ...(t.title === undefined ? {} : { title: t.title }),
                  assignment_id: t.assignment_id,
                },
              ],
        ),
  })

  const deps: GatewayDeps = {
    identity,
    halt: kernel.halt,
    trace: kernel.trace,
    clock,
    eventLog: eventLogPort,
    modules: kernel.modules,
    reconcile,
    approvals,
    changes: txn.ledger,
    guardrails,
    knowledge: knowledgePort,
    skills: skillsPort,
    roles: rolesPort,
    meetings: meetings.port,
    connections: connections.port,
    // WP31：本机秘密库的密钥轮换（owner）。密钥只在请求体里出现一次，
    // 网关这一层不碰库、也不碰值，只把「换了几条」端出去。
    secrets: {
      available: () => secrets.available,
      rotate: (new_key) => {
        try {
          return secrets.rotate(new_key)
        } catch (err) {
          // 秘密库的错误码翻成网关的错误信封；**原文里没有密钥**（见 secret-store.ts）
          if (err instanceof SecretStoreError)
            throw new ApiError(
              err.code === 'key_missing' ? 'not_implemented' : 'invalid_input',
              err.message,
            )
          throw err
        }
      },
    },
    models: modelSettings.port,
    // WP40 数据后端（41 §2.4 的三档与迁移向导）
    storage: storage.port,
    org: org.port,
    // 41 §1 秘书面：`/v1/me/profile`、`/v1/people/:id/ask`、`/v1/people/:id/meet`、`/v1/me/secretary/route`
    secretary: secretary.port,
    // 36 §3 问 AI：单轮、只回给本人、不落任何对客户可见的地方
    ask: createAskPort({
      models,
      work,
      roles,
      appendEvent,
      label: (ref) => workData.label(ref),
      card: async (actor, id) => {
        const items = (await approvals.queue({
          workspace_id: actor.workspace_id,
          person_id: actor.person_id,
          lane: 'mine',
        })) as ApprovalItem[]
        return items.find((i) => i.id === id)
      },
    }),
    // 25 §5 定时与流程面
    schedules: createSchedulePort({
      workspace_id: workspace.id,
      scheduler: schedule.scheduler,
      workflows: schedule.workflows,
      approvals,
      assignmentOf: (id) => {
        const found = roles.assignments.get(id)
        return found === undefined || found.workspace_id !== workspace.id
          ? undefined
          : { person_id: found.person_id, role_id: found.role_id }
      },
    }),
    // 21 §4「删这个人」：网关只转发，编排在 ./erase.ts；actor 带上 grants 与 ranges，
    // 因为数据层的删除同样要过 21 §3 的授权（没给删除开后门）
    privacy: {
      erase: async (input, actor) => {
        const config = roles.effectiveConfig(actor.assignment_id)
        return privacy.erase(input, {
          person_id: actor.person_id,
          assignment_id: actor.assignment_id,
          workspace_id: actor.workspace_id,
          grants: config.scopes,
          ranges: config.ranges,
        })
      },
    },
    // 40 §2 工具箱与查重；五个"建"的入口经 `guardSimilar` 用同一份判定
    catalog: {
      ...catalog.port,
      // 复盘卡 / 工具箱上那个"合并"：出一张 policy_change 卡，批了才合
      merge: (input) =>
        catalog.proposeMerge({
          approvals,
          owner: person.id,
          role_id: ownerAssignment.role_id,
          keep: input.keep,
          drop: input.drop,
          by: input.by,
        }),
    },
    // WP36 40 §1.2：离职是一个正式动作。网关只转发，编排在 ./offboard.ts；
    // 三条路由都是 owner 级（动别人的分配、别人的个人数据、公司技能层）
    offboard: {
      offboard: (actor, person_id, input) =>
        offboard.offboard(
          {
            person_id,
            ...(input.handover_to === undefined ? {} : { handover_to: input.handover_to }),
            ...(input.personal_layer === undefined ? {} : { personal_layer: input.personal_layer }),
            ...(input.memory === undefined ? {} : { memory: input.memory }),
          },
          actor.person_id,
        ),
      archivedSkills: (_actor, owner) => offboard.archivedSkills(owner),
      adopt: (actor, input) =>
        offboard.adopt(
          {
            skill: input.skill,
            owner: input.owner,
            to_tier: input.to_tier,
            ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
          },
          { person_id: actor.person_id, role_id: actor.role_id },
        ),
    },
    // WP36 40 §1.3 备份：网关只转发；路径由服务端定（owner 也不能指定往哪写）
    ...(dbDir === undefined
      ? {}
      : {
          backup: {
            export: async (_actor, input) => {
              const out = runBackup({
                dataDir: dbDir,
                workspace_id: workspace.id,
                outDir: backupDirOf(env, dbDir),
                clock,
                keep: input.keep ?? backupKeepOf(env),
                release: env.AGENTSWS_VERSION ?? '0.1.0',
              })
              return {
                out: out.out,
                bytes: out.bytes,
                events: out.events,
                kept: out.kept,
                pruned: out.pruned,
                at: clock.now(),
              }
            },
          },
        }),
    workstation: createWorkstationPort({ clock, roles, approvals, data: workData }),
    work: createWorkPort({
      clock,
      work,
      // 37 §2 表第三行：会议一定有时间，一定上日历
      meetings: (actor, range) => meetings.calendarItems(range, actor.workspace_id),
      /**
       * 只给本人这条队列里的卡（14 §7：别人的 token 与内容不出现在这里）。
       *
       * 状态要全的——`queue` 默认只回 pending / in_review，而今日战报数的正是
       * 「今天**已经**处理掉的」（37 §1 第 9 行）。等待类的计数在 work 端自己过滤，
       * 所以这里放全不会把「还有几张等你定」算多。
       */
      approvals: (actor) =>
        approvals.queue({
          workspace_id: actor.workspace_id,
          person_id: actor.person_id,
          lane: 'mine',
          state: [...QUEUE_STATES],
        }) as Promise<ApprovalItem[]>,
      orders: () => workData.orders(),
      label: (ref) => workData.label(ref),
      // 40 §2.2：周 / 月复盘里那一段"疑似重复"
      duplicates: async () =>
        (await catalog.duplicates(5)).map((d) => ({
          a: { id: d.a.id, title: d.a.title, owner: d.a.owner, kind: d.a.kind },
          b: { id: d.b.id, title: d.b.title, owner: d.b.owner, kind: d.b.kind },
          similarity: d.similarity,
          both_in_use: d.both_in_use,
          reasons: d.reasons,
        })),
    }),
    traceScope,
    options: {
      version: env.AGENTSWS_VERSION ?? '0.1.0',
      ...(idempotencyStore === undefined ? {} : { idempotencyStore }),
      // 本地单机档：一次性登录 token 直接回给调用方，工作台才能自动登录（20 §3）
      exposeMagicLinkToken: true,
      // 13 §5：桌面壳靠 pid / port 认出「这个 sidecar 就是我起的那个」
      instance: { pid: process.pid, port: () => boundPort },
      // 13 §5：配了会话密钥就开 cookie 那条路（`POST /v1/auth/session`）
      ...(sessionKey === undefined ? {} : { sessionKey }),
      sessionOwnerEmail: person.email,
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
  let unmountWs: (() => Promise<void>) | undefined
  let closed = false

  const server: Server = {
    gateway,
    connectUrl,
    kernel,
    data,
    roles,
    knowledge,
    skills,
    learning,
    models,
    txn,
    work,
    meetings,
    connections,
    channels,
    modelSettings,
    org,
    secretary,
    offboard,
    secrets,
    schedule,
    reconcile,
    ...(runtime === undefined ? {} : { runtime }),
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
        const s = serve({ fetch: gateway.fetch, port: wanted, hostname: bindHost(env) }, () => {
          resolve(s)
        })
      })
      httpServer = started
      // 15 §5.8：接活之前先把账对完。`engage()` 已经在装配时把出站闸拉下来了，
      // 这里是慢的那一半（要查外部系统）；查不清的留成人工对账项，出站保持停着。
      await reconcile.run()
      // WP33：WebSocket 事件流挂在同一个端口的 upgrade 上（28 §2 唯一入口）
      unmountWs = mountEventStream({
        httpServer: started,
        deps,
        cookieName: deps.options?.sessionCookieName ?? SESSION_COOKIE,
      })
      // 25 §4：进程真的起来了才开始巡检（测试里 `scheduleIntervalMs: 0` 关掉）
      schedule.start()
      const address = started.address()
      const bound = typeof address === 'object' && address !== null ? address.port : wanted
      boundPort = bound
      const url = `http://${HOST}:${bound}`
      server.url = url
      if (options.quiet !== true) {
        // 开发期：健康检查地址与内部凭据只在 stdout 出现一次（21 §5：不进事件日志）。
        process.stdout.write(`agentsws server listening on ${url}\n`)
        process.stdout.write(`health: ${url}/v1/health\n`)
        process.stdout.write(`workspace: ${workspace.id}  owner: ${person.email}\n`)
        process.stdout.write(
          `internal token: ${internalToken.slice(0, 8)}…（已遮罩；完整值只在进程内）\n`,
        )
      }
      return { url, port: bound }
    },
    async close() {
      if (closed) return
      closed = true
      if (unmountWs) {
        // 先把 WS 收掉：否则还开着的连接会让 http.Server 的 close 一直挂着
        await unmountWs()
        unmountWs = undefined
      }
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer?.close((err) => (err ? reject(err) : resolve()))
        })
        httpServer = undefined
      }
      learning.close()
      knowledge.close()
      data.close()
      // 接进来的世界由调用方关（它还持有事件日志与替身）
      if (options.mount === undefined) roles.close()
      meetings.close()
      schedule.close()
      catalog.close()
      secretary.close()
      await channels?.close()
      connections.close()
      org.close()
      offboard.close()
      secrets.close()
      txnStore?.close()
      workStore?.close()
      idempotencyStore?.close()
      if (identity instanceof SqliteIdentityService) identity.close()
      await kernel.dispose()
    },
  }
  return server
}
