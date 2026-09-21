import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_WINDOW_MS,
  crossedWarnThreshold,
  judgeQuota,
  MemoryCounterStore,
  monthKeyOf,
} from '../src/quota.js'

const T0 = '2026-09-21T10:00:00.000Z'

describe('对话计数与「一个对话」的口径（修订第 4 条）', () => {
  it('访客发出第一条消息才算一个对话', () => {
    const store = new MemoryCounterStore()
    const verdict = judgeQuota(store, {
      workspace: 'ws',
      visitor: 'v1',
      now: T0,
      limit: 200,
    })
    expect(verdict).toEqual({ admit: true, counted: true })
    expect(store.count('ws', monthKeyOf(T0))).toBe(1)
  })

  it('同一访客 30 分钟内刷新重开算同一个：不计第二次', () => {
    const store = new MemoryCounterStore()
    judgeQuota(store, { workspace: 'ws', visitor: 'v1', now: T0, limit: 200 })
    const again = judgeQuota(store, {
      workspace: 'ws',
      visitor: 'v1',
      now: new Date(Date.parse(T0) + 29 * 60 * 1000).toISOString(),
      limit: 200,
    })
    expect(again).toEqual({ admit: true, counted: false })
    expect(store.count('ws', monthKeyOf(T0))).toBe(1)
  })

  it('过了 30 分钟窗口是新对话：计数加一', () => {
    const store = new MemoryCounterStore()
    judgeQuota(store, { workspace: 'ws', visitor: 'v1', now: T0, limit: 200 })
    const later = judgeQuota(store, {
      workspace: 'ws',
      visitor: 'v1',
      now: new Date(Date.parse(T0) + CONVERSATION_WINDOW_MS + 1000).toISOString(),
      limit: 200,
    })
    expect(later).toEqual({ admit: true, counted: true })
    expect(store.count('ws', monthKeyOf(T0))).toBe(2)
  })

  it('到顶只拦新会话；在途（窗口内）放行到结束', () => {
    const store = new MemoryCounterStore()
    // 塞满：直接置 200 个
    store.bump('ws', monthKeyOf(T0), 200)
    // 新访客：拦
    expect(judgeQuota(store, { workspace: 'ws', visitor: 'new', now: T0, limit: 200 })).toEqual({
      admit: false,
      reason: 'quota_exhausted',
    })
    // 在途访客（20 分钟前刚被计数）：放行且不重复计数
    store.noteCounted('ws', 'inflight', new Date(Date.parse(T0) - 20 * 60 * 1000).toISOString())
    expect(
      judgeQuota(store, { workspace: 'ws', visitor: 'inflight', now: T0, limit: 200 }),
    ).toEqual({ admit: true, counted: false })
  })

  it('试聊不计对话数（AI 费用照算——那在本机一侧）', () => {
    const store = new MemoryCounterStore()
    expect(
      judgeQuota(store, { workspace: 'ws', visitor: 'owner', now: T0, limit: 200, trial: true }),
    ).toEqual({ admit: true, counted: false })
    expect(store.count('ws', monthKeyOf(T0))).toBe(0)
  })

  it('已订阅客服增值服务的不受限（但仍计数给报表）', () => {
    const store = new MemoryCounterStore()
    store.bump('ws', monthKeyOf(T0), 200)
    expect(
      judgeQuota(store, { workspace: 'ws', visitor: 'v2', now: T0, limit: 200, subscribed: true }),
    ).toEqual({ admit: true, counted: true })
  })

  it('无上限（自建 / undefined）永不拦', () => {
    const store = new MemoryCounterStore()
    for (let i = 0; i < 500; i += 1) {
      const verdict = judgeQuota(store, {
        workspace: 'ws',
        visitor: `v${i}`,
        now: new Date(Date.parse(T0) + i * 60_000).toISOString(),
      })
      expect(verdict.admit).toBe(true)
    }
  })

  it('80% 提醒只在跨越那一刻为真', () => {
    expect(crossedWarnThreshold(159, 160, 200)).toBe(true)
    expect(crossedWarnThreshold(160, 161, 200)).toBe(false)
    expect(crossedWarnThreshold(10, 11, 200)).toBe(false)
    expect(crossedWarnThreshold(0, 1, 0)).toBe(false)
  })
})
