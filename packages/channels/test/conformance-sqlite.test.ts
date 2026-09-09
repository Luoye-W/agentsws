import type { DedupeStore } from '../src/pipeline.js'
import type { QueueStore } from '../src/queue.js'
import type { RawStore } from '../src/raw-store.js'
import { SqliteDedupeStore, SqliteQueueStore } from '../src/sqlite-queue.js'
import { SqliteRawStore } from '../src/sqlite-raw-store.js'
import {
  runDedupeConformance,
  runQueueConformance,
  runRawConformance,
} from './store-conformance.js'

/** 一致性套件第二遍：SQLite 档。行为必须与内存档逐字一致。 */
runQueueConformance({
  name: 'SqliteQueueStore',
  make: () => new SqliteQueueStore(),
  dispose: (s: QueueStore) => {
    ;(s as SqliteQueueStore).close()
  },
})
runDedupeConformance({
  name: 'SqliteDedupeStore',
  make: () => new SqliteDedupeStore(),
  dispose: (s: DedupeStore) => {
    ;(s as SqliteDedupeStore).close()
  },
})
runRawConformance({
  name: 'SqliteRawStore',
  make: () => new SqliteRawStore(),
  dispose: (s: RawStore) => {
    ;(s as SqliteRawStore).close()
  },
})
