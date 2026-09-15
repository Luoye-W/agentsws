/**
 * YouTube 官方 Data API 这一路（48 §5.3「YouTube 配额池 + Apify 降级」）。
 *
 * **这一版只有接口、配额池与假实现**：真的 HTTP 调用留给后续 WP。
 * 为什么不顺手写一份"看起来对"的解析：在没有真 key 可验的地方照着文档写解析，
 * 上线第一天就会用错字段名，而错的地方是**所有人共用的那张公共库**——
 * 一条错数据洗进去，后面所有基准与体检都跟着错。没有比这更贵的"顺手"。
 *
 * 配额池是真的（它不需要联网就能验）：
 *
 * - 按天计（UTC），全站一个池子（`YOUTUBE_UNITS_PER_DAY` 默认 10000，可从 env 调）；
 * - 计数落在 `kol_plugin_quota` 那张表的 `source:youtube` 这一行；
 * - **不够就不扣**：`take()` 是先看够不够再扣，扣不动回 `false`，调用方去降级。
 *   为什么全站一个池子不按租户切：配额本来就是我们这把 key 的配额，
 *   按租户切只会让第一个租户把别人的份额也占着。
 */
import type { KolChannel } from '@agentsws/contracts'
import { YOUTUBE_UNIT_COST, YOUTUBE_UNITS_PER_DAY } from '@agentsws/contracts'
import { dayOf } from '../normalize.js'
import type { KolStore } from '../store.js'
import { KolError, type KolSource, type SourceSnapshot } from '../types.js'

/** 配额池在 `kol_plugin_quota` 里的那一行。 */
export const YOUTUBE_QUOTA_SUBJECT = 'source:youtube'

export interface QuotaPool {
  /** 够就扣掉并回 `true`；不够**一个单位都不扣**并回 `false`。 */
  take(units: number, at: string): boolean
  remaining(at: string): number
}

export function createQuotaPool(options: {
  store: KolStore
  subject?: string
  unitsPerDay?: number
}): QuotaPool {
  const subject = options.subject ?? YOUTUBE_QUOTA_SUBJECT
  const perDay = options.unitsPerDay ?? YOUTUBE_UNITS_PER_DAY
  return {
    take(units, at) {
      const day = dayOf(at)
      const row = options.store.quota(subject, day)
      if (row.units + units > perDay) return false
      options.store.putQuota({ ...row, units: row.units + units })
      return true
    },
    remaining(at) {
      return Math.max(0, perDay - options.store.quota(subject, dayOf(at)).units)
    },
  }
}

/** 一次取数要多少单位：读一个频道 1 个，搜一次 100 个（官方口径）。 */
export const YOUTUBE_FETCH_UNITS = YOUTUBE_UNIT_COST.channel + YOUTUBE_UNIT_COST.search

/**
 * 官方口的那个源。
 *
 * 真调用没接：调到这里会抛 `not_implemented` 并带一句人话——**不是静默回空**。
 * 静默回空会让"今天没抓到"与"这个功能还没做"长得一模一样，
 * 而这两件事该由完全不同的人去处理。
 */
export function youtubeSource(options: { apiKey: () => string | undefined }): KolSource {
  return {
    id: 'youtube',
    offshore: true,
    units: () => YOUTUBE_FETCH_UNITS,
    async fetch(): Promise<SourceSnapshot | undefined> {
      if (options.apiKey() === undefined)
        throw new KolError('not_implemented', '云侧没有配 YouTube 的 key。')
      throw new KolError(
        'not_implemented',
        'YouTube 官方口的真调用还没接上（WP61 只做接口、配额池与降级）。现在只能查库里已有的资料。',
      )
    },
  }
}

/** 测试与 `bin/dev.mjs` 用的假实现：从一张给定的表里取，不联网。 */
export function fakeYoutubeSource(snapshots: SourceSnapshot[]): KolSource {
  return {
    id: 'youtube',
    offshore: true,
    units: () => YOUTUBE_FETCH_UNITS,
    fetch: (key: { channel: KolChannel; handle: string }) =>
      Promise.resolve(snapshots.find((s) => s.channel === key.channel && s.handle === key.handle)),
  }
}
