import { MemoryMeetingRawStore } from '../src/raw-store.js'
import { MemoryMeetingStore } from '../src/store.js'
import { makeClock, seeded } from './helpers.js'
import { runMeetingStoreConformance, runRawStoreConformance } from './store-conformance.js'

runMeetingStoreConformance({
  name: '内存档',
  make: () => new MemoryMeetingStore({ clock: makeClock(), random: seeded() }),
})

runRawStoreConformance({ name: '内存档', make: () => new MemoryMeetingRawStore() })
