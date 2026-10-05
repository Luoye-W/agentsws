/**
 * WP218：结束一个子进程**连同它的子孙**。
 *
 * Windows 上没有 SIGTERM：`child.kill()` 就是 TerminateProcess，只杀这一个进程，
 * 而它自己起的子进程（dsh 场景里的终端、工具进程）会变成孤儿继续跑——占着端口、
 * 锁着安装目录里的 `node.exe` 与原生模块，下一次更新 / 卸载就会「文件被占用」。
 * 所以 Windows 上改用系统自带的 `taskkill /T /F` 按进程树结束；其他平台照旧发信号。
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type RunDetached = (command: string, args: string[]) => void

/** `%SystemRoot%\System32\taskkill.exe`——写全路径，不靠 PATH（PATH 上可能先找到别的东西）。 */
export function taskkillPath(env: Readonly<Record<string, string | undefined>>): string {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  return win32.join(root, 'System32', 'taskkill.exe')
}

const runDetached: RunDetached = (command, args) => {
  const proc = spawn(command, args, { stdio: 'ignore', windowsHide: true })
  proc.on('error', () => undefined)
}

export interface KillTreeOptions {
  platform?: string
  env?: Readonly<Record<string, string | undefined>>
  run?: RunDetached
  /** 非 Windows：发哪个信号（默认 SIGTERM，升级时 SIGKILL）。 */
  signal?: NodeJS.Signals
}

export function killTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  options: KillTreeOptions = {},
): void {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || child.pid === undefined) {
    child.kill(options.signal ?? 'SIGTERM')
    return
  }
  ;(options.run ?? runDetached)(taskkillPath(options.env ?? process.env), [
    '/PID',
    String(child.pid),
    '/T',
    '/F',
  ])
}

/**
 * WP218：这个模块是不是被当作进程入口执行的。原来只比 `import.meta.url` 与 `argv[1]` 的 URL，
 * Windows 上 `argv[1]` 可能是 8.3 短名（`C:\\Users\\ZHANGS~1\\…`，中文用户名常见）或盘符大小写不同，
 * 一比不等服务进程就**什么都不做直接退出 0**，桌面壳按退避一遍遍重启。所以再按真实路径比一次。
 */
export function isEntry(
  argv1: string,
  moduleUrl: string,
  realpath: (p: string) => string = realpathSync.native,
  platform: string = process.platform,
): boolean {
  if (moduleUrl === pathToFileURL(argv1).href) return true
  try {
    const a = realpath(argv1)
    const b = realpath(fileURLToPath(moduleUrl))
    return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}
