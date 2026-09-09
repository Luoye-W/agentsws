/**
 * `config.json`（13 §5 启动器：端口、浏览器打开、开机自启、语言）。
 *
 * **不含任何密钥**——写盘时只序列化下面这四个已知字段，未知字段一律丢弃，
 * 所以就算有人往文件里塞了 token 也不会被写回去。密钥走 `secrets.ts` 的 safeStorage。
 */
import type { FileStore } from './ports.js'

export const LANGUAGES = ['zh-CN', 'en-US'] as const
export type Language = (typeof LANGUAGES)[number]

export interface DesktopConfig {
  /** 服务进程端口；0 = 让系统分配（e2e 用）。 */
  port: number
  /** true = 托盘"打开工作台"直接开系统浏览器；默认应用内窗口（13 §5 定案）。 */
  openInBrowser: boolean
  launchAtLogin: boolean
  language: Language
}

export const DEFAULT_PORT = 4317

export const DEFAULT_CONFIG: DesktopConfig = {
  port: DEFAULT_PORT,
  openInBrowser: false,
  launchAtLogin: false,
  language: 'zh-CN',
}

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

function readPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < 0 || value > 65535) return undefined
  return value
}

/** 宽容解析：坏字段退回默认值，不让一个手抖的 JSON 把壳挡在门外。 */
export function parseConfig(raw: unknown): DesktopConfig {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CONFIG }
  const obj = raw as Record<string, unknown>
  return {
    port: readPort(obj.port) ?? DEFAULT_CONFIG.port,
    openInBrowser:
      typeof obj.openInBrowser === 'boolean' ? obj.openInBrowser : DEFAULT_CONFIG.openInBrowser,
    launchAtLogin:
      typeof obj.launchAtLogin === 'boolean' ? obj.launchAtLogin : DEFAULT_CONFIG.launchAtLogin,
    language: isLanguage(obj.language) ? obj.language : DEFAULT_CONFIG.language,
  }
}

/** 只序列化已知字段——这就是"配置里没有密钥"的机械保证。 */
export function serializeConfig(config: DesktopConfig): string {
  const clean: DesktopConfig = {
    port: config.port,
    openInBrowser: config.openInBrowser,
    launchAtLogin: config.launchAtLogin,
    language: config.language,
  }
  return `${JSON.stringify(clean, null, 2)}\n`
}

export interface ConfigStore {
  load(): DesktopConfig
  save(config: DesktopConfig): DesktopConfig
  update(patch: Partial<DesktopConfig>): DesktopConfig
  current(): DesktopConfig
}

export function createConfigStore(files: FileStore, path: string): ConfigStore {
  let cached: DesktopConfig | undefined

  const load = (): DesktopConfig => {
    const text = files.readText(path)
    if (text === undefined) {
      cached = { ...DEFAULT_CONFIG }
      return cached
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      raw = undefined
    }
    cached = parseConfig(raw)
    return cached
  }

  const save = (config: DesktopConfig): DesktopConfig => {
    const clean = parseConfig(config)
    files.writeText(path, serializeConfig(clean))
    cached = clean
    return clean
  }

  return {
    load,
    save,
    update(patch) {
      const base = cached ?? load()
      return save({ ...base, ...patch })
    },
    current() {
      return cached ?? load()
    },
  }
}
