/**
 * TikTok 适配器（48 §5.1：Research API 申请制、TikTok Shop 联盟带货归因）。
 *
 * 三处与别的渠道不同，都来自平台本身：
 *
 * 1. **没有"按关键词搜人"这个接口**。Research API 只有 `/v2/research/user/info/`
 *    （按 username 查一个）与视频查询；用视频查询去反推人，拿到的是"发过这条视频的人"，
 *    与"这个品类的红人"不是一回事。所以 `search` 和 Instagram 一样：给一个或几个
 *    账号名，逐个查。把它硬做成搜索，用户会以为搜不到就是没有这个人。
 * 2. **申请制**。没批下来时上游回的是 401/403，翻成 `needs_approval` 并说清楚
 *    要去哪儿申请——与"没连"分得开：那个用户去连接页能修好，这个他得等审核。
 * 3. **互动率要自己算**。Research API 的用户信息里没有互动率这一格，只有
 *    `likes_count` / `video_count` / `follower_count`。这里按
 *    「人均获赞 ÷ 粉丝数」估一个，并且**只在三个数都有且粉丝数不为 0 时**才给——
 *    估不出来就没有这一格，不给一个 0（0 会被打分当成"互动极差"）。
 */
import type { KolChannel } from '@agentsws/contracts'
import {
  type ChannelBenchmark,
  type ChannelResult,
  type ChannelSearchHit,
  type ChannelSearchQuery,
  type ContactHint,
  type KolChannelAdapter,
  type KolChannelTransport,
  notConnected,
} from './types.js'

const CHANNEL: KolChannel = 'tiktok'
const LABEL = 'TikTok'

/** `/v2/research/user/info/` 回来那一份的子集（`data` 里那一层）。 */
interface RawUser {
  display_name?: string
  username?: string
  follower_count?: number
  following_count?: number
  likes_count?: number
  video_count?: number
  bio_description?: string
  is_verified?: boolean
  region_code?: string
}

/**
 * 互动率估算：人均获赞 ÷ 粉丝数。
 *
 * 三个数缺一个、或者粉丝数是 0 就回 `undefined`——估不出来比估一个 0 强，
 * 因为 0 在打分里的意思是"互动极差"，那是一句假话。
 */
export function tiktokEngagementRate(raw: RawUser): number | undefined {
  const { likes_count, video_count, follower_count } = raw
  if (likes_count === undefined || video_count === undefined || follower_count === undefined)
    return undefined
  if (video_count <= 0 || follower_count <= 0) return undefined
  const perVideo = likes_count / video_count
  // 上限 1：老账号的累计赞除以现在的粉丝数偶尔会大于 1，那不是"互动率 300%"
  return Math.min(1, perVideo / follower_count)
}

const hitOf = (raw: RawUser): ChannelSearchHit => {
  const handle = (raw.username ?? '').replace(/^@/, '').toLowerCase()
  const rate = tiktokEngagementRate(raw)
  return {
    channel: CHANNEL,
    handle,
    url: `https://www.tiktok.com/@${handle}`,
    display_name: raw.display_name ?? raw.username ?? '',
    ...(raw.follower_count === undefined ? {} : { followers: raw.follower_count }),
    ...(rate === undefined ? {} : { engagement_rate: rate }),
    ...(raw.region_code === undefined ? {} : { region: raw.region_code.toUpperCase() }),
  }
}

function failureOf(e: unknown): ChannelResult<never> {
  const text = e instanceof Error ? e.message : String(e)
  if (/scope_not_authorized|access_denied|unauthorized|forbidden|401|403/i.test(text))
    return {
      ok: false,
      reason: 'needs_approval',
      message: `${LABEL} 的 Research API 是申请制：要在 TikTok for Developers 里提交用途说明，批了才有数据。批下来之前这条职责照常能用——找人靠导入你手上那张表与公共库，建联、合作、审核、归因一样不少。`,
    }
  if (/rate_limit|too many|429/i.test(text))
    return {
      ok: false,
      reason: 'quota_exhausted',
      message: `${LABEL} 那边限流了（Research API 按天算配额）。明天会重置；着急的话先用导入或公共库。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    message: `${LABEL} 那边没给回数据：${text.slice(0, 160)}`,
  }
}

export function createTikTokAdapter(transport: KolChannelTransport): KolChannelAdapter {
  const guard = <T>(): ChannelResult<T> | undefined =>
    transport.connected(CHANNEL) ? undefined : notConnected(LABEL)

  const lookup = async (handle: string): Promise<RawUser> => {
    const raw = await transport.call<{ data?: RawUser } | RawUser>({
      channel: CHANNEL,
      action: 'get_user',
      params: { username: handle.replace(/^@/, '') },
    })
    // Research API 把结果包在 `data` 里；替身与旧回放可能直接给那一层
    return (raw as { data?: RawUser }).data ?? (raw as RawUser)
  }

  return {
    channel: CHANNEL,

    /** `q` 当成一个 handle 或一串用逗号隔开的 handle 逐个查（见文件头第 1 条）。 */
    async search(q: ChannelSearchQuery): Promise<ChannelResult<ChannelSearchHit[]>> {
      const off = guard<ChannelSearchHit[]>()
      if (off !== undefined) return off
      const handles = q.q
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .slice(0, q.limit ?? 25)
      if (handles.length === 0)
        return {
          ok: false,
          reason: 'upstream_error',
          message: `${LABEL} 的 Research API 没有"按关键词搜人"这个接口——给一个或几个账号名（@开头那个），我按名字去查。`,
        }
      const out: ChannelSearchHit[] = []
      let lastError: unknown
      for (const h of handles) {
        try {
          out.push(hitOf(await lookup(h)))
        } catch (e) {
          // 查不到的那一个跳过（名字打错了 / 账号没了）；整批不失败
          lastError = e
        }
      }
      // 一个都没查到而且确实报过错：那多半不是"这些人都不在"，是权限或配额
      if (out.length === 0 && lastError !== undefined) return failureOf(lastError)
      return { ok: true, data: out, observed_at: transport.now() }
    },

    async profile(handle: string): Promise<ChannelResult<ChannelSearchHit>> {
      const off = guard<ChannelSearchHit>()
      if (off !== undefined) return off
      try {
        return { ok: true, data: hitOf(await lookup(handle)), observed_at: transport.now() }
      } catch (e) {
        return failureOf(e)
      }
    },

    async benchmark(followers: number): Promise<ChannelResult<ChannelBenchmark | undefined>> {
      const off = guard<ChannelBenchmark | undefined>()
      if (off !== undefined) return off
      try {
        const raw = await transport.call<ChannelBenchmark | undefined>({
          channel: CHANNEL,
          action: 'get_benchmark',
          params: { followers },
        })
        return { ok: true, data: raw, observed_at: transport.now() }
      } catch (e) {
        return failureOf(e)
      }
    },

    async contact_hint(handle: string): Promise<ChannelResult<ContactHint[]>> {
      const off = guard<ContactHint[]>()
      if (off !== undefined) return off
      const clean = handle.replace(/^@/, '')
      let bio: string | undefined
      try {
        bio = (await lookup(clean)).bio_description
      } catch {
        // 读不到简介照样给得出私信入口
      }
      const hints: ContactHint[] = [
        {
          kind: 'dm',
          where: `https://www.tiktok.com/@${clean}`,
          how: 'TikTok 建联走私信，而且**要先互相关注**对方才收得到。所以简介里留了邮箱的，一律先走邮箱。',
        },
      ]
      // 简介里像邮箱的那一段：只说"简介里有"，不把地址抓回来（明文要人自己确认一眼）
      if (bio !== undefined && /[\w.+-]+@[\w-]+\.[\w.]+/.test(bio))
        hints.push({
          kind: 'email',
          where: `https://www.tiktok.com/@${clean}`,
          how: '他在简介里写了一个邮箱。那一段文字要人读一眼再抄——简介里的地址常带空格或者写成 "name (at) domain"。',
        })
      return { ok: true, data: hints, observed_at: transport.now() }
    },
  }
}
