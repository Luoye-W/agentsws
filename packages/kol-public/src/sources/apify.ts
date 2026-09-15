/**
 * Apify 这一路：YouTube 官方配额耗尽之后的降级，以及 IG / TikTok / X 这些
 * 官方口申请制 / 付费档下的兜底（48 §5.3）。
 *
 * 两条纪律：
 *
 * 1. **没有 `APIFY_TOKEN` 就不降级**——回一句"今天配额用完了"，
 *    而不是悄悄换一个别的源。用户看到的"数据从哪来"必须一直是真的（40 §1）。
 * 2. Apify 是**境外**源：数据驻留 `cn` 的请求一个都不走它（22 §2）。
 *
 * 与 `youtube.ts` 同一条：这一版只有接口与假实现，真的 actor run 留给后续 WP。
 */
import type { KolChannel } from '@agentsws/contracts'
import { KolError, type KolSource, type SourceSnapshot } from '../types.js'

/** Apify 按 actor run 计费，不占我们的 YouTube 配额单位。 */
export const APIFY_UNITS = 0

export function apifySource(options: { token: () => string | undefined }): KolSource {
  return {
    id: 'apify',
    offshore: true,
    units: () => APIFY_UNITS,
    async fetch(): Promise<SourceSnapshot | undefined> {
      if (options.token() === undefined)
        throw new KolError('not_implemented', '云侧没有配 Apify 的令牌。')
      throw new KolError(
        'not_implemented',
        'Apify 降级的真调用还没接上（WP61 只做接口与降级判定）。现在只能查库里已有的资料。',
      )
    },
  }
}

/** 测试与 `bin/dev.mjs` 用的假实现。 */
export function fakeApifySource(snapshots: SourceSnapshot[]): KolSource {
  return {
    id: 'apify',
    offshore: true,
    units: () => APIFY_UNITS,
    fetch: (key: { channel: KolChannel; handle: string }) =>
      Promise.resolve(snapshots.find((s) => s.channel === key.channel && s.handle === key.handle)),
  }
}
