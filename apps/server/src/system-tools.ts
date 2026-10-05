/**
 * WP218：调系统自带的命令行工具时写全路径。
 *
 * Windows 10 1803 起 `%SystemRoot%\System32\tar.exe`（bsdtar）认 zip 也认 tar.gz；但 PATH 上要是
 * 先找到 Git for Windows 带的 GNU tar，它不认 zip，还会把 `C:` 当成远程主机名——解包就失败。
 */
import { win32 } from 'node:path'

export function systemTar(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): string {
  if (platform !== 'win32') return 'tar'
  return win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'tar.exe')
}
