/**
 * `HostedInstanceDO` —— 客服增值服务的托管实例（**每个订阅的工作区一个**，WP128）。
 *
 * 一句话：这个对象手里有一个 Cloudflare Container，容器里跑的是**同一份
 * `apps/server`**（docs/74 §5：没有第二份云端客服运行时）。容器起来后自己拨出去
 * 连转发器（`peer: 'hosted'`），`ChatRelayDO` 就把访客消息转给它而不是商家本机。
 *
 * **为什么不 `extends Container`**（派工单写的是继承 `@cloudflare/containers` 的
 * `Container` 类）：那个类继承 `cloudflare:workers` 的 `DurableObject`，普通 tsc 与
 * vitest 里 import 不进来——而本包的每个 DO 都是**朴素类**（见 `index.ts` 头注释），
 * 测试不起 workerd 就能装起来。`Container` 类本身就是对运行时 `ctx.container`
 * 的一层包装（start / getTcpPort / monitor / destroy + 一个 alarm 保活回路），
 * 所以这里直接用 `ctx.container`，把「保活回路」写成我们自己的 alarm：
 * 同一个底座，少一个 npm 依赖，也不和我们自己的 alarm（快照保留、心跳）抢那一个闹钟。
 * 偏离写在 docs/64 §13 与 WP128 报告里。
 *
 * 常驻怎么做：官方没有「永不休眠」的开关（`sleepAfter` 只是「多久没请求就停」，
 * 且那是 `Container` 类里的 JS 逻辑，不是平台开关）。这里的 alarm 每 3 分钟醒一次：
 * 打一次容器的 `/v1/health`（= 心跳，也是一次真实活动），没在跑就拉起来，连续三次
 * 不应就重起。费用照「整月常驻」估（docs/64 §13 的费用一节）。
 *
 * 数据：容器的盘是临时的（官方：「All disk is ephemeral」），所以容器里的
 * `apps/server` 每 6 小时、以及收到 SIGTERM 时，把工作区包（WP36 的导出格式）
 * 推回 `/v1/hosted/snapshot` → 这里 → R2；起来第一件事拉最新那一份。
 * 停容器后快照留 30 天，重新订阅就从它接着跑；过期删掉。
 *
 * 这个对象**不存业务数据**：库里只有状态行（时间、计数、令牌哈希、托管配对）与
 * 快照的索引（键名、时间、大小）。快照本体在 R2，内容是用 `HMAC(种子, 工作区)` 派生的
 * 库密钥加密过的那一份（秘密库），外加工作区的 SQLite——按 21 的口径管。
 */

import { createHash } from 'node:crypto'
import type { VerifiedCloudToken } from '@agentsws/contracts'
import {
  buildHostedEnv,
  composeHostedToken,
  deriveHostedKey,
  estimateCost,
  fullMonthCost,
  HOSTED_HEARTBEAT_TIMEOUT_MS,
  HOSTED_KEEPALIVE_MS,
  HOSTED_MAX_HEARTBEAT_FAILURES,
  HOSTED_PORT,
  HOSTED_TOKEN_SCOPES,
  HOSTED_TOKEN_TTL_MS,
  type HostedDesired,
  type HostedInstanceStatus,
  type HostedInstanceType,
  type HostedStopReason,
  isInstanceType,
  restartBackoffMs,
  SNAPSHOT_KEEP_COUNT,
  SNAPSHOT_MAX_BYTES,
  snapshotKeptUntil,
  stateOf,
} from '@agentsws/hosted'
import type { DoStorageLike } from './do-sql.js'
import type { SnapshotBucketLike, WorkerEnv } from './env.js'
import { principalFrom } from './internal.js'

/** 内部路由（只有 Worker 与 `ChatRelayDO` 打得到；公网上没有地址）。 */
export const HOSTED_INTERNAL = {
  ensure: '/__internal/hosted/ensure',
  stop: '/__internal/hosted/stop',
  status: '/__internal/hosted/status',
  verifyToken: '/__internal/hosted/verify-token',
  snapshot: '/__internal/hosted/snapshot',
} as const

/** 快照是谁推上来的：容器自己（定时 / SIGTERM），还是商家本机（「用本机这份覆盖云端」）。 */
export const SNAPSHOT_SOURCE_HEADER = 'X-Agentsws-Snapshot-Source'

/** 停容器时先发 SIGTERM（让 `apps/server` 推最后一份快照），过这么久还在就强停。 */
export const STOP_GRACE_MS = 60_000

/** 容器规格的缺省：basic（1/4 vCPU、1 GiB、4 GB 盘）。理由见 docs/64 §13。 */
export const DEFAULT_INSTANCE_TYPE: HostedInstanceType = 'basic'

/**
 * `ctx.container` 里用到的那几样（官方 Durable Object Container API：
 * https://developers.cloudflare.com/durable-objects/api/container/ ）。
 * 写成结构类型：生产是 workerd 给的那一个，测试塞假的。
 */
export interface ContainerLike {
  readonly running: boolean
  start(options?: {
    env?: Record<string, string>
    entrypoint?: string[]
    enableInternet?: boolean
  }): void
  monitor(): Promise<void>
  destroy(error?: unknown): Promise<void>
  signal(signo: number): void
  getTcpPort(port: number): { fetch(url: string, init?: RequestInit): Promise<Response> }
}

export interface HostedDoStateLike {
  storage: DoStorageLike & {
    setAlarm(when: number): void | Promise<void>
    getAlarm(): number | null | Promise<number | null>
    deleteAlarm?(): void | Promise<void>
  }
  /** 只有 `wrangler.toml` 的 `[[containers]]` 认了这个类，运行时才给。 */
  container?: ContainerLike
}

export interface HostedDoOptions {
  clock?: () => string
  /** 测试注入：假的容器运行时。 */
  container?: ContainerLike
  /** 测试注入：假的 R2。 */
  bucket?: SnapshotBucketLike
  /** 测试注入：随机串（令牌 / 键名）。 */
  random?: () => string
}

/** 这个对象的全部状态（一行 JSON；没有业务数据）。 */
interface HostedRecord {
  workspace_id?: string
  org_id?: string
  account_id?: string
  desired: HostedDesired
  /** 托管那一头连转发器的配对（明文，只在这里与容器环境变量里；转发器那边只有哈希）。 */
  pairing?: string
  token_sha256?: string
  token_expires_at?: string
  started_at?: string
  last_heartbeat_at?: string
  heartbeat_failures: number
  restart_attempts: number
  next_restart_at?: string
  restarts_month?: string
  restarts_this_month: number
  usage_month?: string
  running_seconds_this_month: number
  usage_mark_at?: string
  stopping_until?: string
  stopped_at?: string
  stop_reason?: HostedStopReason
  snapshot_kept_until?: string
  last_error?: string
}

interface SnapshotMeta {
  key: string
  at: string
  bytes: number
  source: 'hosted' | 'local'
}

const KV_TABLE = 'hosted_kv'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

const monthOf = (iso: string): string => iso.slice(0, 7)

const json = (data: unknown, status = 200): Response => Response.json({ data }, { status })

const fail = (code: string, message: string, status: number): Response =>
  Response.json({ code, message }, { status })

export class HostedInstanceCore {
  readonly #state: HostedDoStateLike
  readonly #env: WorkerEnv
  readonly #now: () => string
  readonly #container: ContainerLike | undefined
  readonly #bucket: SnapshotBucketLike | undefined
  readonly #random: () => string

  constructor(state: HostedDoStateLike, env: WorkerEnv, options: HostedDoOptions = {}) {
    this.#state = state
    this.#env = env
    this.#now = options.clock ?? (() => new Date().toISOString())
    this.#container = options.container ?? state.container
    this.#bucket = options.bucket ?? env.HOSTED_SNAPSHOTS
    this.#random =
      options.random ??
      (() => `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`)
    state.storage.transactionSync(() => {
      state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${KV_TABLE} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      )
    })
  }

  /* ── 存取 ─────────────────────────────────────────────────────── */

  #get(key: string): string | undefined {
    return this.#state.storage.sql
      .exec<{ v: string }>(`SELECT v FROM ${KV_TABLE} WHERE k = ?`, key)
      .toArray()[0]?.v
  }

  #put(key: string, value: string): void {
    this.#state.storage.sql.exec(
      `INSERT INTO ${KV_TABLE} (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      key,
      value,
    )
  }

  #record(): HostedRecord {
    const raw = this.#get('record')
    if (raw === undefined)
      return {
        desired: 'stop',
        heartbeat_failures: 0,
        restart_attempts: 0,
        restarts_this_month: 0,
        running_seconds_this_month: 0,
      }
    return JSON.parse(raw) as HostedRecord
  }

  #save(record: HostedRecord): void {
    this.#put('record', JSON.stringify(record))
  }

  #snapshots(): SnapshotMeta[] {
    const raw = this.#get('snapshots')
    return raw === undefined ? [] : (JSON.parse(raw) as SnapshotMeta[])
  }

  #instanceType(): HostedInstanceType {
    const raw = this.#env.AGENTSWS_HOSTED_INSTANCE_TYPE?.trim()
    return raw !== undefined && isInstanceType(raw) ? raw : DEFAULT_INSTANCE_TYPE
  }

  #running(): boolean {
    try {
      return this.#container?.running ?? false
    } catch {
      return false
    }
  }

  /* ── 路由 ─────────────────────────────────────────────────────── */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const now = this.#now()
    if (url.pathname === HOSTED_INTERNAL.status && request.method === 'GET')
      return json(this.status(now))
    if (url.pathname === HOSTED_INTERNAL.ensure && request.method === 'POST')
      return this.#ensure(request, now)
    if (url.pathname === HOSTED_INTERNAL.stop && request.method === 'POST')
      return this.#stopRoute(request, now)
    if (url.pathname === HOSTED_INTERNAL.verifyToken && request.method === 'POST') {
      const { token } = (await request.json()) as { token?: string }
      return Response.json(token === undefined ? null : (this.verifyToken(token, now) ?? null))
    }
    if (url.pathname === HOSTED_INTERNAL.snapshot) {
      // 快照两头都要验过身份：容器（托管令牌）或商家本机（工作区令牌），Worker 已经验完
      const principal = principalFrom(request)
      const record = this.#record()
      if (principal === undefined || principal.workspace_id !== record.workspace_id)
        return fail('unauthenticated', '要这个工作区的令牌', 401)
      if (request.method === 'PUT') return this.#putSnapshot(request, now)
      if (request.method === 'GET') return this.#getSnapshot()
    }
    return fail('not_found', `没有这个入口：${request.method} ${url.pathname}`, 404)
  }

  /* ── 起 / 停 ──────────────────────────────────────────────────── */

  /**
   * 订阅生效（或宽限中）：记下该跑，容器没在跑就拉起来，闹钟接上。
   * 幂等：`ChatRelayDO` 每次扣费 / 每六小时都会调一次。
   */
  async #ensure(request: Request, now: string): Promise<Response> {
    const body = (await request.json()) as {
      workspace_id?: string
      org_id?: string
      account_id?: string
      pairing?: string
    }
    if (body.workspace_id === undefined || body.org_id === undefined)
      return fail('invalid_input', '缺工作区号或组织号', 400)
    const record = this.#record()
    if (record.workspace_id !== undefined && record.workspace_id !== body.workspace_id)
      return fail('invalid_input', '这个对象属于另一个工作区', 409)
    record.workspace_id = body.workspace_id
    record.org_id = body.org_id
    if (body.account_id !== undefined) record.account_id = body.account_id
    if (body.pairing !== undefined && body.pairing !== '') record.pairing = body.pairing
    if (record.pairing === undefined)
      return fail('need_pairing', '托管那一头还没有连转发器用的配对（转发器会重发一把）', 409)
    const wasStopped = record.desired === 'stop'
    record.desired = 'run'
    if (wasStopped) {
      delete record.stopped_at
      delete record.stop_reason
      delete record.stopping_until
      delete record.snapshot_kept_until
      record.restart_attempts = 0
      delete record.next_restart_at
    }
    this.#save(record)
    await this.#startIfNeeded(now)
    await this.#arm(Date.parse(now) + HOSTED_KEEPALIVE_MS)
    return json(this.status(now))
  }

  async #stopRoute(request: Request, now: string): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { reason?: HostedStopReason }
    await this.stop(now, body.reason ?? 'cancelled')
    return json(this.status(now))
  }

  /**
   * 取消（当期用完）/ 宽限到期：停容器、作废令牌、忘掉托管配对，快照留 30 天。
   * 先发 SIGTERM（容器里的 `apps/server` 收到后推最后一份快照），一分钟后还在就强停。
   */
  async stop(now: string, reason: HostedStopReason): Promise<void> {
    const record = this.#record()
    this.#accrue(record, now)
    const already = record.desired === 'stop' && record.stopped_at !== undefined
    record.desired = 'stop'
    delete record.token_sha256
    delete record.token_expires_at
    delete record.pairing
    if (!already) {
      record.stopped_at = now
      record.stop_reason = reason
      record.snapshot_kept_until = snapshotKeptUntil(now)
    }
    if (this.#running()) {
      try {
        this.#container?.signal(15)
      } catch {
        // 已经退了
      }
      record.stopping_until = new Date(Date.parse(now) + STOP_GRACE_MS).toISOString()
    }
    delete record.usage_mark_at
    this.#save(record)
    const next =
      record.stopping_until !== undefined
        ? Date.parse(record.stopping_until)
        : Date.parse(record.snapshot_kept_until ?? now)
    await this.#arm(next)
  }

  /** 该跑、没在跑、不在退避里 → 换一把令牌，起容器。起不来就把原因写进状态。 */
  async #startIfNeeded(now: string): Promise<void> {
    const record = this.#record()
    if (record.desired !== 'run' || this.#running()) return
    if (record.next_restart_at !== undefined && record.next_restart_at > now) return
    const container = this.#container
    if (container === undefined) {
      record.last_error =
        '这个节点没开容器：wrangler.toml 的 [[containers]] 没生效，或这个对象不是容器类。'
      this.#save(record)
      return
    }
    const seed = this.#env.AGENTSWS_HOSTED_KEY_SEED?.trim()
    if (seed === undefined || seed === '') {
      record.last_error = '没配 AGENTSWS_HOSTED_KEY_SEED（wrangler secret put），容器不起。'
      this.#save(record)
      return
    }
    const workspace = record.workspace_id
    const org = record.org_id
    const pairing = record.pairing
    if (workspace === undefined || org === undefined || pairing === undefined) return

    // 每次起容器换一把令牌，旧的当场作废（库里只有哈希）
    const token = composeHostedToken(workspace, this.#random())
    record.token_sha256 = sha256Hex(token)
    record.token_expires_at = new Date(Date.parse(now) + HOSTED_TOKEN_TTL_MS).toISOString()
    const base = (this.#env.AGENTSWS_CLOUD_BASE_URL ?? 'https://cloud.agentsws.com').replace(
      /\/+$/,
      '',
    )
    try {
      container.start({
        env: buildHostedEnv({
          cloud_base_url: base,
          key: deriveHostedKey(seed, workspace),
          tenants: [{ workspace_id: workspace, cloud_token: token, relay_pairing: pairing }],
        }),
        enableInternet: true,
      })
    } catch (err) {
      record.last_error = `容器没起来：${err instanceof Error ? err.message : String(err)}`
      delete record.token_sha256
      delete record.token_expires_at
      this.#save(record)
      return
    }
    if (record.started_at !== undefined) {
      const month = monthOf(now)
      if (record.restarts_month !== month) {
        record.restarts_month = month
        record.restarts_this_month = 0
      }
      record.restarts_this_month += 1
    }
    record.started_at = now
    record.heartbeat_failures = 0
    record.usage_mark_at = now
    delete record.last_error
    delete record.next_restart_at
    this.#save(record)
    // 退出不抛进调用方：下一拍 alarm 看 `running` 自己会发现并重起
    container.monitor().catch(() => {})
  }

  /* ── 心跳 / 保活 ──────────────────────────────────────────────── */

  /** 打一次容器里 `apps/server` 的 `/v1/health`。通 = 心跳；这一下也是一次真实活动。 */
  async #heartbeat(): Promise<boolean> {
    const container = this.#container
    if (container === undefined) return false
    const timeout = new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), HOSTED_HEARTBEAT_TIMEOUT_MS)
    })
    const probe = container
      .getTcpPort(HOSTED_PORT)
      // tcpPort.fetch 是一条裸 TCP：不做 TLS，所以是 http（与 Container 类同一个写法）
      .fetch('http://container/v1/health')
      .then((res) => res.ok)
      .catch(() => false)
    return Promise.race([probe, timeout])
  }

  /** 把「上次记账到现在」这一段容器活着的秒数记进本月（跨月从一号零点重新数）。 */
  #accrue(record: HostedRecord, now: string): void {
    const month = monthOf(now)
    if (record.usage_month !== month) {
      record.usage_month = month
      record.running_seconds_this_month = 0
      if (record.usage_mark_at !== undefined && monthOf(record.usage_mark_at) !== month)
        record.usage_mark_at = `${month}-01T00:00:00.000Z`
    }
    if (record.usage_mark_at !== undefined && this.#running()) {
      const seconds = Math.max(0, (Date.parse(now) - Date.parse(record.usage_mark_at)) / 1000)
      record.running_seconds_this_month += Math.round(seconds)
    }
    if (this.#running()) record.usage_mark_at = now
    else delete record.usage_mark_at
  }

  /**
   * 闹钟：该跑的时候每 3 分钟一拍（保活 + 心跳 + 崩了重起）；
   * 该停的时候只做两件事——强停没退干净的容器、快照过了 30 天就删。
   */
  async alarm(): Promise<void> {
    const now = this.#now()
    const record = this.#record()
    this.#accrue(record, now)
    this.#save(record)

    if (record.desired === 'run') {
      if (!this.#running()) {
        // 平台滚动更新 / 崩了 / 被收走：按退避重起（第一次立刻）
        if (record.next_restart_at === undefined && record.started_at !== undefined) {
          record.next_restart_at = new Date(
            Date.parse(now) + restartBackoffMs(record.restart_attempts),
          ).toISOString()
          record.restart_attempts += 1
          this.#save(record)
        }
        await this.#startIfNeeded(now)
      } else if (await this.#heartbeat()) {
        const fresh = this.#record()
        fresh.last_heartbeat_at = now
        fresh.heartbeat_failures = 0
        fresh.restart_attempts = 0
        this.#save(fresh)
      } else {
        const fresh = this.#record()
        fresh.heartbeat_failures += 1
        if (fresh.heartbeat_failures >= HOSTED_MAX_HEARTBEAT_FAILURES) {
          // 进程还在、端口不应：判坏，强停，下一拍按退避重起
          fresh.last_error = `连续 ${String(fresh.heartbeat_failures)} 次心跳没应，已重起`
          fresh.heartbeat_failures = 0
          this.#save(fresh)
          await this.#container?.destroy('heartbeat timeout').catch(() => {})
        } else this.#save(fresh)
      }
      await this.#arm(Date.parse(now) + HOSTED_KEEPALIVE_MS)
      return
    }

    // 该停：SIGTERM 之后一分钟还在就强停
    if (record.stopping_until !== undefined && now >= record.stopping_until) {
      if (this.#running()) await this.#container?.destroy('stopped').catch(() => {})
      delete record.stopping_until
      this.#save(record)
    }
    if (record.snapshot_kept_until !== undefined && now >= record.snapshot_kept_until) {
      await this.#purgeSnapshots()
      const fresh = this.#record()
      delete fresh.snapshot_kept_until
      this.#save(fresh)
      return
    }
    const next = record.stopping_until ?? record.snapshot_kept_until
    if (next !== undefined) await this.#arm(Date.parse(next))
  }

  async #arm(at: number): Promise<void> {
    const current = await this.#state.storage.getAlarm()
    const now = Date.parse(this.#now())
    // 已经有一个更早、还没到点的闹钟就不动它（早醒一次无害，晚醒可能错过保活）
    if (current !== null && current !== undefined && current > now && current <= at) return
    await this.#state.storage.setAlarm(at)
  }

  /* ── 令牌 ─────────────────────────────────────────────────────── */

  /** 验一把 `wst_hosted_` 令牌。作废 / 过期 / 不对 / 该停了一律 `undefined`（不区分）。 */
  verifyToken(token: string, now: string): VerifiedCloudToken | undefined {
    const record = this.#record()
    if (record.desired !== 'run') return undefined
    if (record.token_sha256 === undefined || record.token_expires_at === undefined) return undefined
    if (record.token_expires_at <= now) return undefined
    if (sha256Hex(token) !== record.token_sha256) return undefined
    if (
      record.workspace_id === undefined ||
      record.org_id === undefined ||
      record.account_id === undefined
    )
      return undefined
    return {
      account_id: record.account_id,
      org_id: record.org_id,
      workspace_id: record.workspace_id,
      scopes: [...HOSTED_TOKEN_SCOPES],
    }
  }

  /* ── 快照 ─────────────────────────────────────────────────────── */

  async #putSnapshot(request: Request, now: string): Promise<Response> {
    const bucket = this.#bucket
    if (bucket === undefined)
      return fail('provider_unavailable', '这个节点没绑快照桶（HOSTED_SNAPSHOTS），存不了', 503)
    const record = this.#record()
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > SNAPSHOT_MAX_BYTES)
      return fail('invalid_input', '快照太大了（上限 512 MB），没收', 413)
    const body = new Uint8Array(await request.arrayBuffer())
    if (body.byteLength === 0) return fail('invalid_input', '快照是空的', 400)
    if (body.byteLength > SNAPSHOT_MAX_BYTES)
      return fail('invalid_input', '快照太大了（上限 512 MB），没收', 413)
    const source =
      request.headers.get(SNAPSHOT_SOURCE_HEADER) === 'local'
        ? ('local' as const)
        : ('hosted' as const)
    const key = `hosted/${record.workspace_id ?? 'unknown'}/${now.replaceAll(':', '-')}-${source}.zip`
    await bucket.put(key, body, {
      customMetadata: { workspace_id: record.workspace_id ?? '', source, at: now },
    })
    const list = [{ key, at: now, bytes: body.byteLength, source }, ...this.#snapshots()]
    const keep = list.slice(0, SNAPSHOT_KEEP_COUNT)
    const drop = list.slice(SNAPSHOT_KEEP_COUNT).map((s) => s.key)
    if (drop.length > 0) await bucket.delete(drop).catch(() => {})
    this.#put('snapshots', JSON.stringify(keep))
    return json({ at: now, bytes: body.byteLength, source, kept: keep.length })
  }

  async #getSnapshot(): Promise<Response> {
    const bucket = this.#bucket
    if (bucket === undefined)
      return fail('provider_unavailable', '这个节点没绑快照桶（HOSTED_SNAPSHOTS）', 503)
    const latest = this.#snapshots()[0]
    if (latest === undefined) return new Response(null, { status: 204 })
    const object = await bucket.get(latest.key)
    if (object === null) return new Response(null, { status: 204 })
    return new Response(await object.arrayBuffer(), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'x-agentsws-snapshot-at': latest.at,
        [SNAPSHOT_SOURCE_HEADER]: latest.source,
      },
    })
  }

  async #purgeSnapshots(): Promise<void> {
    const keys = this.#snapshots().map((s) => s.key)
    if (keys.length > 0 && this.#bucket !== undefined)
      await this.#bucket.delete(keys).catch(() => {})
    this.#put('snapshots', '[]')
  }

  /* ── 状态 ─────────────────────────────────────────────────────── */

  status(now: string): HostedInstanceStatus {
    const record = this.#record()
    // 只读：按当前时刻把「活着的秒数」算出来，不写回（写回在 alarm 里）
    const probe: HostedRecord = { ...record }
    this.#accrue(probe, now)
    const type = this.#instanceType()
    const month = monthOf(now)
    const latest = this.#snapshots()[0]
    const status: HostedInstanceStatus = {
      workspace_id: record.workspace_id ?? '',
      desired: record.desired,
      state: stateOf({
        desired: record.desired,
        running: this.#running(),
        now,
        started_at: record.started_at,
        last_heartbeat_at: record.last_heartbeat_at,
      }),
      instance_type: type,
      heartbeat_failures: record.heartbeat_failures,
      restarts_this_month: record.restarts_month === month ? record.restarts_this_month : 0,
      month,
      running_seconds_this_month: probe.running_seconds_this_month,
      cost_estimate_usd_this_month: estimateCost({
        instance_type: type,
        seconds: probe.running_seconds_this_month,
      }).total_usd,
      cost_estimate_usd_full_month: fullMonthCost(type, month).total_usd,
    }
    if (record.org_id !== undefined) status.org_id = record.org_id
    if (record.started_at !== undefined) status.started_at = record.started_at
    if (record.last_heartbeat_at !== undefined) status.last_heartbeat_at = record.last_heartbeat_at
    if (record.stopped_at !== undefined) status.stopped_at = record.stopped_at
    if (record.stop_reason !== undefined) status.stop_reason = record.stop_reason
    if (record.snapshot_kept_until !== undefined)
      status.snapshot_kept_until = record.snapshot_kept_until
    if (record.last_error !== undefined) status.last_error = record.last_error
    if (latest !== undefined)
      status.snapshot = { at: latest.at, bytes: latest.bytes, source: latest.source }
    return status
  }
}
