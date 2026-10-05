/**
 * WP228：**本机只读浏览器**——给 Reddit 取数「浏览器只读」那一路（WP220），以及以后的只读研究。
 *
 * 一个品牌一份（用户数据目录、限速账本都在品牌数据目录的 `readonly-browser/` 下）。
 * 要用时才起（无头），读完一阵子没事就关；服务进程退出时一并结束，不留孤儿。
 *
 * 一次 {@link ReadonlyBrowser.read} 的顺序（每一步不过就照实说，不往下走）：
 * 白名单 → 找浏览器 → 限速 / 被拦暂停 → 记一页 → 起浏览器（没起就起）→ 只读打开 →
 * 认拦截（被拦就记暂停）→ 解析 → 认不出任何条目也照实说（不当「0 条」）。
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostAllowed, type ReadonlyBrowserStatus } from '@agentsws/contracts'
import type { ExtractArgs } from './extract.js'
import { type Env, findBrowser } from './find-browser.js'
import { detectWall, hostOf, type WallKind } from './guard.js'
import { type BrowserSession, launchChromeSession, type SessionLauncher } from './session.js'
import { createReadUsage, type ReadLimits, type ReadUsage } from './usage.js'

export { findBrowser, NO_BROWSER_MESSAGE } from './find-browser.js'
export type { ReadLimits, ReadUsage } from './usage.js'

/** 连接页那一格显示的四种状态（docs/36 §7：图标 + 少字，原话进提示）。 */
export type ReadonlyBrowserState = ReadonlyBrowserStatus['state']
export type { ReadonlyBrowserStatus }

export type ReadFailure =
  | 'not_allowed'
  | 'no_browser'
  | 'limited'
  | 'blocked'
  | 'wall'
  | 'off_site'
  | 'empty'
  | 'failed'

export type ReadOutcome =
  | { ok: true; items: Record<string, unknown>[]; final_url: string }
  | { ok: false; reason: ReadFailure; message: string; wall?: WallKind }

export interface ReadonlyBrowserOptions {
  /** 这个品牌的只读浏览器目录（`<品牌数据目录>/readonly-browser`）；不给 = 不落盘（测试）。 */
  dir?: string
  /** 能开哪些站（Reddit 那一路是 `REDDIT_READ_HOSTS`）。 */
  allowedHosts(): readonly string[]
  limits(): ReadLimits
  nowMs(): number
  /** 用户在设置里指定的浏览器可执行文件（不给就自己找）。 */
  executable?(): string | undefined
  platform?: NodeJS.Platform
  env?: Env
  exists?(path: string): boolean
  /** 测试塞替身；默认真起浏览器。 */
  launch?: SessionLauncher
  /** 闲多久自动关（默认 90 秒）。 */
  idleMs?: number
}

export interface ReadonlyBrowser {
  read(url: string, options?: { limit?: number }): Promise<ReadOutcome>
  status(): ReadonlyBrowserStatus
  /** 同一本限速账（Reddit 路由拿它当限速器）。 */
  readonly usage: ReadUsage
  /** 现在浏览器开着没有。 */
  running(): boolean
  close(): Promise<void>
}

const browserName = (exe: string): string =>
  /msedge|edge/iu.test(exe) ? 'Edge' : /chromium/iu.test(exe) ? 'Chromium' : 'Chrome'

export function createReadonlyBrowser(options: ReadonlyBrowserOptions): ReadonlyBrowser {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const launch = options.launch ?? launchChromeSession
  const idleMs = options.idleMs ?? 90_000
  const usage = createReadUsage({
    ...(options.dir === undefined ? {} : { file: join(options.dir, 'usage.json') }),
    limits: options.limits,
  })
  const profileDir = join(options.dir ?? join(tmpdir(), 'agentsws-readonly-browser'), 'profile')
  let session: BrowserSession | undefined
  let starting: Promise<BrowserSession> | undefined
  let idle: NodeJS.Timeout | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const onExit = (): void => session?.killNow()

  const find = () =>
    findBrowser({
      platform,
      env,
      ...(options.exists === undefined ? {} : { exists: options.exists }),
      preferred: options.executable?.(),
    })

  async function ensure(executable: string): Promise<BrowserSession> {
    if (session !== undefined) return session
    starting ??= launch({ executable, profileDir, platform, env }).then(
      (s) => {
        session = s
        process.once('exit', onExit)
        return s
      },
      (err: unknown) => {
        starting = undefined
        throw err
      },
    )
    return starting
  }

  async function closeNow(): Promise<void> {
    if (idle !== undefined) clearTimeout(idle)
    idle = undefined
    const s = session ?? (await starting?.catch(() => undefined))
    session = undefined
    starting = undefined
    process.removeListener('exit', onExit)
    await s?.close()
  }

  const armIdle = (): void => {
    if (idle !== undefined) clearTimeout(idle)
    idle = setTimeout(() => void closeNow(), idleMs)
    idle.unref?.()
  }

  async function readOnce(url: string, limit: number): Promise<ReadOutcome> {
    const hosts = options.allowedHosts()
    if (!hostAllowed(hostOf(url), hosts))
      return { ok: false, reason: 'not_allowed', message: `不在只读白名单里：${url}` }
    const found = find()
    if (!found.ok) return { ok: false, reason: 'no_browser', message: found.message }
    const now = options.nowMs()
    const gate = usage.check(now)
    if (!gate.ok)
      return {
        ok: false,
        reason: gate.reason === 'blocked' ? 'blocked' : 'limited',
        message: gate.message,
      }
    usage.take(now)
    const args: ExtractArgs = { limit, maxText: 4000 }
    let page: Awaited<ReturnType<BrowserSession['readPage']>>
    try {
      const s = await ensure(found.executable)
      page = await s.readPage(url, args, hosts)
    } catch (err) {
      return {
        ok: false,
        reason: 'failed',
        message: `浏览器只读没打开这一页：${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      armIdle()
    }
    const wall = detectWall({
      status: page.status,
      finalUrl: page.finalUrl,
      allowedHosts: hosts,
      ...(page.extract === undefined ? {} : { signals: page.extract.signals }),
    })
    if (wall !== undefined) {
      usage.block(wall.kind, wall.message, options.nowMs(), page.retryAfterMs)
      return {
        ok: false,
        reason: wall.kind === 'off_site' ? 'off_site' : 'wall',
        message: wall.message,
        wall: wall.kind,
      }
    }
    if (page.status >= 400)
      return { ok: false, reason: 'failed', message: `站点回了 ${page.status}，这一页没读到。` }
    const items = page.extract?.items ?? []
    if (items.length === 0)
      return {
        ok: false,
        reason: 'empty',
        message: '页面开了，但没认出任何帖子（可能真没有，也可能页面改了版）。',
      }
    return { ok: true, items, final_url: page.finalUrl }
  }

  return {
    usage,
    read(url, opts) {
      const limit = Math.min(100, Math.max(1, Math.floor(opts?.limit ?? 25)))
      // 一次只开一页：排队（限速本来就要求两页之间隔开）
      const next = queue.then(() => readOnce(url, limit))
      queue = next.catch(() => undefined)
      return next
    },
    status() {
      const limits = options.limits()
      const snap = usage.snapshot(options.nowMs())
      const base = {
        pages_last_day: snap.pages_last_day,
        max_pages_per_day: limits.max_pages_per_day,
      }
      const found = find()
      if (!found.ok) return { ...base, state: 'no_browser', message: found.message }
      const browser = browserName(found.executable)
      if (snap.blocked !== undefined)
        return {
          ...base,
          browser,
          state: 'blocked',
          message: snap.blocked.message,
          until: new Date(snap.blocked.until).toISOString(),
        }
      if (snap.day_full)
        return {
          ...base,
          browser,
          state: 'quota_used_up',
          message: `最近 24 小时已经开了 ${limits.max_pages_per_day} 页（设置里的上限）。`,
        }
      return { ...base, browser, state: 'ready' }
    },
    running: () => session !== undefined,
    close: closeNow,
  }
}
