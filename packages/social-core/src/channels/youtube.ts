/**
 * YouTube 适配器（56 §1：与红人岗位的 `kol.youtube` **共用同一张连接卡**）。
 *
 * 事实来源：YouTube Data API v3 文档（2026-09-16 读）。
 * <https://developers.google.com/youtube/v3/docs>
 *
 * 与红人那条的分工：红人那边读的是**别人的**频道（`kol-core/channels/youtube.ts`
 * 走宿主的只读 Action），这边读写的是**我们自己的**频道——所以两个文件不合并，
 * 合并之后"这一跳是读别人还是改自己"就看不出来了。共用的只有那把 key。
 *
 * 三件要留意的事：
 *
 * 1. **配额是全站的，不是我们的**。一天 10000 单位是**账号级**的数，一个进程里
 *    记不准，所以我们不自己算——上游说配额没了就照实说（`quotaExceeded`），
 *    并告诉用户明天重置。装作算得出来只会算错（照抄红人那条的纪律）。
 * 2. **搜频道视频是两跳**：`search.list` 只给标题与 videoId，播放 / 点赞在
 *    `videos.list` 的 `statistics` 里。合成一跳给调用方，否则"近 30 天表现"
 *    那一块永远是空的。
 * 3. **发视频不在这里**。上传要走 resumable upload（多段 HTTP + 二进制），
 *    不是一次 JSON 调用——`publish` 故意不实现，回 `not_implemented` 并说清
 *    "排期与审批照常能用"。假装有一个 publish 才是骗人。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type ChannelComment,
  type ChannelPost,
  type ChannelProfile,
  callJson,
  guardConnected,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'youtube'
const LABEL = 'YouTube'
export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

interface RawChannelItem {
  id?: string
  snippet?: {
    title?: string
    description?: string
    customUrl?: string
  }
  statistics?: { subscriberCount?: string; videoCount?: string }
}

interface RawSearchItem {
  id?: { videoId?: string }
  snippet?: { title?: string; description?: string; publishedAt?: string }
}

interface RawVideoItem {
  id?: string
  snippet?: { title?: string; description?: string; publishedAt?: string }
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }
}

interface RawCommentThread {
  id?: string
  snippet?: {
    videoId?: string
    topLevelComment?: {
      id?: string
      snippet?: {
        textOriginal?: string
        authorDisplayName?: string
        authorChannelId?: { value?: string }
        publishedAt?: string
      }
    }
  }
}

const int = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 配额用完那一句（文件头第 1 条）。
 *
 * Data API 把它报成 403 + `reason: quotaExceeded`，而 403 在别的情况下是
 * "授权掉了"——两句话对用户来说完全不同（一个等明天，一个现在去重连），
 * 所以这里按 body 里的原因再分一次。
 */
function quotaExhausted(): SocialError {
  return {
    ok: false,
    reason: 'quota_exhausted',
    status: 403,
    message: `${LABEL} 今天的接口配额用完了（全站一天 10000 单位，不是按我们这一个工作区算的）。明天会重置；着急的话先去后台手工做。`,
  }
}

export function createYouTubeSocialAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const key = async (): Promise<string> => {
    const cred = await transport.credential(CHANNEL)
    return cred.api_key ?? cred.key ?? ''
  }
  const bearer = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential(CHANNEL)
    // 读用 API key 就够；写（回评论）要 OAuth 令牌
    return cred.access_token === undefined ? {} : { Authorization: `Bearer ${cred.access_token}` }
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${YOUTUBE_API_BASE}/channels?part=snippet,statistics&id=${encodeURIComponent(account_external_id)}&key=${encodeURIComponent(await key())}`
      const res = await callJson<{ items?: RawChannelItem[] }>(transport, LABEL, url)
      if (!('data' in res)) return res.status === 403 ? quotaExhausted() : res
      const raw = res.data.items?.[0]
      if (raw === undefined)
        return {
          ok: false,
          reason: 'upstream_error',
          message: `${LABEL} 上没有这个频道（${account_external_id}）。频道 id 填对了吗？`,
        }
      const handle = (raw.snippet?.customUrl ?? raw.id ?? '').replace(/^@/, '')
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: raw.id ?? account_external_id,
          handle,
          display_name: raw.snippet?.title ?? '',
          url: `https://www.youtube.com/channel/${raw.id ?? account_external_id}`,
          ...(int(raw.statistics?.subscriberCount) === undefined
            ? {}
            : { followers: int(raw.statistics?.subscriberCount) as number }),
          ...(raw.snippet?.description === undefined ? {} : { bio: raw.snippet.description }),
        },
      }
    },

    async posts({ account_external_id, limit }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const k = encodeURIComponent(await key())
      // ① search.list：只给 videoId 与标题（文件头第 2 条）
      const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&type=video&order=date&channelId=${encodeURIComponent(account_external_id)}&maxResults=${limit ?? 25}&key=${k}`
      const search = await callJson<{ items?: RawSearchItem[] }>(transport, LABEL, searchUrl)
      if (!('data' in search)) return search.status === 403 ? quotaExhausted() : search
      const ids = (search.data.items ?? [])
        .map((i) => i.id?.videoId)
        .filter((x): x is string => typeof x === 'string' && x !== '')
      if (ids.length === 0) return { ok: true, observed_at: transport.now(), data: [] }
      // ② videos.list：播放 / 点赞 / 评论数在这一跳
      const videosUrl = `${YOUTUBE_API_BASE}/videos?part=snippet,statistics&id=${ids.map(encodeURIComponent).join(',')}&key=${k}`
      const videos = await callJson<{ items?: RawVideoItem[] }>(transport, LABEL, videosUrl)
      if (!('data' in videos)) return videos.status === 403 ? quotaExhausted() : videos
      return {
        ok: true,
        observed_at: transport.now(),
        data: (videos.data.items ?? []).map((raw) => ({
          external_id: raw.id ?? '',
          kind: 'video' as const,
          body: raw.snippet?.title ?? '',
          ...(raw.snippet?.publishedAt === undefined
            ? {}
            : { published_at: raw.snippet.publishedAt }),
          url: `https://www.youtube.com/watch?v=${raw.id ?? ''}`,
          metrics: {
            ...(int(raw.statistics?.viewCount) === undefined
              ? {}
              : { views: int(raw.statistics?.viewCount) as number }),
            ...(int(raw.statistics?.likeCount) === undefined
              ? {}
              : { likes: int(raw.statistics?.likeCount) as number }),
            ...(int(raw.statistics?.commentCount) === undefined
              ? {}
              : { comments: int(raw.statistics?.commentCount) as number }),
          },
        })),
      }
    },

    async comments({
      account_external_id,
      post_external_id,
      limit,
    }): Promise<SocialResult<ChannelComment[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const k = encodeURIComponent(await key())
      // 频道级（`allThreadsRelatedToChannelId`）与视频级（`videoId`）两条路都在文档里；
      // 给了视频就要那一条，没给就要整个频道的——比 Meta 那边多一条路。
      const scope =
        post_external_id === undefined
          ? `allThreadsRelatedToChannelId=${encodeURIComponent(account_external_id)}`
          : `videoId=${encodeURIComponent(post_external_id)}`
      const url = `${YOUTUBE_API_BASE}/commentThreads?part=snippet&${scope}&maxResults=${limit ?? 50}&key=${k}`
      const res = await callJson<{ items?: RawCommentThread[] }>(transport, LABEL, url)
      if (!('data' in res)) return res.status === 403 ? quotaExhausted() : res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.items ?? []).map((raw) => {
          const top = raw.snippet?.topLevelComment
          const s = top?.snippet
          return {
            external_id: top?.id ?? raw.id ?? '',
            ...(raw.snippet?.videoId === undefined
              ? {}
              : { parent_external_id: raw.snippet.videoId }),
            surface: 'comment' as const,
            author_external_id: s?.authorChannelId?.value ?? '',
            author_handle: s?.authorDisplayName ?? '',
            text: s?.textOriginal ?? '',
            created_at: s?.publishedAt ?? transport.now(),
          }
        }),
      }
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const headers = await bearer()
      if (headers.Authorization === undefined)
        return {
          ok: false,
          reason: 'not_connected',
          message: `${LABEL} 回评论要 OAuth 令牌（读用 API key 就够，写不行）。去连接页把 YouTube 重新授权一次，勾上"管理你的 YouTube 账号"。`,
        }
      const url = `${YOUTUBE_API_BASE}/comments?part=snippet`
      const res = await callJson<{ id?: string }>(transport, LABEL, url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          snippet: { parentId: input.parent_external_id, textOriginal: input.text },
        }),
      })
      if (!('data' in res)) return res
      return { ok: true, observed_at: transport.now(), data: { external_id: res.data.id ?? '' } }
    },

    // `publish` 故意缺席（文件头第 3 条）：上传要走 resumable upload，
    // 不是一次 JSON 调用。缺席本身就是信息——调用方据此把"发布"那个按钮画成灰的。
  }
}
