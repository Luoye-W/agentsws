/**
 * 急停（28 §1「急停一个变量」、28 §4 用例 3）。内存状态 + 环境变量初值。
 *
 * - `AGENTSWS_HALT=all|model|outbound|learning`（逗号分隔）设初始态
 * - `AGENTSWS_MODEL_HALT=1` 等价于 `model`；其余三档同样支持 `AGENTSWS_<SCOPE>_HALT`
 * - `all` 打开时，所有档位都视为已停（`isHalted('outbound') === true`）
 * - `AGENTSWS_HALT_FILE=<path>`：**启动读、变更写回**。桌面壳的托盘「暂停」写的就是这个文件
 *   （13 §5），所以运行期改急停（`PUT /v1/halt`）与重启后仍然是停的，用的是同一份真源。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { Halt, HaltScope } from '@agentsws/contracts'
import { KernelError } from './errors.js'

export const HALT_SCOPES: readonly HaltScope[] = ['all', 'model', 'outbound', 'learning']

export type HaltEnv = Record<string, string | undefined>

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['', '0', 'false', 'no', 'off'])

function isHaltScope(value: string): value is HaltScope {
  return (HALT_SCOPES as readonly string[]).includes(value)
}

function envFlag(raw: string | undefined, name: string): boolean {
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  if (TRUTHY.has(value)) return true
  if (FALSY.has(value)) return false
  throw new KernelError(
    'invalid_input',
    `${name} must be a boolean flag, got ${JSON.stringify(raw)}`,
  )
}

/** 急停档位的落盘面（桌面壳的 `halt.json`）。注入是为了测试不碰真文件系统。 */
export interface HaltFile {
  read(): string | undefined
  write(text: string): void
}

/** 宽容解析：坏文件当成「没停」，绝不因为解析失败把系统卡在停止态。 */
export function parseHaltFile(text: string | undefined): HaltScope[] {
  if (text === undefined) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const scopes = (raw as { scopes?: unknown } | null)?.scopes
  if (!Array.isArray(scopes)) return []
  const out: HaltScope[] = []
  for (const item of scopes)
    if (typeof item === 'string' && isHaltScope(item) && !out.includes(item)) out.push(item)
  return out
}

export function serializeHaltFile(scopes: readonly HaltScope[]): string {
  return `${JSON.stringify({ scopes: [...scopes] }, null, 2)}\n`
}

/** 真文件系统档；`AGENTSWS_HALT_FILE` 指向的那个文件。 */
export function haltFileAt(path: string): HaltFile {
  return {
    read() {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    write(text) {
      writeFileSync(path, text, 'utf8')
    },
  }
}

export interface MemoryHaltOptions {
  /** 给了就启动读、每次 `set` 写回（桌面壳与服务进程共用同一份真源）。 */
  file?: HaltFile
}

export class MemoryHalt implements Halt {
  private readonly scopes = new Map<HaltScope, { on: boolean; reason?: string }>()
  private readonly file: HaltFile | undefined

  constructor(env: HaltEnv = {}, options: MemoryHaltOptions = {}) {
    for (const scope of HALT_SCOPES) this.scopes.set(scope, { on: false })
    this.file = options.file
    // 顺序：文件 → AGENTSWS_HALT → 单档变量。后面的只会**加**停，不会解停——
    // 任何一处说停了就是停了（宁可多停，不可少停）。
    for (const scope of parseHaltFile(options.file?.read())) {
      this.scopes.set(scope, { on: true, reason: 'AGENTSWS_HALT_FILE' })
    }
    for (const scope of parseHaltEnv(env)) {
      this.scopes.set(scope, { on: true, reason: `AGENTSWS_HALT env` })
    }
    for (const scope of HALT_SCOPES) {
      const name = `AGENTSWS_${scope.toUpperCase()}_HALT`
      if (envFlag(env[name], name)) this.scopes.set(scope, { on: true, reason: `${name} env` })
    }
  }

  /** 当前打开的档位（写回文件用的就是它）。 */
  onScopes(): HaltScope[] {
    return HALT_SCOPES.filter((s) => this.entry(s).on)
  }

  /** `all` 打开时其余档位一并视为已停；查询 `all` 只看 `all` 自身。 */
  isHalted(scope: HaltScope): boolean {
    const entry = this.entry(scope)
    if (entry.on) return true
    return scope !== 'all' && (this.scopes.get('all')?.on ?? false)
  }

  set(scope: HaltScope, on: boolean, reason?: string): void {
    this.entry(scope)
    this.scopes.set(scope, { on, ...(on && reason !== undefined ? { reason } : {}) })
    // 变更写回：桌面壳下次起进程、或者用户重启机器，看到的还是同一份档位
    if (this.file !== undefined) this.file.write(serializeHaltFile(this.onScopes()))
  }

  state(): Record<HaltScope, { on: boolean; reason?: string }> {
    const out = {} as Record<HaltScope, { on: boolean; reason?: string }>
    for (const scope of HALT_SCOPES) {
      const entry = this.entry(scope)
      out[scope] = { on: entry.on, ...(entry.reason === undefined ? {} : { reason: entry.reason }) }
    }
    return out
  }

  private entry(scope: HaltScope): { on: boolean; reason?: string } {
    const entry = this.scopes.get(scope)
    if (!entry) throw new KernelError('invalid_input', `unknown halt scope: ${String(scope)}`)
    return entry
  }
}

/** 解析 `AGENTSWS_HALT`；未知档位是配置错误，直接拒绝（宁可起不来也不要以为停了其实没停）。 */
export function parseHaltEnv(env: HaltEnv): HaltScope[] {
  const raw = env.AGENTSWS_HALT
  if (raw === undefined || raw.trim() === '') return []
  const out: HaltScope[] = []
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase()
    if (token === '') continue
    if (!isHaltScope(token)) {
      throw new KernelError(
        'invalid_input',
        `AGENTSWS_HALT contains an unknown scope ${JSON.stringify(part.trim())}; expected ${HALT_SCOPES.join(' | ')}`,
      )
    }
    out.push(token)
  }
  return out
}
