import type { LocalIdentityService } from '../src/identity.js'
import { SqliteIdentityService } from '../src/sqlite-identity.js'
import { runIdentityConformance } from './identity-conformance.js'

/** 一致性套件第二遍：SQLite 档。行为必须与内存档逐字一致。 */
runIdentityConformance({
  name: 'SqliteIdentityService',
  make: ({ clock, random }) => new SqliteIdentityService({ clock, random }),
  dispose: (s: LocalIdentityService) => {
    ;(s as SqliteIdentityService).close()
  },
})
