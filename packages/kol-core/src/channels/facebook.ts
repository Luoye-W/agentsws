/**
 * Facebook 适配器（48 §5.1：主页 / 群组博主、Graph API 权限、主页私信建联）。
 *
 * 与 YouTube / Instagram 那两份同形状，三处不同，都来自平台本身：
 *
 * 1. **搜人要 `Page Public Content Access`**，那是审核制的。没批下来时上游回的是
 *    权限错，不是"搜到 0 个"——所以这里把它翻成 `needs_approval` 并说清楚差哪一步。
 *    回一个空数组等于告诉用户"Facebook 上没有做这个品类的人"，那是假话。
 * 2. **建联走主页私信，不走邮箱**。很多主页压根没留邮箱；Graph 的 `emails` 字段
 *    只有主页管理员自己读得到。所以 `contact_hint` 第一条是私信入口，
 *    邮箱那条写明"只有主页自己公开了才有"。
 * 3. **粉丝数有两格**：`followers_count`（关注）与 `fan_count`（赞过）。
 *    2018 年之后这两个数在多数主页上已经分家，取 `followers_count`——
 *    打分看的是"有多少人会看到他发的东西"。
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

const CHANNEL: KolChannel = 'facebook'
const LABEL = 'Facebook'

/** Graph API `/{page-id}?fields=…` 回来那一份的子集。 */
interface RawPage {
  id?: string
  name?: string
  username?: string
  followers_count?: number
  fan_count?: number
  engagement_rate?: number
  category?: string
  link?: string
  /** 只有主页管理员自己读得到；别人读到的是 `undefined`，不是空数组。 */
  emails?: string[]
  about?: string
  country_page_likes?: number
  locale?: string
}

const hitOf = (raw: RawPage): ChannelSearchHit => {
  const handle = (raw.username ?? raw.id ?? '').replace(/^@/, '').toLowerCase()
  return {
    channel: CHANNEL,
    handle,
    url: raw.link ?? `https://www.facebook.com/${handle}`,
    display_name: raw.name ?? raw.username ?? raw.id ?? '',
    // 关注数优先于"赞过"：打分看的是"有多少人会看到他发的东西"
    ...((raw.followers_count ?? raw.fan_count) === undefined
      ? {}
      : { followers: (raw.followers_count ?? raw.fan_count) as number }),
    ...(raw.engagement_rate === undefined ? {} : { engagement_rate: raw.engagement_rate }),
    ...(raw.category === undefined ? {} : { category: raw.category }),
    ...(raw.locale === undefined ? {} : { language: raw.locale.replace('_', '-') }),
  }
}

/** 把上游抛的错翻成人话。认不出来的一律 `upstream_error`，不编原因。 */
function failureOf(e: unknown): ChannelResult<never> {
  const text = e instanceof Error ? e.message : String(e)
  if (/permission|scope|oauth|\(#10\)|\(#200\)/i.test(text))
    return {
      ok: false,
      reason: 'needs_approval',
      message: `${LABEL} 这一跳要的权限还没批下来。Meta 的「主页公开内容访问」（Page Public Content Access）是审核制，要在开发者后台提交用途说明。批下来之前，找人靠导入与公共库，建联靠人工到主页发私信。`,
    }
  if (/rate|limit|\(#4\)|\(#17\)|\(#32\)/i.test(text))
    return {
      ok: false,
      reason: 'quota_exhausted',
      message: `${LABEL} 那边限流了（Graph API 按应用算一小时一个额度）。过一会儿再试；着急的话先用导入或公共库。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    message: `${LABEL} 那边没给回数据：${text.slice(0, 160)}`,
  }
}

export function createFacebookAdapter(transport: KolChannelTransport): KolChannelAdapter {
  const guard = <T>(): ChannelResult<T> | undefined =>
    transport.connected(CHANNEL) ? undefined : notConnected(LABEL)

  return {
    channel: CHANNEL,

    async search(q: ChannelSearchQuery): Promise<ChannelResult<ChannelSearchHit[]>> {
      const off = guard<ChannelSearchHit[]>()
      if (off !== undefined) return off
      try {
        const raw = await transport.call<{ data?: RawPage[] }>({
          channel: CHANNEL,
          action: 'search_pages',
          params: {
            q: q.q,
            type: 'page',
            limit: q.limit ?? 25,
            ...(q.region === undefined ? {} : { country: q.region.toUpperCase() }),
          },
        })
        const hits = (raw.data ?? []).map(hitOf)
        return {
          ok: true,
          data:
            q.followers_band === undefined
              ? hits
              : hits.filter(
                  (h) =>
                    h.followers === undefined ||
                    (h.followers >= (q.followers_band as { min: number }).min &&
                      h.followers <= (q.followers_band as { max: number }).max),
                ),
          observed_at: transport.now(),
        }
      } catch (e) {
        return failureOf(e)
      }
    },

    async profile(handle: string): Promise<ChannelResult<ChannelSearchHit>> {
      const off = guard<ChannelSearchHit>()
      if (off !== undefined) return off
      try {
        const raw = await transport.call<RawPage>({
          channel: CHANNEL,
          action: 'get_page',
          params: { page_id: handle.replace(/^@/, '') },
        })
        return { ok: true, data: hitOf(raw), observed_at: transport.now() }
      } catch (e) {
        return failureOf(e)
      }
    },

    async benchmark(followers: number): Promise<ChannelResult<ChannelBenchmark | undefined>> {
      const off = guard<ChannelBenchmark | undefined>()
      if (off !== undefined) return off
      try {
        // k-匿名基准在云上（48 §5.3）。本地拿不到就回 `undefined` 而不是报错
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
      let about: RawPage | undefined
      try {
        about = await transport.call<RawPage>({
          channel: CHANNEL,
          action: 'get_page',
          params: { page_id: clean },
        })
      } catch {
        // 读不到"关于"也照样能给出私信入口——建联不该因为读不到简介就停下
      }
      const hints: ContactHint[] = [
        {
          kind: 'dm',
          where: `https://m.me/${clean}`,
          how: '主页私信。对方主页要开了「允许消息」才收得到；开没开在主页上看得出来。第一条私信落在「其他」箱里是常事，所以别只发一条就当没人理。',
        },
      ]
      // `emails` 只有主页管理员读得到；读到了才说有，没读到不编一个
      if (about?.emails !== undefined && about.emails.length > 0)
        hints.push({
          kind: 'email',
          where: `https://www.facebook.com/${clean}/about`,
          how: '这个主页在「关于」里公开了商务邮箱——优先走邮箱，比私信靠谱。',
        })
      return { ok: true, data: hints, observed_at: transport.now() }
    },
  }
}
