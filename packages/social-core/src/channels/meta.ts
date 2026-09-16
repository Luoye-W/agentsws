/**
 * Meta 适配器（FB 主页 + IG 商业号，56 §1「一把 token 管主页 + IG」）。
 *
 * 事实来源：Meta Graph API 文档（Pages API / Instagram Platform，2026-09-16 读）。
 * <https://developers.facebook.com/docs/graph-api>
 *
 * 形状上要留意的三件事，都在下面的代码里标了：
 *
 * 1. **`access_token` 在 query 上**。Graph API 既接 `Authorization: Bearer`，
 *    也接 `?access_token=`；这里用前者——放在 query 上的 token 会被代理与
 *    访问日志原样记下来。错误消息里的 URL 还是照 `redactUrl` 抹一遍 query。
 * 2. **排期发布用 `scheduled_publish_time`（Unix 秒）+ `published: false`**。
 *    这是 Pages API 的规矩：`published: true` 加一个未来时间不会排期，会立即发。
 *    传错的后果是"排在下周一的那条现在就出去了"，所以两格一起写。
 * 3. **互动数不在 feed 里**。点赞 / 评论要用 `summary(true)` 单独要一次
 *    （见 `POST_FIELDS`）；不要那一格的话，`likes` 回的是一整页点赞的人，
 *    而我们只要一个数。
 */

import type { SocialChannel, SocialPostKind } from '@agentsws/contracts'
import {
  type ChannelComment,
  type ChannelPost,
  type ChannelProfile,
  callJson,
  guardConnected,
  notImplemented,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'meta'
const LABEL = 'Meta（FB 主页 + IG）'

/** 版本钉死：Graph API 每个版本活两年，不钉的话哪天悄悄换了行为没人知道。 */
export const META_GRAPH_VERSION = 'v21.0'
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`

/** 主页资料要的字段（文档 Page 节点）。 */
const PAGE_FIELDS = 'id,name,username,fan_count,about,link'
/** 帖子列表要的字段。互动数靠 `summary(true)` 只取计数（见文件头第 3 条）。 */
const POST_FIELDS =
  'id,message,created_time,permalink_url,shares,likes.summary(true).limit(0),comments.summary(true).limit(0)'
const COMMENT_FIELDS = 'id,message,created_time,from{id,name}'

interface RawPage {
  id?: string
  name?: string
  username?: string
  fan_count?: number
  about?: string
  link?: string
}

interface RawSummary {
  summary?: { total_count?: number }
}

interface RawPost {
  id?: string
  message?: string
  created_time?: string
  permalink_url?: string
  shares?: { count?: number }
  likes?: RawSummary
  comments?: RawSummary
}

interface RawComment {
  id?: string
  message?: string
  created_time?: string
  from?: { id?: string; name?: string }
}

/** 一条帖子在我们这边叫什么形态。Graph 的 feed 不区分，统一按 `post` 记。 */
const POST_KIND: SocialPostKind = 'post'

const postOf = (raw: RawPost): ChannelPost => ({
  external_id: raw.id ?? '',
  kind: POST_KIND,
  body: raw.message ?? '',
  ...(raw.created_time === undefined ? {} : { published_at: raw.created_time }),
  ...(raw.permalink_url === undefined ? {} : { url: raw.permalink_url }),
  metrics: {
    ...(raw.likes?.summary?.total_count === undefined
      ? {}
      : { likes: raw.likes.summary.total_count }),
    ...(raw.comments?.summary?.total_count === undefined
      ? {}
      : { comments: raw.comments.summary.total_count }),
    ...(raw.shares?.count === undefined ? {} : { shares: raw.shares.count }),
  },
})

export function createMetaAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  /** 每次现取现用；**不缓存**（凭据不在对象里留着）。 */
  const auth = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential(CHANNEL)
    return { Authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}` }
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(account_external_id)}?fields=${PAGE_FIELDS}`
      const res = await callJson<RawPage>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      const raw = res.data
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: raw.id ?? account_external_id,
          handle: raw.username ?? raw.id ?? account_external_id,
          display_name: raw.name ?? '',
          url: raw.link ?? `https://www.facebook.com/${raw.id ?? account_external_id}`,
          ...(raw.fan_count === undefined ? {} : { followers: raw.fan_count }),
          ...(raw.about === undefined ? {} : { bio: raw.about }),
        },
      }
    },

    async posts({ account_external_id, limit }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(account_external_id)}/feed?fields=${POST_FIELDS}&limit=${limit ?? 25}`
      const res = await callJson<{ data?: RawPost[] }>(transport, LABEL, url, {
        headers: await auth(),
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data ?? []).map(postOf),
      }
    },

    async comments({
      account_external_id,
      post_external_id,
      limit,
    }): Promise<SocialResult<ChannelComment[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      // 没给帖子 id 就没法要评论：Graph 上评论挂在**帖子**下，没有"这个主页的全部评论"
      if (post_external_id === undefined)
        return notImplemented(
          LABEL,
          'Graph API 上评论挂在帖子下，没有「这个主页的全部评论」这个口子——先取帖子列表，再逐条要评论',
        )
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(post_external_id)}/comments?fields=${COMMENT_FIELDS}&limit=${limit ?? 50}`
      const res = await callJson<{ data?: RawComment[] }>(transport, LABEL, url, {
        headers: await auth(),
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data ?? []).map((raw) => ({
          external_id: raw.id ?? '',
          parent_external_id: post_external_id,
          surface: 'comment' as const,
          author_external_id: raw.from?.id ?? '',
          author_handle: raw.from?.name ?? raw.from?.id ?? '',
          text: raw.message ?? '',
          created_at: raw.created_time ?? transport.now(),
        })),
      }
    },

    async publish(
      input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(input.account_external_id)}/feed`
      /*
       * 排期那两格必须一起写（文件头第 2 条）：`published: false` +
       * `scheduled_publish_time`（Unix **秒**，不是毫秒）。只写时间不写
       * `published: false`，这条会立即发出去。
       */
      const form: Record<string, string> = { message: input.body }
      if (input.scheduled_at !== undefined) {
        const at = Math.floor(Date.parse(input.scheduled_at) / 1000)
        form.published = 'false'
        form.scheduled_publish_time = String(at)
      }
      if (input.media_urls !== undefined && input.media_urls.length > 0)
        form.link = input.media_urls[0] as string
      const res = await callJson<{ id?: string; post_id?: string }>(transport, LABEL, url, {
        method: 'POST',
        headers: { ...(await auth()), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      })
      if (!('data' in res)) return res
      const id = res.data.post_id ?? res.data.id ?? ''
      return {
        ok: true,
        observed_at: transport.now(),
        data: { external_id: id, url: `https://www.facebook.com/${id}` },
      }
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      // 回一条评论 = 往那条评论的 `/comments` 边上 POST（文档 Comment 节点）
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(input.parent_external_id)}/comments`
      const res = await callJson<{ id?: string }>(transport, LABEL, url, {
        method: 'POST',
        headers: { ...(await auth()), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ message: input.text }).toString(),
      })
      if (!('data' in res)) return res
      return { ok: true, observed_at: transport.now(), data: { external_id: res.data.id ?? '' } }
    },
  }
}
