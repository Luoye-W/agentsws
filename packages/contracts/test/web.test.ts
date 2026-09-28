import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATA_SOURCE_ORDER,
  DEFAULT_WEB_LIMITS,
  DEFAULT_WEB_SEARCH_ORDER,
  WEB_FETCH_TOOL,
  WEB_SEARCH_ROUTE_KEY,
  WEB_SEARCH_TOOL,
  WEB_TOOL_NAMES,
} from '../src/index.js'

describe('WP179 网页搜索与抓网页的契约', () => {
  it('工具名就是官方 dsh-tool-web 注册的那两个（排好序，tools.allow 要字节稳定）', () => {
    expect(WEB_SEARCH_TOOL).toBe('web_search')
    expect(WEB_FETCH_TOOL).toBe('web_fetch')
    expect(WEB_TOOL_NAMES).toEqual([...WEB_TOOL_NAMES].sort())
  })

  it('每条运行的缺省上限：搜索 5 次、抓取 10 次（派工单原话）', () => {
    expect(DEFAULT_WEB_LIMITS).toEqual({ max_searches: 5, max_fetches: 10 })
  })

  it('网页搜索这一项能力的默认第一级是官方那条；红人渠道的默认顺序不受影响', () => {
    expect(WEB_SEARCH_ROUTE_KEY).toBe('web.search')
    expect(DEFAULT_WEB_SEARCH_ORDER[0]).toBe('deepseek_native')
    expect(DEFAULT_DATA_SOURCE_ORDER).toEqual(['official_key', 'byo_source', 'workshop'])
  })
})
