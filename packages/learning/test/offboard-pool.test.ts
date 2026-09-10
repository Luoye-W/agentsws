/**
 * 40 §1.2 离职：走的人在 lesson 池里那些**还没被采纳**的观察怎么办。
 *
 * 默认归档（标 `ignored`，以后不再提，证据留着）；`personal_layer: 'erase'` 那一档
 * 连行一起删。已经 `accepted` 的一条都不动——那条已经进过 overlay，属于公司。
 */
import { describe, expect, it } from 'vitest'
import type { ExtractedLesson } from '../src/index.js'
import { LearningPool, MemoryLearningStore, SqliteLearningStore } from '../src/index.js'
import { counterIds, TestClock } from './helpers.js'

const WS = 'ws_1'
const HIS = 'asg_limo'
const HERS = 'asg_wanglan'

const lesson = (assignment_id: string, key: string): ExtractedLesson => ({
  workspace_id: WS,
  assignment_id,
  run_id: `run_${key}`,
  applies_to: { skill: 'customer-care' },
  kind: 'rule',
  signal: 'reject',
  strength: 'medium',
  text: `${key} 这条经验`,
  confidence: 0.5,
  evidence: [{ quote: `原话 ${key}`, at: '2026-09-07T10:00:00.000Z' }],
  semantic_key: key,
})

const seed = (pool: LearningPool): void => {
  pool.pool(lesson(HIS, 'alpha'))
  const accepted = pool.pool(lesson(HIS, 'beta'))
  pool.mark(accepted.id, 'accepted')
  pool.pool(lesson(HERS, 'gamma'))
}

const makePool = (store?: ConstructorParameters<typeof LearningPool>[0]['store']): LearningPool =>
  new LearningPool({
    clock: new TestClock(),
    nextId: counterIds(),
    ...(store === undefined ? {} : { store }),
  })

describe('archiveContributor / eraseContributor', () => {
  it('归档：他还没被采纳的标成 ignored；已采纳的与别人的不动', () => {
    const pool = makePool()
    seed(pool)
    expect(pool.archiveContributor({ workspace_id: WS, assignment_ids: [HIS] })).toBe(1)
    const mine = pool.list({ workspace_id: WS, assignment_id: HIS })
    expect(mine.find((l) => l.semantic_key === 'alpha')?.status).toBe('ignored')
    expect(mine.find((l) => l.semantic_key === 'beta')?.status).toBe('accepted')
    expect(pool.list({ workspace_id: WS, assignment_id: HERS })[0]?.status).toBe('pooled')
    // 证据留着（周复盘要靠它数「这条其实有两个人提过」）
    expect(mine.find((l) => l.semantic_key === 'alpha')?.evidence[0]?.quote).toBe('原话 alpha')
  })

  it('归档幂等：再跑一次 0 条', () => {
    const pool = makePool()
    seed(pool)
    pool.archiveContributor({ workspace_id: WS, assignment_ids: [HIS] })
    expect(pool.archiveContributor({ workspace_id: WS, assignment_ids: [HIS] })).toBe(0)
  })

  it('销毁：落盘档连行一起删，别人的留着', () => {
    const store = new SqliteLearningStore()
    const pool = makePool(store)
    seed(pool)
    expect(pool.eraseContributor({ workspace_id: WS, assignment_ids: [HIS] })).toBe(2)
    expect(pool.list({ workspace_id: WS })).toHaveLength(1)
    expect(pool.list({ workspace_id: WS })[0]?.assignment_id).toBe(HERS)
    store.close()
  })

  it('存储档没实现 delete → 退回「标成 refuted、置信度归零」，不静默什么都不做', () => {
    const base = new MemoryLearningStore()
    // 故意藏掉 delete：模拟一个只实现了必填面的第三方存储
    const store = {
      put: base.put.bind(base),
      get: base.get.bind(base),
      list: base.list.bind(base),
      reject: base.reject.bind(base),
      rejected: base.rejected.bind(base),
    }
    const pool = makePool(store)
    seed(pool)
    expect(pool.eraseContributor({ workspace_id: WS, assignment_ids: [HIS] })).toBe(2)
    const mine = pool.list({ workspace_id: WS, assignment_id: HIS })
    expect(mine.every((l) => l.status === 'refuted' && l.confidence === 0)).toBe(true)
  })
})
