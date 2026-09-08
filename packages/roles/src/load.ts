/** 05 §0：职责定义是配置不是数据——从 `roles/<domain>/<id>.yml` 读，走 schema 校验。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RoleId } from '@agentsws/contracts'
import Schema from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import { collectUnknownKeys, POSITION_SCHEMA, ROLE_SCHEMA } from './schema.js'
import { type Position, type RoleDefinitionFull, RoleSchemaError } from './types.js'

/** 本包自带的职责定义目录（`roles/<domain>/<slug>.yml`）。 */
export const BUNDLED_ROLES_DIR = fileURLToPath(new URL('../roles/', import.meta.url))
/** 本包自带的岗位模板目录（`positions/<id>.yml`）。 */
export const BUNDLED_POSITIONS_DIR = fileURLToPath(new URL('../positions/', import.meta.url))

/** 深删 undefined：schemastery 会给未填的可选字段留下 undefined，exactOptionalPropertyTypes 不收。 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    if (v !== undefined) out[k] = stripUndefined(v)
  return out
}

function validate<T>(raw: unknown, schema: Schemastery, source: string, kind: string): T {
  let checked: unknown
  try {
    checked = schema(raw)
  } catch (error) {
    if (Schema.ValidationError.is(error)) {
      const path = (error.options.path ?? [])
        .map((s) => (typeof s === 'number' ? `[${s}]` : String(s)))
        .join('.')
        .replace(/\.\[/g, '[')
      throw new RoleSchemaError(source, path, error.message.replace(/^\$\S*\s*/, ''))
    }
    throw error
  }
  const unknown = collectUnknownKeys(checked, schema)
  if (unknown.length > 0)
    throw new RoleSchemaError(
      source,
      unknown[0] ?? '',
      `unknown field in ${kind} (declared fields only): ${unknown.join(', ')}`,
    )
  return stripUndefined(checked) as T
}

function parseDocument(text: string, source: string): unknown {
  try {
    return parseYaml(text)
  } catch (error) {
    throw new RoleSchemaError(source, '', `invalid YAML: ${(error as Error).message}`)
  }
}

/** 从 YAML 文本解析一个职责定义。 */
export function parseRole(text: string, source = '<string>'): RoleDefinitionFull {
  return validate<RoleDefinitionFull>(parseDocument(text, source), ROLE_SCHEMA, source, 'role')
}

/** 从 YAML 文件读取一个职责定义。 */
export function loadRole(file: string): RoleDefinitionFull {
  return parseRole(readFileSync(file, 'utf8'), file)
}

/** 读本包自带的职责定义：`dtc.aftersales` → `roles/dtc/aftersales.yml`。 */
export function loadBundledRole(id: RoleId): RoleDefinitionFull {
  const [domain, slug] = id.split('.')
  if (!domain || !slug) throw new RoleSchemaError(id, 'id', 'role id must be `<domain>.<slug>`')
  return loadRole(`${BUNDLED_ROLES_DIR}${domain}/${slug}.yml`)
}

/** 从 YAML 文本解析一个岗位模板。 */
export function parsePosition(text: string, source = '<string>'): Position {
  return validate<Position>(parseDocument(text, source), POSITION_SCHEMA, source, 'position')
}

/** 从 YAML 文件读取一个岗位模板。 */
export function loadPosition(file: string): Position {
  return parsePosition(readFileSync(file, 'utf8'), file)
}

/** 读本包自带的岗位模板：`dtc-ops` → `positions/dtc-ops.yml`。 */
export function loadBundledPosition(id: string): Position {
  return loadPosition(`${BUNDLED_POSITIONS_DIR}${id}.yml`)
}
