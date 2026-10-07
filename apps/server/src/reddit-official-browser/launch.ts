/**
 * WP249（决策 89）：起「Reddit 官方号浏览器」——用户电脑上已装的 Chrome / Edge，**每品牌一个独立的
 * 用户数据目录**（与 WP228 / WP246 的只读读号目录分开，登录态互不串）。
 *
 * 两种起法，同一个目录：
 *
 * - **有头**（「登录官方号」）：开一个看得见的窗口到登录页，用户自己在网页上登录。我们不碰密码、
 *   不读 cookie 内容——登录态只活在这个目录里，由浏览器自己存。
 * - **无头**（读队列、执行审批过的动作）：同一个目录、同一份登录态，看不见窗口。登录窗口开着的时候
 *   不另起，直接在那个窗口里开一个新标签页做（看得见它在点什么）。
 *
 * 复用 WP228 的公共件：找浏览器、环境变量白名单、收孤儿进程、按进程树结束。参数与只读那一份的差别只有：
 * 有头时不加 `--headless`、不关图片（登录页的人机验证要图片）。同样**没有**任何「藏自动化」「伪装 UA」
 * 的开关——被 Reddit 拦了就停下来让人处理，不绕。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { killTree, taskkillPath } from '../kill-tree.js'
import { browserEnv, killOrphan } from '../readonly-browser/chrome.js'
import type { Env } from '../readonly-browser/find-browser.js'

export type LaunchMode = 'headed' | 'headless'

export function officialChromeArgs(
  profileDir: string,
  platform: NodeJS.Platform,
  mode: LaunchMode,
  startUrl: string,
): string[] {
  return [
    ...(mode === 'headless' ? ['--headless=new', '--blink-settings=imagesEnabled=false'] : []),
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--mute-audio',
    // 两种起法同一个口径存登录态（不然有头存的 cookie 无头解不开）
    '--password-store=basic',
    ...(platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(platform === 'win32' && mode === 'headless' ? ['--disable-gpu'] : []),
    startUrl,
  ]
}

const PID_FILE = 'agentsws-browser.pid'

export interface OfficialBrowserProcess {
  mode: LaunchMode
  child: ChildProcess
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>
  /** 这个进程还活着吗（用户关了登录窗口 = 不活了）。 */
  alive(): boolean
  close(): Promise<void>
  killNow(): void
}

export type OfficialLauncher = (input: {
  executable: string
  profileDir: string
  platform: NodeJS.Platform
  env: Env
  mode: LaunchMode
  startUrl: string
}) => Promise<OfficialBrowserProcess>

const killGroup = (pid: number): void => {
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {}
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

/** 默认的起法：自己起进程，`playwright-core` 经 CDP 连上去。 */
export const launchOfficialBrowser: OfficialLauncher = async (input) => {
  const { executable, profileDir, platform, env, mode } = input
  mkdirSync(profileDir, { recursive: true })
  killOrphan(profileDir, executable, platform, env)
  const portFile = join(profileDir, 'DevToolsActivePort')
  if (existsSync(portFile)) unlinkSync(portFile)
  const child = spawn(executable, officialChromeArgs(profileDir, platform, mode, input.startUrl), {
    stdio: 'ignore',
    windowsHide: mode === 'headless',
    detached: platform !== 'win32',
    env: browserEnv(env),
  })
  let exited = false
  let spawnError: Error | undefined
  child.on('exit', () => {
    exited = true
  })
  child.on('error', (err) => {
    spawnError = err
    exited = true
  })
  const pidFile = join(profileDir, PID_FILE)
  if (platform === 'win32' && child.pid !== undefined) writeFileSync(pidFile, String(child.pid))
  const killNow = (): void => {
    if (child.pid === undefined) return
    if (platform !== 'win32') {
      killGroup(child.pid)
      return
    }
    if (child.exitCode !== null) return
    spawnSync(taskkillPath(env), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  }
  const deadline = Date.now() + 20_000
  let endpoint: string | undefined
  while (Date.now() < deadline && !exited && endpoint === undefined) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split(/\r?\n/u)[0]?.trim()
      if (port !== undefined && /^\d+$/u.test(port)) endpoint = `http://127.0.0.1:${port}`
    }
    if (endpoint === undefined) await new Promise((r) => setTimeout(r, 100))
  }
  if (endpoint === undefined) {
    killNow()
    throw new Error(
      spawnError !== undefined
        ? `浏览器起不来：${spawnError.message}`
        : exited
          ? '浏览器一起来就退出了（可能这份官方号目录被别的浏览器窗口占着——先关掉那个窗口）。'
          : '浏览器起来了，但调试口一直没开好。',
    )
  }
  let browser: OfficialBrowserProcess['browser']
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 })
  } catch (err) {
    killNow()
    throw new Error(`连不上起好的浏览器：${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    mode,
    child,
    browser,
    alive: () => !exited && browser.isConnected(),
    killNow,
    async close() {
      const done = new Promise<void>((resolve) => {
        if (exited) resolve()
        else child.once('exit', () => resolve())
      })
      try {
        const cdp = await browser.newBrowserCDPSession()
        await cdp.send('Browser.close').catch(() => undefined)
      } catch {}
      const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3_000))
      if ((await Promise.race([done.then(() => 'exited' as const), timer])) === 'timeout') {
        if (platform === 'win32') killTree(child, { platform, env, signal: 'SIGKILL' })
        else killNow()
        await Promise.race([done, new Promise((r) => setTimeout(r, 3_000))])
      }
      await browser.close().catch(() => undefined)
      if (platform !== 'win32') killNow()
      if (existsSync(pidFile)) unlinkSync(pidFile)
    },
  }
}
