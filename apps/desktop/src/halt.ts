/**
 * 托盘「暂停」= 内核急停（28 §1「急停一个变量」）。
 *
 * **这个文件只是那份真源的读写口**。真源是用户数据目录里的 `halt.json`：
 * 服务进程拿 `AGENTSWS_HALT_FILE` 指向它，启动读、每次 `set` 写回
 * （见 `packages/kernel/src/halt.ts`）。所以「按下暂停」与「重启后仍然是停的」
 * 是同一份文件。
 *
 * WP16 时服务进程还没有运行期急停接口，桌面壳只好写完文件再**重启 sidecar**
 * ——一个正在处理的运行会被硬生生打断。WP24 补了 `PUT /v1/halt`，
 * WP31 把托盘改成调它：文件由服务进程写，桌面壳只负责 {@link HaltControl.reload}
 * 把自己的缓存刷新一遍。`set` 保留给**服务进程还没起来**时的兜底。
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
  /** 丢掉缓存重新读文件——服务进程刚刚写过它。 */
  reload(): HaltScope[]
  /** 直接写文件。只在服务进程没起来、调不了 `PUT /v1/halt` 时用。 */
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
  const reload = (): HaltScope[] => {
    cached = undefined
    return read()
  }
  return {
    read,
    reload,
    set,
    isPaused: () => read().includes('all'),
    toggle: () => (read().includes('all') ? set([]) : set(['all'])),
    env: () => haltEnv(read()),
  }
}
