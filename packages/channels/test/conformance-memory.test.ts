import { MemoryDedupeStore } from '../src/pipeline.js'
import { MemoryQueueStore } from '../src/queue.js'
import { MemoryRawStore } from '../src/raw-store.js'
import {
  runDedupeConformance,
  runQueueConformance,
  runRawConformance,
} from './store-conformance.js'

/** 一致性套件第一遍：内存档（测试与 fast 档模拟用的那份）。 */
runQueueConformance({ name: 'MemoryQueueStore', make: () => new MemoryQueueStore() })
runDedupeConformance({ name: 'MemoryDedupeStore', make: () => new MemoryDedupeStore() })
runRawConformance({ name: 'MemoryRawStore', make: () => new MemoryRawStore() })
