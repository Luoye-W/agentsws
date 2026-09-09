import type { SweepableIdempotencyStore } from '../src/idempotency.js'
import { SqliteIdempotencyStore } from '../src/sqlite-idempotency.js'
import { runIdempotencyConformance } from './idempotency-conformance.js'

/** 一致性套件第二遍：SQLite 档。行为必须与内存档逐字一致。 */
runIdempotencyConformance({
  name: 'SqliteIdempotencyStore',
  make: (ttlMs) => new SqliteIdempotencyStore({ ttlMs }),
  dispose: (s: SweepableIdempotencyStore) => {
    ;(s as SqliteIdempotencyStore).close()
  },
})
