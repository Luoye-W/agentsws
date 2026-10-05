/**
 * WP228：把用户电脑上的 Chrome / Edge **无头**起起来，经 CDP 用 `playwright-core` 驱动。
 *
 * - 驱动库：`playwright-core`（不带浏览器、没有安装脚本）。它本来就在安装包里（官方浏览器
 *   提供方 `@playwright/mcp` 拖进来的同一版），所以钉同一版、安装包不变大；评估见 WP228 报告。
 * - 进程我们自己起（不用 Playwright 的 launch）：环境变量走白名单（密钥不传）、`windowsHide`、
 *   参数按数组传（中文 / 空格路径不经 shell）、退出按进程树结束（WP218 那套 `taskkill /T /F`）。
 * - 单独的用户数据目录（每品牌一份），不带任何登录态、不导入你浏览器的 cookie；每次读页面再开一个
 *   一次性的上下文（关掉就什么都不留）。不伪装 UA、不加任何「藏自动化」的参数——被拦就停。
 * - 调试口只听本机回环、端口随机（`--remote-debugging-port=0`，Chrome 把端口写进
 *   `DevToolsActivePort`）。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { killTree, taskkillPath } from '../kill-tree.js'
import type { Env } from './find-browser.js'

/** 给浏览器的环境变量白名单（值来自本进程；密钥类一律不传）。 */
export const BROWSER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'XDG_RUNTIME_DIR',
  // WP218：Windows 上 Chrome 缺了这些，网络、加密、Profile 一起出毛病
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'COMPUTERNAME',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  // 系统代理（国内网络常见）
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
] as const

export function browserEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of BROWSER_ENV_ALLOWLIST) {
    const v = env[k]
    if (v !== undefined && v !== '') out[k] = v
  }
  return out
}

/** 起浏览器的参数。没有任何「藏自动化」「伪装」的开关。 */
export function chromeArgs(profileDir: string, platform: NodeJS.Platform): string[] {
  return [
    '--headless=new',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--blink-settings=imagesEnabled=false',
    '--mute-audio',
    '--password-store=basic',
    ...(platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(platform === 'win32' ? ['--disable-gpu'] : []),
    'about:blank',
  ]
}

const PID_FILE = 'agentsws-browser.pid'

/**
 * mac / Linux：浏览器按**进程组**起（`detached`），结束时整组一起杀——主进程被强杀后，
 * 网络 / 渲染那几个辅助进程有时要好几秒才自己退（本机满负载实测抓到过），按组杀不等它们。
 */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    // 不是组长（不是我们按组起的）：退回只杀它自己
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经没了
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 上一次没关干净（服务进程被强杀）留下的那个浏览器：还占着**我们这份**用户数据目录的话先结束它，
 * 不然新起的会把活转交给它然后自己退出。只认得出是我们的才动：
 * mac / Linux 看 Chrome 自己写的 `SingletonLock`（`主机名-pid`）；Windows 看我们记的 pid 文件，
 * 再用 `tasklist` 核对映像名是不是那个浏览器（防 pid 被别的程序复用）。
 */
export function killOrphan(
  profileDir: string,
  executable: string,
  platform: NodeJS.Platform,
  env: Env,
): number | undefined {
  let pid: number | undefined
  if (platform === 'win32') {
    try {
      pid = Number(readFileSync(join(profileDir, PID_FILE), 'utf8').trim())
    } catch {
      return undefined
    }
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
    const out = spawnSync(
      `${root}\\System32\\tasklist.exe`,
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, encoding: 'utf8' },
    )
    const image = basename(executable).toLowerCase()
    if (!(out.stdout ?? '').toLowerCase().includes(`"${image}"`)) return undefined
    spawnSync(taskkillPath(env), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return pid
  }
  try {
    const target = readlinkSync(join(profileDir, 'SingletonLock'))
    pid = Number(target.slice(target.lastIndexOf('-') + 1))
  } catch {
    return undefined
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid)) return undefined
  killGroup(pid)
  return pid
}

export interface SpawnedChrome {
  child: ChildProcess
  /** CDP 地址（`http://127.0.0.1:<端口>`）。 */
  endpoint: string
  /** 同步结束整棵进程树（进程退出的最后一刻用）。 */
  killNow(): void
  /** 结束整棵进程树（不等）。 */
  kill(): void
  forgetPid(): void
}

/** 起浏览器并等它把调试口开好。起不来就抛一句人话。 */
export async function spawnChrome(input: {
  executable: string
  profileDir: string
  platform: NodeJS.Platform
  env: Env
  readyTimeoutMs?: number
}): Promise<SpawnedChrome> {
  const { executable, profileDir, platform, env } = input
  mkdirSync(profileDir, { recursive: true })
  killOrphan(profileDir, executable, platform, env)
  const portFile = join(profileDir, 'DevToolsActivePort')
  if (existsSync(portFile)) unlinkSync(portFile)
  const child = spawn(executable, chromeArgs(profileDir, platform), {
    stdio: 'ignore',
    windowsHide: true,
    // mac / Linux 自成一个进程组（见 killGroup）；Windows 用 taskkill /T 按树结束
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
      // 主进程退了也扫一遍这一组（辅助进程可能还在）
      killGroup(child.pid)
      return
    }
    if (child.exitCode !== null) return
    spawnSync(taskkillPath(env), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  }
  const deadline = Date.now() + (input.readyTimeoutMs ?? 20_000)
  while (Date.now() < deadline && !exited) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split(/\r?\n/u)[0]?.trim()
      if (port !== undefined && /^\d+$/u.test(port))
        return {
          child,
          endpoint: `http://127.0.0.1:${port}`,
          killNow,
          kill: () =>
            platform === 'win32'
              ? killTree(child, { platform, env, signal: 'SIGKILL' })
              : killNow(),
          forgetPid: () => {
            if (existsSync(pidFile)) unlinkSync(pidFile)
          },
        }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  killNow()
  throw new Error(
    spawnError !== undefined
      ? `浏览器起不来：${spawnError.message}`
      : exited
        ? '浏览器一起来就退出了（可能这份只读用户数据目录被别的浏览器占着）。'
        : '浏览器起来了，但调试口一直没开好。',
  )
}
