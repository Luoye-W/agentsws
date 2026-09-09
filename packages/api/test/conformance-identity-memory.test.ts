import { MemoryIdentityService } from '../src/identity.js'
import { runIdentityConformance } from './identity-conformance.js'

/** 一致性套件第一遍：内存档。 */
runIdentityConformance({
  name: 'MemoryIdentityService',
  make: ({ clock, random }) => new MemoryIdentityService({ clock, random }),
})
