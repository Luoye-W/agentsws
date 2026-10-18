/**
 * WP411（#13）：`run_watch_now`（since / until / preview）、`query_watch_items`、`read_reddit`（since / until）
 * 的参数表过 dsh 自己那一道编译（三个运行时同一份定义，dsh 那边最挑）。
 */
import { WATCH_TOOL_NAMES } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { buildToolDefinitions } from '../src/index.js'
import { makeRequest } from './helpers.js'

describe('巡查工具的参数表过 dsh 编译', () => {
  it('带时间窗的几个工具一起建得出来', () => {
    const noop = {
      run: async () => ({ status: 'ok' as const }),
      note: () => undefined,
      provenance: () => undefined,
    }
    const allow = [...WATCH_TOOL_NAMES, 'read_reddit']
    const build = () =>
      buildToolDefinitions(makeRequest({ allow }), noop, {
        stage: async () => undefined,
        draft: async () => undefined,
      })
    expect(build).not.toThrow()
    expect(build().map((d) => d.name)).toEqual(expect.arrayContaining(allow))
  })
})
