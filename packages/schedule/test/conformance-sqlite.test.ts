import { createSqliteScheduleStore } from '../src/index.js'
import { TestClock } from './helpers.js'
import { runStoreConformance } from './store-conformance.js'

// 工厂函数与 `new` 走同一条路；服务进程用的是工厂
runStoreConformance('SQLite 档', () =>
  createSqliteScheduleStore({
    dbPath: ':memory:',
    clock: new TestClock('2026-09-10T00:00:00Z'),
  }),
)
