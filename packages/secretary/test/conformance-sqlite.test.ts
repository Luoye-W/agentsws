import { createSqliteSecretaryStore } from '../src/index.js'
import { runStoreConformance } from './store-conformance.js'

runStoreConformance('SQLite 档', () => createSqliteSecretaryStore())
