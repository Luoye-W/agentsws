/**
 * 进程池（49 §6 WP60 / 48 L6）：一个值守工作区 = 一个 `apps/server` 子进程。
 *
 * **同一个 `apps/server`，不是另写一个**。云上跑的就是用户本地那个服务进程的同一份
 * `dist/index.js`，只是数据目录、端口、库密钥各一份。这条是 48 L6「同一时刻只有一个
 * 服务进程」能成立的全部理由：如果云上跑的是另一套代码，那"搬家"就不是搬家，
 * 是迁移到另一个产品。
 *
 * 四件事：
 *
 * | 事 | 怎么做 | 为什么这么做 |
 * |---|---|---|
 * | 起 | 分一个回环端口 → 取租户密钥 → 签一把云令牌 → `spawn` | 密钥只经环境变量传一次，不落库不落日志 |
 * | 健康 | `GET /v1/health`，过了才 `running` | 进程起来 ≠ 能接活（第一次要建库、跑迁移） |
 * | 崩 | 记 `restart_at = now + 退避`，`tick()` 到点重拉 | 退避是给"起不来"的那种崩留的：一秒重拉一次等于把日志刷爆、把 CPU 占满 |
 * | 停 | SIGTERM → 状态 `stopped`，**不删数据** | 停了还能导出（41 §2.3：随时搬家） |
 *
 * 时间**不自己走**：没有 `setInterval`、没有 `Date.now()`。`tick()` 由装配方按
 * 节奏调（云上是一个 interval，测试里是手动调一次），于是"崩了 8 秒之后重拉"
 * 这种事在测试里是一行 `clock.advance(8000)` 而不是一次真的等待。
 */
import type { StandbyEvent, WorkspaceId } from '@agentsws/contracts'
import {
  assertWorkspaceId,
  type ChildHandle,
  type StandbyDeps,
  StandbyError,
  type StandbyRecord,
} from './types.js'

/** 崩溃退避的台阶（毫秒）。连着崩就往后退，退到 5 分钟封顶。 */
export const BACKOFF_MS = [1_000, 5_000, 15_000, 60_000, 300_000] as const

/** 健康检查的超时：子进程在同一台机器上，一秒不回基本就是没起来。 */
export const HEALTH_TIMEOUT_MS = 2_000

export function backoffMs(restarts: number): number {
  const index = Math.min(Math.max(restarts, 1), BACKOFF_MS.length) - 1
  return BACKOFF_MS[index] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 300_000
}

function plusMs(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString()
}

/**
 * 进程池。`StandbyService` 拿着它，路由拿着 `StandbyService`。
 *
 * 拆成两层是因为它们的失败模式不一样：进程起不来是运维问题（重试、退避、告警），
 * 钱不够是产品问题（一句人话 + 402）。混在一个类里，迟早会出现"余额不足所以退避重启"。
 */
export class ProcessPool {
  private readonly deps: StandbyDeps
  /** 活着的子进程。**只在内存里**——云进程重启后靠 `tick()` 按库里的状态重新拉起来。 */
  private readonly children = new Map<string, ChildHandle>()
  /** 我们自己要求它退出的那几个（`exit` 来了不要当成崩溃）。 */
  private readonly intentional = new Set<string>()

  constructor(deps: StandbyDeps) {
    this.deps = deps
  }

  private now(): string {
    return this.deps.clock.now()
  }

  private emit(event: StandbyEvent): void {
    this.deps.onEvent?.(event)
  }

  dataDirOf(workspace_id: WorkspaceId): string {
    return `${this.deps.dataRoot.replace(/\/+$/, '')}/${assertWorkspaceId(workspace_id)}`
  }

  /** 这个工作区现在有没有一个活着的子进程。 */
  isLive(workspace_id: WorkspaceId): boolean {
    return this.children.has(workspace_id)
  }

  /**
   * 拉起来。
   *
   * 已经在跑就原样返回（幂等：`tick()` 会反复调它）。密钥与令牌**只在这个函数的
   * 局部变量里出现一次**，进了 `env` 对象之后没人再引用它们。
   */
  async start(record: StandbyRecord): Promise<StandbyRecord> {
    const id = assertWorkspaceId(record.workspace_id)
    if (this.children.has(id)) return record
    const dataDir = this.dataDirOf(id)
    this.deps.fs.mkdir(dataDir)
    const port = await this.deps.allocatePort()
    // 21 按租户加密：这一把只属于这个租户，编排层的库里没有它
    const key = this.deps.keyring.keyFor(id, dataDir)
    // 49 M2：子进程的模型走 agentsws_cloud provider，凭据是这一把 ai + wallet:read 的令牌。
    // 每次重拉换一把新的，旧的当场作废（`child-token.ts`）
    const token = this.deps.childTokens.issue({
      workspace_id: id,
      org_id: record.org_id,
      account_id: record.owner_account_id,
    })
    const env: Record<string, string> = {
      ...(this.deps.childEnv ?? {}),
      AGENTSWS_DATA_DIR: dataDir,
      AGENTSWS_PORT: String(port),
      // 子进程只监听回环；公网进来的一律走云进程那层反向代理
      AGENTSWS_BIND_HOST: '127.0.0.1',
      AGENTSWS_DATA_KEY: key,
      AGENTSWS_SECRETS_KEY: key,
      AGENTSWS_CLOUD_BASE_URL: this.deps.cloudBaseUrl,
      AGENTSWS_CLOUD_WORKSPACE_TOKEN: token,
      // 公网入口在云进程那一层；子进程要知道自己对外长什么样（回调、widget 地址）
      AGENTSWS_PUBLIC_BASE_URL: `${this.deps.cloudBaseUrl.replace(/\/+$/, '')}/w/${id}`,
      AGENTSWS_WORKSPACE_ID: id,
    }
    const child = this.deps.spawn(this.deps.nodePath ?? 'node', [this.deps.serverEntry], { env })
    this.children.set(id, child)
    this.intentional.delete(id)
    child.onExit((code) => {
      this.onExit(id, code)
    })
    const next: StandbyRecord = { ...record, status: 'starting', port }
    delete next.restart_at
    delete next.reason
    this.deps.store.put(next)
    this.emit({
      type: 'standby.started',
      workspace_id: id,
      org_id: record.org_id,
      at: this.now(),
    })
    return next
  }

  /** 我们自己要它停（用户点了停 / 到期了 / 云进程要关）。**不删数据。** */
  stop(workspace_id: WorkspaceId, reason: string, status: 'stopped' | 'expired' = 'stopped'): void {
    const id = assertWorkspaceId(workspace_id)
    const child = this.children.get(id)
    if (child !== undefined) {
      this.intentional.add(id)
      child.kill('SIGTERM')
      this.children.delete(id)
    }
    const record = this.deps.store.get(id)
    if (record === undefined) return
    const next: StandbyRecord = { ...record, status, reason, restarts: 0 }
    delete next.port
    delete next.restart_at
    this.deps.store.put(next)
    this.emit({
      type: 'standby.stopped',
      workspace_id: id,
      org_id: record.org_id,
      at: this.now(),
      reason,
    })
  }

  /** 子进程自己退了。我们要它退的就当没事，否则记一次退避。 */
  private onExit(workspace_id: WorkspaceId, code: number | null): void {
    this.children.delete(workspace_id)
    if (this.intentional.delete(workspace_id)) return
    const record = this.deps.store.get(workspace_id)
    if (record === undefined) return
    if (record.status === 'expired' || record.status === 'stopped') return
    const restarts = record.restarts + 1
    const at = this.now()
    const next: StandbyRecord = {
      ...record,
      status: 'stopped',
      restarts,
      restart_at: plusMs(at, backoffMs(restarts)),
      reason: `进程退出（code ${code === null ? '信号' : String(code)}），${String(
        Math.round(backoffMs(restarts) / 1000),
      )} 秒后重试`,
    }
    delete next.port
    this.deps.store.put(next)
    this.emit({
      type: 'standby.stopped',
      workspace_id,
      org_id: record.org_id,
      at,
      reason: '进程意外退出，正在退避重启',
    })
  }

  /** 一次健康检查：过了就 `running` + `last_health_at`。 */
  async health(record: StandbyRecord): Promise<StandbyRecord> {
    if (record.port === undefined || !this.children.has(record.workspace_id)) return record
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, HEALTH_TIMEOUT_MS)
    let ok = false
    try {
      const res = await this.deps.fetch(`http://127.0.0.1:${String(record.port)}/v1/health`, {
        method: 'GET',
        signal: controller.signal,
      })
      ok = res.ok
    } catch {
      // 还没起来 / 已经不在了：下一次 tick 再看
      ok = false
    } finally {
      clearTimeout(timer)
    }
    if (!ok) return record
    const next: StandbyRecord = {
      ...record,
      status: 'running',
      restarts: 0,
      last_health_at: this.now(),
    }
    delete next.restart_at
    delete next.reason
    this.deps.store.put(next)
    return next
  }

  /**
   * 该重拉的重拉，该体检的体检。
   *
   * 两种要重拉的：崩了且退避到点的；库里写着"应该在跑"但内存里没有这个子进程的
   * （云进程自己重启过——这一条就是"云侧发版不掉线超过一个 tick"的全部实现）。
   */
  async tick(): Promise<void> {
    const at = this.now()
    for (const record of this.deps.store.list()) {
      if (record.status === 'expired') continue
      const live = this.children.has(record.workspace_id)
      if (live) {
        await this.health(record)
        continue
      }
      if (record.status === 'stopped') {
        const due = record.restart_at
        // 用户主动停的那种没有 restart_at：不自动拉起来
        if (due === undefined || due > at) continue
      }
      await this.start(record)
    }
  }

  /** 云进程要关了：把子进程一起带走，别留孤儿。 */
  async close(): Promise<void> {
    for (const [id, child] of [...this.children]) {
      this.intentional.add(id)
      child.kill('SIGTERM')
      this.children.delete(id)
    }
    await Promise.resolve()
  }

  /** 这个工作区的回环端口（反向代理要）。没在跑就抛 503 + 一句人话。 */
  portOf(workspace_id: WorkspaceId): number {
    const record = this.deps.store.get(assertWorkspaceId(workspace_id))
    if (record === undefined) throw new StandbyError('not_found', '这个工作区没有开值守。')
    if (record.status === 'expired')
      throw new StandbyError(
        'unavailable',
        '这个工作区的值守已经到期停了。去"设置 → 账号与积分"充值后重新开通；数据都在，导出照常。',
      )
    if (record.port === undefined || record.status !== 'running')
      throw new StandbyError('unavailable', '这个工作区的服务正在启动，过几秒再试。')
    return record.port
  }
}
