/**
 * YouTube 适配器（48 §5.1：官方 Data API 搜索 + 频道"关于"页邮箱、配额池 10k/天）。
 *
 * WP67 做的是**接口 + 走 transport 的实现**：四个口子都按真形状写好，
 * 真正打 HTTP 的那一跳由宿主注入（见 `types.ts` 第 1 条）。测试里注入一个假的，
 * 于是"没连怎么办""配额用完怎么办"这几条现在就测得了，不用等连接器接上。
 *
 * 配额那件事这里只做一半：适配器**报**上游说的配额错误（`quota_exhausted`），
 * 不自己记账——全站 10k 单位是**账号级**的数，一个进程里记不准（48 §5.3 说它
 * 属于云端的配额池）。报得准比算得像更有用。
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

const CHANNEL: KolChannel = 'youtube'
const LABEL = 'YouTube'

/** 上游回来的一条频道（Data API `channels.list` 那一份的子集）。 */
interface RawChannel {
  id?: string
  handle?: string
  title?: string
  subscriber_count?: number
  engagement_rate?: number
  topic?: string
  language?: string
  country?: string
  about_url?: string
}

const hitOf = (raw: RawChannel): ChannelSearchHit => ({
  channel: CHANNEL,
  handle: (raw.handle ?? raw.id ?? '').replace(/^@/, '').toLowerCase(),
  url: `https://www.youtube.com/@${(raw.handle ?? raw.id ?? '').replace(/^@/, '')}`,
  display_name: raw.title ?? raw.handle ?? raw.id ?? '',
  ...(raw.subscriber_count === undefined ? {} : { followers: raw.subscriber_count }),
  ...(raw.engagement_rate === undefined ? {} : { engagement_rate: raw.engagement_rate }),
  ...(raw.topic === undefined ? {} : { category: raw.topic }),
  ...(raw.language === undefined ? {} : { language: raw.language }),
  ...(raw.country === undefined ? {} : { region: raw.country.toUpperCase() }),
})

/** 把上游抛的错翻成人话。认不出来的一律 `upstream_error`，不编原因。 */
function failureOf(e: unknown): ChannelResult<never> {
  const text = e instanceof Error ? e.message : String(e)
  if (/quota/i.test(text))
    return {
      ok: false,
      reason: 'quota_exhausted',
      message: `${LABEL} 今天的接口配额用完了（全站一天 10000 单位，不是按我们这一个工作区算的）。明天会重置；着急的话先用导入或公共库。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    message: `${LABEL} 那边没给回数据：${text.slice(0, 160)}`,
  }
}

export function createYouTubeAdapter(transport: KolChannelTransport): KolChannelAdapter {
  const guard = <T>(): ChannelResult<T> | undefined =>
    transport.connected(CHANNEL) ? undefined : notConnected(LABEL)

  return {
    channel: CHANNEL,

    async search(q: ChannelSearchQuery): Promise<ChannelResult<ChannelSearchHit[]>> {
      const off = guard<ChannelSearchHit[]>()
      if (off !== undefined) return off
      try {
        const raw = await transport.call<{ channels: RawChannel[] }>({
          channel: CHANNEL,
          action: 'search_channels',
          params: {
            q: q.q,
            ...(q.language === undefined ? {} : { relevanceLanguage: q.language }),
            ...(q.region === undefined ? {} : { regionCode: q.region }),
            maxResults: q.limit ?? 25,
          },
        })
        return { ok: true, data: raw.channels.map(hitOf), observed_at: transport.now() }
      } catch (e) {
        return failureOf(e)
      }
    },

    async profile(handle: string): Promise<ChannelResult<ChannelSearchHit>> {
      const off = guard<ChannelSearchHit>()
      if (off !== undefined) return off
      try {
        const raw = await transport.call<RawChannel>({
          channel: CHANNEL,
          action: 'get_channel',
          params: { handle },
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
        // k-匿名基准在云上（48 §5.3）。本地连不上就回 `undefined` 而不是报错——
        // "没有基准"是常态，界面上那一格空着就行，不该弹一个错误。
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
      try {
        const raw = await transport.call<RawChannel>({
          channel: CHANNEL,
          action: 'get_channel',
          params: { handle },
        })
        const about = raw.about_url ?? `https://www.youtube.com/@${handle.replace(/^@/, '')}/about`
        // 只回"在哪儿找"，不回明文（`types.ts` 的 `ContactHint` 注释）
        return {
          ok: true,
          data: [
            {
              kind: 'email',
              where: about,
              how: '频道"关于"页上的商务邮箱要点一下"查看邮件地址"才显示，还带验证码——所以这一步是人去拿，不是我们去抓。',
            },
          ],
          observed_at: transport.now(),
        }
      } catch (e) {
        return failureOf(e)
      }
    },
  }
}
