/**
 * WP398（docs/106 §5.6 / §13 A8）：读 Amazon 搜索框联想词的口子 + 用工坊内置浏览器读的那一份实现。
 *
 * 纪律（docs/106 §2.1 Amazon Agent Policy）：
 * - 请求的 User-Agent 带 `Agent/AgentsWorkshop`（桌面壳那一半对 Amazon 域名统一加，`apps/desktop/src/search-browser.ts`）；
 * - 不模仿人的节奏：排进内置浏览器那一条队，**固定间隔、不加随机停顿**（`steady`），每页算进每小时额度（决策 914）；
 * - 被拦（验证页 / 403 / 429）回 `blocked`，调用方这一轮停下：不重试、不换办法绕；
 * - 没有桌面壳（CI、托管实例）= 没有这个读法，照实说「读不了」，不退到别的办法去读。
 *
 * WP394 的读页积木合进来以后，这里的实现可以换成它；口子形状不变。
 */
import { amazonAutocompleteUrl, parseAmazonSuggestions } from '@agentsws/brand-intake'
import { blockOf, type SearchBrowserChannel, type SearchThrottle } from '../web-browser/index.js'

export type AutocompleteRead =
  | { status: 'ok'; suggestions: string[] }
  | { status: 'blocked'; message?: string }
  | { status: 'quota'; message?: string }
  | { status: 'failed'; message: string }

export interface AmazonAutocompleteReader {
  /** 读一个前缀的联想词（站点按国家码）。 */
  suggest(input: { marketplace: string; prefix: string }): Promise<AutocompleteRead>
}

/** 一页联想词等多久算没打开。 */
export const AUTOCOMPLETE_TIMEOUT_MS = 8_000

export function createBrowserAutocompleteReader(o: {
  workspace_id: string
  channel: SearchBrowserChannel
  throttle: SearchThrottle
}): AmazonAutocompleteReader {
  return {
    async suggest({ marketplace, prefix }) {
      const url = amazonAutocompleteUrl(marketplace, prefix)
      if (url === undefined)
        return { status: 'failed', message: `${marketplace} 站点的联想词还读不了` }
      const got = await o.throttle.run(
        () =>
          o.channel.open({
            workspace_id: o.workspace_id,
            url,
            kind: 'page',
            timeout_ms: AUTOCOMPLETE_TIMEOUT_MS,
            settle_ms: 0,
            max_chars: 60_000,
          }),
        { steady: true },
      )
      if (got === undefined)
        return {
          status: 'quota',
          message: `这一小时内置浏览器已经开了 ${o.throttle.maxPerHour} 页（上限），剩下的下次再读`,
        }
      if (!got.ok) return { status: 'failed', message: got.message }
      const block = blockOf(got)
      if (block !== undefined && block.kind !== 'login')
        return { status: 'blocked', message: `Amazon ${block.message}` }
      const parsed = parseAmazonSuggestions(got.page?.text ?? '')
      if (parsed.status === 'blocked') return { status: 'blocked', message: 'Amazon 出了验证页' }
      if (parsed.status === 'unreadable') return { status: 'failed', message: parsed.message }
      return { status: 'ok', suggestions: parsed.suggestions }
    },
  }
}
