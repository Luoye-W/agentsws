/**
 * `ChatRelayDO` —— 官方托管的聊天转发器（**每个工作区一个**，WP124 / docs/74）。
 *
 * 修订第 2 条：**转发器只转发**。这里没有第二份客服运行时——
 * 不存对话正文、不跑 AI、不判任何业务；替商家存的东西只有
 * 配对密钥哈希、对话计数（limits.json：每月 200）、留言密文、挂件外观。
 *
 * 「免费本地档 / 收费在线档」的切档在**对面那一侧**：商家本机连上来就是免费档；
 * 订阅客服增值服务后，托管实例（同一份 `apps/server`，按 `packages/standby`
 * 的方式托管）连上来，转发器优先转给它——挂件与嵌入代码一个字不用改。
 *
 * 计数口径（修订第 4 条，判定在 `packages/chat-relay/src/quota.ts`）：
 * 访客第一条消息才计数；30 分钟窗口内的重开算同一个（= 在途放行）；
 * 试聊不计；订阅生效不受限；80% 与到顶都出**站内提醒**（kv 行，
 * `GET /v1/chat/relay/status` 读走；IM 推送依赖云侧 IM 通道，docs/74 留口）。
 */

import { createHash } from 'node:crypto'
import {
  type ClientFrame,
  createRelayHttp,
  KvCounterStore,
  KvOfflineBox,
  KvPairingStore,
  parseClientFrame,
  RelayCore,
  type RelayEvent,
  type RelayFrame,
  type RelayKv,
  type RelayWidgetConfig,
  sealWithKey,
} from '@agentsws/chat-relay'
import type { ServiceSubscription } from '@agentsws/contracts'
import { SUPPORT_SERVICE_ID } from '@agentsws/contracts'
import type { SubscriptionWallet } from '@agentsws/kol-cloud'
import {
  CHAT_CONVERSATIONS_MONTHLY,
  cancelSubscription,
  chargeKeyOf,
  dueCharges,
  startSubscription,
  subscriptionPaid,
  subscriptionStatusAt,
  subscriptionUnpaid,
} from '@agentsws/metering'
import type { DoStateLike } from './accounts-do.js'
import type { DoStorageLike } from './do-sql.js'
import type { DoNamespaceLike, WorkerEnv } from './env.js'
import { principalFrom } from './internal.js'
import { remoteSubscriptionWallet } from './subscription-wallet.js'

/** kv 表名（这个对象里将来还可能住别的表，不叫 `_migrations`——WP114 的坑）。 */
const RELAY_KV_TABLE = 'relay_kv'

/** DO 的 storage.sql → RelayKv（一张键值表）。 */
class SqlRelayKv implements RelayKv {
  readonly #storage: DoStorageLike

  constructor(storage: DoStorageLike) {
    this.#storage = storage
    storage.transactionSync(() => {
      storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${RELAY_KV_TABLE} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      )
    })
  }

  get(key: string): string | undefined {
    const rows = this.#storage.sql
      .exec<{ v: string }>(`SELECT v FROM ${RELAY_KV_TABLE} WHERE k = ?`, key)
      .toArray()
    return rows[0]?.v
  }

  put(key: string, value: string): void {
    this.#storage.sql.exec(
      `INSERT INTO ${RELAY_KV_TABLE} (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      key,
      value,
    )
  }

  delete(key: string): void {
    this.#storage.sql.exec(`DELETE FROM ${RELAY_KV_TABLE} WHERE k = ?`, key)
  }

  list(prefix: string): { key: string; value: string }[] {
    return this.#storage.sql
      .exec<{ k: string; v: string }>(
        `SELECT k, v FROM ${RELAY_KV_TABLE} WHERE k >= ? AND k < ? ORDER BY k`,
        prefix,
        `${prefix}￿`,
      )
      .toArray()
      .map((r) => ({ key: r.k, value: r.v }))
  }
}

/** 转发器那条长连接上用到的 WebSocket 面（workerd 与测试替身都长这样）。 */
export interface RelayWebSocket {
  send(text: string): void
  close(): void
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', handler: () => void): void
}

/** `state` 里转发器用到的那几样（写成结构类型，测试塞假的）。 */
export interface RelayDoStateLike extends DoStateLike {
  acceptWebSocket(ws: RelayWebSocket): void
  serializeAttachment?(ws: RelayWebSocket, attachment: { workspace?: string }): void
  deserializeAttachment?(ws: RelayWebSocket): { workspace?: string } | undefined
}

export interface ChatRelayDoOptions {
  clock?: () => string
  /** 留言封箱密钥（wrangler secret：`AGENTSWS_CHAT_RELAY_KEY`）。 */
  sealKey?: string
  /** 注入配对校验（测试用）；缺省用 kv 里的 sha256 哈希比对。 */
  verifyPairing?: (workspace: string, token: string) => boolean
  /** 测试注入 WebSocket 对（生产用全局 `WebSocketPair`）。 */
  makeSocketPair?: () => { client: RelayWebSocket; server: RelayWebSocket }
  /** 测试钩子：调高限流。 */
  sessionRate?: { per_minute: number; per_hour: number }
  /** 测试注入：假的钱包（不起第二个 DO）。 */
  wallet?: SubscriptionWallet
}

/** 站内提醒的形状（owner 的「额度用到 80% / 到顶」）。 */
export interface RelayNotification {
  type: 'quota_warn_80' | 'quota_full'
  at: string
  message_zh: string
  count: number
  limit: number
}

/** 留言暂存多久（与 packages/chat-relay 同一个数：7 天）。 */
const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 每天醒一次去扣该扣的月费（幂等；支持补扣落下的几期）。 */
const SUPPORT_BILLING_SWEEP_MS = 24 * 60 * 60 * 1000

const NOTIFICATION_LIMIT = 20

export class ChatRelayDoCore {
  readonly core: RelayCore
  readonly #state: RelayDoStateLike
  readonly #env: WorkerEnv
  readonly #kv: SqlRelayKv
  readonly #now: () => string
  readonly #makeSocketPair: () => { client: RelayWebSocket; server: RelayWebSocket }
  readonly #wallet: SubscriptionWallet
  readonly #options: ChatRelayDoOptions
  /** 访客面按工作区分派（DO = 一个工作区，实际只会有一份）。 */
  readonly #httpByWorkspace = new Map<string, ReturnType<typeof createRelayHttp>>()
  /** 已握手的 socket → 工作区（活着时的缓存；hibernation 之后以 attachment 为准）。 */
  readonly #sockets = new Map<RelayWebSocket, string>()

  constructor(state: RelayDoStateLike, env: WorkerEnv, options: ChatRelayDoOptions = {}) {
    this.#state = state
    this.#env = env
    this.#options = options
    this.#now = options.clock ?? (() => new Date().toISOString())
    this.#makeSocketPair =
      options.makeSocketPair ??
      (() => {
        // 生产：workerd 的 WebSocketPair。类型面很小（send/close/两个事件），
        // 不引 workers-types 的全局类型——普通 tsc 下也编得过（与别的 DO 同一条纪律）。
        const makePair = (
          globalThis as { WebSocketPair?: new () => { 0: RelayWebSocket; 1: RelayWebSocket } }
        ).WebSocketPair
        if (makePair === undefined) throw new Error('WebSocketPair 只在 Workers 运行时里存在')
        const pair = new makePair()
        return { client: pair[0], server: pair[1] }
      })
    this.#kv = new SqlRelayKv(state.storage)
    this.#wallet = options.wallet ?? walletOf(env)
    this.core = new RelayCore({
      clock: this.#now,
      // 配对密钥只存哈希（sha256 hex）；比对就是重算一次
      verifyPairing:
        options.verifyPairing ??
        ((workspace, token) => {
          const hash = new KvPairingStore(this.#kv).hash(workspace)
          return hash !== undefined && sha256Hex(token) === hash
        }),
      // 免费档每月 200（limits.json 数据化；改这张表 = 改额度，不用发版）
      ...(CHAT_CONVERSATIONS_MONTHLY === undefined
        ? {}
        : { conversationLimit: CHAT_CONVERSATIONS_MONTHLY.value }),
      // 订阅客服增值服务 → 不受限（订阅路由写进来的 kv 标志）
      isSubscribed: (workspace) => this.#kv.get(`sub:${workspace}`) === 'active',
      counters: new KvCounterStore(this.#kv),
      offline: new KvOfflineBox(this.#kv),
      // 挂件外观落 kv（DO 会被驱逐；驱逐后挂件照常能画出来）
      configStore: {
        get: (workspace) => {
          const raw = this.#kv.get(`widgetcfg:${workspace}`)
          return raw === undefined ? undefined : (JSON.parse(raw) as RelayWidgetConfig)
        },
        put: (workspace, config) => {
          this.#kv.put(`widgetcfg:${workspace}`, JSON.stringify(config))
        },
      },
      // 留言封箱：AES-256-GCM。密钥是**配对时签发的那把留言密钥**（`msgkey:<ws>`），
      // 签发那一刻连同配对密钥一起只给本机一次；箱子拿来封箱，转发器不拿它做别的。
      // 不做端到端是 21 §4.1 定过的口径——这里是「静态加密」那一层。
      seal: (_workspace, plaintext) =>
        sealWithKey(deriveKey(this.#messageKeyOf(_workspace)), plaintext),
      onEvent: (event) => this.#onEvent(event),
      newId: () => crypto.randomUUID(),
    })
  }

  /* ── 提醒（80% / 到顶）→ 站内提醒行，owner 从状态接口读 ──────────────── */

  #onEvent(event: RelayEvent): void {
    if (event.type !== 'quota_warn_80' && event.type !== 'quota_full') return
    const notification: RelayNotification = {
      type: event.type,
      at: event.at,
      count: event.type === 'quota_full' ? event.limit : event.count,
      limit: event.limit,
      message_zh:
        event.type === 'quota_warn_80'
          ? `官方转发本月对话数已到 ${event.count} / ${event.limit}（80%）。可以订阅客服增值服务解除上限，或自建转发。`
          : `官方转发本月对话数已到上限（${event.limit}）。新访客会看到留言表单；已在进行的会话不受影响。`,
    }
    this.#kv.put(`notify:${event.at}:${event.type}`, JSON.stringify(notification))
  }

  /* ── 路由 ─────────────────────────────────────────────────────── */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // 内部路由（Worker 验完令牌才进来；公网上没有地址）
    if (url.pathname.startsWith('/__internal/')) return this.#internal(request, url)
    const workspace = this.#workspaceOf(url)
    if (workspace === undefined)
      return Response.json(
        { code: 'invalid_input', message: '路径里缺工作区号（/relay/<ws>/*）' },
        { status: 400 },
      )

    // 商家本机 / 托管实例主动外连进来的那条长连接
    if (
      url.pathname === `/relay/${workspace}/connect` &&
      request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    )
      return this.#connect(workspace)

    // 访客面（widget.js / session / messages / stream / typing / offline-messages）
    const prefix = `/relay/${workspace}`
    const stripped = new URL(
      `${url.origin}${url.pathname.slice(prefix.length) || '/'}${url.search}`,
    )
    return this.#httpFor(workspace).fetch(new Request(stripped, request))
  }

  #httpFor(workspace: string): ReturnType<typeof createRelayHttp> {
    let app = this.#httpByWorkspace.get(workspace)
    if (app === undefined) {
      app = createRelayHttp({
        core: this.core,
        workspace,
        visitorSecret: () => deriveKey(`${this.#visitorSeed()}:visitor:${workspace}`),
        ...(this.#options.sessionRate === undefined
          ? {}
          : { sessionRate: this.#options.sessionRate }),
      })
      this.#httpByWorkspace.set(workspace, app)
    }
    return app
  }

  /** 访客令牌的 HMAC 种子：部署侧 secret 优先，没配就派生一把（重启不变）。 */
  #visitorSeed(): string {
    return envValue(this.#env, 'AGENTSWS_CHAT_RELAY_KEY') ?? 'derived:agentsws-chat-relay'
  }

  #workspaceOf(url: URL): string | undefined {
    return /^\/relay\/([^/]+)/.exec(url.pathname)?.[1]
  }

  /* ── 商家本机 / 托管实例那条长连接 ─────────────────────────────── */

  #connect(workspace: string): Response {
    const { client, server } = this.#makeSocketPair()
    this.#state.acceptWebSocket(server)
    const sendFrame = (frame: RelayFrame): void => {
      try {
        server.send(JSON.stringify(frame))
      } catch {
        // 已断开：close 事件里会 dropClient
      }
    }
    server.addEventListener('message', (event) => {
      const frame: ClientFrame | undefined = parseClientFrame(String(event.data))
      if (frame === undefined) {
        sendFrame({ type: 'error', code: 'bad_frame', message: '帧解析失败' })
        return
      }
      if (frame.type === 'hello') {
        // 路径里的工作区是权威：hello 里的必须一致（不然一条连接冒充两个工作区）
        if (frame.workspace !== workspace) {
          sendFrame({ type: 'hello_err', reason: 'bad_pairing', supported_versions: [1] })
          server.close()
          return
        }
        const verdict = this.core.handshake({ send: sendFrame, close: () => server.close() }, frame)
        if (verdict.ok) {
          this.#sockets.set(server, workspace)
          try {
            this.#state.serializeAttachment?.(server, { workspace })
          } catch {
            // 测试替身可能不实现 attachment
          }
        } else {
          server.close()
        }
        return
      }
      if (this.#sockets.get(server) !== workspace) {
        sendFrame({ type: 'error', code: 'not_handshaken', message: '先握手再说话' })
        return
      }
      this.core.onClientFrame(workspace, frame)
    })
    server.addEventListener('close', () => {
      const bound = this.#sockets.get(server)
      this.#sockets.delete(server)
      if (bound !== undefined) this.core.dropClient(bound)
    })
    void client
    // workerd：101 + webSocket。普通 Node 的 Response 不收 101（测试替身不跑
    // workerd）——那就回 200，语义对测试已经够了：连接已接进转发器。
    try {
      return new Response(null, { status: 101, webSocket: server } as unknown as ResponseInit)
    } catch {
      return new Response(null, { status: 200 })
    }
  }

  /* ── 内部路由（验过令牌的 owner 操作） ─────────────────────────── */

  async #internal(request: Request, url: URL): Promise<Response> {
    const principal = principalFrom(request)
    const workspace = principal?.workspace_id
    if (workspace === undefined)
      return Response.json(
        { code: 'unauthenticated', message: '要登录的工作区令牌' },
        { status: 401 },
      )

    // 首次签发配对密钥：只返回一次，之后箱里只有哈希
    if (url.pathname === '/__internal/pairing' && request.method === 'POST') {
      const pairing = new KvPairingStore(this.#kv)
      if (pairing.hash(workspace) !== undefined)
        return Response.json(
          {
            code: 'already_issued',
            message:
              '配对密钥已经签发过一次，重发等于再泄露一遍。本机填过就不用再管；确实丢了先在本机解绑再重签。',
          },
          { status: 409 },
        )
      const token = `prk_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
      pairing.putHash(workspace, sha256Hex(token))
      // 留言密钥：与配对密钥同一刻只给一次（本机拉走留言时用它开箱）
      const message_key = `mkk_${crypto.randomUUID().replaceAll('-', '')}`
      this.#kv.put(`msgkey:${workspace}`, message_key)
      return Response.json({ data: { pairing_token: token, message_key, workspace } })
    }

    // 状态：本月对话数 / 上限 / 留言数 / 对端在线 / 提醒
    if (url.pathname === '/__internal/status' && request.method === 'GET') {
      const month = this.#now().slice(0, 7)
      const limit = CHAT_CONVERSATIONS_MONTHLY?.value
      return Response.json({
        data: {
          workspace,
          conversations_this_month: new KvCounterStore(this.#kv).count(workspace, month),
          ...(limit === undefined ? {} : { limit }),
          subscribed: this.#kv.get(`sub:${workspace}`) === 'active',
          peer_online: this.core.stats().clients > 0,
          peer_kind: this.core.peerKindOf(workspace),
          offline_messages: new KvOfflineBox(this.#kv).count(workspace),
          notifications: this.#notifications(),
        },
      })
    }

    // 拉走留言（本机上线后拉走并清除）。密文原样给——只有本机有开箱的钥匙。
    if (url.pathname === '/__internal/offline-messages' && request.method === 'POST') {
      const box = new KvOfflineBox(this.#kv)
      const items = box.take(workspace)
      return Response.json({ data: { items } })
    }

    // 客服增值服务：开通 / 取消 / 查状态（钱在 WalletDO，规则在 metering 引擎）
    if (url.pathname === '/__internal/support-subscription')
      return this.#handleSubscriptionInternal(request, url, workspace)

    return Response.json(
      { code: 'not_found', message: `没有这个入口：${request.method} ${url.pathname}` },
      { status: 404 },
    )
  }

  #messageKeyOf(workspace: string): string {
    return this.#kv.get(`msgkey:${workspace}`) ?? 'no-message-key-issued'
  }

  /* ── 客服增值服务的订阅（67 §3 那套引擎，support 是第二个实例） ───────── */

  #subscription(): ServiceSubscription | undefined {
    const raw = this.#kv.get('service-sub')
    return raw === undefined ? undefined : (JSON.parse(raw) as ServiceSubscription)
  }

  /** 订阅现在真实生效吗（active / cancelling 都算——当期用完为止）。 */
  #subscriptionEffective(sub: ServiceSubscription | undefined): boolean {
    if (sub === undefined) return false
    const status = subscriptionStatusAt(sub, this.#now())
    return status === 'active' || status === 'cancelling'
  }

  async #handleSubscriptionInternal(
    request: Request,
    url: URL,
    workspace: string,
  ): Promise<Response> {
    const principal = principalFrom(request)
    const orgId = principal?.org_id
    if (orgId === undefined)
      return Response.json(
        { code: 'unauthenticated', message: '要登录的工作区令牌' },
        { status: 401 },
      )
    const now = this.#now()
    const current = this.#subscription()

    if (request.method === 'GET') {
      const sub = this.#subscription()
      return Response.json({
        data: {
          ...(sub === undefined
            ? { status: 'none' as const }
            : {
                status: subscriptionStatusAt(sub, now),
                current_cycle_end: sub.current_cycle_end,
                grace_until: sub.grace_until,
                cancel_at_period_end: sub.cancel_at_period_end,
              }),
          service_id: SUPPORT_SERVICE_ID,
          workspace,
        },
      })
    }

    if (request.method === 'POST' && url.pathname === '/__internal/support-subscription') {
      this.#kv.put('service-org', orgId)
      this.#kv.put('service-workspace', workspace)
      const sub = startSubscription(
        current ?? {
          org_id: orgId,
          service_id: SUPPORT_SERVICE_ID,
          status: 'none',
          cancel_at_period_end: false,
          granted_months: 0,
          updated_at: now,
        },
        now,
      )
      const billed = await this.#runBilling(orgId, workspace, sub, now)
      return Response.json({
        data: { status: subscriptionStatusAt(billed.sub, now), charged: billed.charges },
      })
    }

    if (request.method === 'DELETE') {
      const sub = cancelSubscription(
        current ?? {
          org_id: orgId,
          service_id: SUPPORT_SERVICE_ID,
          status: 'none',
          cancel_at_period_end: false,
          granted_months: 0,
          updated_at: now,
        },
        now,
      )
      this.#kv.put('service-sub', JSON.stringify(sub))
      this.#refreshWorkspaceFlag(workspace, sub, now)
      return Response.json({ data: { status: subscriptionStatusAt(sub, now) } })
    }

    return Response.json(
      { code: 'not_found', message: `没有这个入口：${request.method} ${url.pathname}` },
      { status: 404 },
    )
  }

  /** 把到点的月费扣掉（幂等；支持补扣落下的几期）。 */
  async #runBilling(
    orgId: string,
    workspace: string,
    input: ServiceSubscription,
    now: string,
  ): Promise<{ sub: ServiceSubscription; charges: { cycle_start: string; ok: boolean }[] }> {
    let sub = input
    const charged = new Set(
      (this.#kv.get('service-sub-charged') ?? '').split(',').filter((k) => k !== ''),
    )
    const charges = dueCharges({
      sub,
      credits_per_month: 30,
      now,
      charged,
    })
    const results: { cycle_start: string; ok: boolean }[] = []
    for (const charge of charges) {
      const outcome = await this.#wallet.charge({
        org_id: orgId,
        workspace_id: workspace,
        capability: SUPPORT_SERVICE_ID,
        credits: charge.credits,
        request_id: chargeKeyOf(SUPPORT_SERVICE_ID, orgId, charge.cycle_start),
      })
      if (outcome.ok) {
        sub = subscriptionPaid(sub, charge, now)
        charged.add(charge.charge_key)
        results.push({ cycle_start: charge.cycle_start, ok: true })
      } else {
        sub = subscriptionUnpaid(sub, charge, now)
        results.push({ cycle_start: charge.cycle_start, ok: false })
        break // 没钱：后面的期数等下一拍再补（宽限 30 天）
      }
    }
    this.#kv.put('service-sub', JSON.stringify(sub))
    this.#kv.put('service-sub-charged', [...charged].join(','))
    this.#refreshWorkspaceFlag(workspace, sub, now)
    return { sub, charges: results }
  }

  /** 转发器判「订阅生效」读的就是这个标志（active / cancelling 生效）。 */
  #refreshWorkspaceFlag(
    workspace: string,
    sub: ServiceSubscription | undefined,
    now: string,
  ): void {
    if (sub !== undefined && this.#subscriptionEffectiveFor(sub, now))
      this.#kv.put(`sub:${workspace}`, 'active')
    else this.#kv.delete(`sub:${workspace}`)
  }

  #subscriptionEffectiveFor(sub: ServiceSubscription, now: string): boolean {
    const status = subscriptionStatusAt(sub, now)
    return status === 'active' || status === 'cancelling'
  }

  #notifications(): RelayNotification[] {
    return this.#kv
      .list('notify:')
      .map(({ value }) => JSON.parse(value) as RelayNotification)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, NOTIFICATION_LIMIT)
  }

  /**
   * alarm：扫超期留言（7 天，超的删）+ 把到点的月费扣掉。
   * 六小时一拍（留言一小时的误差无所谓；月费补扣本来就支持，幂等）。
   */
  async alarm(): Promise<void> {
    const nowIso = this.#now()
    const now = Date.parse(nowIso)
    for (const { key, value } of this.#kv.list('offline:')) {
      const item = JSON.parse(value) as { created_at: string }
      if (now - Date.parse(item.created_at) >= OFFLINE_TTL_MS) this.#kv.delete(key)
    }
    // 月费补扣：机器停一周，回来把落下的几期一次扣完（上限 24 期，引擎兜底）
    const sub = this.#subscription()
    const orgId = this.#kv.get('service-org')
    if (
      sub !== undefined &&
      orgId !== undefined &&
      this.#kv.get('service-workspace') !== undefined
    ) {
      await this.#runBilling(orgId, this.#kv.get('service-workspace') as string, sub, nowIso)
    }
    await this.#state.storage.setAlarm(now + 6 * 60 * 60 * 1000)
  }
}

/* ── 小工具 ───────────────────────────────────────────────────── */

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function deriveKey(seed: string): Buffer {
  return createHash('sha256').update(`chat-relay:${seed}`).digest()
}

/**
 * 钱那一跳：打这个组织的 `WalletDO`（与 kol-tenant 同一形状）。
 * 没绑 `WALLET` 就回一个**永远扣不上**的钱包：宁可让订阅停在宽限里，也不能白给服务。
 */
function walletOf(env: WorkerEnv): SubscriptionWallet {
  return {
    async charge(args) {
      const ns = env.WALLET as DoNamespaceLike | undefined
      if (ns === undefined)
        return { ok: false, reason: '这台机器上还没接钱包，这一次没扣成（钱一分没动）。' }
      return remoteSubscriptionWallet({
        wallet: ns.get(ns.idFromName(args.org_id)),
        origin: env.AGENTSWS_CLOUD_BASE_URL ?? 'https://cloud.agentsws.com',
      }).charge(args)
    },
  }
}

function envValue(env: WorkerEnv, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}
