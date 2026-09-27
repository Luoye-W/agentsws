/** WP155：三家适配器的登记处（docs/81）。加一家 = 写一个适配器 + 在这里登记一行。 */
import type { SearchDataProvider } from '@agentsws/contracts'
import type { SearchProviderAdapter } from '../provider.js'
import { dataforseo } from './dataforseo.js'
import { serpapi } from './serpapi.js'
import { serper } from './serper.js'

export const SEARCH_PROVIDERS: Readonly<Record<SearchDataProvider, SearchProviderAdapter>> = {
  dataforseo,
  serpapi,
  serper,
}

/** 按名字取适配器；认不出回 `undefined`（不猜）。 */
export function searchProviderOf(id: string): SearchProviderAdapter | undefined {
  return Object.hasOwn(SEARCH_PROVIDERS, id)
    ? SEARCH_PROVIDERS[id as SearchDataProvider]
    : undefined
}
