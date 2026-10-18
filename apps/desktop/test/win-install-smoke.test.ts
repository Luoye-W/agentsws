/** WP218：Windows 装起来真跑那个脚本里的纯函数（真跑只在 CI 的 windows-latest 上）。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allUsersShortcutPaths,
  checkScopeSwitch,
  copyDirSync,
  descendantsOf,
  describeExit,
  exposedListeners,
  installerArgs,
  installFootprint,
  isLoopback,
  longestPaths,
  normalizeWinPath,
  processesUnder,
  psRows,
} from '../scripts/win-install-smoke.mjs'

describe('win-install-smoke 纯函数', () => {
  it('WP319：安装目录的文件数与大小（MB，一位小数）', () => {
    const list = () => ['a', 'b', 'c']
    expect(installFootprint('C:\\x', list, () => 1_250_000)).toEqual({ files: 3, mb: 3.8 })
  })

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
    // WP409：按机器装加 /allusers，/D= 仍在最后
    expect(installerArgs('C:\\P\\x', ['/allusers'])).toEqual(['/S', '/allusers', '/D=C:\\P\\x'])
  })
})

describe('WP409：按用户 → 按机器换范围之后', () => {
  const userDir = 'C:\\Users\\u\\AppData\\Local\\Programs\\x'
  const machineDir = 'C:\\Program Files\\x'
  const newExe = `${machineDir}\\current\\agentsws.exe`
  const links = {
    userLinks: { startMenu: 'U\\start.lnk', startMenuProduct: 'U\\agentsws.lnk' },
    machineLinks: { startMenu: 'M\\start.lnk', desktop: 'M\\desk.lnk' },
  }

  it('按用户那一份删干净、快捷方式都指新的：没有问题', () => {
    const out = checkScopeSwitch(
      { userDir, machineDir, ...links },
      { exists: () => false, list: () => [] },
      (lnk) => (lnk === 'M\\start.lnk' ? newExe : undefined),
    )
    expect(out.problems).toEqual([])
  })

  it('10-18 内测那一幕：旧版本目录、卸载程序还在，旧的 agentsws.lnk 指着已经没了的 current', () => {
    const out = checkScopeSwitch(
      { userDir, machineDir, ...links },
      {
        exists: () => true,
        list: () => [
          'app-0.2.0-beta.10',
          'app-0.2.0-beta.11',
          'Uninstall agentsws.exe',
          'notes.txt',
        ],
      },
      (lnk) =>
        lnk === 'U\\agentsws.lnk'
          ? `${userDir}\\current\\agentsws.exe`
          : lnk === 'M\\start.lnk'
            ? newExe
            : undefined,
    )
    expect(out.problems).toHaveLength(2)
    expect(out.problems[0]).toContain('app-0.2.0-beta.11')
    expect(out.problems[0]).not.toContain('notes.txt')
    expect(out.problems[1]).toContain('startMenuProduct')
  })

  it('所有用户开始菜单里没有快捷方式也算问题', () => {
    const out = checkScopeSwitch(
      { userDir, machineDir, ...links },
      { exists: () => false, list: () => [] },
      () => undefined,
    )
    expect(out.problems).toEqual(['所有用户开始菜单里的快捷方式没指向新装的 current\\agentsws.exe'])
  })

  it('所有用户的快捷方式位置', () => {
    const p = allUsersShortcutPaths({ ProgramData: 'C:\\PD', PUBLIC: 'C:\\Pub' })
    expect(p.startMenu).toContain('Start Menu')
    expect(p.desktop).toContain('Desktop')
  })
})

describe('WP225：拷日志不用 fs.cpSync（Windows 上带中文路径会 fail-fast）', () => {
  it('一层层拷：子目录、中文名都在；源目录不在就什么都不做', () => {
    const root = mkdtempSync(join(tmpdir(), 'wp225-copy-数据 '))
    try {
      const from = join(root, '日志')
      mkdirSync(join(from, '场景 一'), { recursive: true })
      writeFileSync(join(from, 'desktop.log'), 'a')
      writeFileSync(join(from, '场景 一', 'server.log'), '中文')
      const to = join(root, 'out', 'logs')
      expect(copyDirSync(from, to)).toBe(2)
      expect(readFileSync(join(to, '场景 一', 'server.log'), 'utf8')).toBe('中文')
      expect(copyDirSync(join(root, '没有'), join(root, 'x'))).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
