import { describe, expect, it } from 'vitest'
import type { ExtractedLesson } from '../src/index.js'
import {
  CONFIRM_STEP,
  createLearning,
  extractLessons,
  IGNORE_DECAY,
  LearningPool,
  MemoryLearningStore,
  poolHealth,
  SqliteLearningStore,
  STRENGTH_CONFIDENCE,
} from '../src/index.js'
import { counterIds, extractInput, TestClock } from './helpers.js'

function reject(reason: string, over: Record<string, unknown> = {}): ExtractedLesson {
  const out = extractLessons(
    extractInput({
      decisions: [
        { approval_item_id: 'ai_1', action: 'reject', at: '2026-09-07T10:00:00.000Z', reason },
      ],
      ...over,
    }),
  )
  const first = out[0]
  if (first === undefined) throw new Error('夹具没抽出 lesson')
  return first
}

function makePool(store?: MemoryLearningStore | SqliteLearningStore): {
  pool: LearningPool
  clock: TestClock
} {
  const clock = new TestClock()
  return {
    clock,
    pool: new LearningPool({
      clock,
      nextId: counterIds(),
      ...(store === undefined ? {} : { store }),
    }),
  }
}

describe('24 §3 池：零打扰、按语义键合并', () => {
  it('五次相同纠正 = 一条 lesson，hits=5，置信度按 +0.15 涨', () => {
    const { pool } = makePool()
    for (let i = 0; i < 3; i += 1) pool.pool(reject('退货窗口从送达日算'))
    expect(pool.list()[0]?.confidence).toBeCloseTo(STRENGTH_CONFIDENCE.strong + 2 * CONFIRM_STEP, 6)
    for (let i = 0; i < 2; i += 1) pool.pool(reject('退货窗口从送达日算'))
    const all = pool.list({ workspace_id: 'ws_1' })
    expect(all).toHaveLength(1)
    expect(all[0]?.hits).toBe(5)
    // 0.6 + 4×0.15 = 1.2，封顶到 0.99
    expect(all[0]?.confidence).toBe(0.99)
  })

  it('置信度封顶 0.99', () => {
    const { pool } = makePool()
    for (let i = 0; i < 20; i += 1) pool.pool(reject('退货窗口从送达日算'))
    expect(pool.list()[0]?.confidence).toBe(0.99)
  })

  it('不同人的同一条不合并（池是每人的）', () => {
    const { pool } = makePool()
    pool.pool(reject('退货窗口从送达日算'))
    pool.pool({ ...reject('退货窗口从送达日算'), assignment_id: 'asg_2' })
    expect(pool.list()).toHaveLength(2)
  })

  it('不同段、不同类型不合并', () => {
    const { pool } = makePool()
    const base = reject('退货窗口从送达日算')
    pool.pool(base)
    pool.pool({ ...base, applies_to: { skill: 'customer-care', section_id: 'sec_x' } })
    pool.pool({ ...base, kind: 'anti_example' })
    expect(pool.list()).toHaveLength(3)
  })

  it('话足够像也合并（键不同但重合度 > 0.7）', () => {
    const { pool } = makePool()
    pool.pool(reject('退货窗口一律从送达日开始算起'))
    pool.pool(reject('退货窗口从送达日开始算起的'))
    expect(pool.list()).toHaveLength(1)
  })

  it('被驳回过的那条不再参与合并（refuted 不复活）', () => {
    const { pool } = makePool()
    const first = pool.pool(reject('退货窗口从送达日算'))
    pool.mark(first.id, 'refuted')
    const again = pool.pool(reject('退货窗口从送达日算'))
    expect(again.id).not.toBe(first.id)
    expect(pool.list()).toHaveLength(2)
  })

  it('被忽略过的再出现一次 → 回到 pooled', () => {
    const { pool } = makePool()
    const first = pool.pool(reject('退货窗口从送达日算'))
    pool.mark(first.id, 'ignored')
    expect(pool.get(first.id)?.confidence).toBeCloseTo(STRENGTH_CONFIDENCE.strong * IGNORE_DECAY, 6)
    expect(pool.pool(reject('退货窗口从送达日算')).status).toBe('pooled')
  })

  it('多条一起入池（poolAll）、按 run / assignment 归并来源', () => {
    const { pool } = makePool()
    pool.poolAll([reject('退货窗口从送达日算')])
    pool.pool({
      ...reject('退货窗口从送达日算'),
      run_id: 'run_0002',
      assignment_id: 'asg_2',
    })
    // assignment 不同 → 不合并，两条
    expect(pool.list({ assignment_id: 'asg_2' })).toHaveLength(1)
    expect(pool.list({ skill: 'customer-care' })).toHaveLength(2)
    expect(pool.list({ workspace_id: 'ws_other' })).toHaveLength(0)
  })

  it('mark 到不存在的 id → not_found', () => {
    const { pool } = makePool()
    expect(() => pool.mark('nope', 'accepted')).toThrowError(/lesson 不存在/)
  })

  it('proposed 会记下 proposed_at；refuted 置信度归零', () => {
    const { pool } = makePool()
    const l = pool.pool(reject('退货窗口从送达日算'))
    expect(pool.mark(l.id, 'proposed').proposed_at).toBeDefined()
    expect(pool.mark(l.id, 'refuted').confidence).toBe(0)
  })

  it('黑名单：写、读、判', () => {
    const { pool } = makePool()
    expect(pool.isRejected('ws_1', 'k1')).toBe(false)
    pool.rejectKey({ workspace_id: 'ws_1', semantic_key: 'k1', skill: 's', reason: 'no', by: 'p1' })
    pool.rejectKey({
      workspace_id: 'ws_1',
      semantic_key: 'k1',
      skill: 's',
      reason: 'still no',
      by: 'p1',
      at: '2026-09-08T00:00:00.000Z',
    })
    expect(pool.isRejected('ws_1', 'k1')).toBe(true)
    expect(pool.isRejected('ws_2', 'k1')).toBe(false)
    expect(pool.rejectedKeys('ws_1')).toHaveLength(1)
    expect(pool.rejectedKeys('ws_1')[0]?.reason).toBe('still no')
  })

  it('健康摘要按状态计数', () => {
    const { pool } = makePool()
    const a = pool.pool(reject('退货窗口从送达日算'))
    const b = pool.pool(reject('金额一律写清币种'))
    pool.mark(b.id, 'accepted')
    expect(poolHealth(pool, 'ws_1')).toEqual({
      pooled: 1,
      proposed: 0,
      accepted: 1,
      ignored: 0,
      refuted: 0,
    })
    expect(pool.get(a.id)?.status).toBe('pooled')
  })
})

describe('落盘档与内存档同判定', () => {
  it('SQLite 档：入池、合并、黑名单、重开还在', () => {
    const store = new SqliteLearningStore()
    const { pool } = makePool(store)
    for (let i = 0; i < 3; i += 1) pool.pool(reject('退货窗口从送达日算'))
    pool.rejectKey({ workspace_id: 'ws_1', semantic_key: 'k1', skill: 's', reason: 'x', by: 'p1' })
    expect(pool.list({ workspace_id: 'ws_1', status: 'pooled' })).toHaveLength(1)
    expect(pool.list()[0]?.hits).toBe(3)
    expect(store.rejected('ws_1')).toHaveLength(1)

    // 换一个 pool 读同一个库：数据还在（重启续跑）
    const again = new LearningPool({ clock: new TestClock(), nextId: counterIds('x'), store })
    expect(again.list({ workspace_id: 'ws_1' })[0]?.hits).toBe(3)
    expect(again.get('les_0001')?.text).toContain('退货窗口')
    expect(again.get('missing')).toBeUndefined()
    store.close()
  })

  it('SQLite 档保留段 id 与合并来源', () => {
    const store = new SqliteLearningStore()
    const { pool } = makePool(store)
    const l = pool.pool({
      ...reject('金额写清币种'),
      applies_to: { skill: 'customer-care', section_id: 'sec_1' },
    })
    pool.mark(l.id, 'proposed')
    const back = pool.list({ workspace_id: 'ws_1', skill: 'customer-care' })[0]
    expect(back?.applies_to.section_id).toBe('sec_1')
    expect(back?.proposed_at).toBeDefined()
    expect(pool.list({ assignment_id: 'asg_1' })).toHaveLength(1)
    expect(pool.list({ assignment_id: 'asg_9' })).toHaveLength(0)
    store.close()
  })

  it('createLearning：不给路径是内存档，给了就落盘', () => {
    const mem = createLearning({ clock: new TestClock(), nextId: counterIds() })
    expect(mem.store).toBeInstanceOf(MemoryLearningStore)
    mem.close()
    const disk = createLearning({
      clock: new TestClock(),
      nextId: counterIds(),
      dbPath: ':memory:',
    })
    expect(disk.store).toBeInstanceOf(SqliteLearningStore)
    disk.pool.pool(reject('退货窗口从送达日算'))
    expect(disk.pool.list()).toHaveLength(1)
    disk.close()
  })

  it('外部 db 句柄由调用方关（close 不动它）', () => {
    const owner = new SqliteLearningStore()
    const borrowed = new SqliteLearningStore({ db: owner.db })
    borrowed.close()
    expect(owner.rejected('ws_1')).toEqual([])
    owner.close()
  })
})
