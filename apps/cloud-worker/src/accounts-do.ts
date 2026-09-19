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
 *
 * WP115（65）把**运营后台**也挂在这里：会话 / 角色 / 封禁 / 黑名单 / 审计 /
 * 会员 term 都与账号住在同一张库里（它们互相引用，拆开就是跨对象的一致性问题）。
 * 钱那一侧按组织去问各自的 `WalletDO`，读账那一侧去问单例 `LedgerDO`——
 * 后台那一层握的是两个口（`WalletAdminPort` / `UsageLedger`），不知道自己在
 * 哪个形态里。`/admin/*` 的静态产物由 wrangler 的 `[assets]` 直接服务。
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import {
  type CloudRoute,
  IDEMPOTENCY_MIGRATIONS_TABLE,
  SqlIdempotencyStore,
  type SweepableIdempotencyStore,
} from '@agentsws/api'
import {
  ADMIN_TOKEN_ENV,
  AdminStore,
  adminConsoleRoutes,
  adminExportRoutes,
  buildCloudApp,
  type CloudApp,
  type CloudHealthState,
  type CloudStore,
  cloudflareMailReady,
  cloudflareMailSenderFromEnv,
  createCloudStoreOn,
  createMagicLinkLimiter,
  type MailSender,
  mountAdminWebRoutes,
  parseCookies,
} from '@agentsws/cloud/workers-kit'
import { ADMIN_SESSION_COOKIE, type Clock, cloudBaseUrl, type WalletLot } from '@agentsws/contracts'
import type { KolAdminPort } from '@agentsws/kol-public'
import type { UsageLedger } from '@agentsws/metering'
import { type DoStorageLike, doSyncDb } from './do-sql.js'
import { envRecord, type WorkerEnv } from './env.js'
import { INTERNAL_HEADERS } from './internal.js'
import { remoteKolAdminPort } from './kol-admin.js'
import { LEDGER_SINGLETON, remoteUsageLedger } from './ledger-do.js'
import { remoteWalletAdminPort } from './wallet-admin.js'

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
  /** WP115：后台那一层的库（角色 / 会话 / 封禁 / 黑名单 / 审计 / 会员）。 */
  readonly admin: AdminStore
  readonly #app: CloudApp
  readonly #state: DoStateLike
  readonly #clock: Clock
  readonly #env: WorkerEnv

  constructor(state: DoStateLike, env: WorkerEnv, options: AccountsDoOptions = {}) {
    this.#state = state
    this.#env = env
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

    this.admin = new AdminStore({
      db,
      clock,
      randomBytes: options.randomBytes ?? nodeRandomBytes,
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
        // 公共红人库（WP116 / 64 §10.2 的两段式）：绑了那个 DO 才算开通
        kol_public: env.KOL_PUBLIC !== undefined,
        mail: options.mail !== undefined || cloudflareMailReady(env.EMAIL, record),
        admin_topup: (env.AGENTSWS_CLOUD_ADMIN_TOKEN ?? '').trim() !== '',
        // WP115：后台。读账那一半要 `LEDGER` binding；没绑就只有写动作能用
        admin_console: true,
        admin_ledger: env.LEDGER !== undefined,
      },
    }

    /*
     * WP114 的跨平台退路：账号层的快照在这个对象里，钱在每个组织自己的
     * `WalletDO` 里，所以导出那条路由挂在这边，按组织一个个去问对面要积分批次。
     * 充值那条挂在 `WalletDO`（它要动钱）——同一把钥匙，两条路由各在该在的地方。
     */
    const adminToken = (env[ADMIN_TOKEN_ENV] ?? '').trim()
    const store = this.store
    const modules: CloudRoute[][] =
      adminToken === ''
        ? []
        : [
            adminExportRoutes({
              clock,
              token: adminToken,
              accounts: () => store,
              walletLots: async (org_id) => {
                const res = await env.WALLET.get(env.WALLET.idFromName(org_id)).fetch(
                  new Request(
                    `https://do.internal/__internal/lots?org=${encodeURIComponent(org_id)}`,
                  ),
                )
                return res.ok ? ((await res.json()) as WalletLot[]) : []
              },
              log: (line) => {
                console.log(line.trimEnd())
              },
            }),
          ]

    /*
     * WP115 的后台。三个口都是**取值函数**：`server` 还没建起来的时候就要把
     * 路由声明交出去（OpenAPI 与中间件读的是同一份），所以闭包进去的是取法，
     * 不是值。
     */
    const baseUrl = cloudBaseUrl(record)
    const ledgerOf = (): UsageLedger | undefined =>
      env.LEDGER === undefined
        ? undefined
        : remoteUsageLedger(env.LEDGER.get(env.LEDGER.idFromName(LEDGER_SINGLETON)))
    const walletPort = remoteWalletAdminPort(env.WALLET)
    /*
     * WP116 §4：公共红人库那一页。没绑 `KOL_PUBLIC` 就回 `undefined`，那一页
     * 回 503——与看板页没绑 `LEDGER` 时同一条（不画一堆 0）。
     */
    const kolOf = (): KolAdminPort | undefined =>
      env.KOL_PUBLIC === undefined ? undefined : remoteKolAdminPort(env.KOL_PUBLIC)
    modules.push(
      adminConsoleRoutes({
        clock,
        accounts: () => this.store,
        admin: () => this.admin,
        /*
         * `wallet` 那一格里的 `wallet` 是给会员续发用的进程内钱包——Workers
         * 形态下钱不在这个对象里，所以这里给的是一个**只会被 port 那一半用到**
         * 的壳：`runDueGrants` 走的是下面 `#grantDueCycles`，不碰它。
         */
        wallet: () => ({ wallet: grantOnlyWallet(), port: walletPort }),
        ledger: ledgerOf,
        kol: kolOf,
        baseUrl,
        mail,
        ...(adminToken === '' ? {} : { bootstrapToken: adminToken }),
        health: () => this.health,
        warn: (line: string) => {
          console.warn(line.trimEnd())
        },
      }),
    )

    this.#app = buildCloudApp({
      store: this.store,
      clock,
      mail,
      baseUrl,
      version: env.AGENTSWS_VERSION ?? '0.1.0',
      health: this.health,
      limiter: createMagicLinkLimiter(),
      idempotency: this.idempotency,
      modules,
    })

    // 两页网页（登录页 / magic link 落点）——与 Compose 形态**同一份**
    mountAdminWebRoutes({
      app: this.#app.app,
      store: this.store,
      admin: () => this.admin,
      baseUrl,
      fetch: (request) => this.#app.app.fetch(request),
    })

    /*
     * 后台壳那几条（`/admin`、`/admin/`、`/admin/<别的>`）。
     *
     * 这个对象拿不到 `[assets]` 的 binding（它在入口 Worker 上），所以它只做
     * **判权限**那一半：有会话就回一个 204 + 一个内部头，Worker 看见那个头
     * 再去取文件；没会话就 404——**连 index.html 都不给**，扫描的人看到的与
     * "这台机器上没有后台"一模一样。
     *
     * 注意这几条必须挂在 `mountAdminWebRoutes` **之后**：Hono 先注册先匹配，
     * 否则 `/admin/login` 会被这一条吃掉。
     */
    const assetGate = (c: { req: { header: (n: string) => string | undefined } }): Response => {
      const token = parseCookies(c.req.header('Cookie')).get(ADMIN_SESSION_COOKIE)
      const ok = token !== undefined && token !== '' && this.admin.session(token) !== undefined
      if (!ok) return new Response('Not Found', { status: 404 })
      return new Response(null, { status: 204, headers: { [INTERNAL_HEADERS.adminAsset]: '1' } })
    }
    this.#app.app.get('/admin', assetGate)
    this.#app.app.get('/admin/', assetGate)
    this.#app.app.get('/admin/*', assetGate)
  }

  /**
   * 会员 cycle 的续发（与 Compose 形态同一个函数，只是钱包换成了跨对象那一份）。
   *
   * 由 alarm 顺带跑。**幂等**：`grant_key` 由 `(term_id, cycle 起始日)` 推出来，
   * 而 `WalletDO` 那一头 `wallet_lots (org_id, source_ref)` 上有唯一索引。
   */
  async grantDueCycles(): Promise<number> {
    const due = this.admin.dueCycles(this.#clock.now(), 100)
    if (due.length === 0) return 0
    const port = remoteWalletAdminPort(this.#env.WALLET)
    let granted = 0
    for (const cycle of due) {
      try {
        const lot = await port.grant({
          org_id: cycle.org_id,
          credits: cycle.credits,
          kind: 'granted',
          expires_at: cycle.ends_at,
          source_ref: cycle.grant_key,
        })
        this.admin.markCycleGranted(cycle.id, this.#clock.now(), lot.lot_id)
        this.admin.audit({
          action: 'membership.cycle_grant',
          actor_account_id: 'system',
          actor_role: 'system',
          target_kind: 'org',
          target_id: cycle.org_id,
          outcome: 'done',
          details: { term_id: cycle.term_id, cycle: cycle.index, credits: cycle.credits },
        })
        granted += 1
      } catch {
        // 一个 cycle 发失败不该让整轮停下来；下一次 alarm 再试
        this.admin.audit({
          action: 'membership.cycle_grant',
          actor_account_id: 'system',
          actor_role: 'system',
          target_kind: 'org',
          target_id: cycle.org_id,
          outcome: 'failed',
          details: { term_id: cycle.term_id, cycle: cycle.index },
        })
      }
    }
    return granted
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

  /**
   * 闹钟：扫过期幂等键 + 跑到点的会员 cycle。
   *
   * 两件事各自 try：其中一件炸了不该让另一件也不跑（定时任务把对象带走是
   * 最糟的那种失败）。
   */
  async alarm(): Promise<{ idempotency: number; granted: number }> {
    let idempotency = 0
    let granted = 0
    try {
      idempotency = this.idempotency.sweep(this.#clock)
    } catch {
      idempotency = 0
    }
    try {
      granted = await this.grantDueCycles()
    } catch {
      granted = 0
    }
    await this.#armAlarm()
    return { idempotency, granted }
  }

  async #armAlarm(): Promise<void> {
    // 有幂等键要扫，或者有会员 cycle 等着发，就续下一拍
    if (this.idempotency.size === 0 && this.admin.dueCycles(this.#clock.now(), 1).length === 0)
      return
    const current = await this.#state.storage.getAlarm()
    if (current !== null && current !== undefined) return
    await this.#state.storage.setAlarm(Date.parse(this.#clock.now()) + IDEMPOTENCY_SWEEP_MS)
  }
}

/**
 * 一个**只能发积分**的钱包壳。
 *
 * 后台那一层的 `AdminConsoleWallet.wallet` 是给 Compose 形态的 `runDueGrants`
 * 用的；Workers 形态下钱不在这个对象里，会员续发走的是 `grantDueCycles()`
 * （按组织敲 `WalletDO`）。所以这里给一个**别的方法一调就抛**的壳：
 * 静默回一个假余额比抛出来危险得多。
 */
function grantOnlyWallet(): never {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `官方托管形态下钱在各自的 WalletDO 里，这个壳不提供 ${String(prop)}——` +
            '要动钱请走 WalletAdminPort（见 wallet-admin.ts）',
        )
      },
    },
  ) as never
}
