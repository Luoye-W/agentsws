/**
 * WP404（docs/107 §3 / §12 一期 A）：**岗位内容**叠到骨架上——`applyRoleContent` / `applyPositionContent`。
 *
 * 开源仓的 yml 原样当「基础版」（骨架 + 内容都在里面）。内容层是一份只含白名单字段的数据
 * （契约 `ROLE_CONTENT_FIELDS` / `POSITION_CONTENT_FIELDS`）：写了的那一格整格换上，没写的照基础版。
 *
 * 三条纪律：
 * 1. **白名单外的字段整份拒收**（`RoleSchemaError`）——内容层改不了权限、档位、阈值、出卡规则；
 *    `grounding` 只换两张词表，按 `name` 对齐，骨架里没有的 `name` 也拒。
 * 2. **叠完照样过骨架那一关**：叠出来的对象走 `roleFromDocument`，和 yml 里直接写的一样过 schema、
 *    未知字段、id 重名、persona 六段那几刀。
 * 3. **纯函数**：不读盘、不碰时钟。读内置那份由 `loadBundledRoleWithContent` 包一层。
 *
 * 按条合并（用户隐藏 / 改 / 自己加、官方新版）是 WP406 的事：这里只管「这一层整格换上去」。
 */
import type {
  PositionContent,
  PositionContentFile,
  RoleContent,
  RoleContentFile,
  RoleGroundingContent,
  RoleId,
} from '@agentsws/contracts'
import {
  POSITION_CONTENT_FIELDS,
  ROLE_CONTENT_FIELDS,
  ROLE_CONTENT_SCHEMA,
  ROLE_GROUNDING_CONTENT_FIELDS,
} from '@agentsws/contracts'
import Schema from '@deepseek-ai/schemastery'
import {
  BUNDLED_POSITIONS_DIR,
  bundledPosition,
  bundledRole,
  bundledRoleFile,
  loadPosition,
  loadRole,
  positionFromDocument,
  roleFromDocument,
} from './load.js'
import { collectUnknownKeys, POSITION_CONTENT_SHAPE, ROLE_CONTENT_SHAPE } from './schema.js'
import { type Position, type RoleDefinitionFull, RoleSchemaError } from './types.js'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 内容层体检：形状对、没有白名单外的键。回校验后的那一份（**只留原来写了的那几格**——
 * schemastery 会给没写的格子补默认值，补出来的空数组叠上去就等于把基础版那一格清空了）。
 */
function checkContent<T>(
  raw: unknown,
  shape: Schemastery,
  allowed: readonly string[],
  source: string,
  kind: string,
): T {
  if (!isPlainObject(raw))
    throw new RoleSchemaError(source, '', `${kind} content must be an object`)
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k))
  if (extra.length > 0)
    throw new RoleSchemaError(
      source,
      extra[0] ?? '',
      `field not allowed in ${kind} content (content fields only: ${allowed.join(', ')}): ${extra.join(', ')}`,
    )
  let checked: unknown
  try {
    checked = shape(raw)
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
  const unknown = collectUnknownKeys(raw, shape)
  if (unknown.length > 0)
    throw new RoleSchemaError(
      source,
      unknown[0] ?? '',
      `field not allowed in ${kind} content: ${unknown.join(', ')}`,
    )
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    const v = (checked as Record<string, unknown>)[key]
    if (v !== undefined) out[key] = v
  }
  return out as T
}

/** 职责内容层体检（形状 + 白名单）。不合格抛 `RoleSchemaError`，整份不收。 */
export function checkRoleContent(raw: unknown, source = '<content>'): RoleContent {
  const content = checkContent<RoleContent>(
    raw,
    ROLE_CONTENT_SHAPE,
    ROLE_CONTENT_FIELDS,
    source,
    'role',
  )
  // 同一个理由往里再剥一层：每条意图规则只留原来写了的那张词表（没写 = 照骨架）
  const rawGrounding = (raw as Record<string, unknown>).grounding
  if (content.grounding !== undefined && Array.isArray(rawGrounding))
    content.grounding = content.grounding.map((g, i) => {
      const was = rawGrounding[i] as Record<string, unknown>
      return {
        name: g.name,
        ...('intent_terms' in was && g.intent_terms !== undefined
          ? { intent_terms: g.intent_terms }
          : {}),
        ...('cue_terms' in was && g.cue_terms !== undefined ? { cue_terms: g.cue_terms } : {}),
      }
    })
  const seen = new Set<string>()
  for (const [i, g] of (content.grounding ?? []).entries()) {
    if (seen.has(g.name))
      throw new RoleSchemaError(source, `grounding[${i}].name`, `duplicate grounding: ${g.name}`)
    seen.add(g.name)
  }
  return content
}

/** 岗位内容层体检。 */
export function checkPositionContent(raw: unknown, source = '<content>'): PositionContent {
  return checkContent<PositionContent>(
    raw,
    POSITION_CONTENT_SHAPE,
    POSITION_CONTENT_FIELDS,
    source,
    'position',
  )
}

/** `grounding` 叠法：按 `name` 对齐，只换两张词表；骨架里没有这个 `name` → 拒。 */
function mergeGrounding(
  skeleton: RoleDefinitionFull,
  content: readonly RoleGroundingContent[],
  source: string,
): RoleDefinitionFull['grounding'] {
  const byName = new Map(content.map((g) => [g.name, g]))
  const known = new Set((skeleton.grounding ?? []).map((g) => g.name))
  for (const [i, g] of content.entries())
    if (!known.has(g.name))
      throw new RoleSchemaError(
        source,
        `grounding[${i}].name`,
        `no grounding named ${g.name} in the role (content can only change the terms of an existing one)`,
      )
  return (skeleton.grounding ?? []).map((g) => {
    const c = byName.get(g.name)
    if (c === undefined) return g
    return {
      ...g,
      ...(c.intent_terms === undefined ? {} : { intent_terms: [...c.intent_terms] }),
      ...(c.cue_terms === undefined ? {} : { cue_terms: [...c.cue_terms] }),
    }
  })
}

/**
 * 内容层叠到一份职责骨架上。`skeleton` 是校验过的定义（基础版 yml 读出来的那一份）。
 *
 * 写了的格子整格换上；叠完再走一遍 `roleFromDocument`（骨架那一关）。白名单外的字段整份拒收。
 */
export function applyRoleContent(
  skeleton: RoleDefinitionFull,
  raw: RoleContent | unknown,
  source = `<content ${skeleton.id}>`,
): RoleDefinitionFull {
  const content = checkRoleContent(raw, source)
  const merged: Record<string, unknown> = { ...skeleton }
  for (const key of ROLE_CONTENT_FIELDS) {
    if (key === 'grounding' || content[key] === undefined) continue
    merged[key] = content[key]
  }
  if (content.grounding !== undefined)
    merged.grounding = mergeGrounding(skeleton, content.grounding, source)
  return roleFromDocument(merged, source)
}

/** 内容层叠到一份岗位模板上（同 `applyRoleContent` 的规矩）。 */
export function applyPositionContent(
  skeleton: Position,
  raw: PositionContent | unknown,
  source = `<content ${skeleton.id}>`,
): Position {
  const content = checkPositionContent(raw, source)
  const merged: Record<string, unknown> = { ...skeleton }
  for (const key of POSITION_CONTENT_FIELDS)
    if (content[key] !== undefined) merged[key] = content[key]
  return positionFromDocument(merged, source)
}

/**
 * 一份职责定义（或 yml 原样读出来的对象）里的**内容那一半**——抽取脚本与往返测试用。
 * 只拿白名单里写了的格子；`grounding` 每条只拿 `name` + 两张词表。
 */
export function roleContentOf(def: Record<string, unknown> | RoleDefinitionFull): RoleContent {
  const src = def as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ROLE_CONTENT_FIELDS) {
    const v = src[key]
    if (v === undefined) continue
    out[key] =
      key === 'grounding' && Array.isArray(v)
        ? v.map((g: Record<string, unknown>) => {
            const row: Record<string, unknown> = {}
            for (const f of ROLE_GROUNDING_CONTENT_FIELDS) if (g[f] !== undefined) row[f] = g[f]
            return row
          })
        : v
  }
  return out as RoleContent
}

/** 岗位的内容那一半。 */
export function positionContentOf(def: Record<string, unknown> | Position): PositionContent {
  const src = def as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of POSITION_CONTENT_FIELDS) if (src[key] !== undefined) out[key] = src[key]
  return out as PositionContent
}

/** 内容文件（`RoleContentFile` / `PositionContentFile`）读进来的那一刀：格式版本、种类、id 对得上。 */
export function checkContentFile(
  raw: unknown,
  expect: { kind: 'role' | 'position'; id: string },
  source = '<content file>',
): RoleContent | PositionContent {
  if (!isPlainObject(raw)) throw new RoleSchemaError(source, '', 'content file must be an object')
  if (raw.schema !== ROLE_CONTENT_SCHEMA)
    throw new RoleSchemaError(source, 'schema', `unsupported content schema: ${String(raw.schema)}`)
  if (raw.kind !== expect.kind || raw.id !== expect.id)
    throw new RoleSchemaError(
      source,
      'id',
      `content file is for ${String(raw.kind)}:${String(raw.id)}, not ${expect.kind}:${expect.id}`,
    )
  const extra = Object.keys(raw).filter((k) => !['schema', 'kind', 'id', 'content'].includes(k))
  if (extra.length > 0)
    throw new RoleSchemaError(source, extra[0] ?? '', `unknown field in content file: ${extra}`)
  return expect.kind === 'role'
    ? checkRoleContent(raw.content, source)
    : checkPositionContent(raw.content, source)
}

/** 一条内置职责的内容文件（抽取脚本写盘的就是它）。 */
export function roleContentFileOf(id: RoleId, content: RoleContent): RoleContentFile {
  return { schema: ROLE_CONTENT_SCHEMA, kind: 'role', id, content }
}

/** 一个内置岗位的内容文件。 */
export function positionContentFileOf(id: string, content: PositionContent): PositionContentFile {
  return { schema: ROLE_CONTENT_SCHEMA, kind: 'position', id, content }
}

/**
 * 读内置职责，再叠一层内容（WP406 / WP407 用：官方内容、用户应用过的那一版）。
 *
 * 次序要紧：先叠内容、**再**补生成的英文 persona——英文按中文的哈希认，中文换了，旧的英文自然不用
 * （英文界面回落中文 + 「未翻译」，与 WP226 同一条规矩）。
 */
export function loadBundledRoleWithContent(id: RoleId, content: RoleContent): RoleDefinitionFull {
  const file = bundledRoleFile(id)
  return bundledRole(applyRoleContent(loadRole(file), content, `${file} + content`))
}

/** 读内置岗位，再叠一层内容。 */
export function loadBundledPositionWithContent(id: string, content: PositionContent): Position {
  const file = `${BUNDLED_POSITIONS_DIR}${id}.yml`
  return bundledPosition(applyPositionContent(loadPosition(file), content, `${file} + content`))
}
