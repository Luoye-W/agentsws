/**
 * 方言表（21 §3「SQL 方言差异在 driver 层」）。
 *
 * 规范形态是 **SQLite 那一份**——仓库里已有的 DDL 一个字都不用改，
 * Postgres 档在装载时按下面这张小表改写。表小是故意的：
 * 方言差异一多就说明业务代码在写方言，那该改的是业务代码，不是这张表。
 *
 * 表里没有的两件事另给函数，因为它们要按参数拼：
 * - JSON 取字段：{@link jsonExtract}（SQLite `json_extract` / Postgres `->>`）
 * - 列清单：{@link columnsQuery}（SQLite `pragma_table_info` / Postgres `information_schema`）
 */
import { mapCode, type SqlDialect, splitStatements } from './driver.js'

interface Rule {
  /** 只在这个方言下改写。 */
  readonly pattern: RegExp
  readonly replacement: string
  readonly why: string
}

/**
 * 唯一一条**跨字面量**的规则：`datetime('now')` 的参数是字符串字面量，
 * 所以它在 mapCode 之前整串换掉（见 {@link translateSql}）。
 */
const TIME_NOW: Rule = {
  pattern: /\bdatetime\s*\(\s*'now'\s*\)/gi,
  replacement: "now() at time zone 'utc'",
  why: 'sqlite datetime(now) → postgres now()',
}

/** SQLite 规范 DDL → Postgres。顺序有意义：先长后短。 */
const TO_POSTGRES: readonly Rule[] = [
  {
    // 自增主键：SQLite 的 rowid 别名 ←→ Postgres 的 BIGSERIAL
    pattern: /(?<=[A-Za-z0-9_"]\s+)INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
    replacement: 'BIGSERIAL PRIMARY KEY',
    why: 'autoincrement',
  },
  {
    pattern: /(?<=[A-Za-z0-9_"]\s+)INTEGER\s+PRIMARY\s+KEY\s+NOT\s+NULL\b/gi,
    replacement: 'BIGINT PRIMARY KEY NOT NULL',
    why: 'integer pk',
  },
  { pattern: /\bAUTOINCREMENT\b/gi, replacement: '', why: 'autoincrement leftover' },
  // STRICT 是 SQLite 3.37 的表选项；Postgres 本来就是强类型
  { pattern: /\)\s*STRICT\s*(?=;|$)/gim, replacement: ')', why: 'strict table' },
  { pattern: /\)\s*STRICT\s*,/gi, replacement: '),', why: 'strict table' },
  // 字节列。前瞻断言保证只在**类型位**替换：`blob BLOB` 里改后面那个，不改列名
  { pattern: /(?<=[A-Za-z0-9_"]\s+)BLOB\b/gi, replacement: 'BYTEA', why: 'blob' },
  // 整数列：SQLite 的 INTEGER 是 64 位，Postgres 的是 32 位——毫秒时间戳会溢出
  { pattern: /(?<=[A-Za-z0-9_"]\s+)INTEGER\b/gi, replacement: 'BIGINT', why: 'integer width' },
  // 时间
  { pattern: /\bCURRENT_TIMESTAMP\b/gi, replacement: "now() at time zone 'utc'", why: 'now' },
  // 字符串拼接的 SQLite 专有写法（我们不用，留着挡回归）
  { pattern: /\bIFNULL\s*\(/gi, replacement: 'COALESCE(', why: 'ifnull' },
]

/**
 * DML 里也安全的那几条。
 *
 * 类型名规则（`BLOB` / `INTEGER`）**只在 DDL 里跑**：`INSERT INTO t (blob) VALUES (?)`
 * 里的 `blob` 是列名，改了就查不到这一列了。这不是洁癖——第一版就在自己的测试上踩了一次。
 */
const SAFE_ANYWHERE: readonly Rule[] = [
  { pattern: /\bCURRENT_TIMESTAMP\b/gi, replacement: "now() at time zone 'utc'", why: 'now' },
  { pattern: /\bIFNULL\s*\(/gi, replacement: 'COALESCE(', why: 'ifnull' },
]

/**
 * 把规范（SQLite）SQL 翻成目标方言。SQLite 档原样返回——
 * 规范就是它，翻译一次都不做，老库的行为一个字节都不变。
 */
export function translateSql(sql: string, dialect: SqlDialect): string {
  if (dialect === 'sqlite') return sql
  const statements = splitStatements(sql)
  if (statements.length > 1) {
    return statements.map((s) => translateStatement(s)).join(';\n')
  }
  return translateStatement(statements[0] ?? sql)
}

/** DDL 才认识类型名。 */
const DDL = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(CREATE|ALTER|DROP)\b/i

function translateStatement(sql: string): string {
  // `datetime('now')` 的参数本身是字面量，跨段，先整串换掉再进 mapCode
  const pre = sql.replace(TIME_NOW.pattern, TIME_NOW.replacement)
  const rules = DDL.test(pre) ? TO_POSTGRES : SAFE_ANYWHERE
  // 只改写代码段：字符串字面量与注释里的 `INTEGER` / `BLOB` 是数据，不是类型名
  return mapCode(pre, (code) => {
    let out = code
    for (const rule of rules) out = out.replace(rule.pattern, rule.replacement)
    return out
  })
}

/** 方言表本身（测试与文档用；每条带一句为什么）。 */
export function dialectRules(): readonly { pattern: string; replacement: string; why: string }[] {
  return [TIME_NOW, ...TO_POSTGRES].map((r) => ({
    pattern: r.pattern.source,
    replacement: r.replacement,
    why: r.why,
  }))
}

/** JSON 列取一个顶层字段，结果是文本。字段名由调用方保证合法（见 `isLegalFieldName`）。 */
export function jsonExtract(dialect: SqlDialect, column: string, field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
    throw new Error(`illegal json field name: ${field}`)
  }
  return dialect === 'sqlite'
    ? `json_extract(${column}, '$.${field}')`
    : `(${column}::jsonb ->> '${field}')`
}

/** 一张表的列名（迁移里补列时用）。参数是表名。 */
export function columnsQuery(dialect: SqlDialect): string {
  return dialect === 'sqlite'
    ? 'SELECT name FROM pragma_table_info(?)'
    : 'SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?'
}

/**
 * 「插入，冲突就整行覆盖」。SQLite 有 `INSERT OR REPLACE`，Postgres 只有
 * `ON CONFLICT DO UPDATE`——后者更精确，所以规范写法取后者，两边都能用
 * （SQLite 3.24+ 支持 upsert，我们要求的 better-sqlite3 远高于这个版本）。
 */
export function upsert(
  table: string,
  columns: readonly string[],
  conflict: readonly string[],
): string {
  const cols = columns.map((c) => `"${c}"`).join(', ')
  const values = columns.map(() => '?').join(', ')
  const keys = conflict.map((c) => `"${c}"`).join(', ')
  const updates = columns
    .filter((c) => !conflict.includes(c))
    .map((c) => `"${c}" = excluded."${c}"`)
    .join(', ')
  const action = updates === '' ? 'DO NOTHING' : `DO UPDATE SET ${updates}`
  return `INSERT INTO ${table} (${cols}) VALUES (${values}) ON CONFLICT (${keys}) ${action}`
}

/** 布尔 → 存储值。两个方言都吃 0 / 1（Postgres 的列是 BIGINT）。 */
export function boolValue(v: boolean): number {
  return v ? 1 : 0
}

/**
 * 存储值 → 布尔。Postgres 的 BIGINT 经驱动的类型钩子已经是 number，
 * 但备份导入的老库里可能是字符串，一并认。
 */
export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'bigint') return v !== 0n
  if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false'
  return false
}

/** 存储值 → number。Postgres 的 int8 可能回 string / bigint。 */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v)
  return Number.NaN
}

/** 存储值 → 字节。SQLite 回 Buffer，Postgres 回 Uint8Array。 */
export function toBytes(v: unknown): Uint8Array | undefined {
  if (v === null || v === undefined) return undefined
  if (v instanceof Uint8Array) return v
  if (typeof v === 'string') return Buffer.from(v, 'hex')
  return undefined
}
