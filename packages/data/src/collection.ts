import type { DataDomain, Sensitivity } from '@agentsws/contracts'
import { invalidInput } from './errors.js'

/** 21 §2：字段分级在实体 schema 上声明；默认 internal。`pii` 的字段加密存储（21 §4）。 */
export interface FieldSpec {
  readonly sensitivity: Sensitivity
  readonly pii?: boolean
}

export interface CollectionDef {
  readonly name: string
  readonly domain: DataDomain
  /** 当前 schema 版本；低于此版本的写入被拒（21 §6 用例 2）。 */
  readonly schema_version: number
  readonly fields: Readonly<Record<string, FieldSpec>>
}

/** 21 §2：未声明的字段默认 internal。 */
export const DEFAULT_FIELD_SENSITIVITY: Sensitivity = 'internal'

const IDENTIFIER = /^[a-z][a-z0-9_]*$/
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function defineCollection(def: {
  name: string
  domain: DataDomain
  schema_version?: number
  fields: Record<string, FieldSpec>
}): CollectionDef {
  if (!IDENTIFIER.test(def.name))
    throw invalidInput(`collection name must match ${String(IDENTIFIER)}: ${def.name}`)
  const schemaVersion = def.schema_version ?? 1
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1)
    throw invalidInput(`schema_version must be a positive integer: ${String(schemaVersion)}`)
  for (const field of Object.keys(def.fields)) {
    if (!FIELD_NAME.test(field)) throw invalidInput(`illegal field name: ${field}`)
    if (ENVELOPE_KEYS.has(field)) throw invalidInput(`field collides with the envelope: ${field}`)
  }
  return {
    name: def.name,
    domain: def.domain,
    schema_version: schemaVersion,
    fields: { ...def.fields },
  }
}

/** 21 §2 信封字段；不进 body。 */
export const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'schema_version',
  'workspace_id',
  'owners',
  'scope',
  'sensitivity',
  'source',
  'created_at',
  'updated_at',
  'version',
])

export function fieldSpec(def: CollectionDef, field: string): FieldSpec {
  return def.fields[field] ?? { sensitivity: DEFAULT_FIELD_SENSITIVITY }
}

export function piiFields(def: CollectionDef): string[] {
  return Object.keys(def.fields).filter((f) => def.fields[f]?.pii === true)
}

export function isLegalFieldName(field: string): boolean {
  return FIELD_NAME.test(field)
}
