/**
 * WP184（docs/79 §9）：用户**自己装的**官方 DeepSeek Harness 桌面端——认得出、点得开。
 *
 * 我们不装它、不下载它、不改它的数据（它用 `~/.dsh`，和工坊里的官方场景是两份）；
 * 只看本机有没有，有就在场景列表多一行，点了把它启动起来。
 *
 * 事实出处（`deepseek-ai/deepseek-harness@4878cdab`，MIT，只读核对）：
 * - `apps/desktop/scripts/electron-builder-config.mjs`：`productName: 'DeepSeek Harness'`、
 *   `protocols: [{ schemes: ['dsh'] }]`、NSIS `oneClick: false` + `perMachine: false`
 *   → electron-builder 的按用户安装目录 `%LOCALAPPDATA%\Programs\DeepSeek Harness`
 *   （`getWindowsInstallationDirName`：非一键安装且产品名只含字母数字空格时用产品名）。
 * - `apps/desktop/src/main.ts`：打包版 `app.setAsDefaultProtocolClient('dsh')`；
 *   `open-url` 收到 `dsh://open` 就把主窗口端出来（没开就启动）。
 *
 * 这个文件只放事实与纯判断；读文件、查注册表、起进程都由调用方注入。
 */
import { posix, win32 } from 'node:path'

export const OFFICIAL_DESKTOP_PRODUCT = 'DeepSeek Harness'
export const OFFICIAL_DESKTOP_PROTOCOL = 'dsh'
/** 官方桌面端认的「把窗口端出来」的地址。 */
export const OFFICIAL_DESKTOP_OPEN_URL = 'dsh://open'
/** Windows 上 `dsh://` 协议的注册位置（按用户安装写在 HKCU）。 */
export const OFFICIAL_DESKTOP_REGISTRY_KEY = 'HKCU\\Software\\Classes\\dsh\\shell\\open\\command'
const EXE_NAME = `${OFFICIAL_DESKTOP_PRODUCT}.exe`
const APP_NAME = `${OFFICIAL_DESKTOP_PRODUCT}.app`

export interface OfficialDesktopInstall {
  /** macOS：`.app` 目录；Windows：`DeepSeek Harness.exe` 的路径。 */
  app: string
  /** 系统里 `dsh://` 协议归它（点开就走 `dsh://open`）。 */
  protocol: boolean
}

export interface OfficialDesktopPlaces {
  platform: string
  home: string
  env: Readonly<Record<string, string | undefined>>
}

/** 常见安装位置（按顺序找，找到第一个就算）。 */
export function officialDesktopCandidates(input: OfficialDesktopPlaces): string[] {
  if (input.platform === 'darwin')
    return [posix.join('/Applications', APP_NAME), posix.join(input.home, 'Applications', APP_NAME)]
  if (input.platform === 'win32') {
    const out: string[] = []
    const local = input.env.LOCALAPPDATA ?? win32.join(input.home, 'AppData', 'Local')
    out.push(win32.join(local, 'Programs', OFFICIAL_DESKTOP_PRODUCT, EXE_NAME))
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
      const dir = input.env[key]
      if (dir !== undefined && dir !== '')
        out.push(win32.join(dir, OFFICIAL_DESKTOP_PRODUCT, EXE_NAME))
    }
    return out
  }
  return []
}

/** `Info.plist`（electron-builder 写的是 XML）里 `CFBundleURLSchemes` 有没有 `dsh`。 */
export function plistDeclaresScheme(plist: string, scheme = OFFICIAL_DESKTOP_PROTOCOL): boolean {
  const at = plist.indexOf('<key>CFBundleURLSchemes</key>')
  if (at < 0) return false
  const array = /<array>([\s\S]*?)<\/array>/.exec(plist.slice(at))
  return array?.[1]?.includes(`<string>${scheme}</string>`) === true
}

/** `reg query` 的输出 → 默认值那一行的数据（`(Default)` / `(默认)` 都认：取 `REG_SZ` 后面那段）。 */
export function parseRegQuery(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /\s+REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line)
    if (m?.[1] !== undefined) return m[1].trim()
  }
  return undefined
}

/** 协议的打开命令 `"C:\…\DeepSeek Harness.exe" "%1"` → exe 路径。 */
export function exeFromProtocolCommand(command: string): string | undefined {
  const quoted = /^"([^"]+\.exe)"/i.exec(command.trim())
  if (quoted?.[1] !== undefined) return quoted[1]
  const bare = /^(\S+\.exe)\b/i.exec(command.trim())
  return bare?.[1]
}

export interface DetectOfficialDesktopDeps extends OfficialDesktopPlaces {
  exists(path: string): boolean
  readText(path: string): string | undefined
  /** 只在 Windows 用：`reg query <key> /ve` 的原始输出；查不到回 `undefined`。 */
  queryRegistry?(key: string): Promise<string | undefined>
}

/**
 * 本机有没有装官方桌面端。
 *
 * - macOS：`/Applications` 或 `~/Applications` 里的 `DeepSeek Harness.app`；它的 `Info.plist`
 *   声明了 `dsh` 协议就走 `dsh://open`。
 * - Windows：先看注册表里 `dsh://` 归谁——**只认文件名是 `DeepSeek Harness.exe` 的**
 *   （别的程序抢了这个协议就不算），再看常见安装路径。
 * - 其他系统：官方只发 macOS / Windows 包，不找。
 */
export async function detectOfficialDesktop(
  deps: DetectOfficialDesktopDeps,
): Promise<OfficialDesktopInstall | undefined> {
  if (deps.platform === 'darwin') {
    const app = officialDesktopCandidates(deps).find((p) => deps.exists(p))
    if (app === undefined) return undefined
    const plist = deps.readText(posix.join(app, 'Contents', 'Info.plist'))
    return { app, protocol: plist !== undefined && plistDeclaresScheme(plist) }
  }
  if (deps.platform === 'win32') {
    const raw = await deps.queryRegistry?.(OFFICIAL_DESKTOP_REGISTRY_KEY).catch(() => undefined)
    const command = raw === undefined ? undefined : parseRegQuery(raw)
    const registered = command === undefined ? undefined : exeFromProtocolCommand(command)
    if (
      registered !== undefined &&
      win32.basename(registered).toLowerCase() === EXE_NAME.toLowerCase() &&
      deps.exists(registered)
    )
      return { app: registered, protocol: true }
    const app = officialDesktopCandidates(deps).find((p) => deps.exists(p))
    return app === undefined ? undefined : { app, protocol: false }
  }
  return undefined
}

/**
 * 启动它的命令。macOS 用系统的 `open`（协议在就 `open dsh://open`，否则 `open <.app>`）；
 * Windows 直接起那个 exe（它自己是单实例：已经开着就把窗口端出来）。
 */
export function officialDesktopLaunch(
  install: OfficialDesktopInstall,
  platform: string,
): { command: string; args: string[] } {
  if (platform === 'darwin')
    return { command: 'open', args: [install.protocol ? OFFICIAL_DESKTOP_OPEN_URL : install.app] }
  return { command: install.app, args: [] }
}
