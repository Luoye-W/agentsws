/**
 * X 适配器（48 §5.1：API 付费档、帖子 / 长文审核）。
 *
 * 三处与别的渠道不同：
 *
 * 1. **API v2 没有"按关键词搜人"**。有的是 `GET /2/users/by?usernames=a,b,c`
 *    （一次最多 100 个）与 `GET /2/users/by/username/:name`。所以 `search` 收的是
 *    账号名清单，一次批量查回来——比 Instagram / TikTok 那两条好一点：
 *    那两条只能一个一个查，这条一跳能查一批。
 * 2. **付费档**。403 在这里最常见的意思不是"没权限看这个人"，是"你这个档位
 *    读不了这个接口"。翻成 `needs_approval` 并说清楚是**要买档**，
 *    不是去哪儿点一下就能开——说错了用户会在设置里找一整天。
 * 3. **互动率要自己算**：`public_metrics` 里只有关注数、帖子数、被列表收录数，
 *    没有互动率。单个用户接口拿不到近期帖子的互动数，所以这一格**不给**——
 *    估不出来就说估不出来，打分那边会把"数据不全"算进去（`kol-core` 的 `scoring`）。
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

const CHANNEL: KolChannel = 'x'
const LABEL = 'X'

/** `GET /2/users/by/username/:name?user.fields=…` 回来那一份的子集。 */
interface RawUser {
  id?: string
  name?: string
  username?: string
  description?: string
  location?: string
  verified?: boolean
  public_metrics?: {
    followers_count?: number
    following_count?: number
    tweet_count?: number
    listed_count?: number
  }
}

const hitOf = (raw: RawUser): ChannelSearchHit => {
  const handle = (raw.username ?? '').replace(/^@/, '').toLowerCase()
  const followers = raw.public_metrics?.followers_count
  return {
    channel: CHANNEL,
    handle,
    url: `https://x.com/${handle}`,
    display_name: raw.name ?? raw.username ?? '',
    ...(followers === undefined ? {} : { followers }),
    // 互动率这一格**故意空着**（见文件头第 3 条）
    ...(raw.location === undefined || raw.location === '' ? {} : { region: raw.location }),
  }
}

function failureOf(e: unknown): ChannelResult<never> {
  const text = e instanceof Error ? e.message : String(e)
  if (/client-not-enrolled|403|forbidden|access level|not authorized/i.test(text))
    return {
      ok: false,
      reason: 'needs_approval',
      message: `${LABEL} 的这个接口不在你当前的 API 档位里。X 的官方 API 是**付费**的，要在开发者后台升档才读得到——这一步花钱，不是点一下就能开。在那之前找人走导入与公共库。`,
    }
  if (/rate limit|429|too many/i.test(text))
    return {
      ok: false,
      reason: 'quota_exhausted',
      message: `${LABEL} 那边限流了（按 15 分钟一个窗口算）。等一刻钟再试。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    message: `${LABEL} 那边没给回数据：${text.slice(0, 160)}`,
  }
}

/** 一次最多查几个（X API v2 `users/by` 的上限）。 */
export const X_USERS_BY_LIMIT = 100

export function createXAdapter(transport: KolChannelTransport): KolChannelAdapter {
  const guard = <T>(): ChannelResult<T> | undefined =>
    transport.connected(CHANNEL) ? undefined : notConnected(LABEL)

  return {
    channel: CHANNEL,

    /** `q` 是一个或一串账号名（见文件头第 1 条）。 */
    async search(q: ChannelSearchQuery): Promise<ChannelResult<ChannelSearchHit[]>> {
      const off = guard<ChannelSearchHit[]>()
      if (off !== undefined) return off
      const handles = q.q
        .split(/[,，\s]+/)
        .map((s) => s.trim().replace(/^@/, ''))
        .filter((s) => s !== '')
        .slice(0, Math.min(q.limit ?? X_USERS_BY_LIMIT, X_USERS_BY_LIMIT))
      if (handles.length === 0)
        return {
          ok: false,
          reason: 'upstream_error',
          message: `${LABEL} 的官方接口没有"按关键词搜人"这回事——给一个或几个账号名（@开头那个），我一次全查回来。`,
        }
      try {
        const raw = await transport.call<{ data?: RawUser[]; errors?: unknown[] }>({
          channel: CHANNEL,
          action: 'search_users',
          params: { usernames: handles.join(',') },
        })
        // `errors` 里是查不到的那几个（名字打错 / 账号注销）——整批不失败
        return { ok: true, data: (raw.data ?? []).map(hitOf), observed_at: transport.now() }
      } catch (e) {
        return failureOf(e)
      }
    },

    async profile(handle: string): Promise<ChannelResult<ChannelSearchHit>> {
      const off = guard<ChannelSearchHit>()
      if (off !== undefined) return off
      try {
        const raw = await transport.call<{ data?: RawUser } | RawUser>({
          channel: CHANNEL,
          action: 'get_user',
          params: { username: handle.replace(/^@/, '') },
        })
        const user = (raw as { data?: RawUser }).data ?? (raw as RawUser)
        return { ok: true, data: hitOf(user), observed_at: transport.now() }
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
      let description: string | undefined
      try {
        const raw = await transport.call<{ data?: RawUser } | RawUser>({
          channel: CHANNEL,
          action: 'get_user',
          params: { username: clean },
        })
        description = ((raw as { data?: RawUser }).data ?? (raw as RawUser)).description
      } catch {
        // 读不到简介照样给得出私信入口
      }
      const hints: ContactHint[] = [
        {
          kind: 'dm',
          where: `https://x.com/messages/compose?recipient_id=${encodeURIComponent(clean)}`,
          how: 'X 的私信要对方开了「接收所有人的私信」才收得到；没开的话第一条会被直接丢掉，你这边看不出来。所以简介里留了邮箱的优先走邮箱。',
        },
      ]
      if (description !== undefined && /[\w.+-]+@[\w-]+\.[\w.]+/.test(description))
        hints.push({
          kind: 'email',
          where: `https://x.com/${clean}`,
          how: '他在简介里写了一个邮箱。那一段文字要人读一眼再抄。',
        })
      return { ok: true, data: hints, observed_at: transport.now() }
    },
  }
}
