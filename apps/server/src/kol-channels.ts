/**
 * WP68（48 §5.4）：五条渠道适配器**真打出去的那一跳**。
 *
 * `@agentsws/kol-core` 的适配器是纯的（没有 fetch、碰不到凭据）；真 HTTP 在这里。
 * 这个文件就是那条 `KolChannelTransport` 的实现：把"渠道 + 动作 + 参数"翻成
 * 一条真请求，凭据按连接从**本机加密库**取，返回值整理成适配器认得的形状。
 *
 * 五条纪律：
 *
 * 1. **不带任何真 key**。仓库里一个字节的凭据都没有；token 只从
 *    `SecretStore`（这个品牌那一段）按连接 id 取，取出来直接进请求头 / 查询串，
 *    函数返回之后没人再引用它。日志、事件、错误信封里都没有它。
 * 2. **真 HTTP 形状照各家公开文档写**（Data API v3 / Graph v21.0 /
 *    Research API v2 / X API v2）。没有真账号可验的地方，宁可照文档写死字段名，
 *    也不"先随便写一个，跑起来再说"——跑不起来的时候人只会以为是没连上。
 * 3. **上游的错原样带一段**给适配器去分类（`needs_approval` / `quota_exhausted` /
 *    `upstream_error` 三种人话在 `kol-core` 那一边判）。这里不判，只搬。
 * 4. **基准（`get_benchmark`）本地永远没有**：k-匿名要全网样本，那是云上公共库的事
 *    （48 §5.3）。这里回 `undefined`，适配器据此在面板上留白，而不是弹一个错。
 * 5. **没连就是没连**：`connected()` 只看这个品牌现在真有没有那条连接。
 */
import type { Clock, KolChannel, WorkspaceId } from '@agentsws/contracts'
import { KOL_CHANNELS } from '@agentsws/contracts'
import type { KolChannelAdapter, KolChannelTransport } from '@agentsws/kol-core'
import { createChannelAdapters } from '@agentsws/kol-core'
import type { SecretStore } from './secret-store.js'

/** 注入的 fetch（测试塞一个假的；生产用全局那一个）。 */
export type KolFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** 打一跳最多等多久。卡住不该拖着整张找人清单。 */
export const KOL_HTTP_TIMEOUT_MS = 12_000

/** Graph API 的版本。**只有这一处**——五个地方各写一个版本号迟早分叉。 */
export const GRAPH_VERSION = 'v21.0'

/** 各家的接口根地址（换环境时只改这一张表）。 */
export const KOL_API_BASE: Readonly<Record<KolChannel, string>> = {
  youtube: 'https://www.googleapis.com/youtube/v3',
  facebook: `https://graph.facebook.com/${GRAPH_VERSION}`,
  instagram: `https://graph.facebook.com/${GRAPH_VERSION}`,
  tiktok: 'https://open.tiktokapis.com/v2',
  x: 'https://api.x.com/2',
}

/**
 * 每条渠道的凭据在加密库那条记录里叫什么。
 *
 * 与连接目录（`catalog.ts`）的表单字段名**必须一致**——那边填进去、这边取出来，
 * 两处对不上的表现是"填完了还是说没连"，而那是最难查的一种。
 */
export const KOL_TOKEN_FIELD: Readonly<Record<KolChannel, string>> = {
  youtube: 'api_key',
  facebook: 'access_token',
  instagram: 'access_token',
  tiktok: 'access_token',
  x: 'bearer_token',
}

/** 连接器 kind（`youtube_data` / `facebook_graph` / …）→ 渠道。 */
export const CHANNEL_OF_CONNECTOR: Readonly<Record<string, KolChannel>> = Object.fromEntries(
  KOL_CHANNELS.map((c) => [c.connector_kind, c.id]),
)

/** 这个进程看得到的一条连接（`ConnectionsAssembly.liveConnections()` 那一份）。 */
export interface KolConnectionRef {
  id: string
  service: string
  status: string
}

export interface KolChannelsOptions {
  workspace_id: WorkspaceId
  clock: Clock
  /** 现在这个品牌真有哪些连接（只有 id / service / 状态，**没有凭据**）。 */
  connections(): KolConnectionRef[]
  /** 这个品牌那一段加密库（凭据按连接 id 取）。 */
  secrets: SecretStore
  fetch?: KolFetch
}

export interface KolChannelsAssembly {
  transport: KolChannelTransport
  /** 五条渠道的适配器（按渠道分派只有 `kol-core` 的 `createChannelAdapters` 一处）。 */
  adapters: Record<KolChannel, KolChannelAdapter>
}

/** 一条要打出去的请求。凭据已经拼进去了，所以这个对象不进日志。 */
interface Outgoing {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

/** `?a=1&b=2`；值是 `undefined` 的那几格不出现（不发一个 `&q=undefined`）。 */
function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v))
  const s = q.toString()
  return s === '' ? '' : `?${s}`
}

const str = (params: Record<string, unknown>, key: string): string | undefined => {
  const v = params[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}
const num = (params: Record<string, unknown>, key: string): number | undefined => {
  const v = params[key]
  return typeof v === 'number' ? v : undefined
}

/* ── 各家的真形状（照公开文档写） ─────────────────────────────────────── */

/** YouTube Data API v3。凭据是 API key，走查询串 `key=`（官方文档就是这么给的）。 */
function youtubeRequest(
  action: string,
  params: Record<string, unknown>,
  token: string,
): Outgoing | undefined {
  const base = KOL_API_BASE.youtube
  switch (action) {
    case 'search_channels':
      // search.list 一次 100 单位（全站一天 10000），所以它不是可以随便点的按钮
      return {
        method: 'GET',
        url: `${base}/search${query({
          part: 'snippet',
          type: 'channel',
          q: str(params, 'q'),
          maxResults: num(params, 'maxResults') ?? 25,
          regionCode: str(params, 'regionCode'),
          relevanceLanguage: str(params, 'relevanceLanguage'),
          key: token,
        })}`,
        headers: { accept: 'application/json' },
      }
    case 'list_channels':
      return {
        method: 'GET',
        url: `${base}/channels${query({
          part: 'snippet,statistics,topicDetails',
          id: str(params, 'id'),
          key: token,
        })}`,
        headers: { accept: 'application/json' },
      }
    case 'get_channel': {
      const handle = str(params, 'handle')
      return {
        method: 'GET',
        // `forHandle` 收的是带不带 @ 都认的那个名字（2024 年 Data API 加的）
        url: `${base}/channels${query({
          part: 'snippet,statistics,topicDetails',
          forHandle: handle === undefined ? undefined : `@${handle.replace(/^@/, '')}`,
          key: token,
        })}`,
        headers: { accept: 'application/json' },
      }
    }
    default:
      return undefined
  }
}

/** Facebook Graph API。凭据是 Page / App access token，走查询串 `access_token=`。 */
function facebookRequest(
  action: string,
  params: Record<string, unknown>,
  token: string,
): Outgoing | undefined {
  const base = KOL_API_BASE.facebook
  const PAGE_FIELDS = 'id,name,username,followers_count,fan_count,category,link,about'
  switch (action) {
    case 'search_pages':
      // `/pages/search` 要 Page Public Content Access（审核制）——没批下来上游回 (#10)
      return {
        method: 'GET',
        url: `${base}/pages/search${query({
          q: str(params, 'q'),
          fields: PAGE_FIELDS,
          limit: num(params, 'limit') ?? 25,
          access_token: token,
        })}`,
        headers: { accept: 'application/json' },
      }
    case 'get_page':
      return {
        method: 'GET',
        // `emails` 只有主页管理员自己读得到；别人读到的是这一格不出现
        url: `${base}/${encodeURIComponent(str(params, 'page_id') ?? '')}${query({
          fields: `${PAGE_FIELDS},emails`,
          access_token: token,
        })}`,
        headers: { accept: 'application/json' },
      }
    default:
      return undefined
  }
}

/**
 * Instagram Graph API 的 `business_discovery`。
 *
 * 它挂在**你自己那个** IG 商业账号下（`/{ig-user-id}?fields=business_discovery.username(...)`），
 * 所以连接表单里除了 token 还要一个 `ig_user_id`。没有它这一跳打不出去——
 * 那不是"没连"，是"连是连了但少填一格"，所以这里的错也说成那样。
 */
function instagramRequest(
  action: string,
  params: Record<string, unknown>,
  token: string,
  igUserId: string | undefined,
): Outgoing | undefined {
  if (action !== 'business_discovery') return undefined
  if (igUserId === undefined)
    throw new Error(
      'Instagram 这条连接少了「你自己的 IG 商业账号 id」那一格（business_discovery 要挂在它下面）。去连接页把 Instagram 那张卡补全。',
    )
  const username = (str(params, 'username') ?? '').replace(/^@/, '')
  const inner =
    'username,name,followers_count,follows_count,media_count,biography,website,profile_picture_url'
  return {
    method: 'GET',
    url: `${KOL_API_BASE.instagram}/${encodeURIComponent(igUserId)}${query({
      fields: `business_discovery.username(${username}){${inner}}`,
      access_token: token,
    })}`,
    headers: { accept: 'application/json' },
  }
}

/** TikTok Research API v2。凭据是 client access token，走 `Authorization: Bearer`。 */
function tiktokRequest(
  action: string,
  params: Record<string, unknown>,
  token: string,
): Outgoing | undefined {
  if (action !== 'get_user') return undefined
  return {
    method: 'POST',
    url: `${KOL_API_BASE.tiktok}/research/user/info/${query({
      fields:
        'display_name,follower_count,following_count,likes_count,video_count,bio_description,is_verified',
    })}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ username: (str(params, 'username') ?? '').replace(/^@/, '') }),
  }
}

/** X API v2。凭据是 App-only Bearer token。 */
function xRequest(
  action: string,
  params: Record<string, unknown>,
  token: string,
): Outgoing | undefined {
  const base = KOL_API_BASE.x
  const fields = 'public_metrics,description,location,verified,profile_image_url'
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
  switch (action) {
    case 'search_users':
      // v2 没有"按关键词搜人"；有的是一次最多 100 个的批量按名字查
      return {
        method: 'GET',
        url: `${base}/users/by${query({
          usernames: str(params, 'usernames'),
          'user.fields': fields,
        })}`,
        headers,
      }
    case 'get_user':
      return {
        method: 'GET',
        url: `${base}/users/by/username/${encodeURIComponent((str(params, 'username') ?? '').replace(/^@/, ''))}${query(
          { 'user.fields': fields },
        )}`,
        headers,
      }
    default:
      return undefined
  }
}

/* ── 回来那一份 → 适配器认得的形状 ───────────────────────────────────── */

interface YouTubeItem {
  id?: { channelId?: string } | string
  snippet?: {
    title?: string
    customUrl?: string
    channelId?: string
    country?: string
    defaultLanguage?: string
  }
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string }
  topicDetails?: { topicCategories?: string[] }
}

/** YouTube 的 `channels.list` 一条 → 适配器的 `RawChannel`。 */
function youtubeChannel(item: YouTubeItem): Record<string, unknown> {
  const id = typeof item.id === 'string' ? item.id : (item.id?.channelId ?? item.snippet?.channelId)
  const subs = item.statistics?.subscriberCount
  const topic = item.topicDetails?.topicCategories?.[0]
  return {
    ...(id === undefined ? {} : { id }),
    ...(item.snippet?.customUrl === undefined ? {} : { handle: item.snippet.customUrl }),
    ...(item.snippet?.title === undefined ? {} : { title: item.snippet.title }),
    // `subscriberCount` 是字符串，而且**隐藏了订阅数的频道这一格根本不出现**——
    // 那时候不该写 0（0 的意思是"没人订阅"）
    ...(subs === undefined ? {} : { subscriber_count: Number(subs) }),
    ...(topic === undefined
      ? {}
      : { topic: decodeURIComponent(topic.split('/').pop() ?? '').replace(/_/g, ' ') }),
    ...(item.snippet?.country === undefined ? {} : { country: item.snippet.country }),
    ...(item.snippet?.defaultLanguage === undefined
      ? {}
      : { language: item.snippet.defaultLanguage }),
  }
}

/** 上游回来的 JSON → 适配器要的那个形状。 */
function shape(channel: KolChannel, action: string, raw: unknown): unknown {
  const body = (raw ?? {}) as Record<string, unknown>
  if (channel === 'youtube') {
    if (action === 'search_channels' || action === 'list_channels') {
      const items = (body.items ?? []) as YouTubeItem[]
      return { channels: items.map(youtubeChannel) }
    }
    if (action === 'get_channel') {
      const items = (body.items ?? []) as YouTubeItem[]
      const first = items[0]
      if (first === undefined) throw new Error('这个频道名在 YouTube 上查不到')
      return youtubeChannel(first)
    }
  }
  if (channel === 'instagram') {
    const discovery = (body.business_discovery ?? undefined) as Record<string, unknown> | undefined
    if (discovery === undefined) throw new Error('这个账号不是 Instagram 商业账号，查不到资料')
    return discovery
  }
  // Facebook / TikTok / X：适配器自己认 `data` 那一层，原样给它
  return body
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

export function createKolChannels(options: KolChannelsOptions): KolChannelsAssembly {
  const doFetch: KolFetch =
    options.fetch ??
    ((input, init) =>
      globalThis.fetch(input, init as RequestInit) as unknown as ReturnType<KolFetch>)

  /** 这条渠道现在挂着哪条连接（连上了的才算）。 */
  const connectionOf = (channel: KolChannel): KolConnectionRef | undefined => {
    const kind = KOL_CHANNELS.find((c) => c.id === channel)?.connector_kind
    if (kind === undefined) return undefined
    return options
      .connections()
      .find((c) => c.service === kind && (c.status === 'connected' || c.status === 'ok'))
  }

  /** 凭据。取值即用，不缓存、不落变量、不进日志。 */
  const fieldsOf = (connection_id: string): Record<string, string> | undefined => {
    if (!options.secrets.available) return undefined
    try {
      return options.secrets.get(connection_id)
    } catch {
      // 换过秘密库密钥：当成"没连"——那正是用户看到的现象，而且他修得好（重填一次）
      return undefined
    }
  }

  const build = (
    channel: KolChannel,
    action: string,
    params: Record<string, unknown>,
    fields: Record<string, string>,
  ): Outgoing | undefined => {
    const token = fields[KOL_TOKEN_FIELD[channel]]
    if (token === undefined || token === '')
      throw new Error(
        `这条连接里没有 ${channel} 要的那把令牌（字段 ${KOL_TOKEN_FIELD[channel]}）。去连接页重填一次。`,
      )
    switch (channel) {
      case 'youtube':
        return youtubeRequest(action, params, token)
      case 'facebook':
        return facebookRequest(action, params, token)
      case 'instagram':
        return instagramRequest(action, params, token, fields.ig_user_id)
      case 'tiktok':
        return tiktokRequest(action, params, token)
      case 'x':
        return xRequest(action, params, token)
      default:
        return undefined
    }
  }

  /** 打一跳：建请求 → fetch → 翻错 → 整理形状。 */
  const once = async (
    channel: KolChannel,
    action: string,
    params: Record<string, unknown>,
    fields: Record<string, string>,
  ): Promise<unknown> => {
    const out = build(channel, action, params, fields)
    if (out === undefined) throw new Error(`${channel} 上没有 ${action} 这个动作`)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, KOL_HTTP_TIMEOUT_MS)
    try {
      const res = await doFetch(out.url, {
        method: out.method,
        headers: out.headers,
        ...(out.body === undefined ? {} : { body: out.body }),
        signal: controller.signal,
      })
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = text.trim() === '' ? {} : JSON.parse(text)
      } catch {
        parsed = {}
      }
      if (!res.ok) {
        /*
         * 上游的错原样带一段给适配器去分类（文件头第 3 条）。
         * **只带 message / code，不带整份响应**——响应里可能回显了请求，
         * 而请求的查询串里有令牌。
         */
        const e = (parsed ?? {}) as {
          error?: { message?: string; code?: number; type?: string }
          error_description?: string
          detail?: string
          title?: string
        }
        const message =
          e.error?.message ?? e.error_description ?? e.detail ?? e.title ?? `HTTP ${res.status}`
        const code = e.error?.code === undefined ? '' : ` (#${e.error.code})`
        throw new Error(`${res.status} ${message}${code}`)
      }
      return shape(channel, action, parsed)
    } finally {
      clearTimeout(timer)
    }
  }

  const transport: KolChannelTransport = {
    connected: (channel) => connectionOf(channel) !== undefined,
    now: () => options.clock.now(),
    async call<T>(input: {
      channel: KolChannel
      action: string
      params: Record<string, unknown>
    }): Promise<T> {
      const { channel, action, params } = input
      /*
       * 基准本地永远没有（文件头第 4 条）。回 `undefined` 而不是抛——
       * 适配器据此在面板上留白，"没有基准"是常态，不是错。
       */
      if (action === 'get_benchmark') return undefined as T
      const connection = connectionOf(channel)
      if (connection === undefined) throw new Error(`${channel} 现在没有连上`)
      const fields = fieldsOf(connection.id)
      if (fields === undefined)
        throw new Error(
          `取不到 ${channel} 这条连接的凭据（加密库没开，或者换过密钥）。去连接页重填一次。`,
        )

      const first = await once(channel, action, params, fields)
      /*
       * YouTube 的搜人要**两跳**：`search.list` 只给标题与频道 id，粉丝数、
       * 主题、国家都在 `channels.list` 里。合成一跳给适配器，是因为
       * "搜出来的人没有粉丝数"会让打分那一项直接 0 分——那不是事实。
       *
       * 代价说在明处：`search.list` 100 单位 + `channels.list` 1 单位，
       * 全站一天 10000（48 §5.1）。所以搜人不是可以随便点的按钮。
       */
      if (channel === 'youtube' && action === 'search_channels') {
        const ids = ((first as { channels?: { id?: string }[] }).channels ?? [])
          .map((c) => c.id)
          .filter((id): id is string => typeof id === 'string' && id !== '')
        if (ids.length === 0) return first as T
        // 一跳最多 50 个 id（Data API 的上限）
        return (await once(
          channel,
          'list_channels',
          { id: ids.slice(0, 50).join(',') },
          fields,
        )) as T
      }
      return first as T
    },
  }

  return { transport, adapters: createChannelAdapters(transport) }
}
