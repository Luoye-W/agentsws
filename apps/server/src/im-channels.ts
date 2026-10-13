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
  type DingtalkHttp,
  type DingtalkSocketFactory,
  type FeishuTransportFactory,
  imCardDeepLink,
  isFeishuAppId,
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
  MaybePromise,
  PersonId,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { Context, Hono } from 'hono'
import type { ImInboundPipeline } from './channels.js'
import type { ImAskPick } from './im-ask-route.js'
import {
  createTeamBots,
  type DingtalkStatus,
  dingtalkSecretId,
  type FeishuStatus,
  feishuSecretId,
  IM_TEXT,
  ImBindCodes,
  ImBindings,
  isTeamChannel,
  parseBindCommand,
  type TeamChannel,
} from './im-team-bots.js'
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
/**
 * WP215：个人微信跟**人**走、绑在第一个品牌那一套上；别的品牌那一套不开这条（同一个微信号
 * 两条长轮询会互相顶掉）。团队那三条（企业微信 / 飞书 / 钉钉）是公司的应用凭据，按品牌各一套。
 */
export const WECHAT_FIRST_BRAND_ONLY =
  '个人微信跟人走，不按品牌分：切回第一个品牌绑一次就行，所有品牌都用它跟你的代理说话。'

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
    /** WP306：这条分配在哪个品牌（点名点到别的品牌时给；不给 = 这一套自己的品牌）。 */
    workspace_id?: WorkspaceId
  }): Promise<{ answer: string }>
  /** 本人的那条分配（问代理要带）。拿不到 = 这个人现在没有岗位，不问。 */
  assignmentOf(person_id: PersonId): string | undefined
  /**
   * WP306：按问题挑「问谁」（点名岗位 → 任一品牌里对应的分配；点不出 → 主要岗位）。
   * 不给就退回 `assignmentOf`。回 `undefined` = 哪儿都没有岗位。
   */
  pickAssignment?(person_id: PersonId, question: string): MaybePromise<ImAskPick | undefined>
  /** WP306：问代理最多等多久（默认 90 秒）；过了先回一句人话，答案晚到再补发。 */
  askTimeoutMs?: number
  /** WP306：答案没在这么久里出来就先回「收到，我查一下」（默认 1.5 秒；只对飞书）。 */
  ackAfterMs?: number
  /**
   * WP211（Fable 09-30 定）：谁能填 / 改 / 断开**公司的**应用凭据（企业微信、飞书、钉钉三条）。
   * 只给负责人（持有 `common.owner`）与公司管理员；不给 = 一律不许（fail-closed）。
   * 每人自己的「绑定我的账号」不受它管。
   */
  canManageTeamBots?(person_id: PersonId): boolean | Promise<boolean>
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
  /** WP211：飞书官方 SDK 的包装（真装配接 `im-sdk.ts`；不给就不连飞书）。 */
  feishuTransport?: FeishuTransportFactory
  /** WP211：钉钉 Stream 的长连接与 HTTP（真装配接 `ws` 与 `fetch`；不给就不连钉钉）。 */
  dingtalkSocket?: DingtalkSocketFactory
  dingtalkHttp?: DingtalkHttp
  dingtalkGatewayUrl?: string
  clawbotBaseUrl?: string
  sessionCookieName?: string
  /** 适配器循环里的异常出口。 */
  onError?(e: unknown): void
  /** 适配器的节奏（测试调快）。 */
  pace?: { idle_delay_ms?: number; retry_delay_ms?: number; backoff_delay_ms?: number }
  /**
   * WP215：这一套开不开个人微信（默认开）。品牌各一套 IM 之后，只有第一个品牌那一套开——
   * 见 {@link WECHAT_FIRST_BRAND_ONLY}。
   */
  personalWechat?: boolean
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
    /** WP211：当前这个人有没有把自己的企业微信账号绑上。 */
    me_bound?: boolean
  }
  /** WP211：飞书机器人（团队）。 */
  feishu?: FeishuStatus
  /** WP211：钉钉机器人（团队）。 */
  dingtalk?: DingtalkStatus
  /** WP211：当前这个人能不能填 / 改 / 断开公司的应用凭据（负责人与公司管理员）。 */
  can_manage?: boolean
}

export interface ImChannelsAssembly {
  /** 挂路由（在 `server.ts` 现有中间件链之后、静态托管之前调）。 */
  mount(app: Hono<GatewayEnv>): void
  /** 进程起来时把已经绑好的两条通道拉起来。 */
  resume(): Promise<void>
  /**
   * WP215：这一套的路由处理器（`"METHOD /path"` → 处理器），不挂到任何 app 上。
   * 品牌各一套 IM 之后，路由只挂一次（{@link mountBrandImRoutes}），按主体所在品牌转给那一套。
   */
  handlers(): Map<string, (c: Context<GatewayEnv>) => Promise<Response>>
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

  /* ── WP211：三条团队渠道共用的「这个聊天账号是谁」与飞书 / 钉钉 ──── */

  const bindings = new ImBindings(options.secrets)
  const bindCodes = new ImBindCodes(options.random)
  const teamBots = createTeamBots({
    clock: options.clock,
    workspace_id: options.workspace_id,
    secrets: options.secrets,
    rawStore: options.rawStore,
    makePipeline: options.makePipeline,
    route: routeToAgent,
    onEvent: (event) => answerInbound(event),
    onConnState: (channel, state, prev) => connState(channel, state, prev),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.feishuTransport === undefined ? {} : { feishuTransport: options.feishuTransport }),
    ...(options.dingtalkSocket === undefined ? {} : { dingtalkSocket: options.dingtalkSocket }),
    ...(options.dingtalkHttp === undefined ? {} : { dingtalkHttp: options.dingtalkHttp }),
    ...(options.dingtalkGatewayUrl === undefined
      ? {}
      : { dingtalkGatewayUrl: options.dingtalkGatewayUrl }),
  })

  const emit = (
    type:
      | 'im.bound'
      | 'im.unbound'
      | 'im.answered'
      | 'im.person_bound'
      | 'im.person_unbound'
      // WP306：诊断——收到了一句 / 没答成（原因码）/ 长连接断了 / 连回来了
      | 'im.received'
      | 'im.ask_failed'
      | 'im.disconnected'
      | 'im.reconnected',
    payload: object,
  ): void => {
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
   * 这一跳跑在管线的 `onEvent` 里。
   *
   * WP306 起**永不静默、也不抛**：以前「答不上来就抛、让管线退避重试」，可 IM 那几条管线的
   * 重试队列没人推（`pump` 只在收信那一轮对邮件管线调），失败那一下也不记事件——
   * Luoye 10-13 在飞书里问了两句，名册没刷新、秘书抛「这个人不存在」，两句都掉进了
   * 没人推的队列，一个字没回、事件库里也一条都没有。现在认得出是谁的一句话，
   * 答不上来也回一句人话、记一条 `im.ask_failed`（只有原因码）；重问一次比卡在队列里强。
   */
  const answerInbound = async (event: InboundEvent): Promise<void> => {
    const question = unfence(
      event.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n'),
    )
    const external = event.actor?.external_id ?? ''

    // 三条团队渠道：认人（或当场绑定）→ 按提问人身份问他自己的代理 → 回原会话
    if (
      event.channel === WECOM_BOT_CHANNEL ||
      event.channel === 'feishu' ||
      event.channel === 'dingtalk'
    ) {
      const team = teamReplier(event)
      // 那条通道已经停了（断开 / 进程在关）：不答，也不落到微信那一支去
      if (team === undefined) return
      try {
        await answerTeam(team, external, question)
      } catch (e) {
        // 兜底：走到这里是我们自己的 bug；照样回一句、记原因，不进那条没人推的重试队列
        failed(team.channel, undefined, 'internal', e)
        await say(team.channel, undefined, team.reply, failText(IM_TEXT.failed))
      }
      return
    }

    if (question === '') return
    // 微信：线程 id 是 `wechat:<account_id>:<from>`，账号 → 人在 wechatOwner 里
    const account_id = event.thread?.external_id.split(':')[1] ?? ''
    const person_id = wechatOwner.get(account_id)
    const adapter = person_id === undefined ? undefined : wechat.get(person_id)
    if (person_id === undefined || adapter === undefined) return
    emit('im.received', { channel: 'wechat', person_id, chars: question.length })
    const reply = async (text: string) => adapter.sendText(external, text)
    try {
      await askAndReply('wechat', person_id, question, reply, false)
    } catch (e) {
      failed('wechat', person_id, 'internal', e)
      await say('wechat', person_id, reply, failText(IM_TEXT.failed))
    }
  }

  /** 回复函数：`keep` = 这一句不是最后一句（只有飞书用得上，见 `FeishuBotAdapter.reply`）。 */
  type Reply = (text: string, opts?: { keep?: boolean }) => Promise<unknown>
  interface TeamReplier {
    channel: TeamChannel
    reply: Reply
    /** 先回「收到，我查一下」：只有飞书（同一条消息能回多次；企业微信一条只回一次）。 */
    ack: boolean
  }

  /** 这条入站属于哪条团队渠道、怎么回（回复都按入站的去重键找回原消息）。 */
  const teamReplier = (event: InboundEvent): TeamReplier | undefined => {
    if (event.channel === WECOM_BOT_CHANNEL) {
      const adapter = wecom
      return adapter === undefined
        ? undefined
        : { channel: 'wecom', ack: false, reply: (text) => adapter.reply(event.dedupe_key, text) }
    }
    if (event.channel === 'feishu') {
      const adapter = teamBots.feishu
      return adapter === undefined
        ? undefined
        : {
            channel: 'feishu',
            ack: true,
            reply: (text, opts) => adapter.reply(event.dedupe_key, text, opts),
          }
    }
    if (event.channel === 'dingtalk') {
      const adapter = teamBots.dingtalk
      return adapter === undefined
        ? undefined
        : {
            channel: 'dingtalk',
            ack: false,
            reply: (text) => adapter.reply(event.dedupe_key, text),
          }
    }
    return undefined
  }

  /**
   * 41 §1.3：**按提问人身份**路由到他自己的代理。
   *
   * 认不出这个账号是我们这边的谁 → 不答，只回一句怎么绑。群里所有人都看得见这条回复，
   * 给一个没绑定过的账号代答，等于把公司内部情况说给不认识的人听。
   * 「绑定 123456」是唯一不需要先认出人的一句：码只显示给登录了工作台的那个人。
   */
  const answerTeam = async (
    team: TeamReplier,
    external: string,
    question: string,
  ): Promise<void> => {
    const { channel, reply } = team
    const code = parseBindCommand(question)
    const person_id =
      code !== undefined
        ? undefined
        : ((channel === 'wecom' ? options.personByWecomUser?.(external) : undefined) ??
          bindings.personOf(channel, external))
    // WP306：收到一句就记一笔（只有渠道、是谁、几个字；正文与聊天账号 id 都不记）
    emit('im.received', {
      channel,
      ...(person_id === undefined ? {} : { person_id }),
      kind: code !== undefined ? 'bind' : person_id === undefined ? 'unknown_sender' : 'question',
      chars: question.length,
    })
    if (code !== undefined) {
      const now_ms = Date.parse(options.clock.now())
      const bound =
        external === '' ? undefined : bindCodes.consume(code, `${channel}:${external}`, now_ms)
      if (bound === undefined) {
        await say(channel, undefined, reply, IM_TEXT.badCode)
        return
      }
      bindings.bind(channel, external, bound)
      // 21 §5：只记谁绑了哪条渠道，聊天账号 id 不进事件
      emit('im.person_bound', { channel, person_id: bound })
      await say(channel, bound, reply, IM_TEXT.bound)
      return
    }
    if (person_id === undefined) {
      await say(channel, undefined, reply, IM_TEXT.unknown)
      return
    }
    // 认得出的人发了一句空的（只发了图片 / 表情）：也回一句，不装没看见
    if (question === '') {
      await say(channel, person_id, reply, IM_TEXT.emptyQuestion)
      return
    }
    await askAndReply(channel, person_id, question, reply, team.ack)
  }

  type AskFailReason =
    | 'no_position'
    | 'timeout'
    | 'not_member'
    | 'agent_error'
    | 'route_error'
    | 'reply_failed'
    | 'internal'

  const link = (): string => options.deepLinkBase()
  const failText = (head: string): string => `${head}${link()}`

  /** 记一条「没答成」：只有原因码与错误码，正文、错误原文都不进事件（21 §5）。 */
  const failed = (
    channel: TeamChannel | 'wechat',
    person_id: PersonId | undefined,
    reason: AskFailReason,
    e?: unknown,
  ): void => {
    const code = (e as { code?: unknown } | undefined)?.code
    emit('im.ask_failed', {
      channel,
      ...(person_id === undefined ? {} : { person_id }),
      reason,
      ...(typeof code === 'string' ? { error_code: code } : {}),
    })
  }

  /** 发一句；没发出去（连接断了 / 飞书拒了）也记一笔——「回了但没到」同样不许静默。 */
  const say = async (
    channel: TeamChannel | 'wechat',
    person_id: PersonId | undefined,
    reply: Reply,
    text: string,
    opts?: { keep?: boolean },
  ): Promise<boolean> => {
    try {
      const out = (await reply(text, opts)) as { sent?: boolean; reason?: string } | undefined
      if (out?.sent === false) {
        emit('im.ask_failed', {
          channel,
          ...(person_id === undefined ? {} : { person_id }),
          reason: 'reply_failed' satisfies AskFailReason,
          ...(out.reason === undefined ? {} : { error_code: out.reason }),
        })
        return false
      }
      return true
    } catch (e) {
      failed(channel, person_id, 'reply_failed', e)
      return false
    }
  }

  /** 秘书说「这个人不在这个工作区」那一类：不是模型抖，是人和品牌对不上。 */
  const reasonOf = (e: unknown): AskFailReason => {
    const code = (e as { code?: unknown } | undefined)?.code
    return code === 'not_found' || code === 'forbidden' ? 'not_member' : 'agent_error'
  }

  /** 定时器（不挡进程退出）。 */
  const after = (ms: number): Promise<'timeout'> =>
    new Promise((resolve) => {
      const h = setTimeout(() => resolve('timeout'), ms)
      ;(h as { unref?: () => void }).unref?.()
    })

  /**
   * 问代理并回话，四种结局都有一句话：
   * 答出来（1.5 秒没出来先回「收到，我查一下」）/ 超时（先回一句，答案晚到再补）/
   * 出错 / 没岗位。
   */
  const askAndReply = async (
    channel: TeamChannel | 'wechat',
    person_id: PersonId,
    question: string,
    reply: Reply,
    ack: boolean,
  ): Promise<void> => {
    let pick: ImAskPick | undefined
    try {
      pick =
        options.pickAssignment === undefined
          ? (() => {
              const id = options.assignmentOf(person_id)
              return id === undefined
                ? undefined
                : { assignment_id: id, workspace_id: options.workspace_id }
            })()
          : await options.pickAssignment(person_id, question)
    } catch (e) {
      failed(channel, person_id, 'route_error', e)
      await say(channel, person_id, reply, failText(IM_TEXT.failed))
      return
    }
    if (pick === undefined) {
      failed(channel, person_id, 'no_position')
      await say(channel, person_id, reply, failText(IM_TEXT.noPosition))
      return
    }
    const started = Date.now()
    type Outcome = { answer: string } | { error: unknown }
    const outcome: Promise<Outcome> = options
      .askAgent({
        viewer: person_id,
        question,
        assignment_id: pick.assignment_id,
        ...(pick.workspace_id === options.workspace_id ? {} : { workspace_id: pick.workspace_id }),
      })
      .then(
        (out) => ({ answer: out.answer }),
        (error: unknown) => ({ error }),
      )
    const ackMs = options.ackAfterMs ?? 1500
    const limitMs = options.askTimeoutMs ?? 90_000
    let first: Outcome | 'timeout' = ack ? await Promise.race([outcome, after(ackMs)]) : 'timeout'
    if (first === 'timeout') {
      if (ack) await say(channel, person_id, reply, IM_TEXT.ack, { keep: true })
      first = await Promise.race([outcome, after(Math.max(0, limitMs - (Date.now() - started)))])
    }
    const answered = (answer: string, late: boolean): void => {
      // 21 §5：只记「答了多少字」，问题与答案的正文都不进日志
      emit('im.answered', {
        person_id,
        channel: 'im',
        via: channel,
        answer_chars: answer.length,
        ...(late ? { late: true } : {}),
      })
    }
    const body = (answer: string): string =>
      pick?.note === undefined ? answer : `${answer}\n${pick.note}`
    if (first === 'timeout') {
      failed(channel, person_id, 'timeout')
      await say(channel, person_id, reply, failText(IM_TEXT.timeout), { keep: true })
      // 答案晚到了照样补给他（不阻塞这一跳；补发失败也会记 reply_failed）
      void outcome.then(async (late) => {
        if ('error' in late) {
          failed(channel, person_id, reasonOf(late.error), late.error)
          return
        }
        answered(late.answer, true)
        await say(channel, person_id, reply, `${IM_TEXT.late}\n${body(late.answer)}`)
      })
      return
    }
    if ('error' in first) {
      failed(channel, person_id, reasonOf(first.error), first.error)
      await say(channel, person_id, reply, failText(IM_TEXT.failed))
      return
    }
    answered(first.answer, false)
    await say(channel, person_id, reply, body(first.answer))
  }

  /** WP306：长连接真的断了 / 连回来了，各记一笔（卡片那边按 `state` 如实变色）。 */
  const down = new Set<string>()
  const connState = (channel: 'feishu', state: string, prev: string): void => {
    if (prev === 'connected' && state !== 'connected' && !down.has(channel)) {
      down.add(channel)
      emit('im.disconnected', { channel, state })
      return
    }
    if (state === 'connected' && down.has(channel)) {
      down.delete(channel)
      emit('im.reconnected', { channel })
    }
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

  const canManage = async (person_id: PersonId): Promise<boolean> =>
    (await options.canManageTeamBots?.(person_id)) === true

  /** 公司应用凭据的写口：只给负责人与公司管理员（服务端拦，界面上也不给按钮）。 */
  const requireManager = async (principal: Principal): Promise<void> => {
    if (!(await canManage(principal.person_id)))
      throw new ApiError('forbidden', '公司的应用凭据只有负责人或公司管理员能填、改、断开。')
  }

  const tierGuard = (): void => {
    if (options.personalWechat === false) throw new ApiError('forbidden', WECHAT_FIRST_BRAND_ONLY)
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
      return ok(c, {
        ...status(principal.person_id),
        can_manage: await canManage(principal.person_id),
      })
    })

    app.put('/v1/im/wecom', async (c) => {
      const principal = await principalOf(c)
      await requireManager(principal)
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

    /* ── WP211：飞书 / 钉钉（公司的）与「绑定我的账号」 ──────────────── */

    const requireSecrets = (): void => {
      if (!options.secrets.available)
        throw new ApiError(
          'not_implemented',
          '这台机器没有秘密库密钥，Secret 无处安全存放（见设置页的说明）。',
        )
    }
    const field = (input: unknown, name: string): string => {
      const v = (input as Record<string, unknown> | undefined)?.[name]
      return typeof v === 'string' ? v.trim() : ''
    }

    app.put('/v1/im/feishu', async (c) => {
      const principal = await principalOf(c)
      await requireManager(principal)
      const input: unknown = await c.req.json().catch(() => undefined)
      const app_id = field(input, 'app_id')
      const app_secret = field(input, 'app_secret')
      const domain = field(input, 'domain') === 'lark' ? 'lark' : 'feishu'
      if (app_id === '' || app_secret === '')
        throw new ApiError('invalid_input', 'App ID 与 App Secret 都要填')
      if (!isFeishuAppId(app_id))
        throw new ApiError('invalid_input', 'App ID 应该是 cli_ 开头、后面 16 位字母数字')
      requireSecrets()
      // 13 §4：值只经这一条路进秘密库，不进事件、不进日志、不进响应体
      options.secrets.put(feishuSecretId(options.workspace_id), { app_id, app_secret, domain })
      emit('im.bound', { channel: 'feishu', by: principal.person_id })
      await teamBots.startFeishu()
      return ok(c, { configured: true, app_id })
    })

    app.delete('/v1/im/feishu', async (c) => {
      const principal = await principalOf(c)
      await requireManager(principal)
      await teamBots.stopFeishu()
      const removed = options.secrets.remove(feishuSecretId(options.workspace_id))
      if (removed) emit('im.unbound', { channel: 'feishu', by: principal.person_id })
      return ok(c, { removed })
    })

    app.put('/v1/im/dingtalk', async (c) => {
      const principal = await principalOf(c)
      await requireManager(principal)
      const input: unknown = await c.req.json().catch(() => undefined)
      const client_id = field(input, 'client_id')
      const client_secret = field(input, 'client_secret')
      if (client_id === '' || client_secret === '')
        throw new ApiError('invalid_input', 'Client ID 与 Client Secret 都要填')
      requireSecrets()
      options.secrets.put(dingtalkSecretId(options.workspace_id), { client_id, client_secret })
      emit('im.bound', { channel: 'dingtalk', by: principal.person_id })
      await teamBots.startDingtalk()
      return ok(c, { configured: true, client_id })
    })

    app.delete('/v1/im/dingtalk', async (c) => {
      const principal = await principalOf(c)
      await requireManager(principal)
      await teamBots.stopDingtalk()
      const removed = options.secrets.remove(dingtalkSecretId(options.workspace_id))
      if (removed) emit('im.unbound', { channel: 'dingtalk', by: principal.person_id })
      return ok(c, { removed })
    })

    /** 发一个 6 位绑定码：只给登录了工作台的这个人看，他私聊机器人发出去就绑上了。 */
    app.post('/v1/im/bind-code', async (c) => {
      const principal = await principalOf(c)
      requireSecrets()
      const out = bindCodes.issue(principal.person_id, Date.parse(options.clock.now()))
      return ok(c, { code: out.code, expires_at: new Date(out.expires_at_ms).toISOString() })
    })

    /** 解绑我在这条渠道上的账号（之后它问什么都只会得到「先绑定」）。 */
    app.delete('/v1/im/bind/:channel', async (c) => {
      const principal = await principalOf(c)
      const channel = c.req.param('channel')
      if (!isTeamChannel(channel)) throw new ApiError('not_found', '没有这条渠道')
      const removed = bindings.unbindPerson(channel, principal.person_id)
      if (removed > 0) emit('im.person_unbound', { channel, person_id: principal.person_id })
      return ok(c, { removed })
    })
  }

  let routeTable: Map<string, (c: Context<GatewayEnv>) => Promise<Response>> | undefined

  const status = (person_id: PersonId): ImStatusView => {
    const fields = wechatBinding(person_id)
    const adapter = wechat.get(person_id)
    const firstBrand = options.personalWechat !== false
    const allowed = firstBrand && tier() === 'local'
    const wecomFields = wecomBinding()
    const paused = adapter?.pausedUntil()
    return {
      wechat: {
        bound: fields !== undefined,
        ...(fields?.account_id === undefined ? {} : { account_id: fields.account_id }),
        live: adapter?.health().ok ?? false,
        ...(paused === undefined ? {} : { paused_until: paused }),
        allowed,
        ...(allowed ? {} : { reason: firstBrand ? WECHAT_LOCAL_ONLY : WECHAT_FIRST_BRAND_ONLY }),
      },
      wecom: {
        configured: wecomFields !== undefined,
        connected: wecom?.connected ?? false,
        ...(wecomFields?.bot_id === undefined ? {} : { bot_id: wecomFields.bot_id }),
        me_bound: bindings.isBound('wecom', person_id),
      },
      feishu: teamBots.feishuStatus(bindings.isBound('feishu', person_id)),
      dingtalk: teamBots.dingtalkStatus(bindings.isBound('dingtalk', person_id)),
    }
  }

  return {
    mount,

    handlers() {
      if (routeTable !== undefined) return routeTable
      const table = new Map<string, (c: Context<GatewayEnv>) => Promise<Response>>()
      const record =
        (method: string) =>
        (path: string, handler: (c: Context<GatewayEnv>) => Promise<Response>): void => {
          table.set(`${method} ${path}`, handler)
        }
      // 只收集，不挂：同一套 `mount` 走一遍，路由表与真挂上去的那份逐字相同
      mount({
        get: record('GET'),
        post: record('POST'),
        put: record('PUT'),
        delete: record('DELETE'),
      } as unknown as Hono<GatewayEnv>)
      routeTable = table
      return table
    },

    async resume(): Promise<void> {
      for (const record of options.secrets.list()) {
        if (options.personalWechat === false) break
        if (!record.connection_id.startsWith('im:wechat:')) continue
        const person_id = record.connection_id.slice('im:wechat:'.length)
        if (tier() !== 'local') continue
        await startWechat(person_id)
      }
      await startWecom()
      await teamBots.startFeishu()
      await teamBots.startDingtalk()
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
      await teamBots.close()
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

/**
 * WP215：IM 路由只挂一次，**按主体所在品牌**转给那个品牌那一套（企业微信 / 飞书 / 钉钉的应用凭据、
 * 绑定、入站管线都是品牌自己的）。认不出主体的请求交给第一个品牌那一套——它自己会回 401。
 */
export function mountBrandImRoutes(
  app: Hono<GatewayEnv>,
  options: {
    identity: ImIdentity
    sessionCookieName?: string
    primary: ImChannelsAssembly
    /** 这个品牌那一套（没有 / 不是这家公司的品牌 = `undefined`，交给第一个品牌那一套去拒）。 */
    of(workspace_id: WorkspaceId): Promise<ImChannelsAssembly | undefined>
  },
): void {
  const workspaceOf = async (c: Context<GatewayEnv>): Promise<WorkspaceId | undefined> => {
    const header = c.req.header('Authorization')
    const cookie =
      header === undefined || header.trim() === ''
        ? readCookie(c.req.header('Cookie'), options.sessionCookieName ?? SESSION_COOKIE)
        : undefined
    const raw = header ?? cookie
    if (raw === undefined || raw.trim() === '') return undefined
    const value = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim()
    return (await options.identity.authenticate(value))?.workspace_id
  }
  for (const key of options.primary.handlers().keys()) {
    const [method, path] = key.split(' ') as [string, string]
    app.on(method, [path], async (c) => {
      const ws = await workspaceOf(c)
      const target = (ws === undefined ? undefined : await options.of(ws)) ?? options.primary
      const handler = target.handlers().get(key) ?? options.primary.handlers().get(key)
      if (handler === undefined) throw new ApiError('not_found', '没有这个入口')
      return handler(c)
    })
  }
}
