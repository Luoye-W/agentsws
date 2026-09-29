/**
 * WP191（docs/86 §3.2 / §5）：**Threads** 适配器。
 *
 * 事实来源：Threads API 文档（2026-09-29 读）。
 * <https://developers.facebook.com/docs/threads/posts>
 *
 * 这条渠道特有的四件事：
 *
 * 1. **自己一把令牌**（连接卡 `threads_api`）：Threads 的授权与 FB / IG 分开——
 *    单独的用例、单独的令牌（长期令牌 60 天要续），主页令牌调不动 graph.threads.net。
 * 2. **发布是两跳**：`POST /{user}/threads` 建容器（`media_type`：TEXT / IMAGE /
 *    VIDEO / CAROUSEL），再 `POST /{user}/threads_publish?creation_id=`。纯文字容器
 *    可以马上发；带视频的要等处理完（官方建议隔约 30 秒）。
 * 3. **回复也是发帖**：回一条 = 建一个带 `reply_to_id` 的容器再发布。
 *    24 小时 250 帖 / 1,000 回复——两份额度分开算，所以回复这条渠道给得起 100 / 天。
 * 4. **硬限制先量**：正文 500 字、最多 5 个链接、一个话题标签、轮播 2–20 张（`platform.ts`）。
 */

import type { SocialChannel } from '@agentsws/contracts'
import { checkPostText } from '../platform.js'
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

const CHANNEL: SocialChannel = 'threads'
const LABEL = 'Threads'

export const THREADS_API_VERSION = 'v1.0'
export const THREADS_API_BASE = `https://graph.threads.net/${THREADS_API_VERSION}`

const PROFILE_FIELDS = 'id,username,name,threads_biography'
const POST_FIELDS = 'id,text,media_type,timestamp,permalink'
const REPLY_FIELDS = 'id,text,timestamp,username'

/** 视频容器最多问几次、隔多久（毫秒）。 */
export const THREADS_STATUS_POLLS = 10
export const THREADS_STATUS_GAP_MS = 3_000

const isVideoUrl = (url: string): boolean => /\.(mp4|mov)(\?|$)/i.test(url)

export function createThreadsAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const auth = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential(CHANNEL)
    return { Authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}` }
  }
  const post = async (url: string, body: Record<string, string>) =>
    callJson<{ id?: string }>(transport, LABEL, url, {
      method: 'POST',
      headers: { ...(await auth()), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    })

  const waitFinished = async (id: string): Promise<SocialError | undefined> => {
    const url = `${THREADS_API_BASE}/${encodeURIComponent(id)}?fields=status,error_message`
    const polls = transport.sleep === undefined ? 1 : THREADS_STATUS_POLLS
    for (let i = 0; i < polls; i += 1) {
      const res = await callJson<{ status?: string }>(transport, LABEL, url, {
        headers: await auth(),
      })
      if (!('data' in res)) return res
      if (res.data.status === 'FINISHED') return undefined
      if (res.data.status === 'ERROR' || res.data.status === 'EXPIRED')
        return {
          ok: false,
          reason: 'upstream_error',
          message: `${LABEL} 处理这段视频失败（${res.data.status}）。视频要 MOV / MP4、5 分钟以内、1 GB 以内。`,
        }
      if (i < polls - 1) await transport.sleep?.(THREADS_STATUS_GAP_MS)
    }
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 还在处理这段视频，这一轮没发出去。过几分钟再发一次。`,
    }
  }

  /** 建容器 → （视频等处理完）→ 发布。发帖与回复共用这一段（文件头第 3 条）。 */
  const createAndPublish = async (
    user: string,
    body: string,
    media: readonly string[],
    extra: Record<string, string> = {},
  ): Promise<SocialResult<{ external_id: string }>> => {
    const problems = checkPostText(CHANNEL, body)
    if (problems.length > 0) return contentRejected(LABEL, problems)
    const base = `${THREADS_API_BASE}/${encodeURIComponent(user)}/threads`
    const itemOf = (url: string): Record<string, string> =>
      isVideoUrl(url)
        ? { media_type: 'VIDEO', video_url: url }
        : { media_type: 'IMAGE', image_url: url }

    let creation: { ok: true; data: { id?: string } } | SocialError
    if (media.length > 1) {
      const children: string[] = []
      for (const url of media) {
        const child = await post(base, { ...itemOf(url), is_carousel_item: 'true' })
        if (!('data' in child)) return child
        const id = child.data.id ?? ''
        if (isVideoUrl(url)) {
          const wait = await waitFinished(id)
          if (wait !== undefined) return wait
        }
        children.push(id)
      }
      creation = await post(base, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        text: body,
        ...extra,
      })
    } else if (media.length === 1) {
      const url = media[0] as string
      creation = await post(base, { ...itemOf(url), text: body, ...extra })
      if ('data' in creation && isVideoUrl(url)) {
        const wait = await waitFinished(creation.data.id ?? '')
        if (wait !== undefined) return wait
      }
    } else {
      creation = await post(base, { media_type: 'TEXT', text: body, ...extra })
    }
    if (!('data' in creation)) return creation

    const published = await post(
      `${THREADS_API_BASE}/${encodeURIComponent(user)}/threads_publish`,
      {
        creation_id: creation.data.id ?? '',
      },
    )
    if (!('data' in published)) return published
    return {
      ok: true,
      observed_at: transport.now(),
      data: { external_id: published.data.id ?? '' },
    }
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${THREADS_API_BASE}/${encodeURIComponent(account_external_id)}?fields=${PROFILE_FIELDS}`
      const res = await callJson<{
        id?: string
        username?: string
        name?: string
        threads_biography?: string
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
          url: `https://www.threads.net/@${handle}`,
          ...(raw.threads_biography === undefined ? {} : { bio: raw.threads_biography }),
        },
      }
    },

    async posts({ account_external_id, limit }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${THREADS_API_BASE}/${encodeURIComponent(account_external_id)}/threads?fields=${POST_FIELDS}&limit=${limit ?? 25}`
      const res = await callJson<{
        data?: {
          id?: string
          text?: string
          media_type?: string
          timestamp?: string
          permalink?: string
        }[]
      }>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data ?? []).map((raw) => ({
          external_id: raw.id ?? '',
          kind:
            raw.media_type === 'CAROUSEL_ALBUM'
              ? ('carousel' as const)
              : raw.media_type === 'VIDEO'
                ? ('video' as const)
                : raw.media_type === 'IMAGE'
                  ? ('image' as const)
                  : ('post' as const),
          body: raw.text ?? '',
          ...(raw.timestamp === undefined ? {} : { published_at: raw.timestamp }),
          ...(raw.permalink === undefined ? {} : { url: raw.permalink }),
        })),
      }
    },

    async comments({ post_external_id, limit }): Promise<SocialResult<ChannelComment[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (post_external_id === undefined)
        return notImplemented(LABEL, 'Threads 的回复挂在每条帖子下——先取帖子列表，再逐条要回复')
      const url = `${THREADS_API_BASE}/${encodeURIComponent(post_external_id)}/replies?fields=${REPLY_FIELDS}&limit=${limit ?? 50}`
      const res = await callJson<{
        data?: { id?: string; text?: string; timestamp?: string; username?: string }[]
      }>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data ?? []).map((raw) => ({
          external_id: raw.id ?? '',
          parent_external_id: post_external_id,
          surface: 'comment' as const,
          author_external_id: raw.username ?? '',
          author_handle: raw.username ?? '',
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
      // API 没有排期：`scheduled_at` 不往上游传，到点由我们自己的调度器调这一跳
      return createAndPublish(input.account_external_id, input.body, input.media_urls ?? [])
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (input.account_external_id === undefined)
        return {
          ok: false,
          reason: 'upstream_error',
          message: `${LABEL} 回复要以我们自己的号发出——这条回复没带账号 id。`,
        }
      return createAndPublish(input.account_external_id, input.text, [], {
        reply_to_id: input.parent_external_id,
      })
    },
  }
}
