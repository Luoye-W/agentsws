import { MemoryWorkStore } from '../src/store.js'
import { runWorkStoreConformance } from './store-conformance.js'

/** 一致性套件第一遍：内存档。 */
runWorkStoreConformance({ name: 'MemoryWorkStore', make: () => new MemoryWorkStore() })
