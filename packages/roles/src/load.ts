/** 05 §0：职责定义是配置不是数据——从 `roles/<domain>/<id>.yml` 读，走 schema 校验。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RoleId } from '@agentsws/contracts'
import Schema from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import { checkRoleExtras, collectUnknownKeys, POSITION_SCHEMA, ROLE_SCHEMA } from './schema.js'
import { type Position, type RoleDefinitionFull, RoleSchemaError } from './types.js'

/** 本包自带的职责定义目录（`roles/<domain>/<slug>.yml`）。 */
export const BUNDLED_ROLES_DIR = fileURLToPath(new URL('../roles/', import.meta.url))
/** 本包自带的岗位模板目录（`positions/<id>.yml`）。 */
export const BUNDLED_POSITIONS_DIR = fileURLToPath(new URL('../positions/', import.meta.url))

/**
 * WP54（48 v2 L1）：职责改名 / 合并后的旧 id。
 *
 * 职责 id 是**已经写进别人库里的东西**——分配、审批项的 `role_id`、pack 的
 * `assignments.yml`、导出包。所以改名不是"把 yml 重命名"，而是"新 id 生效 +
 * 旧 id 永远读得进来"：这张表只可加行，一行都不许删。
 *
 * - `dtc.presales` / `dtc.aftersales` → `dtc.support`（售前 + 售后合并成网站客服）
 * - `amz.buyer-messages` → `amz.support`（只改名，语义不变）
 * - `dtc.ops` → `dtc.store`（WP62 / 51 §2：独立站运营 → 网站运营岗位下的**店铺管理**；
 *   职责定义从 15 人 pack 自带搬成内置一份，动作与额度一个数没改）
 *
 * 读得到不等于迁移了：已有分配的真迁移由宿主在启动时做一次，并记一条
 * `assignment.role_migrated`（`apps/server/src/roles-migrate.ts`）。
 */
export const ROLE_ID_ALIASES: Readonly<Record<string, RoleId>> = {
  'dtc.presales': 'dtc.support',
  'dtc.aftersales': 'dtc.support',
  'amz.buyer-messages': 'amz.support',
  'dtc.ops': 'dtc.store',
}

/** 旧 id → 新 id；不是旧 id 就原样返回。 */
export function resolveRoleId(id: RoleId): RoleId {
  return ROLE_ID_ALIASES[id] ?? id
}

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
  const role = validate<RoleDefinitionFull>(
    parseDocument(text, source),
    ROLE_SCHEMA,
    source,
    'role',
  )
  // WP84：条数上限归 schemastery，id 重名归这一刀（schemastery 看不见"这几条之间"）
  const dup = checkRoleExtras(role)
  if (dup !== undefined) throw new RoleSchemaError(source, dup.field, dup.message)
  return role
}

/** 从 YAML 文件读取一个职责定义。 */
export function loadRole(file: string): RoleDefinitionFull {
  return parseRole(readFileSync(file, 'utf8'), file)
}

/**
 * 读本包自带的职责定义：`dtc.support` → `roles/dtc/support.yml`。
 * 旧 id（`dtc.aftersales` …）先过 `resolveRoleId` 换成新 id 再找文件。
 */
export function loadBundledRole(id: RoleId): RoleDefinitionFull {
  const [domain, slug] = resolveRoleId(id).split('.')
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
