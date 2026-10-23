/**
 * WP480：选的文件夹是不是在网络盘上（NAS、公司共享盘）——是的话确认框里多说一句「断网时工坊打不开」。
 *
 * - Windows：`\\server\share` 一眼看得出；盘符映射的（`Z:\`）要问系统一句
 *   `[System.IO.DriveInfo]::new('Z').DriveType`，回 `Network` 就是；
 * - macOS：`/Volumes/xxx` 下面的，看 `mount` 里那个挂载点是不是 smbfs / afpfs / nfs / webdav；
 * - 问不到（超时、命令不在）一律当「不是」：这只是一句提示，不拦人。
 */
import { execFile } from 'node:child_process'
import { isUncPath } from './data-location.js'

export type ExecLike = (command: string, args: readonly string[]) => Promise<string>

/** 真跑命令（5 秒超时、不弹窗口）。 */
export const nodeExec: ExecLike = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: 5000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      },
    )
  })

const NETWORK_FS = /\((smbfs|afpfs|nfs|webdav|cifs|smb2|ftp)[,)]/i

/** `mount` 的一行：`//user@nas/share on /Volumes/share (smbfs, nodev, ...)`。 */
export function networkMountFor(path: string, mountOutput: string): boolean {
  let best: { point: string; network: boolean } | undefined
  for (const line of mountOutput.split('\n')) {
    const m = / on (.+?) \(([^)]*)\)/.exec(line)
    if (m === null) continue
    const point = m[1] ?? ''
    if (
      point === '' ||
      !(path === point || path.startsWith(point.endsWith('/') ? point : `${point}/`))
    )
      continue
    if (best === undefined || point.length > best.point.length)
      best = { point, network: NETWORK_FS.test(`(${m[2] ?? ''})`) }
  }
  return best?.network === true
}

export async function driveIsNetwork(
  path: string,
  platform: string,
  exec: ExecLike = nodeExec,
): Promise<boolean> {
  if (isUncPath(path)) return true
  try {
    if (platform === 'win32') {
      const letter = /^([a-zA-Z]):/.exec(path)?.[1]
      if (letter === undefined) return false
      const out = await exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[System.IO.DriveInfo]::new('${letter.toUpperCase()}').DriveType`,
      ])
      return out.trim().toLowerCase() === 'network'
    }
    if (platform === 'darwin' || platform === 'linux') {
      return networkMountFor(path, await exec('mount', []))
    }
    return false
  } catch {
    return false
  }
}
