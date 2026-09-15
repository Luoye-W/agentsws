/**
 * 49 §6 WP60：把值守（`packages/standby`）挂进这个进程。
 *
 * 写法照着 `entry.ts` —— 值守路由包也有自己的一套鉴权（令牌 + `standby` 动作集）
 * 与错误码表（402 钱不够 / 422 包坏了 / 503 正在起），与账号层的 `CloudRoute` 形状不同。
 * 硬把两套拧成一种形状只会让"余额不足"与"令牌无效"共用一个码表。
 *
 * 这个文件负责三件"只有装配方知道"的事：
 *
 * 1. **子进程跑的是哪一份代码**：`@agentsws/server` 的 `dist/index.js`——
 *    与用户本地跑的是同一份（48 L6 的"同一时刻只有一个服务进程"靠这一条成立）。
 * 2. **包怎么校验**：`importWorkspace` / `exportWorkspace`（WP36 的 manifest +
 *    每文件 sha256 + zip crc）。`packages/standby` 自己不写第二套解包。
 * 3. **子进程那把云令牌怎么被服务入口认出来**：值守自己签、自己验
 *    （`ChildTokens`），这里把它与 WP58 的账号库验证器**串起来**交给
 *    `mountEntry`。串的顺序是"先账号库、后子进程"——商家那把是常态。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type {
  Clock,
  CloudTokenVerifier,
  Pricing,
  StandbyEvent,
  VerifiedCloudToken,
} from '@agentsws/contracts'
import type { Wallet } from '@agentsws/metering'
import {
  allocateLoopbackPort,
  baseChildEnv,
  ChildTokens,
  createFileKeyring,
  MemoryStandbyStore,
  MemoryTokenStore,
  mountStandbyRoutes,
  nodeFs,
  nodeSecrets,
  nodeSpawnAdapter,
  type SpawnLike,
  SqliteStandbyStore,
  SqliteTokenStore,
  type StandbyEnv,
  type StandbyPackager,
  StandbyService,
  type StandbyStore,
  type StandbyTokenStore,
} from '@agentsws/standby'
import type { Database } from 'better-sqlite3'
import type { Hono } from 'hono'
import type { CloudServer } from './server.js'

/** 值守子进程的数据目录挂在 `<AGENTSWS_CLOUD_DATA_DIR>/standby/<workspace_id>/` 底下。 */
export const STANDBY_SUBDIR = 'standby'

/** `tick()` 多久一拍：健康检查 + 退避重启 + 到期结算。 */
export const STANDBY_TICK_MS = 15_000

/** 联调用：给子进程多传几个环境变量（JSON）。**密钥类一律不从这里走。** */
export const STANDBY_CHILD_ENV = 'AGENTSWS_STANDBY_CHILD_ENV'

export interface MountStandbyOptions {
  env?: Record<string, string | undefined>
  clock?: Clock
  wallet: Wallet
  pricing: Pricing
  /** 云侧数据目录；不给就内存档（测试）。 */
  dataDir?: string
  /** 编排层的库；给了就不按 `dataDir` 开库（测试注入内存版）。 */
  store?: StandbyStore
  tokenStore?: StandbyTokenStore
  /** 测试注入假的 spawn / fetch → 全程不起真进程、不联网。 */
  spawn?: SpawnLike
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  /** 测试注入假的打包器（真的那份要读文件系统）。 */
  packager?: StandbyPackager
  /** `apps/server` 的 `dist/index.js`；不给就按 `@agentsws/server` 的包位置找。 */
  serverEntry?: string
  onEvent?: (event: StandbyEvent) => void
  /** 自动起 `tick()` 的定时器；`0` = 不起（测试手动调 `service.tick()`）。 */
  tickMs?: number
}

export interface MountedStandby {
  service: StandbyService
  /** 子进程那把令牌的验证器（装 `mountEntry` 时串在账号库验证器后面）。 */
  childTokens: ChildTokens
  /** 关掉定时器并把子进程一起带走。 */
  close(): Promise<void>
}

/** `@agentsws/server` 的 `dist/index.js` 在哪（不写死相对路径：装出来的形状不一定同一个）。 */
export function resolveServerEntry(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@agentsws/server')
  } catch {
    // 源码树里跑（还没 link）：退回仓库里的位置
    return join(dirname(new URL(import.meta.url).pathname), '../../server/dist/index.js')
  }
}

export function standbyRootOf(dataDir: string | undefined): string {
  return dataDir === undefined || dataDir.trim() === ''
    ? join(process.cwd(), '.agentsws-standby')
    : join(dataDir, STANDBY_SUBDIR)
}

/**
 * 真打包器：WP36 的导出 / 导入。
 *
 * `importWorkspace` 自己核 `manifest.json`、每个文件的 sha256、zip 的 crc，
 * 任意一处对不上就抛——**所以这里不需要再写一遍校验**，写第二遍只会有一遍是对的。
 *
 * 动态 import 是有意的：`apps/cloud` 不该在启动路径上把整个服务进程的依赖树拉进来，
 * 一个只跑账号与入口的云节点根本用不到它。
 */
export function nodePackager(clock: Clock): StandbyPackager {
  return {
    async importPackage(input) {
      const { importWorkspace } = await import('@agentsws/server')
      const result = await importWorkspace({
        pkg: input.zip,
        dataDir: input.dataDir,
        ...(input.force === undefined ? {} : { force: input.force }),
      })
      return { workspace_id: result.manifest.workspace_id, files: result.files_verified }
    },
    async exportPackage(input) {
      const { exportWorkspace } = await import('@agentsws/server')
      const result = exportWorkspace({
        dataDir: input.dataDir,
        workspace_id: input.workspace_id,
        out: input.out,
        clock,
      })
      return { out: result.out, bytes: result.bytes }
    },
  }
}

/** better-sqlite3 只在这一处出现（`packages/standby` 自己不依赖它）。 */
function openStandbyDb(path: string): Database {
  const require = createRequire(import.meta.url)
  const Ctor = require('better-sqlite3') as new (p: string) => Database
  const db = new Ctor(path)
  db.pragma('journal_mode = WAL')
  return db
}

/**
 * 串两个验证器：先问 WP58 的账号库（商家那把），再问值守自己的（子进程那把）。
 *
 * 顺序不是性能考虑，是语义：商家那把是常态，子进程那把是我们发给自己的内部令牌。
 * 两边都不认就 `undefined`——**不区分**是哪一边不认（不给探测口）。
 */
export function chainVerifiers(
  first: CloudTokenVerifier,
  second: (token: string) => Promise<VerifiedCloudToken | undefined>,
): CloudTokenVerifier {
  return async (token: string) => (await first(token)) ?? (await second(token))
}

/** 把值守挂到 `server.app` 上。 */
export function mountStandby(server: CloudServer, options: MountStandbyOptions): MountedStandby {
  const env = options.env ?? process.env
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
  const dataRoot = standbyRootOf(options.dataDir)
  const db =
    options.dataDir === undefined ||
    (options.store !== undefined && options.tokenStore !== undefined)
      ? undefined
      : openStandbyDb(join(options.dataDir, 'standby.sqlite'))
  const store =
    options.store ?? (db === undefined ? new MemoryStandbyStore() : new SqliteStandbyStore(db))
  const tokenStore =
    options.tokenStore ?? (db === undefined ? new MemoryTokenStore() : new SqliteTokenStore(db))

  const childTokens = new ChildTokens({
    store: tokenStore,
    secrets: nodeSecrets,
    now: () => clock.now(),
  })

  const childEnvRaw = env[STANDBY_CHILD_ENV]
  const service = new StandbyService({
    store,
    clock,
    spawn: options.spawn ?? nodeSpawnAdapter,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    keyring: createFileKeyring(),
    packager: options.packager ?? nodePackager(clock),
    fs: nodeFs,
    dataRoot,
    serverEntry: options.serverEntry ?? resolveServerEntry(),
    allocatePort: allocateLoopbackPort,
    // 跑子进程的那个 Node 就是跑云进程的这个（`spawn('node')` 要 PATH，而我们
    // 给子进程的是一份白名单 env——两件事凑在一起就会变成"找不到 node"）
    nodePath: process.execPath,
    cloudBaseUrl: server.baseUrl,
    childTokens,
    wallet: options.wallet,
    pricing: options.pricing,
    ...(options.onEvent === undefined
      ? {
          onEvent: (event: StandbyEvent) => {
            // 事件里只有类型、工作区、组织、时间——打出来也泄露不了什么（49 M6 同一条）
            process.stdout.write(`[standby] ${event.type} ws=${event.workspace_id}\n`)
          },
        }
      : { onEvent: options.onEvent }),
    childEnv: {
      ...baseChildEnv(env),
      ...(childEnvRaw === undefined ? {} : (JSON.parse(childEnvRaw) as Record<string, string>)),
    },
  })

  mountStandbyRoutes(server.app as unknown as Hono<StandbyEnv>, {
    service,
    verifier: server.verifyToken,
  })

  const tickMs = options.tickMs ?? STANDBY_TICK_MS
  let timer: ReturnType<typeof setInterval> | undefined
  if (tickMs > 0) {
    timer = setInterval(() => {
      void service.tick().catch(() => {
        // 一拍失败不该把云进程带走：下一拍再来
      })
    }, tickMs)
    timer.unref?.()
  }

  return {
    service,
    childTokens,
    async close() {
      if (timer !== undefined) clearInterval(timer)
      await service.close()
    },
  }
}
