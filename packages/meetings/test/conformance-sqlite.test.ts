import { SqliteMeetingRawStore } from '../src/sqlite-raw-store.js'
import { SqliteMeetingStore } from '../src/sqlite-store.js'
import { makeClock, seeded } from './helpers.js'
import { runMeetingStoreConformance, runRawStoreConformance } from './store-conformance.js'

runMeetingStoreConformance({
  name: 'SQLite 档',
  make: () => new SqliteMeetingStore({ clock: makeClock(), random: seeded() }),
  dispose: (s) => {
    ;(s as SqliteMeetingStore).close()
  },
})

runRawStoreConformance({
  name: 'SQLite 档',
  make: () => new SqliteMeetingRawStore(),
  dispose: (s) => {
    ;(s as SqliteMeetingRawStore).close()
  },
})
