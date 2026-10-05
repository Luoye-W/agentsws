/** WP218：Windows 上按进程树结束子进程；入口判定认真实路径（8.3 短名 / 盘符大小写）。 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { isEntry, killTree, taskkillPath } from '../src/kill-tree.js'

describe('killTree', () => {
  it('Windows：taskkill /T /F 按进程树结束，不发信号', () => {
    const kill = vi.fn()
    const run = vi.fn()
    killTree({ pid: 4242, kill }, { platform: 'win32', env: { SystemRoot: 'D:\\Win' }, run })
    expect(run).toHaveBeenCalledWith('D:\\Win\\System32\\taskkill.exe', [
      '/PID',
      '4242',
      '/T',
      '/F',
    ])
    expect(kill).not.toHaveBeenCalled()
  })

  it('其他平台照旧发信号；Windows 上没有 pid 也只能发信号', () => {
    const kill = vi.fn()
    killTree({ pid: 1, kill }, { platform: 'darwin' })
    killTree({ pid: 1, kill }, { platform: 'linux', signal: 'SIGKILL' })
    killTree({ pid: undefined, kill }, { platform: 'win32' })
    expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGTERM']])
  })

  it('taskkill 路径：SystemRoot → windir → 默认', () => {
    expect(taskkillPath({ windir: 'E:\\W' })).toBe('E:\\W\\System32\\taskkill.exe')
    expect(taskkillPath({})).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it('默认的 run 真起一个进程（起不来也不抛）', () => {
    const kill = vi.fn()
    expect(() => {
      killTree({ pid: 999_999, kill }, { platform: 'win32', env: { SystemRoot: '/nonexistent' } })
    }).not.toThrow()
  })
})

describe('isEntry', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentsws-entry-')))
  const file = join(dir, 'index.js')
  writeFileSync(file, '')

  it('URL 一样就是', () => {
    expect(isEntry(file, pathToFileURL(file).href)).toBe(true)
  })

  it('URL 不一样但真实路径一样（短名 / 符号链接）也是', () => {
    const realpath = (p: string): string => (p === 'C:\\Users\\ZHANGS~1\\index.js' ? file : p)
    expect(isEntry('C:\\Users\\ZHANGS~1\\index.js', pathToFileURL(file).href, realpath)).toBe(true)
  })

  it('Windows 上盘符大小写不同也是', () => {
    const realpath = (p: string): string => p
    expect(isEntry('/a/x/i.js', 'file:///a/X/i.js', realpath, 'win32')).toBe(true)
    expect(isEntry('/a/x/i.js', 'file:///a/X/i.js', realpath, 'darwin')).toBe(false)
  })

  it('被 import（argv[1] 是别的文件 / 不存在）就不是', () => {
    expect(isEntry(join(dir, 'nope.js'), pathToFileURL(file).href)).toBe(false)
  })
})
