/**
 * WP249（决策 89）：**Reddit 官方号浏览器通道**——每品牌一份（目录在品牌数据目录的
 * `reddit-official-browser/` 下，与 WP228 / WP246 的只读读号目录分开）。
 *
 * 三件事：
 *
 * 1. **登录官方号**（{@link RedditOfficialBrowser.openLogin}）：有头打开登录页，用户自己登录；
 *    「我登录好了」→ 体检（{@link RedditOfficialBrowser.checkLogin}）看首页右上角的登录名。
 *    我们不碰密码、不读 cookie。
 * 2. **读**版务队列 / 版规（`port.readModQueue` / `port.readRules`）：低频（两页之间至少隔几秒、
 *    一天封顶），一次只开一页。
 * 3. **写**（`port.run`）：只由「卡被批准之后的执行器」调；只做卡上那一个动作（白名单在
 *    `social-core/reddit-browser.ts`，闸在 `page.ts` / `runner.ts`），读回自证，被拦就停。
 *    写也有自己的低频账（两次之间隔一会儿、一天封顶）。
 *
 * 被 Reddit 拦了（验证码 / 429 / 拦截页）就记一笔「停到几点」，这期间读写都直接说被拦了，不重试。
 * 登录掉了就把状态改回「没登录」，等人重新登录。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RedditOfficialBrowserStatus } from '@agentsws/contracts'
import {
  loginCheckUrl,
  loginPageUrl,
  modQueueJsonUrl,
  modQueuePageUrl,
  OLD_REDDIT_ORIGIN,
  planRedditWrite,
  REDDIT_OFFICIAL_HOSTS,
  type RedditBrowserReadResult,
  type RedditBrowserRunResult,
  type RedditBrowserWrite,
  type RedditOfficialBrowserPort,
  rulesJsonUrl,
} from '@agentsws/social-core'
import type { BrowserContext } from 'playwright-core'
import { type Env, findBrowser } from '../readonly-browser/find-browser.js'
import { BLOCK_PAUSE_MS } from '../readonly-browser/usage.js'
import {
  launchOfficialBrowser,
  type OfficialBrowserProcess,
  type OfficialLauncher,
} from './launch.js'
import { type AutomationPage, openAutomationPage } from './page.js'
import {
  checkLoginOn,
  type PageVerdict,
  readModQueueOn,
  readRulesOn,
  runWriteOn,
} from './runner.js'

export type { OfficialLauncher } from './launch.js'
export type { AutomationPage } from './page.js'

export interface OfficialBrowserLimits {
  /** 读：两页之间至少隔几秒（到了就等一下再开，最多等这么久）。 */
  read_interval_seconds: number
  reads_per_day: number
  /** 写：两次动作之间至少隔几秒（不够就照实说，不排队）。 */
  write_interval_seconds: number
  writes_per_day: number
}

/** 默认：读两页隔 4 秒、一天 150 页；写两次隔 20 秒、一天 30 次（版务 20 + 发帖回帖）。 */
export const DEFAULT_OFFICIAL_LIMITS: OfficialBrowserLimits = {
  read_interval_seconds: 4,
  reads_per_day: 150,
  write_interval_seconds: 20,
  writes_per_day: 30,
}

export type PageOpener = (
  ctx: BrowserContext | undefined,
  allowedHosts: readonly string[],
  plan?: ReturnType<typeof planRedditWrite>,
) => Promise<AutomationPage>

export interface RedditOfficialBrowserOptions {
  /** `<品牌数据目录>/reddit-official-browser`；不给 = 临时目录、不落账（测试）。 */
  dir?: string
  /** old.reddit 的地址（测试指向本地假站点）。 */
  origin?: string
  allowedHosts?(): readonly string[]
  nowMs(): number
  limits?(): OfficialBrowserLimits
  executable?(): string | undefined
  platform?: NodeJS.Platform
  env?: Env
  exists?(path: string): boolean
  launch?: OfficialLauncher
  /** 测试塞替身（不起真浏览器）。 */
  openPage?: PageOpener
  sleep?(ms: number): Promise<void>
  /** 无头那一个闲多久自动关（默认 90 秒；登录窗口不自动关）。 */
  idleMs?: number
  /** 测试用：「登录官方号」也无头起（CI 与并行代理不弹窗口）。生产不给。 */
  loginHeadless?: boolean
}

export interface RedditOfficialBrowser {
  status(): RedditOfficialBrowserStatus
  /** 有头打开登录页（用户自己在网页上登录）。 */
  openLogin(): Promise<RedditOfficialBrowserStatus>
  /** 体检：现在登着谁。 */
  checkLogin(): Promise<RedditOfficialBrowserStatus>
  /** 关掉登录窗口（或无头那一个）。 */
  closeWindow(): Promise<void>
  readonly port: RedditOfficialBrowserPort
  close(): Promise<void>
}

interface StateFile {
  version: 1
  logged_in: boolean
  username?: string
  checked_at?: number
  block?: { kind: string; message: string; until: number }
  reads: number[]
  writes: number[]
}

const DAY = 86_400_000
const browserName = (exe: string): string =>
  /msedge|edge/iu.test(exe) ? 'Edge' : /chromium/iu.test(exe) ? 'Chromium' : 'Chrome'

export function createRedditOfficialBrowser(
  options: RedditOfficialBrowserOptions,
): RedditOfficialBrowser {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const origin = options.origin ?? OLD_REDDIT_ORIGIN
  const hosts = (): readonly string[] => options.allowedHosts?.() ?? REDDIT_OFFICIAL_HOSTS
  const limits = (): OfficialBrowserLimits => options.limits?.() ?? DEFAULT_OFFICIAL_LIMITS
  const launch = options.launch ?? launchOfficialBrowser
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const idleMs = options.idleMs ?? 90_000
  const root = options.dir ?? join(tmpdir(), 'agentsws-reddit-official')
  const profileDir = join(root, 'profile')
  const stateFile = options.dir === undefined ? undefined : join(options.dir, 'state.json')

  let state: StateFile = { version: 1, logged_in: false, reads: [], writes: [] }
  if (stateFile !== undefined && existsSync(stateFile)) {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<StateFile>
      state = {
        version: 1,
        logged_in: raw.logged_in === true,
        ...(typeof raw.username === 'string' ? { username: raw.username } : {}),
        ...(typeof raw.checked_at === 'number' ? { checked_at: raw.checked_at } : {}),
        ...(raw.block === undefined ? {} : { block: raw.block }),
        reads: Array.isArray(raw.reads) ? raw.reads.filter((t) => typeof t === 'number') : [],
        writes: Array.isArray(raw.writes) ? raw.writes.filter((t) => typeof t === 'number') : [],
      }
    } catch {
      // 坏了就当没登录过（只影响「要不要重新体检」，不影响安全）
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state))
    renameSync(`${stateFile}.tmp`, stateFile)
  }
  const prune = (now: number): void => {
    state.reads = state.reads.filter((t) => t > now - DAY)
    state.writes = state.writes.filter((t) => t > now - DAY)
    if (state.block !== undefined && state.block.until <= now) delete state.block
  }

  let proc: OfficialBrowserProcess | undefined
  /** 现在开着的是「登录官方号」那个窗口（不自动关、状态显示「登录窗口开着」）。 */
  let loginWindow = false
  let idle: NodeJS.Timeout | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const onExit = (): void => proc?.killNow()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => undefined)
    return next
  }

  const find = () =>
    findBrowser({
      platform,
      env,
      ...(options.exists === undefined ? {} : { exists: options.exists }),
      preferred: options.executable?.(),
    })

  const alive = (): boolean => proc?.alive() === true

  async function stop(): Promise<void> {
    if (idle !== undefined) clearTimeout(idle)
    idle = undefined
    const p = proc
    proc = undefined
    loginWindow = false
    process.removeListener('exit', onExit)
    await p?.close()
  }

  async function ensure(): Promise<BrowserContext | undefined> {
    if (options.openPage !== undefined) return undefined
    if (!alive()) {
      if (proc !== undefined) await stop()
      const found = find()
      if (!found.ok) throw new Error(found.message)
      proc = await launch({
        executable: found.executable,
        profileDir,
        platform,
        env,
        mode: 'headless',
        startUrl: 'about:blank',
      })
      process.once('exit', onExit)
    }
    return (proc as OfficialBrowserProcess).browser.contexts()[0]
  }

  const armIdle = (): void => {
    if (idle !== undefined) clearTimeout(idle)
    if (proc === undefined || loginWindow) return
    idle = setTimeout(() => void serial(stop), idleMs)
    idle.unref?.()
  }

  const open = async (plan?: ReturnType<typeof planRedditWrite>): Promise<AutomationPage> => {
    const ctx = await ensure()
    if (options.openPage !== undefined) return options.openPage(ctx, hosts(), plan)
    if (ctx === undefined) throw new Error('浏览器起来了，但拿不到它的默认窗口。')
    return openAutomationPage(ctx, hosts(), plan)
  }

  /** 读了一页 / 写了一下之后看到的结论落账（被拦 → 停到几点；登录掉了 → 改回没登录）。 */
  const absorb = (v: PageVerdict | undefined): void => {
    if (v === undefined || v.ok) return
    const now = options.nowMs()
    if (v.wall === 'login') {
      state.logged_in = false
      state.checked_at = now
      flush()
      return
    }
    if (v.wall === 'rate_limited' || v.wall === 'captcha' || v.wall === 'blocked') {
      const pause = Math.max(BLOCK_PAUSE_MS[v.wall], v.retryAfterMs ?? 0)
      state.block = { kind: v.wall, message: v.message ?? '被 Reddit 拦了。', until: now + pause }
      flush()
    }
  }

  const blockedMessage = (): string | undefined => {
    prune(options.nowMs())
    const b = state.block
    if (b === undefined) return undefined
    const d = new Date(b.until)
    const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    return `${b.message}（停到 ${hh}；要早点恢复，去「登录官方号」窗口里把验证 / 提示处理掉，再点「我登录好了」）`
  }

  /** 读之前：被拦 / 一天额度到了就说；间隔不够就等一下（最多等一个间隔）。 */
  async function readGate(): Promise<string | undefined> {
    const blocked = blockedMessage()
    if (blocked !== undefined) return blocked
    const l = limits()
    const now = options.nowMs()
    if (state.reads.length >= l.reads_per_day)
      return `官方号浏览器最近 24 小时已经读了 ${l.reads_per_day} 页（上限），明天再刷新。`
    const last = state.reads[state.reads.length - 1]
    const gap = l.read_interval_seconds * 1000
    if (last !== undefined && now - last < gap) await sleep(gap - (now - last))
    state.reads.push(options.nowMs())
    flush()
    return undefined
  }

  function writeGate(): string | undefined {
    const blocked = blockedMessage()
    if (blocked !== undefined) return blocked
    const l = limits()
    const now = options.nowMs()
    if (state.writes.length >= l.writes_per_day)
      return `官方号浏览器最近 24 小时已经执行了 ${l.writes_per_day} 个动作（上限），这一条明天再做。`
    const last = state.writes[state.writes.length - 1]
    if (last !== undefined && now - last < l.write_interval_seconds * 1000) {
      const wait = Math.ceil((l.write_interval_seconds * 1000 - (now - last)) / 1000)
      return `两次动作之间要隔 ${l.write_interval_seconds} 秒（像人在操作），还要等 ${wait} 秒。这一条没执行，过一会儿在卡片流里点「重试」。`
    }
    return undefined
  }

  async function read<T>(
    fn: (page: AutomationPage) => Promise<RedditBrowserReadResult<T> & { verdict?: PageVerdict }>,
  ): Promise<RedditBrowserReadResult<T>> {
    return serial(async () => {
      if (!state.logged_in)
        return { ok: false, reason: 'login', message: '官方号还没登录：去连接页点「登录官方号」。' }
      const gate = await readGate()
      if (gate !== undefined)
        return {
          ok: false,
          reason: state.block === undefined ? 'limited' : 'blocked',
          message: gate,
        }
      let page: AutomationPage | undefined
      try {
        page = await open()
        const res = await fn(page)
        absorb(res.verdict)
        if (res.ok) return { ok: true, data: res.data }
        return { ok: false, reason: res.reason, message: res.message }
      } catch (err) {
        return {
          ok: false,
          reason: 'failed',
          message: `官方号浏览器没读到：${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        }
      } finally {
        await page?.close()
        armIdle()
      }
    })
  }

  const port: RedditOfficialBrowserPort = {
    ready: () => state.logged_in && blockedMessage() === undefined,
    readModQueue: (sub, source, _limit) =>
      read((page) =>
        readModQueueOn(
          page,
          {
            json: modQueueJsonUrl(origin, sub, source),
            html: modQueuePageUrl(origin, sub, source),
          },
          source,
          hosts(),
        ),
      ),
    readRules: (sub) => read((page) => readRulesOn(page, rulesJsonUrl(origin, sub), hosts())),
    run: (write: RedditBrowserWrite): Promise<RedditBrowserRunResult> =>
      serial(async () => {
        if (!state.logged_in)
          return { status: 'handover', message: '官方号还没登录（或者登录掉了）。' }
        const gate = writeGate()
        if (gate !== undefined) return { status: 'failed', message: gate }
        state.writes.push(options.nowMs())
        flush()
        let page: AutomationPage | undefined
        try {
          page = await open(planRedditWrite(origin, write))
          const res = await runWriteOn(page, origin, write, hosts())
          absorb(res.verdict)
          if (res.status === 'ok')
            return {
              status: 'ok',
              ...(res.fullname === undefined ? {} : { fullname: res.fullname }),
              ...(res.url === undefined ? {} : { url: res.url }),
            }
          return { status: res.status, message: res.message }
        } catch (err) {
          return {
            status: 'failed',
            message: `官方号浏览器没做成：${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
          }
        } finally {
          await page?.close()
          armIdle()
        }
      }),
  }

  function status(): RedditOfficialBrowserStatus {
    const now = options.nowMs()
    prune(now)
    const base = {
      writes_last_day: state.writes.length,
      max_writes_per_day: limits().writes_per_day,
      ...(state.checked_at === undefined
        ? {}
        : { checked_at: new Date(state.checked_at).toISOString() }),
    }
    const found = find()
    if (!found.ok && options.openPage === undefined)
      return { ...base, state: 'no_browser', message: found.message }
    const browser = found.ok ? { browser: browserName(found.executable) } : {}
    if (state.block !== undefined)
      return {
        ...base,
        ...browser,
        state: 'blocked',
        message: state.block.message,
        until: new Date(state.block.until).toISOString(),
      }
    if (loginWindow && alive() && !state.logged_in)
      return { ...base, ...browser, state: 'login_window_open' }
    if (state.logged_in)
      return {
        ...base,
        ...browser,
        state: 'logged_in',
        ...(state.username === undefined ? {} : { username: state.username }),
      }
    return {
      ...base,
      ...browser,
      state: state.checked_at === undefined ? 'unknown' : 'not_logged_in',
    }
  }

  return {
    status,
    port,
    openLogin: () =>
      serial(async () => {
        if (options.openPage === undefined) {
          if (loginWindow && alive()) return status()
          await stop()
          const found = find()
          if (!found.ok) return status()
          proc = await launch({
            executable: found.executable,
            profileDir,
            platform,
            env,
            mode: options.loginHeadless === true ? 'headless' : 'headed',
            startUrl: loginPageUrl(origin),
          })
          process.once('exit', onExit)
          loginWindow = true
        }
        state.logged_in = false
        flush()
        const s = status()
        return options.openPage === undefined ? s : { ...s, state: 'login_window_open' as const }
      }),
    checkLogin: () =>
      serial(async () => {
        let page: AutomationPage | undefined
        let closeAfter = false
        try {
          page = await open()
          const res = await checkLoginOn(page, loginCheckUrl(origin), hosts())
          state.checked_at = options.nowMs()
          if (res.ok) {
            state.logged_in = true
            if (res.username === undefined) delete state.username
            else state.username = res.username
            // 人在窗口里处理过了：之前记的「被拦」作废
            delete state.block
            // 登好了就把登录窗口收起来（之后读写在无头那一个里做，不再弹窗）；页面在 finally 里先关
            closeAfter = loginWindow
          } else {
            state.logged_in = false
            absorb(res.verdict.wall === 'login' ? undefined : res.verdict)
          }
          flush()
        } catch {
          state.logged_in = false
          state.checked_at = options.nowMs()
          flush()
        } finally {
          await page?.close()
          if (closeAfter) await stop()
          armIdle()
        }
        return status()
      }),
    closeWindow: () => serial(stop),
    close: () => serial(stop),
  }
}
