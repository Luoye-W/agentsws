import { MemoryScheduleStore } from '../src/index.js'
import { runStoreConformance } from './store-conformance.js'

runStoreConformance('内存档', () => new MemoryScheduleStore())
