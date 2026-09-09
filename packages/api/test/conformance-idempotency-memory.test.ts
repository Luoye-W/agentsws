import { MemoryIdempotencyStore } from '../src/idempotency.js'
import { runIdempotencyConformance } from './idempotency-conformance.js'

/** 一致性套件第一遍：内存档。 */
runIdempotencyConformance({
  name: 'MemoryIdempotencyStore',
  make: (ttlMs) => new MemoryIdempotencyStore(ttlMs),
})
