import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkStore } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createSqliteWorkStore, SqliteWorkStore } from '../src/sqlite-store.js'
import { FakeClock, goal, matter, matterEvent, plan, review, todo } from './helpers.js'
import { runWorkStoreConformance } from './store-conformance.js'

/** 一致性套件第二遍：SQLite 档。行为必须与内存档逐字一致。 */
runWorkStoreConformance({
  name: 'SqliteWorkStore',
  make: () => new SqliteWorkStore({ clock: new FakeClock() }),
  dispose: (s: WorkStore) => {
    ;(s as SqliteWorkStore).close()
  },
})

describe('SqliteWorkStore · 落盘特性', () => {
  const withDir = <T>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-work-'))
    try {
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('重启（关库再开）后事项 / 时间线 / 目标 / 待办 / 计划 / 复盘都还在', () => {
    withDir((dir) => {
      const dbPath = join(dir, 'work.sqlite')
      const first = createSqliteWorkStore({ dbPath, clock: new FakeClock() })
      first.putMatter(matter())
      first.appendMatterEvent(matterEvent())
      first.putGoal(goal())
      first.putTodo(todo({ due: '2026-09-09T10:00:00.000Z' }))
      first.putPlan(plan())
      first.putReview(review())
      expect(first.schemaVersion()).toBe(1)
      first.close()
      // close 幂等
      first.close()

      const second = new SqliteWorkStore({ dbPath })
      expect(second.getMatter('mat_1')?.title).toBe('Anna 的退货请求')
      expect(second.listMatterEvents('mat_1')).toHaveLength(1)
      expect(second.getGoal('goal_1')?.target).toBe(100000)
      expect(second.getTodo('td_1')?.due).toBe('2026-09-09T10:00:00.000Z')
      expect(second.findPlan('ws_1', 'per_1', '2026-09-09')?.id).toBe('plan_1')
      expect(second.getReview('rev_1')?.id).toBe('rev_1')
      // 迁移幂等：第二次开库不重复建表
      expect(second.schemaVersion()).toBe(1)
      second.close()
    })
  })

  it('同一条时间线事件重复写不会出两行', () => {
    const s = new SqliteWorkStore()
    s.putMatter(matter())
    s.appendMatterEvent(matterEvent())
    s.appendMatterEvent(matterEvent({ text: '改过了' }))
    expect(s.countMatterEvents('mat_1')).toBe(1)
    expect(s.listMatterEvents('mat_1')[0]?.text).toBe('改过了')
    s.close()
  })
})
