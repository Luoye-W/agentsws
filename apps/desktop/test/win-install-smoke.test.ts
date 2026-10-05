/** WP218：Windows 装起来真跑那个脚本里的纯函数（真跑只在 CI 的 windows-latest 上）。 */
import { describe, expect, it } from 'vitest'
import {
  descendantsOf,
  describeExit,
  exposedListeners,
  installerArgs,
  isLoopback,
  longestPaths,
  normalizeWinPath,
  processesUnder,
  psRows,
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

  it('WP225：几种写法都认（8.3 短名、\\\\?\\ 前缀、正斜杠、大小写），同名前缀的别的目录不算', () => {
    const json = JSON.stringify([
      {
        ProcessId: 1,
        ExecutablePath: 'C:\\Users\\ZHANGS~1\\AppData\\Local\\Programs\\智能体~1\\agentsws.exe',
      },
      {
        ProcessId: 2,
        ExecutablePath: '\\\\?\\C:\\Users\\张三\\AppData\\Local\\Programs\\智能体 工坊\\x.exe',
      },
      {
        ProcessId: 3,
        ExecutablePath: 'c:/users/张三/appdata/local/programs/智能体 工坊/resources/node/node.exe',
      },
      {
        ProcessId: 4,
        ExecutablePath: 'C:\\Users\\张三\\AppData\\Local\\Programs\\智能体 工坊2\\agentsws.exe',
      },
    ])
    const dirs = [
      'C:\\Users\\张三\\AppData\\Local\\Programs\\智能体 工坊\\',
      'C:\\Users\\ZHANGS~1\\AppData\\Local\\Programs\\智能体~1',
    ]
    expect(processesUnder(json, dirs).map((p: { ProcessId: number }) => p.ProcessId)).toEqual([
      1, 2, 3,
    ])
    expect(normalizeWinPath('\\\\?\\C:/A/B\\')).toBe('c:\\a\\b')
  })

  it('WP225：PowerShell 输出带 BOM 也能读', () => {
    expect(psRows('\uFEFF[{"a":1}]')).toEqual([{ a: 1 }])
    expect(psRows('  ')).toEqual([])
  })

  it('WP225：按进程树认子孙（壳 → 服务进程 → 场景），不含别人的', () => {
    const rows = [
      { ProcessId: 10, ParentProcessId: 1 },
      { ProcessId: 11, ParentProcessId: 10 },
      { ProcessId: 12, ParentProcessId: 11 },
      { ProcessId: 13, ParentProcessId: 12 },
      { ProcessId: 20, ParentProcessId: 1 },
    ]
    expect(descendantsOf(rows, 10).map((r: { ProcessId: number }) => r.ProcessId)).toEqual([
      11, 12, 13,
    ])
    expect(descendantsOf(rows, 99)).toEqual([])
  })

  it('WP225：退出码按十六进制写出 NTSTATUS（Git Bash 把它们一律报成 127）', () => {
    expect(describeExit(0, null)).toBe('0')
    expect(describeExit(1, null)).toBe('1')
    expect(describeExit(3221226505, null)).toBe('3221226505（0xC0000409）')
    expect(describeExit(-1073740791, null)).toBe('-1073740791（0xC0000409）')
    expect(describeExit(null, 'SIGTERM')).toBe('被信号 SIGTERM 结束')
    expect(describeExit(null, null)).toBe('没有退出码')
  })

  it('NSIS 静默安装：/D= 在最后、不带引号', () => {
    expect(installerArgs('C:\\P\\智能体 工坊')).toEqual(['/S', '/D=C:\\P\\智能体 工坊'])
  })
})
