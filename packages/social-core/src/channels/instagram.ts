/**
 * WP191（docs/86 §3.2 / §5）：**Instagram** 适配器（专业账号，走「Facebook 登录」那条路）。
 *
 * 事实来源：Instagram Platform 文档（2026-09-29 读）。
 * <https://developers.facebook.com/docs/instagram-platform/content-publishing>
 *
 * 与 FB 主页**共用 `meta_graph` 那一把令牌**（连一次、批一次）：IG 账号 id 就是
 * 连接卡上 `ig_user_id` 那一格，也是 `SocialAccount.external_id`。
 *
 * 这条渠道特有的四件事：
 *
 * 1. **发布是两跳**：先 `POST /{ig-user-id}/media` 建一个容器（图 / 视频 / Reels /
 *    快拍 / 轮播），再 `POST /{ig-user-id}/media_publish` 把它发出去。视频容器要等
 *    平台处理完（`status_code: FINISHED`）才能发——给了 `transport.sleep` 就隔几秒
 *    问一次，不给就只问一次、没好就照实说"还在处理"。
 * 2. **API 没有排期**：`scheduled_at` 不往上游传，排期是我们自己的调度器到点再调这一跳。
 * 3. **硬限制先量**：配文 2,200 字、30 个话题标签、20 个 @、轮播最多 10 张、只收 JPEG
 *    （`platform.ts`）。超了的不打那一跳——发出去也一定被退回。
 * 4. **评论挂在媒体下**：没有"这个号的全部评论"的口子，先取媒体再逐条要评论（同 FB）。
 */

import type { SocialChannel, SocialPostKind } from '@agentsws/contracts'
import { checkPostText, PLATFORM_LIMITS } from '../platform.js'
import { META_GRAPH_BASE } from './meta.js'
import {
  type ChannelComment,
  type ChannelPost,
  type ChannelProfile,
  callJson,
  contentRejected,
  guardConnected,
  notImplemented,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'instagram'
const LABEL = 'Instagram'

const PROFILE_FIELDS = 'id,username,name,followers_count,biography,website'
const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count'
const COMMENT_FIELDS = 'id,text,timestamp,username,from{id,username}'

/** 视频容器最多问几次状态、每次隔多久（毫秒）。 */
export const INSTAGRAM_STATUS_POLLS = 10
export const INSTAGRAM_STATUS_GAP_MS = 3_000

interface RawMedia {
  id?: string
  caption?: string
  media_type?: string
  media_product_type?: string
  timestamp?: string
  permalink?: string
  like_count?: number
  comments_count?: number
}

/** IG 的媒体类型 → 我们的形态。 */
export function instagramKindOf(raw: {
  media_type?: string
  media_product_type?: string
}): SocialPostKind {
  if (raw.media_product_type === 'REELS') return 'reel'
  if (raw.media_product_type === 'STORY') return 'story'
  if (raw.media_type === 'CAROUSEL_ALBUM') return 'carousel'
  if (raw.media_type === 'VIDEO') return 'video'
  return 'image'
}

const isVideoUrl = (url: string): boolean => /\.(mp4|mov)(\?|$)/i.test(url)

export function createInstagramAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const auth = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential(CHANNEL)
    return { Authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}` }
  }
  const form = async (body: Record<string, string>) => ({
    method: 'POST',
    headers: { ...(await auth()), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })

  /** 建一个容器，回容器 id。 */
  const container = async (
    ig: string,
    body: Record<string, string>,
  ): Promise<{ ok: true; id: string } | SocialError> => {
    const url = `${META_GRAPH_BASE}/${encodeURIComponent(ig)}/media`
    const res = await callJson<{ id?: string }>(transport, LABEL, url, await form(body))
    if (!('data' in res)) return res
    return { ok: true, id: res.data.id ?? '' }
  }

  /** 等视频容器处理完（文件头第 1 条）。 */
  const waitFinished = async (id: string): Promise<SocialError | undefined> => {
    const url = `${META_GRAPH_BASE}/${encodeURIComponent(id)}?fields=status_code`
    const polls = transport.sleep === undefined ? 1 : INSTAGRAM_STATUS_POLLS
    for (let i = 0; i < polls; i += 1) {
      const res = await callJson<{ status_code?: string }>(transport, LABEL, url, {
        headers: await auth(),
      })
      if (!('data' in res)) return res
      const code = res.data.status_code
      if (code === 'FINISHED') return undefined
      if (code === 'ERROR' || code === 'EXPIRED')
        return {
          ok: false,
          reason: 'upstream_error',
          message: `${LABEL} 处理这段视频失败（${code}）。多半是格式、比例或时长不合要求——Reels 要 3 秒到 15 分钟，进推荐要 3 分钟以内。`,
        }
      if (i < polls - 1) await transport.sleep?.(INSTAGRAM_STATUS_GAP_MS)
    }
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 还在处理这段视频，这一轮没发出去。过几分钟再发一次。`,
    }
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(account_external_id)}?fields=${PROFILE_FIELDS}`
      const res = await callJson<{
        id?: string
        username?: string
        name?: string
        followers_count?: number
        biography?: string
      }>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      const raw = res.data
      const handle = raw.username ?? raw.id ?? account_external_id
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: raw.id ?? account_external_id,
          handle,
          display_name: raw.name ?? handle,
          url: `https://www.instagram.com/${handle}/`,
          ...(raw.followers_count === undefined ? {} : { followers: raw.followers_count }),
          ...(raw.biography === undefined ? {} : { bio: raw.biography }),
        },
      }
    },

    async posts({ account_external_id, limit }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(account_external_id)}/media?fields=${MEDIA_FIELDS}&limit=${limit ?? 25}`
      const res = await callJson<{ data?: RawMedia[] }>(transport, LABEL, url, {
        headers: await auth(),
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data ?? []).map((raw) => ({
          external_id: raw.id ?? '',
          kind: instagramKindOf(raw),
          body: raw.caption ?? '',
          ...(raw.timestamp === undefined ? {} : { published_at: raw.timestamp }),
          ...(raw.permalink === undefined ? {} : { url: raw.permalink }),
          metrics: {
            ...(raw.like_count === undefined ? {} : { likes: raw.like_count }),
            ...(raw.comments_count === undefined ? {} : { comments: raw.comments_count }),
          },
        })),
      }
    },

    async comments({ post_external_id, limit }): Promise<SocialResult<ChannelComment[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (post_external_id === undefined)
        return notImplemented(
          LABEL,
          'Instagram 上评论挂在每条媒体下，没有「这个号的全部评论」这个口子——先取媒体列表，再逐条要评论',
        )
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(post_external_id)}/comments?fields=${COMMENT_FIELDS}&limit=${limit ?? 50}`
      const res = await callJson<{
        data?: {
          id?: string
          text?: string
          timestamp?: string
          username?: string
          from?: { id?: string; username?: string }
        }[]
      }>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data ?? []).map((raw) => ({
          external_id: raw.id ?? '',
          parent_external_id: post_external_id,
          surface: 'comment' as const,
          author_external_id: raw.from?.id ?? '',
          author_handle: raw.username ?? raw.from?.username ?? '',
          text: raw.text ?? '',
          created_at: raw.timestamp ?? transport.now(),
        })),
      }
    },

    async publish(
      input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const problems = checkPostText(CHANNEL, input.body)
      if (problems.length > 0) return contentRejected(LABEL, problems)
      const media = input.media_urls ?? []
      if (media.length === 0)
        return {
          ok: false,
          reason: 'content_rejected',
          message: `${LABEL} 不收纯文字：一条至少要一张图或一段视频。`,
        }
      const maxItems = PLATFORM_LIMITS.instagram?.max_carousel_items ?? 10
      if (media.length > maxItems)
        return {
          ok: false,
          reason: 'content_rejected',
          message: `${LABEL} 一组轮播最多 ${maxItems} 张，这条有 ${media.length} 张。`,
        }
      const ig = input.account_external_id
      const mediaBody = (url: string): Record<string, string> =>
        isVideoUrl(url) ? { video_url: url } : { image_url: url }

      let creation: { ok: true; id: string } | SocialError
      if (media.length > 1) {
        // 轮播：每张先建一个子容器（`is_carousel_item`），再建父容器
        const children: string[] = []
        for (const url of media) {
          const child = await container(ig, {
            ...mediaBody(url),
            ...(isVideoUrl(url) ? { media_type: 'VIDEO' } : {}),
            is_carousel_item: 'true',
          })
          if (!child.ok) return child
          if (isVideoUrl(url)) {
            const wait = await waitFinished(child.id)
            if (wait !== undefined) return wait
          }
          children.push(child.id)
        }
        creation = await container(ig, {
          media_type: 'CAROUSEL',
          children: children.join(','),
          caption: input.body,
        })
      } else {
        const url = media[0] as string
        const type =
          input.kind === 'story'
            ? { media_type: 'STORIES' }
            : isVideoUrl(url) || input.kind === 'reel' || input.kind === 'video'
              ? { media_type: 'REELS' }
              : {}
        creation = await container(ig, {
          ...mediaBody(url),
          ...type,
          // 快拍没有配文
          ...(input.kind === 'story' ? {} : { caption: input.body }),
        })
        if (creation.ok && isVideoUrl(url)) {
          const wait = await waitFinished(creation.id)
          if (wait !== undefined) return wait
        }
      }
      if (!creation.ok) return creation

      const url = `${META_GRAPH_BASE}/${encodeURIComponent(ig)}/media_publish`
      const res = await callJson<{ id?: string }>(
        transport,
        LABEL,
        url,
        await form({ creation_id: creation.id }),
      )
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: { external_id: res.data.id ?? '' },
      }
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      // 回一条评论 = 往那条评论的 `/replies` 边上 POST（Comment Moderation 文档）
      const url = `${META_GRAPH_BASE}/${encodeURIComponent(input.parent_external_id)}/replies`
      const res = await callJson<{ id?: string }>(
        transport,
        LABEL,
        url,
        await form({ message: input.text }),
      )
      if (!('data' in res)) return res
      return { ok: true, observed_at: transport.now(), data: { external_id: res.data.id ?? '' } }
    },
  }
}
