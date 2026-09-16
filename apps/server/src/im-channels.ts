/**
 * 两条 IM 渠道在服务进程里的装配（WP85；54 §5，Luoye 拍板 Q5b）。
 *
 * - **微信 ClawBot**：个人的。一个人扫一次码，从此可以在微信里跟**自己的代理**
 *   说话。归属 person、**留本机**（20：个人身份类渠道跟人走），token 按 person 键
 *   进本机秘密库；工作区数据搬到共享档 / 托管档的机器上**不让绑**（见 `tierGuard`）。
 * - **企业微信智能机器人**：公司的。归属 workspace，BotID + Secret 经 13 §4 的
 *   安全表单一次性提交，之后只在秘密库里。
 *
 * 两条通道共用同一条路：
 *
 * ```
 * 入站 → 18 §2 管线（去重 / 围栏 / 脱敏 / 排队 / 死信）→ 这个人的代理（41）→ 回一句话
 * ```
 *
 * **代理没有在 IM 里施行的路**：它产出的审批卡只以「文本摘要 + 去工作台处理」的
 * 深链投递（`renderCardForIm`），按钮一个都不放进 IM——凭据与决策不经 IM（13 §4）。
 */

import {
  ApiError,
  type GatewayEnv,
  type Principal,
  readCookie,
  SESSION_COOKIE,
} from '@agentsws/api'
import type { RouteInput, RouteResult } from '@agentsws/channels'
import {
  ClawBotLogin,
  type ClawBotStateStore,
  type ClawBotTransport,
  clawBotPipelineAdapter,
  createHttpClawBotTransport,
  imCardDeepLink,
  MemoryClawBotStateStore,
  type RawStore,
  renderCardForIm,
  WECHAT_CLAWBOT_CHANNEL,
  WECOM_BOT_CHANNEL,
  WeChatClawBotAdapter,
  WecomBotAdapter,
  type WecomInboundBody,
  type WecomSocketFactory,
  type WireMessage,
  wecomPipelineAdapter,
} from '@agentsws/channels'
import type {
  ChannelAdapter,
  Clock,
  EventEnvelope,
  InboundEvent,
  Iso8601,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { Context, Hono } from 'hono'
import type { ImInboundPipeline } from './channels.js'
import type { SecretFields, SecretStore } from './secret-store.js'
import { BLOB_URL_ENV, DATABASE_URL_ENV } from './storage.js'

/* ------------------------------------------------------------------ */
/* 秘密库里的键                                                         */
/* ------------------------------------------------------------------ */

/**
 * 个人微信的 token 按 **person** 键存（20：个人身份类渠道跟人走，不跟工作区）。
 * 一台机器上两个人各绑各的，互相读不到（秘密库还按品牌加过一层前缀，见 secret-store.ts）。
 */
export function wechatSecretId(person_id: PersonId): string {
  return `im:wechat:${person_id}`
}

/** 企业微信是**公司资产**：按工作区键存。 */
export function wecomSecretId(workspace_id: WorkspaceId): string {
  return `im:wecom:${workspace_id}`
}

/* ------------------------------------------------------------------ */
/* 三档与「个人微信只能绑在本机档」                                       */
/* ------------------------------------------------------------------ */

/** 41 §2 的三档（与 `packages/api` 的 `StorageTier` 同名同义）。 */
export type ImStorageTier = 'local' | 'byo_cloud' | 'managed'

/**
 * 这台机器现在是第几档。
 *
 * 判据与 `storage.ts` 里那个私有的 `currentTier()` 一模一样（两行环境变量），
 * 只是那一个没导出、而且它的端口是异步的。绑微信这条路必须**同步**判得出来：
 * 它是一道拒绝门，不该为了问一句「我在第几档」先去 await 一次对象存储的用量。
 */
export function storageTierOf(env: NodeJS.ProcessEnv): ImStorageTier {
  const dbUrl = env[DATABASE_URL_ENV]
  const blobUrl = env[BLOB_URL_ENV]
  const remote = (dbUrl !== undefined && dbUrl !== '') || blobUrl?.startsWith('s3://') === true
  return remote ? 'byo_cloud' : 'local'
}

/** 拒绝时说的那句人话（不是错误码，是给人看的）。 */
export const WECHAT_LOCAL_ONLY =
  '个人微信只能绑在你自己这台机器上。这个工作区的数据现在放在共享数据库 / 云上，' +
  '你的微信登录凭据一旦存进去，同一套数据库的其他人、以及托管方都在它的可及范围里。' +
  '想用微信跟自己的代理说话，请在本机档（数据在你自己电脑上）的那台机器上绑。'

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

/** 本模块只用得上身份服务的这一个方法。 */
export interface ImIdentity {
  authenticate(bearer: string): Promise<Principal | undefined>
}

/** 要投进 IM 的一张卡。 */
export interface ImCard {
  id: string
  title: string
  summary: string
  kind?: string
  hint?: string
}

export interface ImChannelsOptions {
  clock: Clock
  workspace_id: WorkspaceId
  secrets: SecretStore
  identity: ImIdentity
  rawStore: RawStore
  /**
   * 18 §2 入站管线的**工厂**（真装配接 `channels.imPipeline`，与邮件共用
   * 受控区、队列与去重表）。
   *
   * 传工厂而不是传实例，是因为「答一句」这件事必须发生在管线的 `onEvent` 里：
   * 那是重试与死信的边（抛异常 = 退避重试 ≤ 5 次，耗尽进死信）。
   * 如果在 `ingest` 返回之后才去问代理，模型抖一下这条消息就静默丢了。
   */
  makePipeline(input: {
    adapters: readonly ChannelAdapter[]
    route(input: RouteInput): RouteResult | undefined
    onEvent(event: InboundEvent): Promise<void>
  }): ImInboundPipeline
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  newId(): string
  random(): number
  /** 这台机器在第几档；缺省按环境变量算。 */
  storageTier?(): ImStorageTier
  /**
   * 问**这个人自己的**代理（41 §1）。接的是 `secretary.ask`，
   * 所以 41 §1.3 的公开级别在那一层就已经生效了——这里不做第二套过滤，
   * 也不放大任何权限：`viewer` 永远是解析出来的那个人，解析不出来就不问。
   */
  askAgent(input: {
    viewer: PersonId
    question: string
    assignment_id: string
  }): Promise<{ answer: string }>
  /** 本人的那条分配（问代理要带）。拿不到 = 这个人现在没有岗位，不问。 */
  assignmentOf(person_id: PersonId): string | undefined
  /** 企业微信 userid → 我们这边的人。认不出来就不答（不给陌生人代答）。 */
  personByWecomUser?(userid: string): PersonId | undefined
  /** 深链的根（工作台地址）。 */
  deepLinkBase(): string
  /** 游标与会话上下文的落点；不给就只在内存里。 */
  clawbotState?: ClawBotStateStore
  /** 测试注入。 */
  clawbotTransport?: ClawBotTransport
  wecomSocket?: WecomSocketFactory
  wecomUrl?: string
  clawbotBaseUrl?: string
  sessionCookieName?: string
  /** 适配器循环里的异常出口。 */
  onError?(e: unknown): void
  /** 适配器的节奏（测试调快）。 */
  pace?: { idle_delay_ms?: number; retry_delay_ms?: number; backoff_delay_ms?: number }
}

/** `GET /v1/im/status` 的形状。**不含任何凭据**。 */
export interface ImStatusView {
  wechat: {
    bound: boolean
    /** 绑的是哪个微信账号（`ilink_bot_id`）；不是秘密。 */
    account_id?: string
    /** 收信活着没。 */
    live: boolean
    /** 登录失效之后的停机到什么时候（要重扫）。 */
    paused_until?: Iso8601
    /** 这台机器允不允许绑（第二 / 三档不允许）。 */
    allowed: boolean
    /** 不允许时的那句人话。 */
    reason?: string
  }
  wecom: {
    configured: boolean
    connected: boolean
    /** BotID 不是秘密（Secret 才是）。 */
    bot_id?: string
  }
}

export interface ImChannelsAssembly {
  /** 挂路由（在 `server.ts` 现有中间件链之后、静态托管之前调）。 */
  mount(app: Hono<GatewayEnv>): void
  /** 进程起来时把已经绑好的两条通道拉起来。 */
  resume(): Promise<void>
  status(person_id: PersonId): ImStatusView
  /**
   * 把一张卡投到这个人的 IM 上（文本摘要 + 深链；**没有按钮**）。
   * 回 `false` = 他没绑 / 没有可回的会话上下文，调用方回落到工作台那一路。
   */
  deliverCard(person_id: PersonId, card: ImCard): Promise<boolean>
  close(): Promise<void>
}

/** 去掉围栏标记：进模型的那一份仍然带围栏，问代理的这一句是给人读的。 */
function unfence(text: string): string {
  return text
    .replace(/<\/?external_data>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function createImChannels(options: ImChannelsOptions): ImChannelsAssembly {
  const tier = options.storageTier ?? (() => storageTierOf(process.env))
  const clawbotState = options.clawbotState ?? new MemoryClawBotStateStore()
  const transport =
    options.clawbotTransport ??
    createHttpClawBotTransport({
      random: options.random,
      ...(options.clawbotBaseUrl === undefined ? {} : { base_url: options.clawbotBaseUrl }),
    })

  /** person → 正在跑的那条微信通道。 */
  const wechat = new Map<PersonId, WeChatClawBotAdapter>()
  /** 微信 `account_id` → 这条绑定是谁的（入站只带账号，不带我们的人）。 */
  const wechatOwner = new Map<string, PersonId>()
  let wecom: WecomBotAdapter | undefined

  /**
   * IM 入站一律落 `common.member`（06 §2.1：代理永远是这条职责）。
   *
   * 不走 `defaultRoute`：那一份是「邮件 → 客服岗位」的映射，而 IM 这一路
   * 从头到尾只有一件事——**本人问自己的代理**。
   */
  const AGENT_ROLE: RoleId = 'common.member'
  const routeToAgent = (_input: RouteInput): RouteResult => ({
    role_id: AGENT_ROLE,
    confidence: 1,
  })

  const emit = (type: 'im.bound' | 'im.unbound' | 'im.answered', payload: object): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id: options.workspace_id,
      // 21 §5：只记结论，正文与凭据一个字都不进日志
      type: 'connection.changed',
      actor: { kind: 'system', id: 'im-channels' },
      correlation: { trace_id: `trc_im_${options.newId()}` },
      payload: { im_event: type, ...payload },
    })
  }

  /* ── 微信 ClawBot ──────────────────────────────────────────────── */

  const wechatBinding = (person_id: PersonId): SecretFields | undefined => {
    try {
      return options.secrets.get(wechatSecretId(person_id))
    } catch {
      // 秘密库换过密钥 / 没有密钥：当成「没绑」，界面上会让他重扫
      return undefined
    }
  }

  /** 一次扫码属于谁：`onConfirmed` 要凭它把 token 写进**这个人**的那一行。 */
  const loginOwner = new Map<string, PersonId>()

  const login = new ClawBotLogin({
    clock: options.clock,
    transport,
    newId: options.newId,
    ...(options.clawbotBaseUrl === undefined ? {} : { base_url: options.clawbotBaseUrl }),
    /*
     * token 的**唯一落点**：从这里直接进秘密库。
     * 它不经过任何返回值、任何事件、任何日志（13 §4.3）。
     */
    onConfirmed: (handoff) => {
      const person_id = loginOwner.get(handoff.login_id)
      if (person_id === undefined)
        throw new ApiError('not_found', '这次扫码已经不在了，重新生成一个二维码。')
      if (tier() !== 'local') throw new ApiError('forbidden', WECHAT_LOCAL_ONLY)
      persistWechatBinding(options.secrets, person_id, handoff)
      emit('im.bound', { channel: 'wechat', person_id, account_id: handoff.account_id })
    },
  })

  const startWechat = async (person_id: PersonId): Promise<void> => {
    const fields = wechatBinding(person_id)
    if (fields === undefined) return
    const account_id = fields.account_id ?? ''
    const base_url = fields.base_url ?? ''
    const user_id = fields.user_id ?? ''
    if (account_id === '' || base_url === '' || user_id === '') return
    await wechat.get(person_id)?.stop()
    const adapter = new WeChatClawBotAdapter({
      clock: options.clock,
      rawStore: options.rawStore,
      transport,
      account_id,
      base_url,
      // 现取现用：适配器不持有 token（13 §4.3）
      token: () => wechatBinding(person_id)?.bot_token,
      // allow-list = 扫码那个人。别人给这个 bot 发消息一律不处理
      allow_from: [user_id],
      state: clawbotState,
      ...(options.pace ?? {}),
      ...(options.onError === undefined ? {} : { on_error: options.onError }),
      onTokenStale: (input) => {
        emit('im.unbound', { channel: 'wechat', person_id, reason: 'token_stale', ...input })
      },
    })
    wechat.set(person_id, adapter)
    wechatOwner.set(account_id, person_id)
    const pipeline = options.makePipeline({
      adapters: [clawBotPipelineAdapter(adapter)],
      route: routeToAgent,
      onEvent: answerInbound,
    })
    adapter.start(async (msg: WireMessage) => {
      await pipeline.ingest(WECHAT_CLAWBOT_CHANNEL, msg, options.workspace_id)
    })
  }

  /* ── 企业微信 ───────────────────────────────────────────────────── */

  const wecomBinding = (): SecretFields | undefined => {
    try {
      return options.secrets.get(wecomSecretId(options.workspace_id))
    } catch {
      return undefined
    }
  }

  const startWecom = async (): Promise<void> => {
    if (options.wecomSocket === undefined) return
    const fields = wecomBinding()
    if (fields?.bot_id === undefined || fields.secret === undefined) return
    await wecom?.stop()
    const adapter = new WecomBotAdapter({
      clock: options.clock,
      rawStore: options.rawStore,
      workspace_id: options.workspace_id,
      // 每次（含重连）现取一次；secret 不在适配器里留
      credentials: () => {
        const now = wecomBinding()
        if (now?.bot_id === undefined || now.secret === undefined) return undefined
        return { bot_id: now.bot_id, secret: now.secret }
      },
      socket: options.wecomSocket,
      newId: options.newId,
      ...(options.wecomUrl === undefined ? {} : { url: options.wecomUrl }),
      ...(options.onError === undefined ? {} : { on_error: options.onError }),
    })
    wecom = adapter
    const pipeline = options.makePipeline({
      adapters: [wecomPipelineAdapter(adapter)],
      route: routeToAgent,
      onEvent: answerInbound,
    })
    await adapter.start(async (body: WecomInboundBody) => {
      await pipeline.ingest(WECOM_BOT_CHANNEL, body, options.workspace_id)
    })
  }

  /* ── 入站的最后一跳：路由到「我的代理」，把答案回到原来那条会话 ──── */

  /**
   * 这一跳跑在管线的 `onEvent` 里，所以**抛异常 = 退避重试**（≤ 5 次），
   * 耗尽进死信（18 §2.2）。故意不 catch：模型抖一下应该重试，不该静默吞掉。
   *
   * 「答不上来」与「不该答」是两回事：前者抛（会重试），
   * 后者回一句人话就 return（不重试——重试一百次它还是不该答）。
   */
  const answerInbound = async (event: InboundEvent): Promise<void> => {
    const question = unfence(
      event.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n'),
    )
    if (question === '') return
    const external = event.actor?.external_id ?? ''

    if (event.channel === WECOM_BOT_CHANNEL) {
      const adapter = wecom
      if (adapter === undefined) return
      /*
       * 41 §1.3：**按提问人身份**路由到他自己的代理。
       *
       * 认不出这个 userid 是我们这边的谁 → 不答。群里所有人都看得见这条回复，
       * 给一个没绑定过的账号代答，等于把公司内部情况说给不认识的人听。
       */
      const person_id = options.personByWecomUser?.(external)
      if (person_id === undefined) {
        await adapter.reply(
          event.dedupe_key,
          '我还不认识你这个企业微信账号。先在工作台里把它和你的人对上，我才敢替你查。',
        )
        return
      }
      const answer = await askFor(person_id, question)
      if (answer !== undefined) await adapter.reply(event.dedupe_key, answer)
      return
    }

    // 微信：线程 id 是 `wechat:<account_id>:<from>`，账号 → 人在 wechatOwner 里
    const account_id = event.thread?.external_id.split(':')[1] ?? ''
    const person_id = wechatOwner.get(account_id)
    const adapter = person_id === undefined ? undefined : wechat.get(person_id)
    if (person_id === undefined || adapter === undefined) return
    const answer = await askFor(person_id, question)
    if (answer !== undefined) await adapter.sendText(external, answer)
  }

  const askFor = async (person_id: PersonId, question: string): Promise<string | undefined> => {
    const assignment_id = options.assignmentOf(person_id)
    // 这个人现在没有任何岗位（离职 / 还没分配）：不答，也不重试
    if (assignment_id === undefined) return undefined
    const out = await options.askAgent({ viewer: person_id, question, assignment_id })
    // 21 §5：只记「答了多少字」，问题与答案的正文都不进日志
    emit('im.answered', {
      person_id,
      channel: 'im',
      answer_chars: out.answer.length,
    })
    return out.answer
  }

  /* ── 鉴权中间件（网关那一套在 createGateway 里面，挂不到这里来） ──── */

  const principalOf = async (c: Context<GatewayEnv>): Promise<Principal> => {
    const header = c.req.header('Authorization')
    const cookie =
      header === undefined || header.trim() === ''
        ? readCookie(c.req.header('Cookie'), options.sessionCookieName ?? SESSION_COOKIE)
        : undefined
    const raw = header ?? cookie
    if (raw === undefined || raw.trim() === '')
      throw new ApiError('unauthenticated', '缺少 Authorization: Bearer <token> 或会话 cookie')
    const value = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
    const principal = await options.identity.authenticate(value)
    if (principal === undefined) throw new ApiError('unauthenticated', '凭据无效或已过期')
    if (principal.workspace_id !== options.workspace_id)
      throw new ApiError('forbidden', '凭据不属于这个工作区')
    return principal
  }

  const ok = (c: Context<GatewayEnv>, data: unknown): Response =>
    c.json({ data, trace_id: c.get('rctx')?.trace_id ?? '' })

  const tierGuard = (): void => {
    if (tier() !== 'local') throw new ApiError('forbidden', WECHAT_LOCAL_ONLY)
  }

  /* ── 路由 ───────────────────────────────────────────────────────── */

  const mount = (app: Hono<GatewayEnv>): void => {
    app.post('/v1/im/wechat/login', async (c) => {
      const principal = await principalOf(c)
      tierGuard()
      const started = await login.start()
      loginOwner.set(started.login_id, principal.person_id)
      return ok(c, started)
    })

    app.get('/v1/im/wechat/login/:id', async (c) => {
      const principal = await principalOf(c)
      tierGuard()
      const id = c.req.param('id')
      const owner = loginOwner.get(id)
      if (owner !== principal.person_id)
        throw new ApiError('not_found', '这次扫码不是你发起的，或者已经过期了。')
      const verify = c.req.query('verify_code')
      const out = await login.poll(id, verify)
      if (out.status === 'confirmed') {
        loginOwner.delete(id)
        await startWechat(principal.person_id)
      }
      if (out.status === 'expired' || out.status === 'failed') loginOwner.delete(id)
      return ok(c, out)
    })

    app.delete('/v1/im/wechat', async (c) => {
      const principal = await principalOf(c)
      const adapter = wechat.get(principal.person_id)
      const account_id = adapter?.account_id
      await adapter?.forget()
      wechat.delete(principal.person_id)
      // 解绑 = **销毁 token**（不是停掉轮询）
      const removed = options.secrets.remove(wechatSecretId(principal.person_id))
      if (removed) emit('im.unbound', { channel: 'wechat', person_id: principal.person_id })
      return ok(c, { unbound: removed, ...(account_id === undefined ? {} : { account_id }) })
    })

    app.get('/v1/im/status', async (c) => {
      const principal = await principalOf(c)
      return ok(c, status(principal.person_id))
    })

    app.put('/v1/im/wecom', async (c) => {
      const principal = await principalOf(c)
      const parsed: unknown = await c.req.json().catch(() => undefined)
      const input = parsed as { bot_id?: unknown; secret?: unknown } | undefined
      const bot_id = typeof input?.bot_id === 'string' ? input.bot_id.trim() : ''
      const secret = typeof input?.secret === 'string' ? input.secret.trim() : ''
      if (bot_id === '' || secret === '')
        throw new ApiError('invalid_input', 'BotID 与 Secret 都要填')
      if (!options.secrets.available)
        throw new ApiError(
          'not_implemented',
          '这台机器没有秘密库密钥，Secret 无处安全存放（见设置页的说明）。',
        )
      // 13 §4：值只经这一条路进秘密库，不进事件、不进日志、不进响应体
      options.secrets.put(wecomSecretId(options.workspace_id), { bot_id, secret })
      emit('im.bound', { channel: 'wecom', by: principal.person_id })
      await startWecom()
      return ok(c, { configured: true, bot_id })
    })
  }

  const status = (person_id: PersonId): ImStatusView => {
    const fields = wechatBinding(person_id)
    const adapter = wechat.get(person_id)
    const allowed = tier() === 'local'
    const wecomFields = wecomBinding()
    const paused = adapter?.pausedUntil()
    return {
      wechat: {
        bound: fields !== undefined,
        ...(fields?.account_id === undefined ? {} : { account_id: fields.account_id }),
        live: adapter?.health().ok ?? false,
        ...(paused === undefined ? {} : { paused_until: paused }),
        allowed,
        ...(allowed ? {} : { reason: WECHAT_LOCAL_ONLY }),
      },
      wecom: {
        configured: wecomFields !== undefined,
        connected: wecom?.connected ?? false,
        ...(wecomFields?.bot_id === undefined ? {} : { bot_id: wecomFields.bot_id }),
      },
    }
  }

  return {
    mount,

    async resume(): Promise<void> {
      for (const record of options.secrets.list()) {
        if (!record.connection_id.startsWith('im:wechat:')) continue
        const person_id = record.connection_id.slice('im:wechat:'.length)
        if (tier() !== 'local') continue
        await startWechat(person_id)
      }
      await startWecom()
    },

    status,

    async deliverCard(person_id, card): Promise<boolean> {
      const text = renderCardForIm(card, imCardDeepLink(options.deepLinkBase(), card.id))
      const adapter = wechat.get(person_id)
      if (adapter !== undefined) {
        const fields = wechatBinding(person_id)
        const user_id = fields?.user_id
        if (user_id !== undefined) {
          const out = await adapter.sendText(user_id, text)
          if (out.external_id !== undefined) return true
        }
      }
      return false
    },

    async close(): Promise<void> {
      for (const adapter of wechat.values()) await adapter.stop()
      wechat.clear()
      await wecom?.stop()
      wecom = undefined
    },
  }
}

/**
 * 供 `login.ts` 的 `onConfirmed` 用的写库动作，单独提出来是为了**只有一处**
 * 碰得到 `bot_token`：扫码确认 → 秘密库，中间不经任何变量、日志、响应体。
 */
export function persistWechatBinding(
  secrets: SecretStore,
  person_id: PersonId,
  handoff: { account_id: string; bot_token: string; base_url: string; user_id?: string },
): void {
  secrets.put(wechatSecretId(person_id), {
    bot_token: handoff.bot_token,
    account_id: handoff.account_id,
    base_url: handoff.base_url,
    ...(handoff.user_id === undefined ? {} : { user_id: handoff.user_id }),
  })
}
