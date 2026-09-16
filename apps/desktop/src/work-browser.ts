/**
 * 「打开工作用的浏览器」（55 §3 末段，WP82）。
 *
 * 一句话：给用户起**一个单独的 Chrome**，带调试口，然后把地址写进工作台的设置。
 *
 * 三条纪律，每一条都有代价在后面：
 *
 * 1. **单独一个 Profile**（`~/Library/Application Support/agentsws/browser-profile`），
 *    不碰用户日常那个。理由是 55 §3 末段点名的那类事故（ego-lite #319 的跨 Profile
 *    泄漏）：AI 用的浏览器和你收私人邮件的浏览器共用一份 cookie，一次越界就什么
 *    都拿到了。代价是用户要在这个 Profile 里**再登一次**那几个平台——值得。
 * 2. **端口固定 9333**（被占了才往后找）。固定的好处是工作台设置页里那个地址
 *    不会每次都变，用户看一眼就知道是不是同一个；往后找是因为用户可能开了两个。
 * 3. **不自己下载浏览器**。找不到 Chrome 就如实说"没找到，请先装一个"，
 *    不偷偷下几百兆（16 §3 / `allowBuilds` 里 playwright 那两行同一条纪律）。
 *
 * 这个模块只依赖 `./ports.js` 的注入口，不 import `electron`——所以能在 vitest 里
 * 跑满覆盖（同 `menu.ts` / `sidecar.ts`）。
 */
import { join } from 'node:path'
import type { FetchLike, FileStore, Spawner } from './ports.js'

/** 工作用浏览器的首选调试端口（工作台设置页的默认值也是它）。 */
export const WORK_BROWSER_PORT = 9333
/** 被占了就往后找，最多找这么多个。 */
const PORT_ATTEMPTS = 4
/** 起完之后等它把调试口开起来，总共最多等这么久。 */
export const WORK_BROWSER_READY_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 250

/**
 * 各平台上 Chrome / Chromium / Edge 的常见位置（按优先级）。
 *
 * 为什么连 Edge 也找：它也是 Chromium，CDP 一模一样；Windows 上很多人只有 Edge。
 * 找不到任何一个就如实说——不去下载。
 */
export function candidateExecutables(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  if (platform === 'win32') {
    const program = process.env.PROGRAMFILES ?? 'C:\\Program Files'
    const x86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA ?? ''
    return [
      `${program}\\Google\\Chrome\\Application\\chrome.exe`,
      `${x86}\\Google\\Chrome\\Application\\chrome.exe`,
      ...(local === '' ? [] : [`${local}\\Google\\Chrome\\Application\\chrome.exe`]),
      `${program}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${x86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ]
}

export interface WorkBrowserPorts {
  files: FileStore
  spawner: Spawner
  fetch: FetchLike
  /** 单独 Profile 放哪（`app.getPath('userData')` 那一级）。 */
  userDataDir: string
  platform: NodeJS.Platform
  /** 等一会儿（测试注入一个立即返回的）。 */
  sleep(ms: number): Promise<void>
  now(): number
  /** 用户在设置里指了路径就用它（不猜）。 */
  executablePath?: string
}

export type WorkBrowserResult =
  | { ok: true; endpoint: string; executable: string; profileDir: string; reused: boolean }
  | { ok: false; reason: 'no_chrome' | 'no_port' | 'not_ready'; detail: string }

/** AI 用的那个 Profile 放哪。与用户日常那个**没有任何共享**。 */
export function workProfileDir(userDataDir: string): string {
  return join(userDataDir, 'browser-profile')
}

/** 这个端口上是不是已经有一个开着调试口的浏览器。 */
async function debugPortLive(fetchLike: FetchLike, port: number): Promise<boolean> {
  try {
    const res = await fetchLike(`http://127.0.0.1:${port}/json/version`)
    return res.ok
  } catch {
    return false
  }
}

/**
 * 起（或复用）工作用的浏览器，返回它的 CDP 地址。
 *
 * **已经有一个开着就复用**（`reused: true`）：用户点第二次不该冒出第二个窗口，
 * 而且 attach 模式本来就是一次一个（55 §3「一 Session 一浏览器」）。
 */
export async function openWorkBrowser(ports: WorkBrowserPorts): Promise<WorkBrowserResult> {
  // 1. 已经有一个开着就直接用它
  for (let i = 0; i < PORT_ATTEMPTS; i += 1) {
    const port = WORK_BROWSER_PORT + i
    if (await debugPortLive(ports.fetch, port)) {
      return {
        ok: true,
        endpoint: `http://127.0.0.1:${port}`,
        executable: ports.executablePath ?? '',
        profileDir: workProfileDir(ports.userDataDir),
        reused: true,
      }
    }
  }

  // 2. 找一个 Chrome
  const executable =
    ports.executablePath !== undefined && ports.executablePath !== ''
      ? ports.executablePath
      : candidateExecutables(ports.platform).find((p) => ports.files.exists(p))
  if (executable === undefined || !ports.files.exists(executable)) {
    return {
      ok: false,
      reason: 'no_chrome',
      detail:
        '这台电脑上没找到 Chrome / Chromium。请先装一个（我们不替你下载浏览器），' +
        '或者在工作台的「设置 → 浏览器」里手填一个可执行文件路径。',
    }
  }

  // 3. 起它。**单独的 user-data-dir**，不碰你日常那个 Profile。
  const profileDir = workProfileDir(ports.userDataDir)
  ports.files.ensureDir(profileDir)
  const port = WORK_BROWSER_PORT
  ports.spawner.spawn({
    command: executable,
    args: [
      `--remote-debugging-port=${port}`,
      // 调试口只听回环：别的机器连不上你的浏览器
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      // 没有这一条时 Chrome 会把新窗口交给**已经在跑的那个实例**，
      // 于是 `--user-data-dir` 与调试口双双失效——AI 就接到你日常那个浏览器上了。
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    env: {},
  })

  // 4. 等它把调试口开起来
  const deadline = ports.now() + WORK_BROWSER_READY_TIMEOUT_MS
  while (ports.now() < deadline) {
    if (await debugPortLive(ports.fetch, port)) {
      return {
        ok: true,
        endpoint: `http://127.0.0.1:${port}`,
        executable,
        profileDir,
        reused: false,
      }
    }
    await ports.sleep(POLL_INTERVAL_MS)
  }
  return {
    ok: false,
    reason: 'not_ready',
    detail: `浏览器起来了，但 ${WORK_BROWSER_READY_TIMEOUT_MS / 1000} 秒内没有开出调试口（端口 ${port} 可能被别的程序占了）。`,
  }
}
