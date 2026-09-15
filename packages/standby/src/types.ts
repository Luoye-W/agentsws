/**
 * 值守编排的装配面（49 §6 WP60、48 L6）。
 *
 * 这个包是**一个库 + 一个路由包，不是一个服务**：它只导出 `StandbyService` 与
 * `standbyRoutes(deps)`，由云侧那个进程（`apps/cloud`）挂上去——风格与 WP59 的
 * `packages/cloud-entry` 一样，合并时不会撞同一个文件。
 *
 * 一条纪律贯穿整个包：**编排层不认识租户的数据**。
 *
 * - 起进程用的库密钥由 {@link StandbyKeyring} 出，只经环境变量传一次，
 *   **不进 {@link StandbyStore}**（21「我们没有读数据的路径」）；
 * - 反向代理**不读、不记正文**（只看 method / path / 状态码）；
 * - 上传的包由 {@link StandbyPackager} 校验（WP36 的 manifest + 每个文件的 sha256 +
 *   zip 的 crc）**之后**才解包。
 */
import type {
  Clock,
  Iso8601,
  StandbyEvent,
  StandbyStatus,
  StandbyWorkspace,
  WorkspaceId,
} from '@agentsws/contracts'
import type { ChildTokens } from './child-token.js'

/** 打子进程 / 打上游用的 fetch（测试注入假的 → 全程不联网）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * 一个被拉起来的子进程。
 *
 * 形状刻意做薄：`child_process.spawn` 的返回值有几十个成员，编排层只用到三个。
 * 薄到这个程度，测试里那个假的才写得完（而写得完的假的才会被真的用起来）。
 */
export interface ChildHandle {
  pid?: number | undefined
  /** 送一个信号过去。已经退了就当没发生。 */
  kill(signal?: string): void
  /** 退出时调一次；`code` 为 null 表示被信号杀掉。 */
  onExit(listener: (code: number | null) => void): void
}

export interface SpawnOptions {
  env: Record<string, string>
  cwd?: string
}

/** `child_process.spawn` 的那一跳，写成一个函数——于是测试能换掉它。 */
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildHandle

/**
 * 每个租户一把库密钥。
 *
 * **不在 {@link StandbyStore} 里**。默认实现把它写在租户自己的数据目录下
 * （`<dataDir>/tenant.key`，0600），理由见 `keyring.ts` 的头注释：
 * 云进程重启之后拿不回密钥 = 这个租户的数据永久读不出来，那比"少一层隔离"糟得多。
 */
export interface StandbyKeyring {
  /** 取（没有就生成一把）。同一个工作区每次都是同一把。 */
  keyFor(workspace_id: WorkspaceId, dataDir: string): string
}

/** 导入 / 导出一个工作区包（WP36 的格式）。校验不过就抛，**半个目录都不留**。 */
export interface StandbyPackager {
  importPackage(input: {
    zip: string
    dataDir: string
    force?: boolean
  }): Promise<{ workspace_id: WorkspaceId; files: number }>
  exportPackage(input: {
    dataDir: string
    workspace_id: WorkspaceId
    out: string
  }): Promise<{ out: string; bytes: number }>
}

/** 一个用完就扔的临时文件。`dispose()` 连它独占的那个临时目录一起删。 */
export interface TempFile {
  path: string
  dispose(): void
}

/** 目录与文件那一点点事（测试注入内存档）。 */
export interface StandbyFs {
  mkdir(path: string): void
  exists(path: string): boolean
  /** 目录里有没有东西（判"这个租户的数据在不在"）。 */
  isEmptyDir(path: string): boolean
  /** 造一个自己独占目录的临时文件（上传的包落在这儿，校验完就扔）。 */
  writeTemp(name: string, bytes: Uint8Array): TempFile
  readFile(path: string): Uint8Array
}

/** 库里的一行：契约那份再加上编排自己要记的几格。 */
export interface StandbyRecord extends StandbyWorkspace {
  /** 谁开的这个值守（云账号）。子进程那把令牌代表的就是他。 */
  owner_account_id: string
  created_at: Iso8601
  /** 连着崩了几次（退避用；起成功一次就清零）。 */
  restarts: number
  /** 到这个点之后才允许再拉起来（崩溃退避）。 */
  restart_at?: Iso8601
  /** 最近一次停 / 崩的原因（人话，不含标识符）。 */
  reason?: string
  /** 这一期的续费提醒发过没有（发过就不再发第二遍）。 */
  renewal_notified_at?: Iso8601
}

/**
 * 子进程那把云令牌的库。
 *
 * **与 WP58 的 `workspace_links` 是两张表**，这一条是有意的：那张表上有一条不变量
 * ——"一个工作区同时只能有一条活着的关联"（一个工作区的钱只能从一个地方出）。
 * 为子进程再签一条关联就破了它。子进程那把是**我们发给自己的**内部令牌，
 * 动作集只有 `ai` + `wallet:read`，所以它归值守自己管。
 *
 * 库里只有 sha256（21 §5 秘密不落库），明文只在签发那一刻返回一次。
 */
export interface StandbyTokenStore {
  put(row: ChildTokenRow): void
  bySha256(sha256: string): ChildTokenRow | undefined
  /** 这个工作区之前那几把一律作废（重拉 = 换一把新的）。 */
  revokeAllOf(workspace_id: WorkspaceId, at: Iso8601): void
}

export interface ChildTokenRow {
  sha256: string
  workspace_id: WorkspaceId
  org_id: string
  account_id: string
  issued_at: Iso8601
  expires_at: Iso8601
  revoked_at?: Iso8601
}

/** 随机与哈希那一跳（`node:crypto` 只在 `node-host.ts` 出现一次）。 */
export interface StandbySecrets {
  /** 一把新的令牌明文（`wst_…`）。 */
  newToken(): string
  sha256(value: string): string
}

/** 编排层的库。两份实现：内存（测试）与 sqlite（云上）。 */
export interface StandbyStore {
  get(workspace_id: WorkspaceId): StandbyRecord | undefined
  /** 不给 `org_id` 就是全部（`tick()` 要遍历）。 */
  list(org_id?: string): StandbyRecord[]
  put(record: StandbyRecord): void
  close?(): void
}

export interface StandbyDeps {
  store: StandbyStore
  clock: Clock
  spawn: SpawnLike
  fetch: FetchLike
  keyring: StandbyKeyring
  packager: StandbyPackager
  fs: StandbyFs
  /** 每个值守工作区的数据目录挂在它底下（`<root>/<workspace_id>/`）。 */
  dataRoot: string
  /** `node`（或别的 Node 可执行）。 */
  nodePath?: string
  /** `apps/server` 的 `dist/index.js`——**同一个** `apps/server`，不是另写一个。 */
  serverEntry: string
  /** 分一个本机回环端口出来（真实现要 listen(0) 问系统要，所以是异步的）。 */
  allocatePort: () => Promise<number>
  /** 子进程那把云令牌（签发与验证都在 `child-token.ts`）。 */
  childTokens: ChildTokens
  /** 云自己的对外地址（子进程的模型 provider 指回来）。 */
  cloudBaseUrl: string
  /** 值守事件（起来了 / 停了 / 快到期了）。**不含正文、不含端口、不含密钥。** */
  onEvent?: (event: StandbyEvent) => void
  /** 传给子进程的额外环境变量（联调用；密钥类一律不从这里走）。 */
  childEnv?: Record<string, string>
}

export type StandbyErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'insufficient_credits'
  | 'corrupt_package'
  | 'unavailable'
  | 'internal'

export const STANDBY_STATUS: Record<StandbyErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  // 402 Payment Required：钱不够开不了值守
  insufficient_credits: 402,
  // 422：包坏了不是"你没权限"也不是"服务器错了"，是这一份东西本身不能用
  corrupt_package: 422,
  unavailable: 503,
  internal: 500,
}

export class StandbyError extends Error {
  readonly code: StandbyErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: StandbyErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = 'StandbyError'
    this.code = code
    this.status = options.status ?? STANDBY_STATUS[code]
    this.details = options.details
  }
}

/**
 * 工作区 id 会被拼进文件路径，所以先把它钉死：字母数字加 `_ - . :`，最长 64。
 *
 * 不是"过滤掉 `..`"而是"只认这一串"——黑名单永远少一条，白名单只有一条。
 */
export const WORKSPACE_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/

export function assertWorkspaceId(id: string): WorkspaceId {
  if (!WORKSPACE_ID_RE.test(id) || id.includes('..'))
    throw new StandbyError('invalid_input', `不是一个工作区 id：${id}`)
  return id
}

/** 状态机上"应该在跑"的那两格。 */
export function shouldRun(status: StandbyStatus): boolean {
  return status === 'running' || status === 'starting'
}
