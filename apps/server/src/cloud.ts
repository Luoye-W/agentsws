/**
 * 云侧那一面在本地的装配（49 M2 / M5，WP59）。
 *
 * 一句话职责：把"云上的余额与价目"取过来给界面看，把"每项能力用谁的"存在本地。
 *
 * 四条纪律：
 *
 * 1. **本地不记账**。余额、用量、价目全是云上那一份的透传，本地一个数字都不自己算——
 *    自己算就是第二本账，两本账必然对不上（49 §1 的同一条理由）。
 * 2. **令牌只在一处出现**：`secret-store` 里的 `cloud.workspace_token`（WP58 存进去的）。
 *    取出来直接进 `Authorization` 头，不落变量、不进事件、不进响应体、不进日志。
 * 3. **没关联账号不是错**。回 `{ linked: false, reason }`，界面据此把按钮变成
 *    "先关联账号"，而不是画一堆 0 或者弹一个红框。
 * 4. **缓存 60 秒**。余额不是实时账，界面每切一次标签页就打一次云是浪费；
 *    充值成功之后用户会自己刷新，60 秒也等得起。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CloudActor, CloudPort } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  CapabilitySource,
  CapabilitySourceSettings,
  CapabilitySources,
  Clock,
  CloudCreditsView,
  DataSourceLevel,
  DataSourceRoute,
  KolCloudDeleteResult,
  KolCloudExport,
  Pricing,
  ServiceSubscription,
  TopupOrder,
  TopupTiers,
  UsageGroup,
  UsageReport,
  WalletBalance,
} from '@agentsws/contracts'
import { DEFAULT_DATA_SOURCE_ORDER } from '@agentsws/contracts'
import { buildPricing, TOPUP_TIERS_FILE } from '@agentsws/metering'
import type { KolStore } from './kol.js'
import type { KolCloudCall, KolCloudCallFn, KolCloudSync } from './kol-cloud-sync.js'
import { createKolCloudSync } from './kol-cloud-sync.js'
import { CLOUD_BASE_URL_ENV, CLOUD_TOKEN_SECRET_ID, DEFAULT_CLOUD_BASE_URL } from './models.js'
import type { SecretStore } from './secret-store.js'

/** 余额缓存多久（毫秒）。 */
export const CREDITS_CACHE_MS = 60_000

/** 打云侧最多等多久：卡住不该拖着设置页。 */
export const CLOUD_TIMEOUT_MS = 8_000

export type CloudFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

interface CapabilitySourcesFile {
  version: 1
  capability_sources: CapabilitySources
  /**
   * WP126 数据接口路由：键 `kol.<channel>`，只存显式改过的那几条
   * （没存的渠道用 `DEFAULT_DATA_SOURCE_ORDER`）。
   */
  data_source_routing?: Record<string, DataSourceRoute>
  updated_at?: string
}

export interface CloudOptions {
  clock: Clock
  secrets: SecretStore
  env: Record<string, string | undefined>
  /** `capability-sources.json` 的目录；不给就全内存（测试与一次性任务）。 */
  dbDir?: string
  /** 测试注入；不给就用全局 `fetch`。 */
  fetch?: CloudFetch
  /**
   * 这个品牌的红人库（WP118 / 67 §3：云端红人库要同步的就是它）。
   *
   * 递**取值函数**而不是库本身，理由与 `kolService` 那一处逐字相同：打断装配期的环。
   * 不给就没有云端红人库这一格（那一组路由回一句人话，不是 500）——一次性任务与
   * 只跑模型面的进程不该被迫建一个红人库出来。
   */
  kol?: () => KolStore | undefined
}

export interface CloudAssembly {
  port: CloudPort
  /** 这台机器关联过 agentsws 账号没有（首页与模型卡问它）。 */
  linked(): boolean
  /**
   * WP68：某项能力现在用谁的（49 M2）。
   *
   * 端出来是因为**真的有模块要按它路由了**——WP59 那一版只有模型那一项按开关走，
   * 其余只存偏好；红人那五条渠道是第二处（`kol.<channel>`）。同步：路由那一跳
   * 要在拼请求之前就知道走哪条路，为一个本地文件里的布尔位加一次 await 不值当。
   */
  sourceOf(capability: string): CapabilitySource
  /**
   * WP126：某条渠道的数据接口路由（顺序 + 被关掉的那几级）。
   * 红人装配把它递给 `kol-service`，搜人那四级路由按它走。
   */
  routeOf(channel: 'youtube' | 'instagram' | 'tiktok' | 'facebook' | 'x'): DataSourceRoute
  /** 一项能力的价目（49 M4）。取不到就回 `undefined`——不编一个数。 */
  priceOf(capability: string): Promise<{ credits: number; unit: string } | undefined>
  /**
   * 红人营销增值服务的本地那一头（WP118 / 67 §3）。没装配红人库就没有它。
   *
   * 端出来是给关库那一跳用的（它手里有一个 sqlite 句柄），不是给路由用的——
   * 路由走 `port` 上那七个方法。
   */
  kolSync?: KolCloudSync
  /**
   * WP124：官方托管转发器的本月对话数（云侧 `GET /v1/chat/relay/status`）。
   * 取不到回 `undefined`——界面上显示「暂时取不到」，不编一个数。
   */
  relayCloudStatus(): Promise<
    | {
        conversations_this_month?: number
        limit?: number
        subscribed?: boolean
        offline_messages?: number
        /** WP128：托管实例的状态（订阅了客服增值服务、云端绑了托管对象才有）。 */
        hosted?: {
          state: 'running' | 'starting' | 'sleeping' | 'stopped'
          last_heartbeat_at?: string
        }
      }
    | undefined
  >
}

export function cloudBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env[CLOUD_BASE_URL_ENV]?.trim()
  return raw === undefined || raw === '' ? DEFAULT_CLOUD_BASE_URL : raw.replace(/\/+$/, '')
}

/** 本月一号零点（用量那条的起点）。 */
function monthStart(at: string): string {
  return `${at.slice(0, 7)}-01T00:00:00.000Z`
}

const NOT_LINKED =
  '还没关联 agentsws 账号。去"设置 → 账号与积分"里关联一次，就能用积分跑模型、看余额与用量。'

export function createCloud(options: CloudOptions): CloudAssembly {
  const { clock, secrets, env } = options
  const base = cloudBaseUrl(env)
  const stateFile =
    options.dbDir === undefined ? undefined : join(options.dbDir, 'capability-sources.json')

  let state: CapabilitySourcesFile = { version: 1, capability_sources: {} }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as CapabilitySourcesFile
      state = {
        version: 1,
        capability_sources: parsed.capability_sources ?? {},
        ...(parsed.data_source_routing === undefined
          ? {}
          : { data_source_routing: parsed.data_source_routing }),
        ...(parsed.updated_at === undefined ? {} : { updated_at: parsed.updated_at }),
      }
    } catch {
      // 第一次跑，或者文件坏了：从空开始（空 = 全部"用我的"，正是默认值）
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /** 工作区服务令牌（WP58 关联账号时存进去的）。取值即用，不缓存。 */
  const tokenOf = (): string | undefined => {
    if (!secrets.available) return undefined
    try {
      const token = secrets.get(CLOUD_TOKEN_SECRET_ID)?.token
      return token === undefined || token === '' ? undefined : token
    } catch {
      // 换过秘密库密钥：当成"没关联"
      return undefined
    }
  }

  const doFetch: CloudFetch =
    options.fetch ??
    ((input, init) =>
      globalThis.fetch(input, init as RequestInit) as unknown as ReturnType<CloudFetch>)

  /** 打一次云侧。令牌在这一行进头，函数返回之后没人再引用它。 */
  const callCloud = async <T>(
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T | undefined> => {
    const token = tokenOf()
    if (token === undefined) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, CLOUD_TIMEOUT_MS)
    try {
      const res = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      })
      if (!res.ok) return undefined
      const envelope = (await res.json()) as { data?: T }
      return envelope.data
    } catch {
      // 云连不上不是本地的错：界面上显示"暂时取不到"，不弹红框
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 打云侧一跳，**把状态码与那句人话一起带回来**。
   *
   * 与上面那个 `callCloud` 的差别就这一条，而这一条是全部：`callCloud` 是"取不到
   * 就 `undefined`"（余额与价目取不到，界面上显示"暂时取不到"就完了），而同步这一组
   * 要把云上那句话原样端给用户——**402「还没开通」与 503「云连不上」是两句话**，
   * 一句给"去开通"，一句给"稍后再试"，合成一句用户就不知道该怎么办了。
   */
  const cloudCall: KolCloudCallFn = async <T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<KolCloudCall<T>> => {
    const token = tokenOf()
    if (token === undefined) return { ok: false, status: 0 }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, CLOUD_TIMEOUT_MS)
    try {
      const res = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      })
      const payload = (await res.json().catch(() => undefined)) as
        | { data?: T; code?: string; message?: string }
        | undefined
      if (!res.ok)
        return {
          ok: false,
          status: res.status,
          ...(payload?.code === undefined ? {} : { code: payload.code }),
          message: payload?.message ?? `云上回了 ${String(res.status)}，这一次没有动你的数据。`,
        }
      return {
        ok: true,
        status: res.status,
        ...(payload?.data === undefined ? {} : { data: payload.data }),
      }
    } catch {
      // 超时 / 断网 / DNS：状态 0，界面上是"联系不上"，不是"出错了"
      return { ok: false, status: 0 }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 红人营销增值服务的本地那一头（67 §3）。
   *
   * 没装配红人库就没有它：那一组路由回一句人话（`not_implemented`），不是 500——
   * 一个只跑模型面的进程不该因为没建红人库就在设置页上挂一个红框。
   */
  const kolSync =
    options.kol === undefined
      ? undefined
      : createKolCloudSync({
          clock,
          store: options.kol,
          call: cloudCall,
          linked: () => tokenOf() !== undefined,
          ...(options.dbDir === undefined ? {} : { dbDir: options.dbDir }),
        })

  const kolSyncOf = (): KolCloudSync => {
    if (kolSync === undefined)
      throw new ApiError('not_implemented', '这个服务进程没有装配红人库，云端红人库这一格用不了。')
    return kolSync
  }

  /**
   * 云侧那一跳的失败 → 一句人话 + 一个不吓人的码。
   *
   * 三档，界面上是三张不同的脸：**没关联账号**（去关联）、**402**（这一项要付费 /
   * 欠费暂停，数据一条没动）、**云连不上**（稍后再试）。全归成 500 的话，用户看到
   * 的是"系统坏了"，而三件里没有一件是系统坏了。
   */
  const unwrap = <T>(res: KolCloudCall<T>, action: string): T => {
    if (res.ok && res.data !== undefined) return res.data
    if (res.status === 0)
      throw new ApiError(
        'provider_unavailable',
        res.message ?? `云上暂时${action}不了（联系不上）。你的数据一条没动，稍后再试一次。`,
      )
    if (res.status === 402)
      throw new ApiError('budget_exhausted', res.message ?? `这一项要付费：${action}暂停了。`)
    if (res.status >= 500)
      throw new ApiError(
        'provider_unavailable',
        res.message ?? `云上出了点问题，这一次没有${action}。`,
      )
    throw new ApiError('invalid_input', res.message ?? `云上没答应这一次${action}。`)
  }

  let cached: { at: number; view: CloudCreditsView } | undefined

  const creditsView = async (): Promise<CloudCreditsView> => {
    const nowMs = Date.parse(clock.now())
    if (cached !== undefined && nowMs - cached.at < CREDITS_CACHE_MS) return cached.view
    if (tokenOf() === undefined) {
      const view: CloudCreditsView = { linked: false, reason: NOT_LINKED }
      cached = { at: nowMs, view }
      return view
    }
    const at = clock.now()
    const [balance, usage] = await Promise.all([
      callCloud<WalletBalance>('/v1/wallet'),
      callCloud<{ total_credits: number }>(
        `/v1/wallet/usage?group=capability&from=${encodeURIComponent(monthStart(at))}`,
      ),
    ])
    const view: CloudCreditsView =
      balance === undefined
        ? {
            linked: true,
            reason: '暂时取不到余额（云上连不通或者令牌被撤了）。稍后再看一眼。',
            fetched_at: at,
          }
        : {
            linked: true,
            balance,
            month_credits: usage?.total_credits ?? 0,
            fetched_at: at,
          }
    cached = { at: nowMs, view }
    return view
  }

  /** 云上的价目表；取不到就回本地内置那一份——价目表不该因为断网就一片空白。 */
  const pricingView = async (): Promise<Pricing> =>
    (await callCloud<Pricing>('/v1/wallet/pricing')) ?? buildPricing()

  const settingsOf = (actor: CloudActor): CapabilitySourceSettings => ({
    workspace_id: actor.workspace_id,
    capability_sources: { ...state.capability_sources },
    ...(state.data_source_routing === undefined
      ? {}
      : { data_source_routing: state.data_source_routing }),
    ...(state.updated_at === undefined ? {} : { updated_at: state.updated_at }),
  })

  /**
   * 用量明细。**不缓存**：用户是特意点开"按天看一眼"的，给他一份 60 秒前的没有意义。
   * 看得到多少由云上那把令牌的 scope 说了算，本地不做第二次裁剪。
   */
  const usageView = async (filter: {
    group: UsageGroup
    from?: string | undefined
    to?: string | undefined
  }): Promise<UsageReport | undefined> => {
    const query = new URLSearchParams({
      group: filter.group,
      from: filter.from ?? monthStart(clock.now()),
    })
    /*
     * **不给 `to` 就不传 `to`。**
     *
     * 本机的钟和云上的钟不是一个钟（时区、NTP 漂移、虚拟机挂起）。本地这一头
     * 算一个"现在"发过去，等于用一个可能慢几秒到几小时的钟去裁云上的账——
     * 最近那几笔会凭空消失，而用户看到的是"我明明刚用过"。上界由云侧自己定。
     */
    if (filter.to !== undefined) query.set('to', filter.to)
    return callCloud<UsageReport>(`/v1/wallet/usage?${query.toString()}`)
  }

  /**
   * 充值四档。云上取不到就回本地内置那一份——四张卡不该因为断网就一片空白
   * （与价目表同一条理由）。
   */
  const tiersView = async (): Promise<TopupTiers> =>
    (await callCloud<TopupTiers>('/v1/wallet/topup/tiers')) ?? TOPUP_TIERS_FILE

  /**
   * 按档建一笔充值单。
   *
   * **本地只转发一个档位 id**，金额由云上那张表说了算——本地算一遍金额等于
   * 多一份会跟云上分岔的价目表。没关联账号 / 云上没配 Stripe 都回一句人话。
   */
  const createTopupOrder = async (tier_id: string): Promise<TopupOrder> => {
    if (tokenOf() === undefined) throw new ApiError('invalid_input', NOT_LINKED)
    const order = await callCloud<TopupOrder>('/v1/wallet/topup', {
      method: 'POST',
      body: JSON.stringify({ provider: 'stripe', tier_id }),
    })
    if (order === undefined)
      throw new ApiError(
        'provider_unavailable',
        '云上暂时建不了充值单（连不通，或者那边还没接上支付）。稍后再试一次。',
      )
    return order
  }

  const port: CloudPort = {
    credits: () => creditsView(),
    pricing: () => pricingView(),
    usage: (_actor, filter) => usageView(filter),
    topupTiers: () => tiersView(),
    createTopup: (_actor, input) => createTopupOrder(input.tier_id),
    kolCloudStatus: async () => {
      const engine = kolSyncOf()
      /*
       * 读状态那一跳顺带把排队的东西补上去（限流在引擎里，5 分钟最多一次）。
       * 放在这里而不是起一个定时任务：用户打开这一页就是"我想看看同步了没有"，
       * 而这一刻补一趟，比让他再点一次「立即同步」少一步。
       */
      engine.autoDrain()
      return engine.status()
    },
    kolCloudSync: async () => kolSyncOf().sync(),
    kolCloudSubscribe: async () => {
      if (tokenOf() === undefined) throw new ApiError('invalid_input', NOT_LINKED)
      return unwrap(
        await cloudCall<ServiceSubscription>('/v1/kol/subscription', { method: 'POST' }),
        '开通',
      )
    },
    kolCloudCancel: async () => {
      if (tokenOf() === undefined) throw new ApiError('invalid_input', NOT_LINKED)
      return unwrap(
        await cloudCall<ServiceSubscription>('/v1/kol/subscription', { method: 'DELETE' }),
        '取消',
      )
    },
    kolCloudResolveConflict: (_actor, input) => kolSyncOf().resolveConflict(input),
    kolCloudExport: async () => {
      if (tokenOf() === undefined) throw new ApiError('invalid_input', NOT_LINKED)
      return unwrap(await cloudCall<KolCloudExport>('/v1/kol/cloud/export'), '导出')
    },
    kolCloudDelete: async () => {
      if (tokenOf() === undefined) throw new ApiError('invalid_input', NOT_LINKED)
      return unwrap(
        await cloudCall<KolCloudDeleteResult>('/v1/kol/cloud', { method: 'DELETE' }),
        '删除',
      )
    },
    capabilitySources: (actor) => settingsOf(actor),
    setCapabilitySources(actor, input) {
      /*
       * **只存显式改过的那几项**：值是 `mine` 的一律不落盘。
       *
       * 为什么：`mine` 是默认，把默认值也写进文件等于把"今天的默认"腌成"这台机器的
       * 设置"——以后默认值真要改（比如某项能力本地那条没了），这些行会挡着。
       *
       * WP126：`data_source_routing` 同理，只存非空的渠道条目；空条目 = 回默认。
       */
      const next: CapabilitySources = {}
      for (const [capability, source] of Object.entries(input.capability_sources)) {
        if (source === 'agentsws') next[capability] = source
      }
      const routingInput = input.data_source_routing
      // WP126：与已存的路由**合并**（每次只改一个渠道的表）；空条目 = 那一渠道回默认
      const routing: Record<string, DataSourceRoute> | undefined =
        routingInput === undefined && state.data_source_routing === undefined
          ? undefined
          : { ...(state.data_source_routing ?? {}) }
      if (routingInput !== undefined && routing !== undefined)
        for (const [channel, entry] of Object.entries(routingInput)) {
          const order = entry.order.filter(
            (l): l is DataSourceLevel =>
              l === 'official_key' || l === 'byo_source' || l === 'workshop',
          )
          const disabled = entry.disabled.filter(
            (l): l is DataSourceLevel =>
              l === 'official_key' || l === 'byo_source' || l === 'workshop',
          )
          if (order.length === 0 && disabled.length === 0) delete routing[channel]
          else routing[channel] = { order, disabled }
        }
      state = {
        version: 1,
        capability_sources: next,
        ...(routing === undefined ? {} : { data_source_routing: routing }),
        updated_at: clock.now(),
      }
      flush()
      return settingsOf(actor)
    },
  }

  return {
    port,
    ...(kolSync === undefined ? {} : { kolSync }),
    relayCloudStatus: () => callCloud('/v1/chat/relay/status'),
    linked: () => tokenOf() !== undefined,
    sourceOf: (capability) => state.capability_sources[capability] ?? 'mine',
    /**
     * WP126：某条渠道的数据接口路由（顺序 + 被关掉的那几级）。
     * 没存的渠道回默认顺序。
     */
    routeOf: (channel) =>
      state.data_source_routing?.[`kol.${channel}`] ?? {
        order: [...DEFAULT_DATA_SOURCE_ORDER],
        disabled: [],
      },
    priceOf: async (capability) => {
      const found = (await pricingView()).entries.find((e) => e.capability === capability)
      return found === undefined ? undefined : { credits: found.credits_per_unit, unit: found.unit }
    },
  }
}
