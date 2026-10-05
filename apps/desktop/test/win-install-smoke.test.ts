/** WP218：Windows 装起来真跑那个脚本里的纯函数（真跑只在 CI 的 windows-latest 上）。 */
import { describe, expect, it } from 'vitest'
import {
  exposedListeners,
  installerArgs,
  isLoopback,
  longestPaths,
  processesUnder,
} from '../scripts/win-install-smoke.mjs'

describe('win-install-smoke 纯函数', () => {
  it('最长路径排前面', () => {
    const list = () => ['C:\\a\\b', 'C:\\a\\bbbbbbb', 'C:\\a']
    expect(longestPaths('C:\\a', 2, list)).toEqual([
      { path: 'C:\\a\\bbbbbbb', length: 12 },
      { path: 'C:\\a\\b', length: 6 },
    ])
  })

  it('只认本机回环', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback('::')).toBe(false)
  })

  it('PowerShell JSON：一条是对象、多条是数组、没有是空串', () => {
    expect(exposedListeners('')).toEqual([])
    expect(
      exposedListeners('{"LocalAddress":"127.0.0.1","LocalPort":4317,"OwningProcess":9}'),
    ).toEqual([])
    expect(
      exposedListeners(
        '[{"LocalAddress":"0.0.0.0","LocalPort":5353,"OwningProcess":9},{"LocalAddress":"::1","LocalPort":1,"OwningProcess":9}]',
      ),
    ).toEqual(['0.0.0.0:5353（pid 9）'])
  })

  it('安装目录里的进程（不分大小写）', () => {
    const json = JSON.stringify([
      {
        ProcessId: 1,
        ExecutablePath: 'C:\\Users\\X\\AppData\\Local\\Programs\\智能体 工坊\\agentsws.exe',
      },
      {
        ProcessId: 2,
        ExecutablePath:
          'c:\\users\\x\\appdata\\local\\programs\\智能体 工坊\\resources\\node\\node.exe',
      },
      { ProcessId: 3, ExecutablePath: 'C:\\Windows\\explorer.exe' },
      { ProcessId: 4, ExecutablePath: null },
    ])
    const dir = 'C:\\Users\\X\\AppData\\Local\\Programs\\智能体 工坊'
    expect(processesUnder(json, dir).map((p: { ProcessId: number }) => p.ProcessId)).toEqual([1, 2])
    expect(processesUnder('', dir)).toEqual([])
    expect(
      processesUnder(
        // 只有一条时 PowerShell 回的是对象，不是数组
        JSON.stringify({ ProcessId: 5, ExecutablePath: `${dir}\\x.exe` }),
        dir,
      ),
    ).toHaveLength(1)
  })

  it('NSIS 静默安装：/D= 在最后、不带引号', () => {
    expect(installerArgs('C:\\P\\智能体 工坊')).toEqual(['/S', '/D=C:\\P\\智能体 工坊'])
  })
})
