/**
 * 团队渠道：飞书 / 钉钉机器人的装配，与三条团队渠道共用的「这个聊天账号是谁」（WP211）。
 *
 * 行为与企业微信那条一致（WP85；54 §5）：
 *
 * ```
 * 私聊它 / 群里 @ 它 → 18 §2 管线（去重 / 围栏 / 脱敏 / 排队 / 死信）
 *   → 认出提问人是我们这边的谁 → 问**他自己的**代理（41）→ 回到原来那条会话
 * ```
 *
 * - **认不出的人不代答**：群里所有人都看得见回复，给一个没对上的账号代答，等于把公司
 *   内部情况说给不认识的人听。第一次要在工作台点「绑定我的账号」拿一串 6 位绑定码，
 *   私聊机器人发「绑定 123456」——码只显示给登录了工作台的那个人，所以「谁拿着这个
 *   聊天账号」由他本人证明，不靠管理员手工对表。
 * - **推给人的只有「摘要 + 去工作台处理」**：审批按钮一个都不进聊天软件（`im-cards.ts`）。
 * - **凭据只经原生表单进本机加密库**：不经 AI、不进日志、不进响应体，填完不回显。
 */

import { canAdministerOrganization } from '@agentsws/api'
import {
  DINGTALK_BOT_CHANNEL,
  DingtalkBotAdapter,
  type DingtalkHttp,
  type DingtalkRobotMessage,
  type DingtalkSocketFactory,
  dingtalkPipelineAdapter,
  FEISHU_BOT_CHANNEL,
  FeishuBotAdapter,
  type FeishuDomain,
  type FeishuMessageEvent,
  type FeishuTransportFactory,
  feishuPipelineAdapter,
  type RawStore,
  type RouteInput,
  type RouteResult,
} from '@agentsws/channels'
import type {
  ChannelAdapter,
  Clock,
  InboundEvent,
  Organization,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { ImInboundPipeline } from './channels.js'
import type { SecretFields, SecretStore } from './secret-store.js'

/** 三条团队渠道（个人微信不在这里：它只认扫码的本人，不需要对人）。 */
export type TeamChannel = 'wecom' | 'feishu' | 'dingtalk'

export const TEAM_CHANNELS: readonly TeamChannel[] = ['wecom', 'feishu', 'dingtalk']

export function isTeamChannel(v: string): v is TeamChannel {
  return (TEAM_CHANNELS as readonly string[]).includes(v)
}

/** 飞书应用是公司资产：按工作区键存（与企业微信同）。 */
export function feishuSecretId(workspace_id: WorkspaceId): string {
  return `im:feishu:${workspace_id}`
}

export function dingtalkSecretId(workspace_id: WorkspaceId): string {
  return `im:dingtalk:${workspace_id}`
}

/** 「这个聊天账号是谁」的一行。放在本机加密库里：聊天账号 id 也是个人信息，不落明文表。 */
export function imBindingId(channel: TeamChannel, external_id: string): string {
  return `im:who:${channel}:${external_id}`
}

/* ------------------------------------------------------------------ */
/* 绑定码                                                              */
/* ------------------------------------------------------------------ */

/** 绑定码 10 分钟有效、只能用一次。 */
export const BIND_CODE_TTL_MS = 10 * 60 * 1000

/** 同一个聊天账号 10 分钟里最多猜错 5 次，之后这段时间里它发的码一律不认。 */
export const BIND_MAX_MISSES = 5

/** 「绑定 123456」/「bind 123456」（可带冒号、空格）。认出来回那 6 位数字。 */
export function parseBindCommand(text: string): string | undefined {
  const m = /^\s*(?:绑定|bind)\s*[:：]?\s*(\d{6})\s*$/i.exec(text)
  return m?.[1]
}

export class ImBindCodes {
  readonly #random: () => number
  readonly #codes = new Map<string, { person_id: PersonId; expires_at_ms: number }>()
  readonly #misses = new Map<string, number[]>()

  constructor(random: () => number) {
    this.#random = random
  }

  /** 给这个人发一个新码（他之前没用掉的那个作废）。 */
  issue(person_id: PersonId, now_ms: number): { code: string; expires_at_ms: number } {
    for (const [code, v] of [...this.#codes])
      if (v.person_id === person_id || v.expires_at_ms <= now_ms) this.#codes.delete(code)
    let code = ''
    for (let i = 0; i < 20; i++) {
      code = String(Math.floor(this.#random() * 1_000_000)).padStart(6, '0')
      if (!this.#codes.has(code)) break
    }
    const expires_at_ms = now_ms + BIND_CODE_TTL_MS
    this.#codes.set(code, { person_id, expires_at_ms })
    return { code, expires_at_ms }
  }

  /**
   * 用掉一个码。`who` 是发码的那个聊天账号（`渠道:id`），用来数猜错的次数。
   * 回 `undefined` = 码不对 / 过期 / 这个账号猜错太多次。
   */
  consume(code: string, who: string, now_ms: number): PersonId | undefined {
    const misses = (this.#misses.get(who) ?? []).filter((t) => now_ms - t < BIND_CODE_TTL_MS)
    if (misses.length >= BIND_MAX_MISSES) {
      this.#misses.set(who, misses)
      return undefined
    }
    const hit = this.#codes.get(code)
    if (hit === undefined || hit.expires_at_ms <= now_ms) {
      this.#codes.delete(code)
      this.#misses.set(who, [...misses, now_ms])
      return undefined
    }
    this.#codes.delete(code)
    this.#misses.delete(who)
    return hit.person_id
  }
}

/* ------------------------------------------------------------------ */
/* 绑定表（本机加密库里）                                              */
/* ------------------------------------------------------------------ */

export class ImBindings {
  readonly #secrets: SecretStore

  constructor(secrets: SecretStore) {
    this.#secrets = secrets
  }

  personOf(channel: TeamChannel, external_id: string): PersonId | undefined {
    if (external_id === '') return undefined
    try {
      return this.#secrets.get(imBindingId(channel, external_id))?.person_id
    } catch {
      // 秘密库换过密钥 / 没有密钥：当成「没绑」，界面上会让他重绑
      return undefined
    }
  }

  bind(channel: TeamChannel, external_id: string, person_id: PersonId): void {
    // 一个人在一条渠道上只留一个账号：换了号先把旧的解掉
    this.unbindPerson(channel, person_id)
    this.#secrets.put(imBindingId(channel, external_id), { person_id, external_id })
  }

  unbindPerson(channel: TeamChannel, person_id: PersonId): number {
    let removed = 0
    for (const id of this.#idsOf(channel, person_id)) if (this.#secrets.remove(id)) removed += 1
    return removed
  }

  isBound(channel: TeamChannel, person_id: PersonId): boolean {
    return this.#idsOf(channel, person_id).length > 0
  }

  #idsOf(channel: TeamChannel, person_id: PersonId): string[] {
    const prefix = `im:who:${channel}:`
    const out: string[] = []
    for (const record of this.#secrets.list()) {
      if (!record.connection_id.startsWith(prefix)) continue
      try {
        if (this.#secrets.get(record.connection_id)?.person_id === person_id)
          out.push(record.connection_id)
      } catch {
        // 解不开的那一行不算他的
      }
    }
    return out
  }
}

/* ------------------------------------------------------------------ */
/* 回给人的几句话                                                      */
/* ------------------------------------------------------------------ */

export const IM_TEXT = {
  unknown:
    '我还不认识你。先去工作台「消息渠道」页点「绑定我的账号」，再私聊我发「绑定 + 那 6 位数字」，我才敢替你查。',
  bound: '绑好了。以后你在这里问，我按你在 Agents 工坊里的身份答。',
  badCode: '这个绑定码不对或已经过期了。去工作台「消息渠道」页重新点一次「绑定我的账号」。',
} as const

/* ------------------------------------------------------------------ */
/* 飞书 / 钉钉的装配                                                   */
/* ------------------------------------------------------------------ */

/** 一条团队渠道在状态页上的样子。**不含任何凭据**（App ID / Client ID 不是秘密，Secret 才是）。 */
export interface TeamBotStatus {
  configured: boolean
  connected: boolean
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  /** 连不上时给人看的一句话（凭据不对 / 没开长连接 / 暂时连不上）。 */
  error?: string
  /** 当前这个人有没有把自己在这条渠道上的账号绑上。 */
  me_bound: boolean
}

export interface FeishuStatus extends TeamBotStatus {
  app_id?: string
  domain?: FeishuDomain
}

export interface DingtalkStatus extends TeamBotStatus {
  client_id?: string
}

export interface TeamBotsDeps {
  clock: Clock
  workspace_id: WorkspaceId
  secrets: SecretStore
  rawStore: RawStore
  makePipeline(input: {
    adapters: readonly ChannelAdapter[]
    route(input: RouteInput): RouteResult | undefined
    onEvent(event: InboundEvent): Promise<void>
  }): ImInboundPipeline
  route(input: RouteInput): RouteResult
  onEvent(event: InboundEvent): Promise<void>
  onError?(e: unknown): void
  feishuTransport?: FeishuTransportFactory
  dingtalkSocket?: DingtalkSocketFactory
  dingtalkHttp?: DingtalkHttp
  dingtalkGatewayUrl?: string
}

export interface TeamBots {
  readonly feishu: FeishuBotAdapter | undefined
  readonly dingtalk: DingtalkBotAdapter | undefined
  startFeishu(): Promise<void>
  startDingtalk(): Promise<void>
  stopFeishu(): Promise<void>
  stopDingtalk(): Promise<void>
  feishuStatus(me_bound: boolean): FeishuStatus
  dingtalkStatus(me_bound: boolean): DingtalkStatus
  close(): Promise<void>
}

const readFields = (secrets: SecretStore, id: string): SecretFields | undefined => {
  try {
    return secrets.get(id)
  } catch {
    return undefined
  }
}

export function createTeamBots(deps: TeamBotsDeps): TeamBots {
  let feishu: FeishuBotAdapter | undefined
  let dingtalk: DingtalkBotAdapter | undefined

  const feishuFields = (): SecretFields | undefined =>
    readFields(deps.secrets, feishuSecretId(deps.workspace_id))
  const dingtalkFields = (): SecretFields | undefined =>
    readFields(deps.secrets, dingtalkSecretId(deps.workspace_id))

  const startFeishu = async (): Promise<void> => {
    if (deps.feishuTransport === undefined) return
    const f = feishuFields()
    if (f?.app_id === undefined || f.app_secret === undefined) return
    await feishu?.stop()
    const adapter = new FeishuBotAdapter({
      clock: deps.clock,
      rawStore: deps.rawStore,
      workspace_id: deps.workspace_id,
      // 每次起连接现取一次；Secret 不在适配器里留
      credentials: () => {
        const now = feishuFields()
        if (now?.app_id === undefined || now.app_secret === undefined) return undefined
        return {
          app_id: now.app_id,
          app_secret: now.app_secret,
          domain: now.domain === 'lark' ? 'lark' : 'feishu',
        }
      },
      transport: deps.feishuTransport,
      ...(deps.onError === undefined ? {} : { on_error: deps.onError }),
    })
    feishu = adapter
    const pipeline = deps.makePipeline({
      adapters: [feishuPipelineAdapter(adapter)],
      route: deps.route,
      onEvent: deps.onEvent,
    })
    await adapter.start(async (e: FeishuMessageEvent) => {
      await pipeline.ingest(FEISHU_BOT_CHANNEL, e, deps.workspace_id)
    })
  }

  const startDingtalk = async (): Promise<void> => {
    if (deps.dingtalkSocket === undefined) return
    const f = dingtalkFields()
    if (f?.client_id === undefined || f.client_secret === undefined) return
    await dingtalk?.stop()
    const adapter = new DingtalkBotAdapter({
      clock: deps.clock,
      rawStore: deps.rawStore,
      workspace_id: deps.workspace_id,
      credentials: () => {
        const now = dingtalkFields()
        if (now?.client_id === undefined || now.client_secret === undefined) return undefined
        return { client_id: now.client_id, client_secret: now.client_secret }
      },
      socket: deps.dingtalkSocket,
      ...(deps.dingtalkHttp === undefined ? {} : { http: deps.dingtalkHttp }),
      ...(deps.dingtalkGatewayUrl === undefined ? {} : { gateway_url: deps.dingtalkGatewayUrl }),
      ...(deps.onError === undefined ? {} : { on_error: deps.onError }),
    })
    dingtalk = adapter
    const pipeline = deps.makePipeline({
      adapters: [dingtalkPipelineAdapter(adapter)],
      route: deps.route,
      onEvent: deps.onEvent,
    })
    await adapter.start(async (m: DingtalkRobotMessage) => {
      await pipeline.ingest(DINGTALK_BOT_CHANNEL, m, deps.workspace_id)
    })
  }

  return {
    get feishu() {
      return feishu
    },
    get dingtalk() {
      return dingtalk
    },
    startFeishu,
    startDingtalk,
    async stopFeishu() {
      await feishu?.stop()
      feishu = undefined
    },
    async stopDingtalk() {
      await dingtalk?.stop()
      dingtalk = undefined
    },
    feishuStatus(me_bound) {
      const f = feishuFields()
      const error = feishu?.lastError?.message
      return {
        configured: f !== undefined,
        connected: feishu?.connected ?? false,
        state: feishu?.state ?? 'idle',
        ...(error === undefined ? {} : { error }),
        me_bound,
        ...(f?.app_id === undefined ? {} : { app_id: f.app_id }),
        ...(f?.domain === 'lark' ? { domain: 'lark' as const } : {}),
      }
    },
    dingtalkStatus(me_bound) {
      const f = dingtalkFields()
      const error = dingtalk?.lastError?.message
      return {
        configured: f !== undefined,
        connected: dingtalk?.connected ?? false,
        state: dingtalk?.state ?? 'idle',
        ...(error === undefined ? {} : { error }),
        me_bound,
        ...(f?.client_id === undefined ? {} : { client_id: f.client_id }),
      }
    },
    async close() {
      await feishu?.stop()
      await dingtalk?.stop()
      feishu = undefined
      dingtalk = undefined
    },
  }
}

/* ------------------------------------------------------------------ */
/* 谁能管公司的应用凭据（Fable 09-30 定）                               */
/* ------------------------------------------------------------------ */

/**
 * 企业微信 / 飞书 / 钉钉三条的**公司应用凭据**（填、改、断开）只给两种人：
 * 这个工作区里持有 `common.owner` 的负责人，与这家公司的所有者 / 管理员。
 * 其他人在卡上只看得到状态；每人自己的「绑定我的账号」不受这条管。
 */
export function createTeamBotManagerCheck(deps: {
  isOwner(person_id: PersonId): boolean
  /** 这个工作区挂在哪家公司下（取不到 = 只认负责人）。 */
  organization(): Promise<Organization | undefined>
}): (person_id: PersonId) => Promise<boolean> {
  return async (person_id) => {
    if (deps.isOwner(person_id)) return true
    const org = await deps.organization()
    return org !== undefined && canAdministerOrganization(org, person_id)
  }
}
