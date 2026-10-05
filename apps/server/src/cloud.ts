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
  AllocationAuditList,
  AllocationLimitChanged,
  AllocationLimitRequest,
  AllocationMemberRemoved,
  AllocationReport,
  AllocationRosterRequest,
  AllocationRosterSynced,
  Attribution,
  CapabilitySource,
  CapabilitySourceSettings,
  CapabilitySources,
  Clock,
  CloudAllocationView,
  CloudCreditsView,
  CloudMyAllocationView,
  DataSourceLevel,
  DataSourceRoute,
  KolCloudDeleteResult,
  KolCloudExport,
  LocalPricing,
  LocalTopupTiers,
  MyAllocation,
  RedditBrowserReadLimits,
  ServiceSubscription,
  TopupOrder,
  UsageGroup,
  UsageReport,
  WalletBalance,
} from '@agentsws/contracts'
import {
  ALLOCATION_WEB_PATH,
  allocationTimezoneOf,
  attributionHeaders,
  clampRedditBrowserReadLimits,
  DATA_CAPABILITY_ROUTE_LEVELS,
  DATA_CAPABILITY_ROUTE_PREFIX,
  DEFAULT_ALLOCATION_TIMEZONE,
  DEFAULT_DATA_CAPABILITY_ORDER,
  DEFAULT_DATA_SOURCE_ORDER,
  DEFAULT_REDDIT_BROWSER_READ_LIMITS,
  DEFAULT_REDDIT_READ_ORDER,
  DEFAULT_WEB_SEARCH_ORDER,
  dataCapabilityRouteKey,
  REDDIT_READ_ROUTE_KEY,
  REDDIT_READ_ROUTE_LEVELS,
  WEB_SEARCH_ROUTE_KEY,
} from '@agentsws/contracts'
import { currentCloudHeaders } from './cloud-attribution.js'
import type { KolStore } from './kol.js'
import type { KolCloudCall, KolCloudCallFn, KolCloudSync } from './kol-cloud-sync.js'
import { createKolCloudSync } from './kol-cloud-sync.js'
import { CLOUD_BASE_URL_ENV, CLOUD_TOKEN_SECRET_ID, DEFAULT_CLOUD_BASE_URL } from './models.js'
import { createPricingCatalog, type PricingCatalogSource } from './pricing-catalog.js'
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
  /** WP220：Reddit 浏览器只读的限速（只存改过的；没存用默认）。 */
  reddit_browser_read?: RedditBrowserReadLimits
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
  /**
   * WP165：价目从哪来（云上公开的 `/v1/pricing` + 本机缓存）。价目不分品牌，服务进程
   * 建一份、各品牌共用；不给就自己建一份（缓存落在 `dbDir`）。
   */
  pricingCatalog?: PricingCatalogSource
  /**
   * WP194：一条职责归哪个岗位（`positions.positionOf`）。打云时据此带 `X-Agentsws-Position`；
   * 取值函数——岗位面在云面之后才装好。不给 = 只带「谁」，不带岗位。
   */
  positionOf?: (role_id: string) => string | undefined
  /**
   * WP194：公司时区（工作区档案的 `tz`）。改额度时顺手告诉云上（自然月按它切）；
   * 只认 IANA 名（`Asia/Shanghai`），`+08:00` 这种偏移不传（云上缺省就是上海）。
   */
  timeZone?: () => Promise<string | undefined> | string | undefined
  /**
   * WP194：这个人能不能管公司的积分（公司的 owner / admin，或本工作区所有者职责的持有人）。
   * 不给 = 谁都不能看公司那一页（最保守：漏放一个人看全公司的账比多拦一次糟）。
   */
  canManage?: (
    actor: CloudActor,
  ) => Promise<'owner' | 'admin' | boolean | undefined> | 'owner' | 'admin' | boolean | undefined
  /**
   * WP194：本机公司的名册——成员 / 岗位的名字（云上只有 id，「积分」页与 100% 提醒信要名字），
   * 与提醒信发给谁（公司的 owner / admin 的邮箱）。取值函数：名册在云面之后才装好。
   */
  directory?: () => Promise<CreditsDirectory> | CreditsDirectory
}

/** WP194：本机公司的名册（给「积分」页与提醒信用）。 */
export interface CreditsDirectory {
  members: Record<string, string>
  positions: Record<string, string>
  /** 公司的 owner / admin 的邮箱（用到 100% 时那封提醒信发给他们）。 */
  notify_emails: string[]
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
  /**
   * WP179：网页搜索这一项能力（`web.search`）的路由。默认第一级就是官方那条
   * （`deepseek_native`，对外叫「用你的 DeepSeek 账号搜索」）；用户在设置里关掉就是 `disabled` 里有它。
   */
  webSearchRoute(): DataSourceRoute
  /**
   * WP194：删成员时把他在云上的额度行清掉（历史用量保留）。**尽力而为**：没关联 / 连不上
   * 不拦删人——本地这一刀已经切了，云上那一行留着也不会再被用到（他不再出现在请求头里）。
   */
  forgetMember(person_id: string, by: string): Promise<boolean>
  /**
   * WP206：把这个工作区的名册推上云（成员 id + 名字 + 持有的岗位、岗位 id + 名字；不带业务内容），
   * 网页版账号页「成员额度」据此列人。没关联回 `false`；连不上 / 云上拒了也回 `false`（下一轮再推）。
   */
  syncRoster(roster: AllocationRosterRequest): Promise<boolean>
  /**
   * WP192：官方数据接口统一能力口那些能力（`maps.places`、`serp.google`……）的路由，
   * 键 `data.<能力>`。默认只有「Agents 工坊（用积分）」一级（`workshop`）。
   */
  dataRouteOf(capability: string): DataSourceRoute
  /**
   * WP220（Luoye 10-05）：Reddit 取数的路由（键 `reddit.read`）。默认 ①接口中台（`workshop`）
   * → ②浏览器只读（`browser_readonly`）；每个品牌可调顺序、可关某一路。
   */
  redditReadRoute(): DataSourceRoute
  /** WP220：Reddit 浏览器只读那一路的限速（没改过就是保守的默认值）。 */
  redditBrowserReadLimits(): RedditBrowserReadLimits
  /**
   * WP192：打云侧一跳、把状态码与那句人话一起带回来（与红人云同步那一组同一个函数）。
   * 数据能力口（`/v1/data/capabilities`、`/v1/data/call/*`、`/v1/data/tasks*`）经它走。
   */
  call: KolCloudCallFn
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
  '还没关联 Agents 工坊账号。去"设置 → 账号与积分"里关联一次，就能用积分跑模型、看余额与用量。'

export function createCloud(options: CloudOptions): CloudAssembly {
  const { clock, secrets, env } = options
  const base = cloudBaseUrl(env)
  const catalog =
    options.pricingCatalog ??
    createPricingCatalog({
      clock,
      baseUrl: base,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.dbDir === undefined ? {} : { dir: options.dbDir }),
    })
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
        ...(parsed.reddit_browser_read === undefined
          ? {}
          : { reddit_browser_read: clampRedditBrowserReadLimits(parsed.reddit_browser_read) }),
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
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
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
          // WP194：算在谁头上（作用域里的那一份；显式给的优先）
          ...currentCloudHeaders(),
          ...init.headers,
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
  const cloudCall = async <T>(
    path: string,
    init: {
      method?: string
      body?: unknown
      headers?: Record<string, string>
      timeout_ms?: number
    } = {},
  ): Promise<KolCloudCall<T>> => {
    const token = tokenOf()
    if (token === undefined) return { ok: false, status: 0 }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, init.timeout_ms ?? CLOUD_TIMEOUT_MS)
    try {
      const res = await doFetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...currentCloudHeaders(),
          ...init.headers,
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

  /**
   * WP194：这一次算在谁头上——本机公司成员（`person_id`）+ 这条职责归的岗位。
   * 云上的令牌是工作区级的、分不出人，所以由持令牌的本机服务在请求头里声明。
   */
  const whoOf = (actor: CloudActor): Attribution => {
    const position = options.positionOf?.(actor.role_id)
    return {
      member_id: actor.person_id,
      ...(position === undefined ? {} : { position_id: position }),
    }
  }
  const headersOf = (actor: CloudActor): Record<string, string> => attributionHeaders(whoOf(actor))

  const directoryOf = async (): Promise<CreditsDirectory> => {
    try {
      return (await options.directory?.()) ?? { members: {}, positions: {}, notify_emails: [] }
    } catch {
      return { members: {}, positions: {}, notify_emails: [] }
    }
  }

  /**
   * 公司时区与提醒信收件人（改额度前推一次，尽力而为）。时区：IANA 名原样、`+08:00` 这类偏移换算后推，
   * 认不出的按上海（Fable 09-29 定；界面上注一句「按北京时间切月」）。
   */
  const pushSettings = async (directory: CreditsDirectory): Promise<void> => {
    try {
      const tz = allocationTimezoneOf(await options.timeZone?.()) ?? DEFAULT_ALLOCATION_TIMEZONE
      await cloudCall('/v1/wallet/allocation/settings', {
        method: 'POST',
        body: { timezone: tz, notify_emails: directory.notify_emails.slice(0, 20) },
      })
    } catch {
      /* 没推上去不拦改额度：云上照上海时区切，提醒信照样发给组织 owner */
    }
  }

  const MANAGERS_ONLY = '只有公司的所有者和管理员看得到、改得了公司的积分分配。'
  const assertManager = async (actor: CloudActor): Promise<'owner' | 'admin'> => {
    const role = await options.canManage?.(actor)
    if (role === 'admin') return 'admin'
    if (role === 'owner' || role === true) return 'owner'
    throw new ApiError('forbidden', MANAGERS_ONLY)
  }

  /** 公司「积分」页那一份（管理员看）。 */
  const allocationView = async (
    actor: CloudActor,
    month: string | undefined,
  ): Promise<CloudAllocationView> => {
    if (tokenOf() === undefined) return { linked: false, reason: NOT_LINKED }
    const query = month === undefined ? '' : `?month=${encodeURIComponent(month)}`
    const res = await cloudCall<AllocationReport>(`/v1/wallet/allocation${query}`, {
      headers: headersOf(actor),
    })
    if (res.ok && res.data !== undefined) {
      // 公司的 admin 不一定进得了设置 → 积分那一页，余额与名字在这里一并给
      const [balance, directory] = await Promise.all([
        callCloud<WalletBalance>('/v1/wallet'),
        directoryOf(),
      ])
      return {
        linked: true,
        report: res.data,
        ...(balance === undefined ? {} : { balance }),
        names: { members: directory.members, positions: directory.positions },
      }
    }
    return {
      linked: true,
      reason:
        res.status === 0
          ? '暂时取不到（云上连不通）。稍后再看一眼。'
          : (res.message ?? '暂时取不到公司的额度与用量。'),
    }
  }

  /**
   * 「我的本月额度」（成员自己看）。WP206：看的人是公司的 owner / admin 时顺带给网页「成员额度」页的地址
   * ——额度分配只在网页上做，设置 → 积分据此画「给同事分额度 → 在网页上」。
   */
  const myAllocationView = async (actor: CloudActor): Promise<CloudMyAllocationView> => {
    let role: 'owner' | 'admin' | undefined
    try {
      const r = await options.canManage?.(actor)
      role = r === 'admin' ? 'admin' : r === 'owner' || r === true ? 'owner' : undefined
    } catch {
      role = undefined
    }
    const manager =
      role === undefined ? {} : { role, allocation_url: `${base}${ALLOCATION_WEB_PATH}` }
    if (tokenOf() === undefined) return { linked: false, reason: NOT_LINKED, ...manager }
    const res = await cloudCall<MyAllocation>('/v1/wallet/allocation/me', {
      headers: headersOf(actor),
    })
    if (res.ok && res.data !== undefined) return { linked: true, mine: res.data, ...manager }
    return {
      linked: true,
      reason: res.status === 0 ? '暂时取不到（云上连不通）。' : (res.message ?? '暂时取不到。'),
      ...manager,
    }
  }

  let cached: { at: number; view: CloudCreditsView } | undefined
  /** WP198b：网页账号页。工作台不知道云地址，这里按本机连的那朵云填；没关联也给。 */
  const accountUrl = `${base}/account`

  const creditsView = async (): Promise<CloudCreditsView> => {
    const nowMs = Date.parse(clock.now())
    /*
     * WP140：关联状态一变就不认缓存。否则刚关联完的 60 秒里（demo 的合成时钟不走时
     * 就是永远）设置页还说「还没关联」——缓存省的是打云的次数，不该挡住状态变化。
     */
    const linkedNow = tokenOf() !== undefined
    if (
      cached !== undefined &&
      cached.view.linked === linkedNow &&
      nowMs - cached.at < CREDITS_CACHE_MS
    )
      return cached.view
    if (!linkedNow) {
      const view: CloudCreditsView = { linked: false, reason: NOT_LINKED, account_url: accountUrl }
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
            account_url: accountUrl,
          }
        : {
            linked: true,
            balance,
            month_credits: usage?.total_credits ?? 0,
            fetched_at: at,
            account_url: accountUrl,
          }
    cached = { at: nowMs, view }
    return view
  }

  /**
   * 云上的价目表（WP165：公开的 `/v1/pricing`，不要令牌）。取不到用本机存的上一份；
   * 从没取到过就回一份空的、带一句「价目暂时拿不到」——**不编数**（价目不再内置进开源仓）。
   */
  const pricingView = (): Promise<LocalPricing> => catalog.pricing()

  const settingsOf = (actor: CloudActor): CapabilitySourceSettings => ({
    workspace_id: actor.workspace_id,
    capability_sources: { ...state.capability_sources },
    ...(state.data_source_routing === undefined
      ? {}
      : { data_source_routing: state.data_source_routing }),
    ...(state.reddit_browser_read === undefined
      ? {}
      : { reddit_browser_read: { ...state.reddit_browser_read } }),
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
   * 充值四档（与价目表同一份、同一条路：云上公开的 `/v1/pricing` + 本机缓存）。
   * 从没取到过就是空的，界面上说「价目暂时拿不到」。
   */
  const tiersView = (): Promise<LocalTopupTiers> => catalog.topupTiers()

  /**
   * 按档建一笔充值单。
   *
   * **本地只转发一个档位 id**，金额由云上那张表说了算——本地算一遍金额等于
   * 多一份会跟云上分岔的价目表。没关联账号 / 云上没配 Stripe 都回一句人话。
   */
  const createTopupOrder = async (tier_id: string): Promise<TopupOrder> => {
    if (tokenOf() === undefined) throw new ApiError('invalid_input', NOT_LINKED)
    /*
     * WP142：走带人话的那一跳（`cloudCall`）——云上说了为什么建不了（demo 替身的「不真收钱」、
     * 还没接上支付……），就把那一句原样端给用户；连都连不上才用下面这句兜底。
     */
    const out = await cloudCall<TopupOrder>('/v1/wallet/topup', {
      method: 'POST',
      body: { provider: 'stripe', tier_id },
    })
    if (out.ok && out.data !== undefined) return out.data
    throw new ApiError(
      'provider_unavailable',
      !out.ok && out.status !== 0 && out.message !== undefined
        ? out.message
        : '云上暂时建不了充值单（连不通，或者那边还没接上支付）。稍后再试一次。',
    )
  }

  const port: CloudPort = {
    // WP194：成员 / 岗位额度（谁能看公司那一页在路由那一层判：公司的 owner / admin）
    allocation: async (actor, filter) => {
      const role = await assertManager(actor)
      return { ...(await allocationView(actor, filter.month)), role }
    },
    myAllocation: (actor) => myAllocationView(actor),
    setAllocationLimit: async (actor, input: AllocationLimitRequest) => {
      await assertManager(actor)
      if (tokenOf() === undefined) throw new ApiError('invalid_input', NOT_LINKED)
      const directory = await directoryOf()
      await pushSettings(directory)
      // 名字只进 100% 那封提醒信（云上别处只认 id）
      const label =
        input.label ??
        (input.kind === 'member'
          ? directory.members[input.subject_id]
          : directory.positions[input.subject_id])
      return unwrap(
        await cloudCall<AllocationLimitChanged>('/v1/wallet/allocation/limits', {
          method: 'POST',
          body: { ...input, ...(label === undefined ? {} : { label }) },
          headers: headersOf(actor),
        }),
        '改额度',
      )
    },
    allocationAudit: async (actor) => {
      await assertManager(actor)
      if (tokenOf() === undefined) throw new ApiError('invalid_input', NOT_LINKED)
      return unwrap(
        await cloudCall<AllocationAuditList>('/v1/wallet/allocation/audit', {
          headers: headersOf(actor),
        }),
        '读改额度记录',
      )
    },
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
          // WP179：每一项能力只认它自己那几级——网页搜索只有官方那一级，红人渠道只有原来三级
          const levelOk = (l: DataSourceLevel): boolean =>
            channel === WEB_SEARCH_ROUTE_KEY
              ? l === 'deepseek_native'
              : // WP220：Reddit 取数只认「接口中台」与「浏览器只读」两路
                channel === REDDIT_READ_ROUTE_KEY
                ? REDDIT_READ_ROUTE_LEVELS.includes(l)
                : // WP192：数据能力口那些能力只认「自带数据接口」与「Agents 工坊（用积分）」两级
                  channel.startsWith(DATA_CAPABILITY_ROUTE_PREFIX)
                  ? DATA_CAPABILITY_ROUTE_LEVELS.includes(l)
                  : l === 'official_key' || l === 'byo_source' || l === 'workshop'
          const order = entry.order.filter((l): l is DataSourceLevel => levelOk(l))
          const disabled = entry.disabled.filter((l): l is DataSourceLevel => levelOk(l))
          if (order.length === 0 && disabled.length === 0) delete routing[channel]
          else routing[channel] = { order, disabled }
        }
      // WP220：限速不给就不改；给了就收进范围再存（出界的按边界收，不报错）
      const limits =
        input.reddit_browser_read === undefined
          ? state.reddit_browser_read
          : clampRedditBrowserReadLimits(input.reddit_browser_read)
      state = {
        version: 1,
        capability_sources: next,
        ...(routing === undefined ? {} : { data_source_routing: routing }),
        ...(limits === undefined ? {} : { reddit_browser_read: limits }),
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
    forgetMember: async (person_id, by) => {
      if (tokenOf() === undefined) return false
      const res = await cloudCall<AllocationMemberRemoved>('/v1/wallet/allocation/members/remove', {
        method: 'POST',
        body: { member_id: person_id },
        headers: attributionHeaders({ member_id: by }),
      })
      return res.ok
    },
    syncRoster: async (roster) => {
      if (tokenOf() === undefined) return false
      const res = await cloudCall<AllocationRosterSynced>('/v1/wallet/allocation/roster', {
        method: 'POST',
        body: roster,
      })
      return res.ok
    },
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
    webSearchRoute: () =>
      state.data_source_routing?.[WEB_SEARCH_ROUTE_KEY] ?? {
        order: [...DEFAULT_WEB_SEARCH_ORDER],
        disabled: [],
      },
    dataRouteOf: (capability) =>
      state.data_source_routing?.[dataCapabilityRouteKey(capability)] ?? {
        order: [...DEFAULT_DATA_CAPABILITY_ORDER],
        disabled: [],
      },
    redditReadRoute: () =>
      state.data_source_routing?.[REDDIT_READ_ROUTE_KEY] ?? {
        order: [...DEFAULT_REDDIT_READ_ORDER],
        disabled: [],
      },
    redditBrowserReadLimits: () => ({
      ...(state.reddit_browser_read ?? DEFAULT_REDDIT_BROWSER_READ_LIMITS),
    }),
    call: cloudCall,
    priceOf: async (capability) => {
      /*
       * WP165：关联了账号才去云上按需刷新（与以前「关联了才打云」同一个口径：搜红人每一次都要问价，
       * 没关联的机器不该因为一次本机搜索就去敲云）；没关联就只读手上存的那一份。
       */
      if (tokenOf() !== undefined) await catalog.refresh()
      const found = catalog.current()?.pricing.entries.find((e) => e.capability === capability)
      return found === undefined ? undefined : { credits: found.credits_per_unit, unit: found.unit }
    },
  }
}
