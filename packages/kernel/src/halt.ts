/**
 * 急停（28 §1「急停一个变量」、28 §4 用例 3）。内存状态 + 环境变量初值。
 *
 * - `AGENTSWS_HALT=all|model|outbound|learning`（逗号分隔）设初始态
 * - `AGENTSWS_MODEL_HALT=1` 等价于 `model`；其余三档同样支持 `AGENTSWS_<SCOPE>_HALT`
 * - `all` 打开时，所有档位都视为已停（`isHalted('outbound') === true`）
 */
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

export class MemoryHalt implements Halt {
  private readonly scopes = new Map<HaltScope, { on: boolean; reason?: string }>()

  constructor(env: HaltEnv = {}) {
    for (const scope of HALT_SCOPES) this.scopes.set(scope, { on: false })
    for (const scope of parseHaltEnv(env)) {
      this.scopes.set(scope, { on: true, reason: `AGENTSWS_HALT env` })
    }
    for (const scope of HALT_SCOPES) {
      const name = `AGENTSWS_${scope.toUpperCase()}_HALT`
      if (envFlag(env[name], name)) this.scopes.set(scope, { on: true, reason: `${name} env` })
    }
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
