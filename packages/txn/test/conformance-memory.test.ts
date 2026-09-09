import { MemoryTxnStore } from '../src/store.js'
import { runTxnStoreConformance } from './store-conformance.js'

/** 一致性套件第一遍：内存档（测试与 fast 档模拟用的那份）。 */
runTxnStoreConformance({
  name: 'MemoryTxnStore',
  make: () => new MemoryTxnStore(),
})
