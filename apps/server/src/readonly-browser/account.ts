/**
 * WP246（Luoye 10-07 定 87 / 88）：Reddit 浏览器备选用的**读号**。
 *
 * Windows 真机上无头、不登录的只读浏览器读 reddit.com 被人机验证拦下；Reddit 没有免登录的路
 * （匿名 `.json` 全 403、官方 API 停止自助申请）。所以浏览器那一路改成：用户**自己在网页上**登录
 * 一个普通号，我们只借这份用户数据目录里的登录态去只读。
 *
 * - 「登录读号」：先停掉自动读取的那个浏览器（这份目录只能有一个浏览器占着），再**有头**打开同一份
 *   目录到 Reddit 登录页。用户在网页上输密码——我们不碰密码、不读 cookie 内容。窗口关掉后自动体检；
 * - 体检：开旧版首页，只读页头显示的用户名（`u/xxx`）；
 * - **不用版主号 / 品牌官方号**（决策 88）：认出来的号是本品牌「登记的号」里的那一个，就拦下、提示换号；
 *   认不出登录的是谁也先不读（宁可这一路不通，也不冒用版主号的风险）；
 * - 自动读取仍只读（驱动层拦一切非 GET、页面脚本关着）、限速与白名单照旧。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RedditReadAccountStatus } from '@agentsws/contracts'
import { normalizeRedditUsername } from '@agentsws/contracts'
import { taskkillPath } from '../kill-tree.js'
import { spawnChrome } from './chrome.js'
import type { Env } from './find-browser.js'
import type { ReadonlyBrowser } from './index.js'

export const REDDIT_LOGIN_URL = 'https://www.reddit.com/login/'
/** 体检开旧版首页：页头的用户名是服务端画的，关着页面脚本也在。 */
export const REDDIT_WHOAMI_URL = 'https://old.reddit.com/'

export const NOT_LOGGED_IN_MESSAGE =
  '还没登录读号：Reddit 不登录基本都会被人机验证拦。点「登录读号」，用一个普通号登录（别用版主号 / 品牌官方号）。'
export const HOLD_MESSAGE = '「登录读号」的窗口还开着：在那里登录好之后把它关掉，我们再读。'

/** 「登录读号」那个给人用的窗口。 */
export interface LoginWindow {
  /** 窗口关了（用户关的、超时关的都算）。 */
  closed: Promise<void>
  /** 我们这边关它（体面地关：让浏览器把登录态写完再退）。 */
  close(): Promise<void>
}

export type LoginWindowLauncher = (input: {
  executable: string
  profileDir: string
  url: string
  platform: NodeJS.Platform
  env: Env
}) => Promise<LoginWindow>

export interface ReadAccountOptions {
  browser: ReadonlyBrowser
  /** 存读号状态（`read-account.json`）的目录；不给 = 只在内存里。 */
  dir?: string
  /** 本品牌「登记的号」（Reddit 那几个：官方号 / 版主号）。读号是其中之一就拦。 */
  brandHandles(): readonly string[]
  nowMs(): number
  platform?: NodeJS.Platform
  env?: Env
  loginUrl?: string
  whoamiUrl?: string
  /** 测试塞替身；默认真起有头浏览器。 */
  openWindow?: LoginWindowLauncher
  /** 登录窗口最多开多久（默认 15 分钟，到点体面地关掉）。 */
  loginTimeoutMs?: number
}

export interface RedditReadAccount {
  status(): RedditReadAccountStatus
  /** 打开「登录读号」窗口（已经开着就原样回）。 */
  openLogin(): Promise<RedditReadAccountStatus>
  /** 体检：读页头上登录的是谁。 */
  check(): Promise<RedditReadAccountStatus>
  /** 自动读取前问一句：这一路现在能不能用读号读。 */
  gate(): { ok: true } | { ok: false; message: string; refused?: boolean }
  close(): Promise<void>
}

const iso = (ms: number): string => new Date(ms).toISOString()

export function createRedditReadAccount(options: ReadAccountOptions): RedditReadAccount {
  const file = options.dir === undefined ? undefined : join(options.dir, 'read-account.json')
  const rb = options.browser
  let state: RedditReadAccountStatus = { state: 'none' }
  if (file !== undefined && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as RedditReadAccountStatus
      if (['none', 'logged_in', 'refused', 'unknown'].includes(raw.state)) state = raw
      // 上次服务进程在登录窗口开着时退了：不知道登没登好，等体检
      else if (raw.state === 'logging_in')
        state = {
          state: 'unknown',
          message: '上次「登录读号」没走完，点「重新体检」看看登好没有。',
        }
    } catch {
      // 坏了就当没登录（宁可这一路不通）
    }
  }
  const save = (next: RedditReadAccountStatus): RedditReadAccountStatus => {
    state = next
    if (file !== undefined && next.state !== 'logging_in') {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(next))
      renameSync(`${file}.tmp`, file)
    }
    return state
  }
  let window: LoginWindow | undefined
  let timer: NodeJS.Timeout | undefined
  const launchWindow = options.openWindow ?? openLoginWindow

  async function check(): Promise<RedditReadAccountStatus> {
    if (state.state === 'logging_in') return state
    const got = await rb.whoami(options.whoamiUrl ?? REDDIT_WHOAMI_URL)
    const at = iso(options.nowMs())
    if (!got.ok) {
      if (got.reason === 'held') return state
      if (got.reason === 'no_browser')
        return save({ ...state, message: got.message, checked_at: at })
      const wall = got.wall === 'captcha' || got.wall === 'blocked'
      return save({
        state: state.state === 'none' ? 'none' : 'unknown',
        ...(state.username === undefined ? {} : { username: state.username }),
        message: wall
          ? '体检那一页要人机验证：点「登录读号」，在打开的窗口里手动过一次验证再关掉。'
          : `没认出登录的是谁：${got.message}`,
        checked_at: at,
      })
    }
    if (got.account === undefined)
      return save({ state: 'none', message: NOT_LOGGED_IN_MESSAGE, checked_at: at })
    const name = normalizeRedditUsername(got.account)
    const brand = new Set(options.brandHandles().map(normalizeRedditUsername))
    if (brand.has(name))
      return save({
        state: 'refused',
        username: name,
        message: `u/${name} 是品牌登记的号（官方号 / 版主号），读取不用它。点「登录读号」，在窗口里退出、换一个普通号。`,
        checked_at: at,
      })
    // 人刚在登录窗口里手动过了验证、读号也认出来了：解除被拦暂停
    rb.usage.unblock()
    return save({ state: 'logged_in', username: name, checked_at: at })
  }

  return {
    status: () => state,
    check,
    gate() {
      if (state.state === 'logged_in') return { ok: true }
      if (state.state === 'logging_in') return { ok: false, message: HOLD_MESSAGE }
      if (state.state === 'refused')
        return {
          ok: false,
          refused: true,
          message: state.message ?? '登录的是品牌登记的号，换一个普通号。',
        }
      if (state.state === 'unknown')
        return {
          ok: false,
          message: `${state.message ?? '认不出登录的是谁'}（为了不误用版主号，认出来之前先不读）`,
        }
      return { ok: false, message: NOT_LOGGED_IN_MESSAGE }
    },
    async openLogin() {
      if (window !== undefined) return state
      const exe = rb.executable()
      if (!exe.ok) return { ...state, message: exe.message }
      await rb.hold(HOLD_MESSAGE)
      try {
        window = await launchWindow({
          executable: exe.executable,
          profileDir: rb.profileDir,
          url: options.loginUrl ?? REDDIT_LOGIN_URL,
          platform: options.platform ?? process.platform,
          env: options.env ?? process.env,
        })
      } catch (err) {
        rb.release()
        return {
          ...state,
          message: `登录窗口没打开：${err instanceof Error ? err.message : String(err)}`,
        }
      }
      const before = state
      state = {
        state: 'logging_in',
        ...(before.username === undefined ? {} : { username: before.username }),
        message: HOLD_MESSAGE,
      }
      const opened = window
      timer = setTimeout(() => void opened.close(), options.loginTimeoutMs ?? 15 * 60_000)
      timer.unref?.()
      void opened.closed.then(async () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        window = undefined
        rb.release()
        state = before
        await check().catch(() => undefined)
      })
      return state
    },
    async close() {
      if (timer !== undefined) clearTimeout(timer)
      await window?.close()
    },
  }
}

/**
 * 默认的登录窗口：有头起浏览器（同一份只读用户数据目录），打开 Reddit 登录页。
 *
 * 怎么知道「关掉了」：Windows / Linux 上关了最后一个窗口浏览器自己退出；mac 上浏览器关了窗口还在跑，
 * 所以隔一会儿问一下本机调试口「还有没有页面」（只问清单、不连进页面，不在登录页上留任何自动化痕迹），
 * 一个都没了就请它体面地退出（SIGTERM / taskkill 不带 /F），让它把登录态写完。
 */
export const openLoginWindow: LoginWindowLauncher = async (input) => {
  const chrome = await spawnChrome({ ...input, mode: 'login' })
  const exited = new Promise<void>((resolve) => {
    if (chrome.child.exitCode !== null || chrome.child.signalCode !== null) resolve()
    else chrome.child.once('exit', () => resolve())
  })
  const gently = (): void => {
    const pid = chrome.child.pid
    if (pid === undefined || chrome.child.exitCode !== null) return
    try {
      // 不带 /F：请它关窗口、自己退（登录态写完）
      if (input.platform === 'win32')
        spawnSync(taskkillPath(input.env), ['/PID', String(pid), '/T'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      else process.kill(pid, 'SIGTERM')
    } catch {
      // 已经退了
    }
  }
  let seenPage = false
  const poll = setInterval(() => {
    void fetch(`${chrome.endpoint}/json/list`, { signal: AbortSignal.timeout(2_000) })
      .then((r) => r.json() as Promise<{ type?: string }[]>)
      .then((targets) => {
        const pages = targets.filter((t) => t.type === 'page').length
        if (pages > 0) seenPage = true
        else if (seenPage) gently()
      })
      .catch(() => undefined)
  }, 1_500)
  poll.unref?.()
  const closed = exited.then(() => {
    clearInterval(poll)
    chrome.forgetPid()
  })
  return {
    closed,
    async close() {
      gently()
      const late = await Promise.race([
        closed.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), 10_000)),
      ])
      if (late) chrome.kill()
      await closed
    },
  }
}
