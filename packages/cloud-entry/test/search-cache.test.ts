/** WP155：官方那一侧的搜索结果缓存（WP165 从 search-analyze.test.ts 拆出来——适配器搬进开源包 `@agentsws/search-providers`，缓存留在云端）。 */
import { describe, expect, it } from 'vitest'
import { MemorySearchCache } from '../src/search/cache.js'

describe('缓存', () => {
  it('过期即失效；超出上限挤掉最久没用的', () => {
    const c = new MemorySearchCache(2)
    c.put('a', 1, 0, 100)
    c.put('b', 2, 0, 100)
    c.get('a', 10)
    c.put('c', 3, 10, 100)
    expect(c.get('b', 20)).toBeUndefined()
    expect(c.get('a', 20)).toBe(1)
    expect(c.get('a', 200)).toBeUndefined()
  })
})
