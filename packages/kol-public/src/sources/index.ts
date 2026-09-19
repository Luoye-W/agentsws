/**
 * 取数那一跳：**驻留 → 配额 → 降级**，三步的顺序不能换。
 *
 * 1. **驻留先判**（22 §2 / 21）：`X-Agentsws-Region: cn` 的请求一个境外源都不走——
 *    先判驻留再判配额，是因为"配额还有"永远不该成为走境外源的理由；
 * 2. **配额再判**：YouTube 官方口从全站那个日池子里扣单位，扣不动就降级；
 * 3. **降级**：有 Apify 才降，没有就回一句"今天配额用完了，只查了库"。
 *
 * 三步的结果都是一个 {@link SourceOutcome}：**没取到不是错**。
 * 抛 500 会让"今天配额用完"和"云侧挂了"长得一样。
 */
import type { Iso8601, KolChannel } from '@agentsws/contracts'
import type { KolStore } from '../store.js'
import type { KolSource, SourceLookup, SourceOutcome } from '../types.js'
import { KOL_ENV, KolError } from '../types.js'
import { apifySource } from './apify.js'
import type { QuotaPool } from './youtube.js'
import { createQuotaPool, youtubeSource } from './youtube.js'

export { APIFY_UNITS, apifySource, fakeApifySource } from './apify.js'
export {
  createQuotaPool,
  fakeYoutubeSource,
  type QuotaPool,
  YOUTUBE_FETCH_UNITS,
  YOUTUBE_QUOTA_SUBJECT,
  youtubeSource,
} from './youtube.js'

export interface SourcePoolDeps {
  /** 官方口（只服务 YouTube 这一条渠道）。 */
  youtube?: KolSource
  /** 降级口（所有渠道）。没有它就不降级。 */
  apify?: KolSource
  /** YouTube 的日配额池。 */
  quota: QuotaPool
}

/** 把驻留、配额与降级串成一跳。 */
export function createSourcePool(deps: SourcePoolDeps): SourceLookup {
  return {
    async fetch(
      key: { channel: KolChannel; handle: string },
      options: { region: 'cn' | 'global'; at: Iso8601 },
    ): Promise<SourceOutcome> {
      // 1. 驻留：境外源一个都不走。明说是驻留挡的，不是"没找到"
      if (options.region === 'cn') {
        return {
          used: 'none',
          reason: 'residency',
          units: 0,
          message:
            '这个工作区选的是数据留在境内，YouTube 官方口与 Apify 都在境外——这一次只查了我们库里已有的资料，没有出境。',
        }
      }

      // 2. 官方口 + 配额池
      const youtube = deps.youtube
      if (key.channel === 'youtube' && youtube !== undefined) {
        const units = youtube.units()
        if (deps.quota.take(units, options.at)) {
          const snapshot = await youtube.fetch(key)
          return snapshot === undefined
            ? {
                used: 'youtube',
                reason: 'not_found',
                units,
                message: '官方口上没有这个频道。',
              }
            : { used: 'youtube', snapshot, units, message: '来自 YouTube 官方口。' }
        }
      }

      // 3. 降级
      const apify = deps.apify
      if (apify === undefined) {
        return {
          used: 'none',
          reason: key.channel === 'youtube' ? 'quota_exhausted' : 'no_source',
          units: 0,
          message:
            key.channel === 'youtube'
              ? '今天的 YouTube 配额用完了，也没有配降级的采集源——这一次只查了库里已有的资料，明天配额会重置。'
              : '这条渠道现在只有浏览器插件汇聚这一条数据来源（官方口是申请制 / 付费档），这一次只查了库里已有的资料。',
        }
      }
      const snapshot = await apify.fetch(key)
      return snapshot === undefined
        ? { used: 'apify', reason: 'not_found', units: 0, message: '降级的采集源也没找到这个人。' }
        : {
            used: 'apify',
            snapshot,
            units: 0,
            message: '今天的官方配额用完了，这一条来自降级的采集源。',
          }
    },
  }
}

/** 装配时按环境变量拼一个池子；`youtube` / `apify` 谁都可以没有。 */
export function sourcePoolFromParts(deps: SourcePoolDeps): SourceLookup {
  if (deps.youtube === undefined && deps.apify === undefined) {
    // 一个源都没有也要能起：那就是"只查库"，而不是一个起不来的云进程
    return {
      fetch: () =>
        Promise.resolve({
          used: 'none',
          reason: 'no_source',
          units: 0,
          message: '云侧现在没有配任何外部采集源，这一次只查了库里已有的资料。',
        } satisfies SourceOutcome),
    }
  }
  return createSourcePool(deps)
}

/** 源抛出来的 `not_implemented` 不该把整条请求打成 500。 */
export function outcomeOfError(err: unknown): SourceOutcome {
  if (err instanceof KolError && err.code === 'not_implemented')
    return { used: 'none', reason: 'no_source', units: 0, message: err.message }
  throw err
}

/**
 * 按环境变量拼外部源（**两个形态共用**：Compose 的 `apps/cloud` 与官方托管的
 * `KolPublicDO` 都调这一个）。
 *
 * 没有 key 就**没有那个源**，而不是一个会在运行时报错的空壳——"今天配额用完了"
 * 与"这个功能没配"是两句不同的人话，用户要能分得开。
 *
 * 为什么它在这个包里而不在装配方那边：哪个环境变量开哪个源是**这个包自己的事**，
 * 两个形态各写一遍迟早对不上（一边加了新源另一边没加，表现是"云上刷不出来"）。
 */
export function kolSourcesFromEnv(
  env: Record<string, string | undefined>,
  store: KolStore,
): SourceLookup {
  const unitsRaw = Number(env[KOL_ENV.youtubeUnitsPerDay])
  const quota = createQuotaPool({
    store,
    ...(Number.isFinite(unitsRaw) && unitsRaw > 0 ? { unitsPerDay: unitsRaw } : {}),
  })
  const youtube: KolSource | undefined =
    env[KOL_ENV.youtubeApiKey] === undefined || env[KOL_ENV.youtubeApiKey] === ''
      ? undefined
      : youtubeSource({ apiKey: () => env[KOL_ENV.youtubeApiKey] })
  const apify: KolSource | undefined =
    env[KOL_ENV.apifyToken] === undefined || env[KOL_ENV.apifyToken] === ''
      ? undefined
      : apifySource({ token: () => env[KOL_ENV.apifyToken] })
  return sourcePoolFromParts({
    quota,
    ...(youtube === undefined ? {} : { youtube }),
    ...(apify === undefined ? {} : { apify }),
  })
}
