/**
 * `AccountsDO` —— 账号那一层的 Durable Object（**单例**，WP114）。
 *
 * 它里面有什么：账号 / 隐式组织 / magic link / 会话 / 工作区服务令牌 / 幂等键 /
 * magic-link 限流计数。为什么是**一个**对象：这几张表互相引用（会话要账号、
 * 令牌要组织），而且全局只有一份；拆开就等于把外键变成跨对象的一致性问题。
 *
 * 它跑的是 `@agentsws/cloud` 的 `buildCloudApp`——**与 Compose 形态同一段代码**：
 * 同一张路由表、同一套三档鉴权、同一份错误信封、同一页登录落地页。两个形态
 * 行为一致这件事，靠的不是两边各写一遍再对齐，而是根本只有一份。
 *
 * 三条只有这里才有的事：
 *
 * 1. **库**是 `ctx.storage.sql`（DO 的 SQLite，同步），经 `doSyncDb` 包成 `SyncDb`；
 *    迁移在**第一次唤醒时**跑完（构造函数里，同步的）——所以"升级 = 再 deploy 一次"；
 * 2. **发信**是 Cloudflare Email Sending 的 binding，没绑就拒绝装配（health 标红）；
 * 3. **两条内部路由**（`/__internal/*`）只回答 Worker 的问题：验令牌、把邮箱解析成
 *    组织。它们不在 OpenAPI 里，也不可能从公网打到——DO 在外面没有地址。
 */

import {
  IDEMPOTENCY_MIGRATIONS_TABLE,
  SqlIdempotencyStore,
  type SweepableIdempotencyStore,
} from '@agentsws/api'
import {
  buildCloudApp,
  type CloudApp,
  type CloudHealthState,
  type CloudStore,
  cloudflareMailReady,
  cloudflareMailSenderFromEnv,
  createCloudStoreOn,
  createMagicLinkLimiter,
  type MailSender,
} from '@agentsws/cloud/workers-kit'
import { type Clock, cloudBaseUrl } from '@agentsws/contracts'
import { type DoStorageLike, doSyncDb } from './do-sql.js'
import { envRecord, type WorkerEnv } from './env.js'

/** 幂等键多久扫一遍。TTL 是 24h，六小时一拍足够，也不至于把 DO 一直叫醒。 */
export const IDEMPOTENCY_SWEEP_MS = 6 * 60 * 60 * 1000

/** `DurableObjectState` 里我们用到的那几样（写成结构类型，测试能塞假的）。 */
export interface DoStateLike {
  readonly storage: DoStorageLike & {
    setAlarm(when: number): Promise<void> | void
    getAlarm(): Promise<number | null> | number | null
  }
}

export interface AccountsDoOptions {
  clock?: Clock
  /** 测试注入：默认是 `node:crypto` 的 randomBytes（Workers 上由 nodejs_compat 提供）。 */
  randomBytes?: (n: number) => Buffer
  /** 测试注入一个假的发信口（生产上必须是 binding）。 */
  mail?: MailSender
}

/**
 * 账号 DO 的实现（与 Cloudflare 的 `DurableObject` 基类解耦，好测）。
 *
 * `index.ts` 里那个真正被 `wrangler.toml` 认的类只是一层壳：
 * `new AccountsCore(ctx, env)` 然后把 `fetch` / `alarm` 转进来。
 */
export class AccountsCore {
  readonly store: CloudStore
  readonly idempotency: SweepableIdempotencyStore
  readonly health: CloudHealthState
  readonly #app: CloudApp
  readonly #state: DoStateLike
  readonly #clock: Clock

  constructor(state: DoStateLike, env: WorkerEnv, options: AccountsDoOptions = {}) {
    this.#state = state
    const clock: Clock = options.clock ?? { now: () => new Date().toISOString() }
    this.#clock = clock
    const record = envRecord(env)
    const db = doSyncDb(state.storage)
    /*
     * 迁移在这里跑完——**同步**，而且是这个 DO 第一次被唤醒的那一刻。
     * 于是"升级怎么迁移"这个问题在 Workers 形态上没有答案也不需要答案：
     * 新版本 deploy 上去，对象下次醒来自己把缺的版本补上（见 docs/64 §8）。
     */
    this.store = createCloudStoreOn({
      db,
      clock,
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    })
    /*
     * 幂等表与账号库住在**同一张** DO SQLite 里，所以它的版本号表要另起一个名字——
     * 都叫 `_migrations` 的话，先跑完的账号库会让幂等表以为自己也跑过了。
     */
    this.idempotency = new SqlIdempotencyStore({
      db,
      clock,
      migrationsTable: IDEMPOTENCY_MIGRATIONS_TABLE,
    })

    const mail =
      options.mail ??
      /*
       * 没绑 binding / 没配发件地址就**抛**——与 WP58 那道闸同一条纪律。
       * 登录信是云侧唯一的进门方式，发不出去的节点不该起得来假装自己好着。
       */
      cloudflareMailSenderFromEnv({ binding: env.EMAIL, env: record })

    this.health = {
      modules: {
        entry: true,
        // 在线值守要常驻子进程，Workers 上没有这种东西——**如实说没开通**
        standby: false,
        // 公共红人库这一轮不上（见 docs/64 §9 与 WP114 报告）
        kol_public: false,
        mail: options.mail !== undefined || cloudflareMailReady(env.EMAIL, record),
        admin_topup: (env.AGENTSWS_CLOUD_ADMIN_TOKEN ?? '').trim() !== '',
      },
    }

    this.#app = buildCloudApp({
      store: this.store,
      clock,
      mail,
      baseUrl: cloudBaseUrl(record),
      version: env.AGENTSWS_VERSION ?? '0.1.0',
      health: this.health,
      limiter: createMagicLinkLimiter(),
      idempotency: this.idempotency,
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/__internal/')) return this.#internal(request, url)
    const res = await this.#app.app.fetch(request)
    // 有幂等键躺着就把闹钟续上（没有就不续——空转的闹钟是白花的钱）
    await this.#armAlarm()
    return res
  }

  /** Worker 问的两件事。**只有 Worker 问得到**——DO 在公网上没有地址。 */
  async #internal(request: Request, url: URL): Promise<Response> {
    if (url.pathname === '/__internal/verify-token') {
      const { token } = (await request.json()) as { token?: string }
      const verified = token === undefined ? undefined : await this.store.verifyToken(token)
      // 撤销 / 过期 / 不存在一律同一个答案——连内部口也不给探测的余地
      return Response.json(verified ?? null)
    }
    if (url.pathname === '/__internal/resolve-org') {
      const input = (await request.json()) as { org_id?: string; email?: string }
      const org_id = this.#resolveOrg(input)
      return org_id === undefined
        ? new Response('null', { status: 404, headers: { 'content-type': 'application/json' } })
        : Response.json({ org_id })
    }
    return new Response('null', { status: 404, headers: { 'content-type': 'application/json' } })
  }

  #resolveOrg(input: { org_id?: string; email?: string }): string | undefined {
    if (input.org_id !== undefined && input.org_id !== '') return this.store.org(input.org_id)?.id
    const email = (input.email ?? '').trim().toLowerCase()
    if (email === '') return undefined
    const account = this.store.accountByEmail(email)
    return account === undefined ? undefined : this.store.primaryOrg(account.id)?.id
  }

  /** 闹钟：扫过期幂等键。TTL 到了没人再读的键不该一直躺在库里。 */
  alarm(): { idempotency: number } {
    const idempotency = this.idempotency.sweep(this.#clock)
    return { idempotency }
  }

  async #armAlarm(): Promise<void> {
    if (this.idempotency.size === 0) return
    const current = await this.#state.storage.getAlarm()
    if (current !== null && current !== undefined) return
    await this.#state.storage.setAlarm(Date.parse(this.#clock.now()) + IDEMPOTENCY_SWEEP_MS)
  }
}
