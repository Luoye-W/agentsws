/**
 * Instagram 适配器（48 §5.1：IG DM 建联、Reels / 帖子审核、Basic Display 限制）。
 *
 * 与 YouTube 那份形状相同，两处不同，都来自平台本身：
 *
 * 1. **没有"搜人"这个接口**。Graph API 只让你读你自己（或你管理的商业账号）
 *    与 `business_discovery` 明确指名的那一个。所以 `search` 走的是
 *    `business_discovery` 的逐个查——查不到就是查不到，不返回一堆猜的。
 * 2. **建联走 DM 不走邮箱**。`contact_hint` 回的是私信入口，
 *    并说明白"DM 要对方先允许"这件事——不说清楚的话，用户会以为是我们没发出去。
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

const CHANNEL: KolChannel = 'instagram'
const LABEL = 'Instagram'

interface RawProfile {
  username?: string
  name?: string
  followers_count?: number
  engagement_rate?: number
  category?: string
  language?: string
  country?: string
}

const hitOf = (raw: RawProfile): ChannelSearchHit => {
  const handle = (raw.username ?? '').replace(/^@/, '').toLowerCase()
  return {
    channel: CHANNEL,
    handle,
    url: `https://www.instagram.com/${handle}`,
    display_name: raw.name ?? raw.username ?? '',
    ...(raw.followers_count === undefined ? {} : { followers: raw.followers_count }),
    ...(raw.engagement_rate === undefined ? {} : { engagement_rate: raw.engagement_rate }),
    ...(raw.category === undefined ? {} : { category: raw.category }),
    ...(raw.language === undefined ? {} : { language: raw.language }),
    ...(raw.country === undefined ? {} : { region: raw.country.toUpperCase() }),
  }
}

function failureOf(e: unknown): ChannelResult<never> {
  const text = e instanceof Error ? e.message : String(e)
  if (/permission|scope|oauth/i.test(text))
    return {
      ok: false,
      reason: 'needs_approval',
      message: `${LABEL} 这一跳要的权限还没批下来（Graph API 的商业账号权限是审核制）。审核通过之前，找人靠导入与公共库，建联靠人工私信。`,
    }
  if (/rate|limit/i.test(text))
    return {
      ok: false,
      reason: 'quota_exhausted',
      message: `${LABEL} 那边限流了，过一会儿再试。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    message: `${LABEL} 那边没给回数据：${text.slice(0, 160)}`,
  }
}

export function createInstagramAdapter(transport: KolChannelTransport): KolChannelAdapter {
  const guard = <T>(): ChannelResult<T> | undefined =>
    transport.connected(CHANNEL) ? undefined : notConnected(LABEL)

  const lookup = async (handle: string): Promise<RawProfile> =>
    transport.call<RawProfile>({
      channel: CHANNEL,
      action: 'business_discovery',
      params: { username: handle.replace(/^@/, '') },
    })

  return {
    channel: CHANNEL,

    /**
     * `q` 当成一个 handle 或一串用逗号隔开的 handle 逐个查。
     *
     * 这不是偷懒，是平台的形状：IG 没有"按关键词搜人"的公开接口。
     * 把它硬做成"搜索"，用户会以为搜不到就是没有这个人。
     */
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
          message: `${LABEL} 没有"按关键词搜人"这个接口——给一个或几个账号名（@开头那个），我按名字去查。`,
        }
      const out: ChannelSearchHit[] = []
      for (const h of handles) {
        try {
          out.push(hitOf(await lookup(h)))
        } catch {
          // 查不到的那一个跳过（对方不是商业账号，或者名字打错了）。
          // 整批不失败：查到三个里的两个，比什么都不给有用。
        }
      }
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
      return {
        ok: true,
        data: [
          {
            kind: 'dm',
            where: `https://www.instagram.com/${clean}`,
            how: 'IG 建联走私信。对方没开"允许陌生人私信"的话，第一条会落进请求箱里可能一直没人看——所以主页简介里留了邮箱的，优先走邮箱。',
          },
          {
            kind: 'email',
            where: `https://www.instagram.com/${clean}`,
            how: '很多人把商务邮箱写在主页简介里。那一段文字要人读一眼，不自动抓。',
          },
        ],
        observed_at: transport.now(),
      }
    },
  }
}
