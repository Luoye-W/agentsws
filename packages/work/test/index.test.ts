/** 包的公开面：外面拿到的就是这些（也让 index.ts 进覆盖率）。 */
import { describe, expect, it } from 'vitest'
import {
  battleReport,
  buildCalendar,
  buildReview,
  cardRefOf,
  createSqliteWorkStore,
  createWork,
  deriveHorizon,
  draftDailyPlan,
  goalProgress,
  goalTree,
  MemoryWorkStore,
  SqliteWorkStore,
  TIMELINE_PAGE,
  WORK_MIGRATIONS,
  Work,
  WorkError,
} from '../src/index.js'

describe('@agentsws/work 公开面', () => {
  it('契约里要用到的东西都导出了', () => {
    for (const fn of [
      createWork,
      Work,
      MemoryWorkStore,
      SqliteWorkStore,
      createSqliteWorkStore,
      draftDailyPlan,
      buildReview,
      battleReport,
      goalProgress,
      goalTree,
      buildCalendar,
      deriveHorizon,
      cardRefOf,
      WorkError,
    ]) {
      expect(typeof fn).toBe('function')
    }
    expect(TIMELINE_PAGE).toBe(20)
    expect(WORK_MIGRATIONS).toHaveLength(1)
  })
})
