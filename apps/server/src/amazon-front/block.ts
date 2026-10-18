/**
 * WP402（决策 1146）：**品牌级「被 Amazon 拦了」**——竞品读页（WP394）和联想词（WP398）原来各记各的暂停，
 * 现在合成一份：任一边在工坊内置浏览器里碰到验证页，这个品牌 24 小时内内置浏览器一页 Amazon 都不开，
 * 两边**同时**转取数链的下一条路（竞品 → 工坊云端；联想词 → 你自己的浏览器，要同意）。
 *
 * 存在这个品牌的竞品监控库杂项里（重启不丢）。老的两份暂停不再读（还没有真实用户，不留兼容层）。
 */
import { AMAZON_BRAND_PAUSE_MS, type AmazonBlockState } from '@agentsws/contracts'

export interface AmazonBlockPort {
  /** 暂停到几点（毫秒）；没在暂停回 `undefined`。 */
  pausedUntil(): number | undefined
  /** 记一次被拦（哪一边先碰到的）。 */
  block(by: NonNullable<AmazonBlockState['by']>): number
  state(): AmazonBlockState
}

export interface AmazonBlockDeps {
  get(): AmazonBlockState | undefined
  set(next: AmazonBlockState): void
  nowMs(): number
  log?(message: string, fields?: Record<string, unknown>): void
}

export function createAmazonBlock(deps: AmazonBlockDeps): AmazonBlockPort {
  return {
    state: () => deps.get() ?? {},
    pausedUntil() {
      const own = deps.get()?.paused_until
      const until = own === undefined ? Number.NaN : Date.parse(own)
      return Number.isFinite(until) && until > deps.nowMs() ? until : undefined
    },
    block(by) {
      const now = deps.nowMs()
      const until = now + AMAZON_BRAND_PAUSE_MS
      deps.set({
        paused_until: new Date(until).toISOString(),
        by,
        at: new Date(now).toISOString(),
      })
      deps.log?.('Amazon 要人机验证：这个品牌暂停用内置浏览器读 Amazon', { by })
      return until
    },
  }
}
