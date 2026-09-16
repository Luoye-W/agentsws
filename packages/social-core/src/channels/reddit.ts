/**
 * Reddit 适配器（社群组，56 §2；**真实现** WP73）。
 *
 * 事实来源：Reddit API 文档（2026-09-16 读）。<https://www.reddit.com/dev/api/>
 *
 * 五件这条渠道特有的事：
 *
 * 1. **`User-Agent` 不是可选的。** Reddit 明文要求一个认得出来的 UA，写错 / 不写
 *    一律限流到不可用。所以它在 {@link redditHeaders} 里，每一跳都带
 *    （连接卡上那一格填什么，这里就带什么——用户自己那份比我们编的更认得出来）。
 * 2. **fullname 带类型前缀，不是裸 id。** `t3_abc123` 是帖子、`t1_def456` 是评论、
 *    `t5_` 是 subreddit。回帖与管理动作收的都是 fullname；传裸 id 的表现是
 *    上游回 200 而什么都没发生——最难查的一种。{@link redditFullname} 负责补前缀。
 * 3. **写动作是 form-urlencoded，不是 JSON。** `POST /api/submit` 收 JSON 会
 *    回一个语焉不详的 400。
 * 4. **一分钟 60 跳**是 Reddit 给 OAuth 客户端的配额。这里自己数着
 *    （{@link REDDIT_MAX_CALLS_PER_MINUTE}）：与其被上游 429 之后再猜"等多久"，
 *    不如在打出去之前就说"这一分钟满了"。
 * 5. **"群发"在 Reddit 上 = 发一条置顶帖。** 给每个订阅者发私信是明令禁止的
 *    （会被当成垃圾信举报，封的是这个号）。所以 `broadcast` 是两跳：
 *    `/api/submit` 发帖 + `/api/distinguish` 置顶加管理员标记。
 *
 * 凭据：OAuth 换来的 `access_token`（连接卡上是 client id / secret / UA）。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type BroadcastInput,
  type ChannelComment,
  type ChannelMember,
  type ChannelPost,
  type ChannelProfile,
  callJson,
  guardConnected,
  type ModerateInput,
  notImplemented,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'reddit'
const LABEL = 'Reddit'
export const REDDIT_API_BASE = 'https://oauth.reddit.com'
/** Reddit 明文要求带一个认得出来的 UA，否则限流到不可用。 */
export const REDDIT_USER_AGENT = 'agentsws/1.0 (社媒运营；https://github.com/agentsws)'

/** 文件头第 4 条：一分钟 60 跳（Reddit 给 OAuth 客户端的配额）。 */
export const REDDIT_MAX_CALLS_PER_MINUTE = 60

export const REDDIT_SUBMIT_PATH = '/api/submit'
export const REDDIT_COMMENT_PATH = '/api/comment'
export const REDDIT_APPROVE_PATH = '/api/approve'
export const REDDIT_REMOVE_PATH = '/api/remove'
export const REDDIT_DISTINGUISH_PATH = '/api/distinguish'
export const REDDIT_FRIEND_PATH = '/api/friend'
export const REDDIT_UNFRIEND_PATH = '/api/unfriend'

/**
 * 补上 fullname 的类型前缀（文件头第 2 条）。
 *
 * 已经带前缀的原样返回——调用方手上拿到的多半就是上游给的那一串。
 */
export function redditFullname(id: string, kind: 't1' | 't3' | 't5'): string {
  return /^t\d_/.test(id) ? id : `${kind}_${id}`
}

/** `r/<sub>` / `/r/<sub>` / `<sub>` 一律归成 `<sub>`。 */
function subOf(value: string): string {
  return value.replace(/^\/?r\//, '').replace(/^\//, '')
}

interface RawListing<T> {
  data?: { children?: { data?: T }[]; after?: string | null }
}

interface RawLink {
  id?: string
  name?: string
  title?: string
  selftext?: string
  created_utc?: number
  permalink?: string
  ups?: number
  num_comments?: number
  author?: string
  body?: string
}

interface RawAbout {
  display_name?: string
  title?: string
  public_description?: string
  subscribers?: number
  url?: string
  name?: string
}

interface RawModerator {
  id?: string
  name?: string
  date?: number
  mod_permissions?: string[]
}

export function createRedditAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)

  /*
   * 文件头第 4 条：自己数着这一分钟打了几跳。
   *
   * 时间从 `transport.now()` 来（这个包里没有 `Date.now()`），所以同样的输入
   * 永远算出同样的结论，测试里推一下时钟就能把这一档测掉。
   */
  const recent: number[] = []
  const overQuota = (): SocialError | undefined => {
    const t = Date.parse(transport.now())
    if (Number.isNaN(t)) return undefined
    while (recent.length > 0 && t - (recent[0] as number) >= 60_000) recent.shift()
    if (recent.length >= REDDIT_MAX_CALLS_PER_MINUTE)
      return {
        ok: false,
        reason: 'rate_limited',
        message: `${LABEL} 一分钟最多 ${REDDIT_MAX_CALLS_PER_MINUTE} 次调用，这一分钟已经用满了。等一会儿再试；这一批先排着，不会丢。`,
      }
    recent.push(t)
    return undefined
  }

  const headers = async (extra?: Record<string, string>): Promise<Record<string, string>> => {
    const cred = await transport.credential(CHANNEL)
    return {
      authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}`,
      // 文件头第 1 条：用户自己填的那一份比我们编的更认得出来
      'user-agent': cred.user_agent ?? REDDIT_USER_AGENT,
      accept: 'application/json',
      ...extra,
    }
  }

  /** 一跳（读）。配额先过。 */
  const get = async <T>(path: string): Promise<{ ok: true; data: T } | SocialError> => {
    const quota = overQuota()
    if (quota !== undefined) return quota
    return callJson<T>(transport, LABEL, `${REDDIT_API_BASE}${path}`, {
      headers: await headers(),
    })
  }

  /** 一跳（写）。文件头第 3 条：form-urlencoded。 */
  const form = async <T>(
    path: string,
    fields: Record<string, string>,
  ): Promise<{ ok: true; data: T } | SocialError> => {
    const quota = overQuota()
    if (quota !== undefined) return quota
    const body = new URLSearchParams({ api_type: 'json', ...fields }).toString()
    return callJson<T>(transport, LABEL, `${REDDIT_API_BASE}${path}`, {
      method: 'POST',
      headers: await headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body,
    })
  }

  /** `api_type=json` 的响应把业务错误放在 `json.errors` 里，HTTP 仍是 200。 */
  const jsonErrors = (raw: unknown): SocialError | undefined => {
    const errs = (raw as { json?: { errors?: unknown[][] } }).json?.errors ?? []
    if (errs.length === 0) return undefined
    const first = errs[0] ?? []
    const code = String(first[0] ?? '')
    const text = String(first[1] ?? '')
    if (code === 'RATELIMIT')
      return { ok: false, reason: 'rate_limited', message: `${LABEL} 说太快了：${text}` }
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 那边没做成（${code}${text === '' ? '' : `：${text}`}）。`,
    }
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const sub = subOf(account_external_id)
      const res = await get<{ data?: RawAbout }>(`/r/${encodeURIComponent(sub)}/about`)
      if (!('data' in res)) return res
      const raw = res.data.data ?? {}
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: account_external_id,
          handle: `r/${raw.display_name ?? sub}`,
          display_name: raw.title ?? raw.display_name ?? sub,
          url: `https://www.reddit.com${raw.url ?? `/r/${sub}/`}`,
          // subreddit 的"成员"就是订阅者
          ...(raw.subscribers === undefined ? {} : { member_count: raw.subscribers }),
          ...(raw.public_description === undefined ? {} : { bio: raw.public_description }),
        },
      }
    },

    async posts({
      account_external_id,
      limit,
    }: {
      account_external_id: string
      limit?: number
    }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const sub = subOf(account_external_id)
      const res = await get<RawListing<RawLink>>(
        `/r/${encodeURIComponent(sub)}/new?limit=${Math.min(limit ?? 25, 100)}`,
      )
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data?.children ?? []).map((c) => {
          const raw = c.data ?? {}
          return {
            external_id: raw.name ?? redditFullname(raw.id ?? '', 't3'),
            kind: 'post' as const,
            body: raw.title ?? raw.selftext ?? '',
            // `created_utc` 是**秒**
            ...(raw.created_utc === undefined
              ? {}
              : { published_at: new Date(raw.created_utc * 1000).toISOString() }),
            ...(raw.permalink === undefined
              ? {}
              : { url: `https://www.reddit.com${raw.permalink}` }),
            metrics: {
              ...(raw.ups === undefined ? {} : { likes: raw.ups }),
              ...(raw.num_comments === undefined ? {} : { comments: raw.num_comments }),
            },
          }
        }),
      }
    },

    async comments({
      account_external_id,
      limit,
    }: {
      account_external_id: string
      post_external_id?: string
      limit?: number
    }): Promise<SocialResult<ChannelComment[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const sub = subOf(account_external_id)
      const res = await get<RawListing<RawLink>>(
        `/r/${encodeURIComponent(sub)}/comments?limit=${Math.min(limit ?? 25, 100)}`,
      )
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data?.children ?? []).map((c) => {
          const raw = c.data ?? {}
          return {
            external_id: raw.name ?? redditFullname(raw.id ?? '', 't1'),
            surface: 'thread' as const,
            author_external_id: raw.author ?? '',
            author_handle: raw.author ?? '',
            text: raw.body ?? '',
            created_at:
              raw.created_utc === undefined
                ? transport.now()
                : new Date(raw.created_utc * 1000).toISOString(),
          }
        }),
      }
    },

    async members({
      account_external_id,
      status,
    }: {
      account_external_id: string
      status?: 'pending' | 'active'
      limit?: number
    }): Promise<SocialResult<ChannelMember[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      /*
       * subreddit **没有成员名册，也没有入群审批**（关注是单向的）。
       * 读得到的只有版务名单（`/about/moderators`）——那是"这个群谁说了算"，
       * 不是"群里有谁"。所以 `pending` 在这条渠道上照实说没有。
       */
      if (status === 'pending')
        return notImplemented(
          LABEL,
          'subreddit 没有「入群申请」这回事（关注是单向的）——这条渠道上没有待审入群',
        )
      const sub = subOf(account_external_id)
      const res = await get<{ data?: { children?: RawModerator[] } }>(
        `/r/${encodeURIComponent(sub)}/about/moderators`,
      )
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data?.children ?? []).map((m) => ({
          external_id: m.id ?? m.name ?? '',
          handle: m.name ?? '',
          status: 'active' as const,
          ...(m.date === undefined ? {} : { joined_at: new Date(m.date * 1000).toISOString() }),
        })),
      }
    },

    async publish(
      input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (input.scheduled_at !== undefined)
        return notImplemented(
          LABEL,
          'Reddit 那边没有排期发布；排期由我们自己的调度器管，到点之后再调这一跳',
        )
      const sub = subOf(input.account_external_id)
      // 标题与正文用同一段文案的两截：Reddit 的标题是必填的，正文可以为空
      const [title, ...rest] = input.body.split('\n')
      const res = await form<{
        json?: { data?: { name?: string; url?: string }; errors?: unknown[][] }
      }>(REDDIT_SUBMIT_PATH, {
        sr: sub,
        kind: 'self',
        title: (title ?? input.body).slice(0, 300),
        text: rest.join('\n'),
      })
      if (!('data' in res)) return res
      const bad = jsonErrors(res.data)
      if (bad !== undefined) return bad
      const made = res.data.json?.data ?? {}
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          external_id: made.name ?? '',
          ...(made.url === undefined ? {} : { url: made.url }),
        },
      }
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const res = await form<{
        json?: { data?: { things?: { data?: { name?: string } }[] }; errors?: unknown[][] }
      }>(REDDIT_COMMENT_PATH, {
        // 文件头第 2 条：fullname，不是裸 id。回在帖子下面就是 `t3_`
        thing_id: redditFullname(input.parent_external_id, 't3'),
        text: input.text,
      })
      if (!('data' in res)) return res
      const bad = jsonErrors(res.data)
      if (bad !== undefined) return bad
      return {
        ok: true,
        observed_at: transport.now(),
        data: { external_id: res.data.json?.data?.things?.[0]?.data?.name ?? '' },
      }
    },

    async moderate(input: ModerateInput): Promise<SocialResult<{ ok: true }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const sub = subOf(input.account_external_id)
      let res: { ok: true; data: unknown } | SocialError
      switch (input.action) {
        case 'delete_post':
          // `spam: false` = 按"违反版规"删，不是标成垃圾信（后者会连坐这个人的别的帖子）
          res = await form(REDDIT_REMOVE_PATH, {
            id: redditFullname(input.target_external_id, 't3'),
            spam: 'false',
          })
          break
        case 'unmute':
          // Reddit 上"取消删除"就是 approve：把被删的内容放回去
          res = await form(REDDIT_APPROVE_PATH, {
            id: redditFullname(input.target_external_id, 't3'),
          })
          break
        case 'mute':
          res = await form(REDDIT_FRIEND_PATH, {
            r: sub,
            type: 'muted',
            name: input.target_external_id,
            ...(input.reason === undefined ? {} : { note: input.reason }),
          })
          break
        case 'ban':
        case 'permanent_ban':
          res = await form(REDDIT_FRIEND_PATH, {
            r: sub,
            type: 'banned',
            name: input.target_external_id,
            // 不给 `duration` = 永久（Reddit 的语义）；`ban` 给 7 天
            ...(input.action === 'ban'
              ? {
                  duration: String(
                    Math.max(1, Math.round((input.duration_minutes ?? 10_080) / 1440)),
                  ),
                }
              : {}),
            ...(input.reason === undefined ? {} : { ban_reason: input.reason.slice(0, 100) }),
          })
          break
        case 'unban':
          res = await form(REDDIT_UNFRIEND_PATH, {
            r: sub,
            type: 'banned',
            name: input.target_external_id,
          })
          break
      }
      if (!('data' in res)) return res
      const bad = jsonErrors(res.data)
      if (bad !== undefined) return bad
      return { ok: true, observed_at: transport.now(), data: { ok: true } }
    },

    async broadcast(
      input: BroadcastInput,
    ): Promise<SocialResult<{ sent: number; failed: number }>> {
      const guard = off()
      if (guard !== undefined) return guard
      /*
       * 文件头第 5 条：Reddit 上的"群发" = 发一条**置顶帖**。
       * 给每个订阅者发私信在 Reddit 是明令禁止的，所以这条路这里根本不存在——
       * `recipients` 有没有给都一样，它在这条渠道上没有意义。
       */
      const sub = subOf(input.account_external_id)
      const [title, ...rest] = input.body.split('\n')
      const made = await form<{
        json?: { data?: { name?: string }; errors?: unknown[][] }
      }>(REDDIT_SUBMIT_PATH, {
        sr: sub,
        kind: 'self',
        title: (title ?? input.body).slice(0, 300),
        text: rest.join('\n'),
      })
      if (!('data' in made)) return made
      const bad = jsonErrors(made.data)
      if (bad !== undefined) return bad
      const name = made.data.json?.data?.name ?? ''
      if (name === '')
        return {
          ok: false,
          reason: 'upstream_error',
          message: `${LABEL} 收下了这条公告，却没给帖子 id——置顶那一步就做不了了，所以这次不算成功。`,
        }
      // 第二跳：置顶 + 加管理员标记（公告要看得出来是版务发的）
      const pinned = await form<{ json?: { errors?: unknown[][] } }>(REDDIT_DISTINGUISH_PATH, {
        id: name,
        how: 'yes',
        sticky: 'true',
      })
      if (!('data' in pinned)) return pinned
      const badPin = jsonErrors(pinned.data)
      if (badPin !== undefined) return badPin
      // 一条置顶帖 = 一次"发出去了"。数字是 1 不是订阅者数——我们没给谁单独发过东西
      return { ok: true, observed_at: transport.now(), data: { sent: 1, failed: 0 } }
    },

    // `decideMember` 故意缺席：subreddit 没有入群审批（见 `members` 里那一段）。
  }
}
