/**
 * WP246：取数路线的两样本机小账——每品牌一份 `<品牌目录>/read-routes.json`：
 *
 * 1. 设置：网页转文字的第三方那一级开没开（默认关）、Reddit 自动读取时浏览器怎么开；
 * 2. 每一级**最近一次真去取数**的结果（体检里「上次没成：……」那一句；工具用过才有）。
 *
 * Reddit 那条的顺序与停用不在这里（WP220 的 `data_source_routing['reddit.read']`，不动）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_READ_ROUTES_SETTINGS,
  type ReadLevel,
  type ReadLevelCheck,
  type ReadRoutesSettings,
} from '@agentsws/contracts'

type Last = NonNullable<ReadLevelCheck['last']>

interface File {
  settings: ReadRoutesSettings
  last: Record<string, Last>
}

export interface ReadRoutesStore {
  settings(): ReadRoutesSettings
  setSettings(patch: Partial<ReadRoutesSettings>): ReadRoutesSettings
  note(platform: string, level: ReadLevel, ok: boolean, at: string, message?: string): void
  last(platform: string, level: ReadLevel): Last | undefined
}

const clean = (raw: unknown): ReadRoutesSettings => {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    web_third_party_reader: o.web_third_party_reader === true,
    reddit_browser_window: o.reddit_browser_window === 'headless' ? 'headless' : 'minimized',
  }
}

/** `dir` 不给 = 只在内存里（测试 / 演示）。 */
export function createReadRoutesStore(dir?: string): ReadRoutesStore {
  const file = dir === undefined ? undefined : join(dir, 'read-routes.json')
  let state: File = { settings: { ...DEFAULT_READ_ROUTES_SETTINGS }, last: {} }
  if (file !== undefined && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<File>
      state = {
        settings: clean(raw.settings),
        last: typeof raw.last === 'object' && raw.last !== null ? raw.last : {},
      }
    } catch {
      // 坏了就回默认（第三方那一级默认关，回默认只会更保守）
    }
  }
  const flush = (): void => {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(state))
    renameSync(`${file}.tmp`, file)
  }
  return {
    settings: () => ({ ...state.settings }),
    setSettings(patch) {
      state.settings = clean({ ...state.settings, ...patch })
      flush()
      return { ...state.settings }
    },
    note(platform, level, ok, at, message) {
      state.last[`${platform}/${level}`] = {
        ok,
        at,
        ...(message === undefined ? {} : { message: message.slice(0, 300) }),
      }
      flush()
    },
    last: (platform, level) => state.last[`${platform}/${level}`],
  }
}
