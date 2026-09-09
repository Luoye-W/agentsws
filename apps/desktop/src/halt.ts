/**
 * 托盘"暂停" = 内核急停（28 §1「急停一个变量」）。
 *
 * `packages/kernel` 的 `MemoryHalt` 只在**进程启动时**读 `AGENTSWS_HALT`，网关也没有
 * 运行期改急停的路由。所以桌面壳的做法是：把档位写进用户数据目录的 `halt.json`
 * （重启后仍然是停的），再按新的环境变量重启服务进程 sidecar。
 * 一旦 server 提供了运行期急停接口，这里换成直接调它即可（见报告第 4 节）。
 */
import type { FileStore } from './ports.js'

export const HALT_SCOPES = ['all', 'model', 'outbound', 'learning'] as const
export type HaltScope = (typeof HALT_SCOPES)[number]

export function isHaltScope(value: unknown): value is HaltScope {
  return typeof value === 'string' && (HALT_SCOPES as readonly string[]).includes(value)
}

/** 宽容解析：坏文件当成"没停"，绝不因为解析失败把系统卡在停止态。 */
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
  for (const item of scopes) if (isHaltScope(item) && !out.includes(item)) out.push(item)
  return out
}

export function serializeHaltFile(scopes: readonly HaltScope[]): string {
  return `${JSON.stringify({ scopes: [...scopes] }, null, 2)}\n`
}

/** 没停就不设变量——`AGENTSWS_HALT=''` 与不设等价，但少一个变量少一次误会。 */
export function haltEnv(scopes: readonly HaltScope[]): Record<string, string> {
  return scopes.length === 0 ? {} : { AGENTSWS_HALT: scopes.join(',') }
}

export interface HaltControl {
  read(): HaltScope[]
  set(scopes: readonly HaltScope[]): HaltScope[]
  /** 托盘勾选态：`all` 打开就是"已暂停"。 */
  isPaused(): boolean
  /** 返回切换后的档位。 */
  toggle(): HaltScope[]
  env(): Record<string, string>
}

export function createHaltControl(files: FileStore, path: string): HaltControl {
  let cached: HaltScope[] | undefined
  const read = (): HaltScope[] => {
    cached ??= parseHaltFile(files.readText(path))
    return [...cached]
  }
  const set = (scopes: readonly HaltScope[]): HaltScope[] => {
    const clean = scopes.filter((s, i) => scopes.indexOf(s) === i)
    files.writeText(path, serializeHaltFile(clean))
    cached = [...clean]
    return [...clean]
  }
  return {
    read,
    set,
    isPaused: () => read().includes('all'),
    toggle: () => (read().includes('all') ? set([]) : set(['all'])),
    env: () => haltEnv(read()),
  }
}
