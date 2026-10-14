/** WP327：Windows 安装器条目清单、e2e 改更新源、装好的 exe 在哪（纯函数；真跑在 CI 的 windows-latest 上）。 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appEntriesNsh } from '../scripts/after-pack.mjs'
import { installedExe } from '../scripts/win-install-smoke.mjs'
import { patchAppUpdateYml } from '../scripts/win-update-e2e.mjs'

describe('WP327 Windows 脚本', () => {
  it('安装器挪进版本目录的条目：每个条目展开一次，排好序；current / app-* / 带引号的名字直接拒', () => {
    const nsh = appEntriesNsh(['resources', 'agentsws.exe', 'locales'])
    expect(nsh).toContain('!macro agentswsAppEntries CMD')
    expect(nsh.split('\r\n').filter((l) => l.includes('!insertmacro'))).toEqual([
      '  !insertmacro $' + '{CMD} "agentsws.exe"',
      '  !insertmacro $' + '{CMD} "locales"',
      '  !insertmacro $' + '{CMD} "resources"',
    ])
    expect(() => appEntriesNsh(['current'])).toThrow()
    expect(() => appEntriesNsh(['app-1.0.0'])).toThrow()
    expect(() => appEntriesNsh(['a"b'])).toThrow()
  })

  it('e2e 把老版本的更新源改指本机（没有 url 行就补一行）', () => {
    const yml = 'provider: generic\nurl: https://dl.agentsws.com/beta\nupdaterCacheDirName: x\n'
    expect(patchAppUpdateYml(yml, 'http://127.0.0.1:1/beta')).toBe(
      'provider: generic\nurl: http://127.0.0.1:1/beta\nupdaterCacheDirName: x\n',
    )
    expect(patchAppUpdateYml('provider: generic\n', 'http://x')).toBe(
      'provider: generic\nurl: http://x\n',
    )
  })

  it('装好的 exe：有 current 联接用它，没有就是平铺的根上那个', () => {
    expect(installedExe('D', (p: string) => p === join('D', 'current', 'agentsws.exe'))).toBe(
      join('D', 'current', 'agentsws.exe'),
    )
    expect(installedExe('D', () => false)).toBe(join('D', 'agentsws.exe'))
  })
})
