import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ActionMeta } from '@agentsws/contracts'
import { parse } from 'yaml'
import { ConnectAdapterError } from './errors.js'

export type SideEffect = ActionMeta['side_effect']

interface Pattern {
  match: string
  side_effect: SideEffect
}

export interface SideEffectTableFile {
  version?: number
  default?: SideEffect
  actions?: Record<string, string>
  patterns?: Pattern[]
}

/** 18 §1 覆盖表。**未标的按 write**——这一条是安全默认，不许改成 read。 */
export class SideEffectTable {
  private readonly exact: ReadonlyMap<string, SideEffect>
  private readonly patterns: readonly Pattern[]
  readonly fallback: SideEffect

  constructor(file: SideEffectTableFile) {
    const exact = new Map<string, SideEffect>()
    for (const [id, value] of Object.entries(file.actions ?? {})) {
      exact.set(id, assertSideEffect(value, id))
    }
    this.exact = exact
    this.patterns = (file.patterns ?? []).map((p) => ({
      match: p.match,
      side_effect: assertSideEffect(p.side_effect, p.match),
    }))
    this.fallback = file.default === undefined ? 'write' : assertSideEffect(file.default, 'default')
  }

  /** 精确 id → 通配 → 兜底 write。 */
  resolve(action_id: string): SideEffect {
    const exact = this.exact.get(action_id)
    if (exact !== undefined) return exact
    for (const p of this.patterns) {
      if (matches(p.match, action_id)) return p.side_effect
    }
    return this.fallback
  }

  /** 表里显式标过（精确或通配命中）的才算"已覆盖"。 */
  covers(action_id: string): boolean {
    if (this.exact.has(action_id)) return true
    return this.patterns.some((p) => matches(p.match, action_id))
  }

  size(): number {
    return this.exact.size
  }
}

function matches(pattern: string, id: string): boolean {
  if (!pattern.endsWith('*')) return pattern === id
  return id.startsWith(pattern.slice(0, -1))
}

function assertSideEffect(v: unknown, where: string): SideEffect {
  if (v === 'read' || v === 'write') return v
  throw new ConnectAdapterError(
    'invalid_input',
    `action-side-effects.yml：${where} 的 side_effect 必须是 read 或 write，得到 ${String(v)}`,
  )
}

export function parseSideEffectTable(yamlText: string): SideEffectTable {
  const parsed: unknown = parse(yamlText)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConnectAdapterError('invalid_input', 'action-side-effects.yml 必须是一个映射')
  }
  return new SideEffectTable(parsed as SideEffectTableFile)
}

/** 包内自带的默认表路径（`packages/connect-adapter/action-side-effects.yml`）。 */
export function defaultSideEffectsFile(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'action-side-effects.yml')
}

export function loadSideEffectTable(file?: string): SideEffectTable {
  const path = file ?? defaultSideEffectsFile()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new ConnectAdapterError('not_found', `读不到副作用覆盖表：${path}`, {
      cause: e instanceof Error ? e.message : String(e),
    })
  }
  return parseSideEffectTable(text)
}
