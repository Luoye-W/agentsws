/**
 * TikTok 适配器（内容组，56 §2；**真实现** WP73）。
 *
 * 事实来源：TikTok for Developers, Content Posting API + Display API
 * （2026-09-16 读）。
 * <https://developers.tiktok.com/doc/content-posting-api-get-started>
 *
 * 三件这条渠道特有的事，写在这里免得下一个人再踩一遍：
 *
 * 1. **发布是两跳，不是一跳。** `POST /post/publish/video/init/` 只拿到一个
 *    `publish_id`（`PULL_FROM_URL` 的话 TikTok 自己去抓素材），真发出去没有
 *    同步的确认——要轮询 `POST /post/publish/status/fetch/`。所以 `publish`
 *    回的 `external_id` 是 **`publish_id` 而不是视频 id**，视频 id 要等状态
 *    变成 `PUBLISH_COMPLETE` 才有（{@link tiktokPublishStatus}）。
 * 2. **申请制的表现是 403，不是 401。** Content Posting API 要先提交用途说明
 *    并通过审核；没批下来打过去是 403。共用的 `httpFailure` 把 403 翻成
 *    "授权掉了，去重连"——在这条渠道上那句话是错的，用户会在连接页上反复重填一把
 *    根本没问题的 key。所以这里**单独判 403**，说"要先申请"。
 * 3. **业务错误可能藏在 200 里。** TikTok 每个响应都有一格 `error.code`，
 *    成功是字符串 `'ok'`。只看 HTTP 状态码会把"配额用完"当成成功。
 *
 * 凭据：连接卡上是 client key / secret（client_credentials），换出来的
 * access token 存在同一条记录的 `access_token` 格里。取值即用，不落变量、
 * 不进日志（这个文件里没有一处 `console`）。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type ChannelPost,
  type ChannelProfile,
  callJson,
  guardConnected,
  httpFailure,
  needsApproval,
  type PublishInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'tiktok'
const LABEL = 'TikTok'
export const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2'

/** 发布那两跳的路径（形状在 WP72 就钉死了，这里只是接上真调用）。 */
export const TIKTOK_PUBLISH_INIT_PATH = '/post/publish/video/init/'
export const TIKTOK_PUBLISH_STATUS_PATH = '/post/publish/status/fetch/'
/** 发布之前要先问一次创作者能发什么（TikTok 要求的一步，也顺便当账号资料用）。 */
export const TIKTOK_CREATOR_INFO_PATH = '/post/publish/creator_info/query/'
/** Display API：自己的视频列表。 */
export const TIKTOK_VIDEO_LIST_PATH = '/video/list/'

/** 申请制那一句（文件头第 2 条：403 在这条渠道上不是"授权掉了"）。 */
function tiktokFailure(status: number, url: string, what: string): SocialError {
  if (status === 403) return needsApproval(LABEL, what)
  return httpFailure(LABEL, status, url)
}

/** TikTok 的业务错误（文件头第 3 条：藏在 200 里的那一格）。 */
interface TikTokEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; log_id?: string }
}

/**
 * 200 里那一格 `error.code`。`'ok'` 之外的一律当失败。
 *
 * **`message` 原样带一段**：TikTok 的业务错误话说得挺清楚
 * （`spam_risk_too_many_posts` / `reached_active_user_cap`），翻译一遍只会变糊。
 */
function businessError(env: TikTokEnvelope<unknown>): SocialError | undefined {
  const code = env.error?.code
  if (code === undefined || code === 'ok') return undefined
  if (code === 'access_token_invalid' || code === 'scope_not_authorized')
    return {
      ok: false,
      reason: 'not_connected',
      message: `${LABEL} 拒绝了这次调用（${code}）。去连接页重新授权一次。`,
    }
  if (code === 'rate_limit_exceeded' || code === 'spam_risk_too_many_posts')
    return {
      ok: false,
      reason: 'rate_limited',
      message: `${LABEL} 说太快了（${code}）。等一会儿再试；这一批先排着，不会丢。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    message: `${LABEL} 那边没做成（${code}${env.error?.message === undefined ? '' : `：${env.error.message.slice(0, 120)}`}）。`,
  }
}

interface RawCreatorInfo {
  creator_username?: string
  creator_nickname?: string
  creator_avatar_url?: string
  privacy_level_options?: string[]
  max_video_post_duration_sec?: number
}

interface RawVideo {
  id?: string
  title?: string
  video_description?: string
  create_time?: number
  share_url?: string
  view_count?: number
  like_count?: number
  comment_count?: number
  share_count?: number
}

/** 一次 POST JSON（TikTok 的每一跳都是 POST，连读也是）。 */
async function post<T>(
  transport: SocialTransport,
  token: string,
  path: string,
  bodyValue: unknown,
  what: string,
): Promise<{ ok: true; data: T } | SocialError> {
  const url = `${TIKTOK_API_BASE}${path}`
  const res = await callJson<TikTokEnvelope<T>>(transport, LABEL, url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      // TikTok 明文要求带 charset，少了它有些端点直接 400
      'content-type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(bodyValue),
  })
  if (!('data' in res)) {
    // `callJson` 已经把 HTTP 错翻过一遍了，这里只把 403 那一档改说成"要先申请"
    return res.status === undefined ? res : tiktokFailure(res.status, url, what)
  }
  const bad = businessError(res.data)
  if (bad !== undefined) return bad
  return { ok: true, data: (res.data.data ?? {}) as T }
}

export function createTikTokAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const tokenOf = async (): Promise<string> => {
    const cred = await transport.credential(CHANNEL)
    return cred.access_token ?? cred.token ?? ''
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const res = await post<RawCreatorInfo>(
        transport,
        await tokenOf(),
        TIKTOK_CREATOR_INFO_PATH,
        {},
        '账号资料接口（Content Posting API 的 creator_info）',
      )
      if (!('data' in res)) return res
      const raw = res.data
      const handle = raw.creator_username ?? account_external_id
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: account_external_id,
          handle,
          display_name: raw.creator_nickname ?? handle,
          url: `https://www.tiktok.com/@${handle.replace(/^@/, '')}`,
          // **粉丝数这条接口不给**，所以这一格不出现（不补 0，见契约的注释）
        },
      }
    },

    async posts({
      account_external_id: _account_external_id,
      limit,
    }: {
      account_external_id: string
      limit?: number
    }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const fields =
        'id,title,video_description,create_time,share_url,view_count,like_count,comment_count,share_count'
      const res = await post<{ videos?: RawVideo[] }>(
        transport,
        await tokenOf(),
        `${TIKTOK_VIDEO_LIST_PATH}?fields=${encodeURIComponent(fields)}`,
        // 一次最多 20（Display API 的上限）
        { max_count: Math.min(limit ?? 20, 20) },
        '视频列表与表现数据接口（Display API）',
      )
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.videos ?? []).map((v) => ({
          external_id: v.id ?? '',
          kind: 'video' as const,
          body: v.title ?? v.video_description ?? '',
          // `create_time` 是**秒**（不是毫秒）。乘错的表现是所有视频都发在 1970 年
          ...(v.create_time === undefined
            ? {}
            : { published_at: new Date(v.create_time * 1000).toISOString() }),
          ...(v.share_url === undefined ? {} : { url: v.share_url }),
          metrics: {
            ...(v.view_count === undefined ? {} : { views: v.view_count }),
            ...(v.like_count === undefined ? {} : { likes: v.like_count }),
            ...(v.comment_count === undefined ? {} : { comments: v.comment_count }),
            ...(v.share_count === undefined ? {} : { shares: v.share_count }),
          },
        })),
      }
    },

    async publish(
      input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      /*
       * TikTok **没有服务端排期**。排期由我们自己的调度器管（到点了再调这一跳），
       * 所以收到一个未来时间就是调用方搞错了，照实说——不假装排上了。
       */
      if (input.scheduled_at !== undefined)
        return {
          ok: false,
          reason: 'not_implemented',
          message: `${LABEL} 那边没有排期发布；排期由我们自己的调度器管，到点之后再调这一跳。`,
        }
      const source = input.media_urls?.[0]
      if (source === undefined)
        return {
          ok: false,
          reason: 'not_implemented',
          message: `${LABEL} 只发视频，而这一条没有素材。先把视频传到一个 TikTok 拉得到的地址上，再把地址填进来。`,
        }
      const res = await post<{ publish_id?: string }>(
        transport,
        await tokenOf(),
        TIKTOK_PUBLISH_INIT_PATH,
        {
          post_info: {
            title: input.body.slice(0, 2200),
            privacy_level: 'PUBLIC_TO_EVERYONE',
            disable_comment: false,
            disable_duet: false,
            disable_stitch: false,
          },
          // `PULL_FROM_URL` 让 TikTok 自己去抓；域名要先在开发者后台验过
          source_info: { source: 'PULL_FROM_URL', video_url: source },
        },
        '发布接口（Content Posting API）',
      )
      if (!('data' in res)) return res
      const publish_id = res.data.publish_id ?? ''
      if (publish_id === '')
        return {
          ok: false,
          reason: 'upstream_error',
          message: `${LABEL} 收下了这一跳，却没给 publish_id——没有它就查不到这条到底发出去没有，所以这次不算成功。`,
        }
      // 文件头第 1 条：这是 `publish_id`，**不是**视频 id
      return { ok: true, observed_at: transport.now(), data: { external_id: publish_id } }
    },

    // `comments` / `reply` 故意缺席：TikTok 没有开放的评论读写接口。
    // 缺席本身就是信息——调用方据此把"回评论"那个按钮画成灰的。
  }
}

/** 一条发布的状态（{@link tiktokPublishStatus} 回的那一份）。 */
export interface TikTokPublishStatus {
  /** `PROCESSING_UPLOAD` / `PUBLISH_COMPLETE` / `FAILED` … */
  status: string
  /** 发完了才有的视频 id。 */
  post_id?: string
  /** 失败原因（TikTok 的原话）。 */
  fail_reason?: string
}

/**
 * 第二跳：这条 `publish_id` 现在到哪一步了（文件头第 1 条）。
 *
 * 单独一个函数而不是塞进适配器：`SocialChannelAdapter` 上没有"查发布状态"这个口子，
 * 而给它加一个只有一条渠道用得上的方法，等于让另外八条渠道都多一格空的。
 * 调用方（定时那一跳）直接调它。
 */
export async function tiktokPublishStatus(
  transport: SocialTransport,
  publish_id: string,
): Promise<SocialResult<TikTokPublishStatus>> {
  const guard = guardConnected(transport, CHANNEL, LABEL)
  if (guard !== undefined) return guard
  const cred = await transport.credential(CHANNEL)
  const res = await post<{
    status?: string
    publicaly_available_post_id?: string[]
    fail_reason?: string
  }>(
    transport,
    cred.access_token ?? cred.token ?? '',
    TIKTOK_PUBLISH_STATUS_PATH,
    { publish_id },
    '发布状态查询接口',
  )
  if (!('data' in res)) return res
  // 上游这个字段名就是拼错的（`publicaly`）。照抄，别"修正"——改对了就读不到了
  const post_id = res.data.publicaly_available_post_id?.[0]
  return {
    ok: true,
    observed_at: transport.now(),
    data: {
      status: res.data.status ?? 'UNKNOWN',
      ...(post_id === undefined ? {} : { post_id }),
      ...(res.data.fail_reason === undefined ? {} : { fail_reason: res.data.fail_reason }),
    },
  }
}
