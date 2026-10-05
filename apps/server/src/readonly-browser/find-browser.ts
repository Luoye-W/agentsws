/**
 * WP228：找用户电脑上**已经装好的** Chrome / Edge / Chromium。**不打包、不下载浏览器**
 * （记忆「不打包重型本机方案」；16 §3）——找不到就照实说「没找到」+ 一句怎么办。
 *
 * 位置表与桌面壳「工作用的浏览器」（`apps/desktop/src/work-browser.ts`）同一份思路，多了几处
 * Windows 的写法（`ProgramW6432`、按用户装的 Edge）。Windows 一定有 Edge，所以 Windows 上
 * 几乎不会落到「没找到」。路径里有中文 / 空格没关系：起进程时按参数数组传，不经 shell。
 */
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export type Env = Readonly<Record<string, string | undefined>>

/** 各平台的候选位置（按优先级：Chrome → Chromium → Edge）。 */
export function browserCandidates(platform: NodeJS.Platform, env: Env): string[] {
  if (platform === 'darwin') {
    const home = env.HOME ?? ''
    const apps = ['/Applications', ...(home === '' ? [] : [`${home}/Applications`])]
    return apps.flatMap((dir) => [
      `${dir}/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `${dir}/Chromium.app/Contents/MacOS/Chromium`,
      `${dir}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
    ])
  }
  if (platform === 'win32') {
    const roots = [
      env.PROGRAMFILES ?? env.ProgramFiles ?? 'C:\\Program Files',
      env.ProgramW6432,
      env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      env.LOCALAPPDATA,
    ].filter((r): r is string => r !== undefined && r !== '')
    const uniq = [...new Set(roots)]
    return [
      ...uniq.map((r) => win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...uniq.map((r) => win32.join(r, 'Chromium', 'Application', 'chrome.exe')),
      ...uniq.map((r) => win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ]
}

export type FoundBrowser =
  | { ok: true; executable: string }
  | { ok: false; reason: 'no_browser'; message: string }

/** 没找到时那一句（连接页的提示也用它）。 */
export const NO_BROWSER_MESSAGE =
  '这台电脑上没找到 Chrome 或 Edge。装一个 Chrome（或 Edge）就能用；我们不替你下载浏览器。'

/** 找一个能用的浏览器。用户在设置里指了路径就只认它（不猜）。 */
export function findBrowser(
  options: {
    platform?: NodeJS.Platform
    env?: Env
    exists?: (path: string) => boolean
    /** 用户指定的可执行文件。 */
    preferred?: string | undefined
  } = {},
): FoundBrowser {
  const exists = options.exists ?? existsSync
  const preferred = options.preferred?.trim()
  if (preferred !== undefined && preferred !== '') {
    return exists(preferred)
      ? { ok: true, executable: preferred }
      : {
          ok: false,
          reason: 'no_browser',
          message: `设置里指定的浏览器不在了：${preferred}`,
        }
  }
  const found = browserCandidates(
    options.platform ?? process.platform,
    options.env ?? process.env,
  ).find((p) => exists(p))
  return found === undefined
    ? { ok: false, reason: 'no_browser', message: NO_BROWSER_MESSAGE }
    : { ok: true, executable: found }
}
