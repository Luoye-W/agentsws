/**
 * WP173：序列与配额提到 core 之后的行为（红人那一侧拿到的是同一个函数，见
 * `kol-core/test/sequence-shared.test.ts`）；预热按发信邮箱第一次发信那天算。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WARMUP,
  nextInSequence,
  outreachQuota,
  SEQUENCE_DAYS,
  SEQUENCE_ORDER,
  warmupCap,
} from '../src/index.js'

describe('sequence（core）', () => {
  it('日配额：滚动 24 小时', () => {
    const q = outreachQuota({
      cap: 2,
      sent_at: ['2026-09-27T08:00:00.000Z', '2026-09-28T08:00:00.000Z'],
      now: '2026-09-28T09:00:00.000Z',
    })
    expect(q).toEqual({ cap: 2, sent_today: 1, remaining: 1, allowed: true })
    expect(SEQUENCE_ORDER).toEqual(['first', 'follow_up', 'final'])
  })

  it('三封节奏：0 / 3 / 7 天；收尾发完真停', () => {
    expect(SEQUENCE_DAYS).toEqual({ first: 0, follow_up: 3, final: 7 })
    const sent = [
      { step: 'first' as const, at: '2026-09-01T09:00:00.000Z' },
      { step: 'follow_up' as const, at: '2026-09-04T09:00:00.000Z' },
    ]
    const next = nextInSequence({ sent, replied: false, contact: 'a@x.com', suppressed: [] })
    expect(next?.step).toBe('final')
    expect(next?.due_at).toBe('2026-09-08T09:00:00.000Z')
    const done = nextInSequence({
      sent: [...sent, { step: 'final', at: '2026-09-08T09:00:00.000Z' }],
      replied: false,
      contact: 'a@x.com',
      suppressed: [],
    })
    expect(done).toBeUndefined()
  })

  it('预热：第一次发信起 14 天内 20 封 / 天，之后 50', () => {
    expect(DEFAULT_WARMUP).toEqual({ cap_new: 20, cap_warmed: 50, warmup_days: 14 })
    const never = warmupCap({ now: '2026-09-28T09:00:00.000Z' })
    expect(never.cap).toBe(20)
    expect(never.warming).toBe(true)
    expect(never.warm_from).toBe('2026-10-12T09:00:00.000Z')
    const day13 = warmupCap({
      first_sent_at: '2026-09-15T10:00:00.000Z',
      now: '2026-09-28T09:00:00.000Z',
    })
    expect(day13.cap).toBe(20)
    const day14 = warmupCap({
      first_sent_at: '2026-09-14T09:00:00.000Z',
      now: '2026-09-28T09:00:00.000Z',
    })
    expect(day14).toEqual({ cap: 50, warming: false })
    // yml 改过的数照改过的算
    expect(warmupCap({ policy: { cap_new: 10 }, now: '2026-09-28T09:00:00.000Z' }).cap).toBe(10)
  })
})
