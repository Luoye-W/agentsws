/**
 * WP125（72 §P0-3）：知识缺口的「有多少客户在等」。
 *
 * 钉三件事：按线程去重、待补区按人数排（不是更新时间）、零新表（走 ADDED_COLUMNS）。
 */
import { describe, expect, it } from 'vitest'
import {
  addWaiter,
  compareGapsByWaiting,
  EXPECTATION_BRIEF,
  GAP_EXPECTATIONS,
  isGapExpectation,
  sortGapsByWaiting,
  waitingCount,
} from '../src/gap-waiting.js'
import { createKnowledge } from '../src/index.js'

const clock = (() => {
  let t = Date.parse('2026-09-19T00:00:00.000Z')
  return {
    now: (): string => {
      t += 60_000
      return new Date(t).toISOString()
    },
  }
})()

const ws = 'ws_demo'

describe('addWaiter（纯函数）', () => {
  it('按 thread_id 去重：同一条线程追问三次仍然是一个人在等', () => {
    let waiting = addWaiter([], { thread_id: 't1', channel: 'email', since: 'A' })
    waiting = addWaiter(waiting, { thread_id: 't1', channel: 'email', since: 'B' })
    waiting = addWaiter(waiting, { thread_id: 't2', channel: 'chat', since: 'C' })
    expect(waiting).toHaveLength(2)
    // 第一次记下的 since 不动：「等了多久」从他第一次问起算
    expect(waiting[0]?.since).toBe('A')
  })

  it('已经在等的那一条只补预期与语言', () => {
    const first = addWaiter([], { thread_id: 't1', channel: 'email', since: 'A' })
    const again = addWaiter(first, {
      thread_id: 't1',
      channel: 'email',
      since: 'B',
      expectation: 'checking_with_team',
      language: 'de',
    })
    expect(again[0]).toMatchObject({
      since: 'A',
      expectation: 'checking_with_team',
      language: 'de',
    })
  })
})

describe('待补区排序', () => {
  const gap = (id: string, threads: string[], since: string) => ({
    id,
    workspace_id: ws,
    question: 'q',
    subject: { type: 'policy', key: id },
    domain: 'company' as const,
    status: 'open' as const,
    asked_by: { kind: 'agent' as const, id: 'a' },
    created_at: since,
    waiting: threads.map((t) => ({ thread_id: t, channel: 'email' as const, since })),
  })

  it('人多的在前；人数相同时等得久的在前', () => {
    const few = gap('g_few', ['t1'], '2026-09-01T00:00:00.000Z')
    const many = gap('g_many', ['t1', 't2', 't3'], '2026-09-10T00:00:00.000Z')
    const alsoFewButOlder = gap('g_old', ['t9'], '2026-08-01T00:00:00.000Z')
    const sorted = sortGapsByWaiting([few, many, alsoFewButOlder])
    expect(sorted.map((g) => g.id)).toEqual(['g_many', 'g_old', 'g_few'])
    expect(compareGapsByWaiting(many, few)).toBeLessThan(0)
  })

  it('没人在等的缺口 waitingCount 是 0', () => {
    expect(waitingCount({ waiting: undefined })).toBe(0)
  })
})

describe('预期 preset', () => {
  it('只有三个，每个都有给模型的口径', () => {
    expect(GAP_EXPECTATIONS).toEqual(['compiling_details', 'checking_with_team', 'sending_guide'])
    for (const id of GAP_EXPECTATIONS) expect(EXPECTATION_BRIEF[id].length).toBeGreaterThan(0)
    expect(isGapExpectation('compiling_details')).toBe(true)
    expect(isGapExpectation('promise_refund')).toBe(false)
  })
})

describe('落库（零新表：走 knowledge_gaps 上新加的一列）', () => {
  it('记等待者 → 读回来 → 待补区按人数排', () => {
    const knowledge = createKnowledge({ clock })
    const a = knowledge.intake.openGap({
      workspace_id: ws,
      question: '德国退货运费谁出',
      subject: { type: 'policy', key: 'return_shipping_de' },
      asked_by: { kind: 'agent', id: 'agent_support' },
    })
    const b = knowledge.intake.openGap({
      workspace_id: ws,
      question: '丢件怎么赔',
      subject: { type: 'policy', key: 'lost_package' },
      asked_by: { kind: 'agent', id: 'agent_support' },
    })
    for (const thread of ['t1', 't2', 't3']) {
      knowledge.intake.addGapWaiter(a.id, {
        thread_id: thread,
        channel: 'email',
        since: clock.now(),
        expectation: 'checking_with_team',
      })
    }
    // 同一条线程再记一次：人数不变
    knowledge.intake.addGapWaiter(a.id, { thread_id: 't1', channel: 'email', since: clock.now() })
    knowledge.intake.addGapWaiter(b.id, { thread_id: 't9', channel: 'chat', since: clock.now() })

    const queue = knowledge.intake.gapsByWaiting(ws)
    expect(queue.map((g) => g.id)).toEqual([a.id, b.id])
    expect(waitingCount(queue[0] as { waiting?: readonly unknown[] })).toBe(3)
    expect(queue[0]?.waiting?.[0]?.expectation).toBe('checking_with_team')

    // 答过的缺口不再收等待者（那是一条新缺口）
    knowledge.intake.answerGap(a.id, { answer: '由我们承担', by: 'p_wang' })
    expect(() =>
      knowledge.intake.addGapWaiter(a.id, {
        thread_id: 't4',
        channel: 'email',
        since: clock.now(),
      }),
    ).toThrow()
    knowledge.close()
  })
})
