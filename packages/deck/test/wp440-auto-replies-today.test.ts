/**
 * WP440（docs/108 M9）：客服面板「今天 AI 直接回」——只数今天施行成功的「有把握就直接回」那几封
 * （自动批 + `payload.auto_reply`）；人批的回信、施行失败的、昨天的都不算进今天。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { blocksForRole, runQuery, type ScalarResult } from '../src/index.js'
import { item, queryContext } from './fixtures.js'

// NOW = 2026-09-07T01:00Z = 上海 09:00；今天 0 点 = 2026-09-06T16:00Z
const applied = (id: string, at: string, over: Partial<ApprovalItem> = {}): ApprovalItem =>
  item({
    id,
    state: 'applied',
    automation: {
      level_at_creation: 'L2',
      auto_approved: true,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    payload: {
      channel: 'email',
      to: { type: 'contact', id: 'c1' },
      thread_ref: 't1',
      body: { subject: 'Re: x', text: 'hi' },
      auto_reply: { score: 0.86 },
    },
    apply: { attempts: [{ at, by_executor: 'ex', idempotency_key: id, result: 'ok' }] },
    ...over,
  })

describe('WP440：今天 AI 直接回', () => {
  it('只数今天施行成功的直接回', () => {
    const ctx = queryContext({
      approvals: [
        applied('a1', '2026-09-06T23:00:00.000Z'),
        applied('a2', '2026-09-07T00:30:00.000Z'),
        // 昨天的：算进对比
        applied('a3', '2026-09-06T10:00:00.000Z'),
        // 人批的回信：不算
        applied('a4', '2026-09-07T00:10:00.000Z', {
          automation: {
            level_at_creation: 'L1',
            auto_approved: false,
            mandate_check: { within: true, caps_hit: [] },
            sampling: { selected: false },
          },
        }),
        // 施行失败：不算
        applied('a5', '2026-09-07T00:20:00.000Z', {
          state: 'apply_failed',
          apply: {
            attempts: [
              {
                at: '2026-09-07T00:20:00.000Z',
                by_executor: 'ex',
                idempotency_key: 'a5',
                result: 'failed',
              },
            ],
          },
        }),
      ],
    })
    const r = runQuery('approvals.email_auto_replies_today', ctx, 'yesterday')
    if (r.status !== 'ok') throw new Error(r.status)
    const data = r.data as ScalarResult
    expect(data.value).toBe(2)
    expect(data.previous).toBe(1)
  })

  it('客服面板上有这一格', () => {
    const ids = blocksForRole('dtc.support').map((b) => b.id)
    expect(ids).toContain('support.auto_replies_today')
  })
})
