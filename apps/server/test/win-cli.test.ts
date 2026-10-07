/**
 * WP225：Windows 上起 npm 装的命令（`.cmd` 壳）与读控制台程序的输出（OEM 代码页）。
 * 纯函数，mac 上也跑：文件是否存在由替身回答，平台按参数给。
 */
import { describe, expect, it } from 'vitest'
import { cliInvocation, privateCliDir, privateCliEntry } from '../src/platform-cli-runner.js'
import {
  CliArgumentError,
  cliSpawnSpec,
  decodeConsoleText,
  decoderLabel,
  envValue,
  findWindowsCommand,
  oemCodePageOf,
} from '../src/win-cli.js'

const ENV = {
  Path: 'C:\\Windows\\System32;"C:\\Users\\张三\\AppData\\Roaming\\npm";C:\\Program Files\\nodejs',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SystemRoot: 'C:\\Windows',
}
const FILES = new Set([
  'C:\\Users\\张三\\AppData\\Roaming\\npm\\shopify.cmd',
  'C:\\Users\\张三\\AppData\\Roaming\\npm\\shopify.ps1',
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files\\nodejs\\npx.cmd',
])
const exists = (p: string): boolean => FILES.has(p)

describe('findWindowsCommand：按 PATH + PATHEXT 找（就是 where.exe 的找法）', () => {
  it('npm 的 .cmd 壳、带引号的 PATH 段、PATH 大小写都认', () => {
    expect(findWindowsCommand('shopify', ENV, exists)).toBe(
      'C:\\Users\\张三\\AppData\\Roaming\\npm\\shopify.cmd',
    )
    expect(findWindowsCommand('node', ENV, exists)).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(findWindowsCommand('npx', ENV, exists)).toBe('C:\\Program Files\\nodejs\\npx.cmd')
    expect(findWindowsCommand('nope', ENV, exists)).toBeUndefined()
    expect(envValue({ path: 'x' }, 'PATH')).toBe('x')
  })

  it('带了扩展名 / 目录的只看那一处；PATHEXT 没给用默认', () => {
    expect(findWindowsCommand('C:\\Program Files\\nodejs\\node.exe', {}, exists)).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    )
    expect(findWindowsCommand('C:\\Program Files\\nodejs\\npx', {}, exists)).toBe(
      'C:\\Program Files\\nodejs\\npx.cmd',
    )
    expect(findWindowsCommand('shopify', { PATH: ENV.Path }, exists)).toBe(
      'C:\\Users\\张三\\AppData\\Roaming\\npm\\shopify.cmd',
    )
  })
})

describe('cliSpawnSpec：.cmd 壳经 cmd.exe 起', () => {
  it('非 Windows 原样', () => {
    expect(cliSpawnSpec('shopify', ['theme', 'list'], { platform: 'darwin' })).toEqual({
      command: 'shopify',
      args: ['theme', 'list'],
    })
  })

  it('Windows：.cmd → cmd.exe /d /s /c "…"，每个参数加引号、原样传', () => {
    const spec = cliSpawnSpec('shopify', ['theme', 'push', '--theme', 'WP225 预览 (副本)'], {
      platform: 'win32',
      env: ENV,
      exists,
    })
    expect(spec).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Users\\张三\\AppData\\Roaming\\npm\\shopify.cmd" "theme" "push" "--theme" "WP225 预览 (副本)""',
      ],
      windowsVerbatimArguments: true,
    })
  })

  it('Windows：.exe 直接起（用找到的全路径）；找不到原样起（照旧 ENOENT = 没装）', () => {
    expect(cliSpawnSpec('node', ['--version'], { platform: 'win32', env: ENV, exists })).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['--version'],
    })
    expect(cliSpawnSpec('nope', ['x'], { platform: 'win32', env: ENV, exists })).toEqual({
      command: 'nope',
      args: ['x'],
    })
  })

  it('尾巴上的反斜杠翻倍；含 " 或 % 的参数直接拒（cmd 在双引号里也解释它们）', () => {
    const spec = cliSpawnSpec('npx', ['--path', 'C:\\主题\\'], {
      platform: 'win32',
      env: { ...ENV, ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      exists,
    })
    expect(spec.command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(spec.args[3]).toBe('""C:\\Program Files\\nodejs\\npx.cmd" "--path" "C:\\主题\\\\""')
    for (const bad of ['a"b', '100%', '%USERPROFILE%', 'x\ny']) {
      expect(() => cliSpawnSpec('shopify', [bad], { platform: 'win32', env: ENV, exists })).toThrow(
        CliArgumentError,
      )
    }
  })
})

describe('控制台输出的编码', () => {
  // 「C:\程序\官方」的 GBK 字节
  const gbk = Uint8Array.from([
    0x43, 0x3a, 0x5c, 0xb3, 0xcc, 0xd0, 0xf2, 0x5c, 0xb9, 0xd9, 0xb7, 0xbd,
  ])

  it('不是 UTF-8 就按 OEM 代码页解（936 = GBK）；本来就是 UTF-8 的原样', () => {
    expect(decodeConsoleText(gbk, 936)).toBe('C:\\程序\\官方')
    expect(decodeConsoleText(new TextEncoder().encode('C:\\程序'), 936)).toBe('C:\\程序')
  })

  it('代码页认不出 / 没问到：latin1 兜底（不抛）', () => {
    expect(decodeConsoleText(gbk, 437)).toHaveLength(gbk.length)
    expect(decodeConsoleText(gbk, undefined)).toHaveLength(gbk.length)
  })

  it('代码页号 → 解码器名；注册表那一行 → 代码页号', () => {
    expect(decoderLabel(936)).toBe('gbk')
    expect(decoderLabel(950)).toBe('big5')
    expect(decoderLabel(1252)).toBe('windows-1252')
    expect(decoderLabel(437)).toBeUndefined()
    expect(
      oemCodePageOf(
        '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    OEMCP    REG_SZ    936\r\n',
      ),
    ).toBe(936)
    expect(oemCodePageOf('ERROR')).toBeUndefined()
  })
})

describe('WP245：一键安装 / 一键登录在 Windows 上怎么起（中文用户名路径）', () => {
  const NODE = 'C:\\Program Files\\Agents Workshop\\resources\\node\\node.exe'
  const TOOLS = 'C:\\Users\\张三\\AppData\\Roaming\\Agents Workshop\\data\\tools'
  const SPEC = { id: 'shopify-cli', npm: '@shopify/cli', bin: 'shopify' }
  const PKG = `${TOOLS}\\shopify-cli\\node_modules\\@shopify\\cli\\package.json`
  const ENTRY = `${TOOLS}\\shopify-cli\\node_modules\\@shopify\\cli\\bin\\run.js`
  const files = new Set([NODE, PKG, ENTRY])
  const has = (p: string): boolean => files.has(p)
  const read = (): string => JSON.stringify({ bin: { shopify: './bin/run.js' } })

  it('私有安装：按 Windows 路径找到入口，由我们自己的 node.exe 直接起（不经 cmd.exe、不碰 .cmd 壳）', () => {
    expect(privateCliDir(TOOLS, SPEC, 'win32')).toBe(`${TOOLS}\\shopify-cli`)
    expect(privateCliEntry(TOOLS, SPEC, has, read, 'win32')).toBe(ENTRY)
    const how = cliInvocation(TOOLS, NODE, SPEC, has, read, 'win32')
    expect(how).toEqual({ command: NODE, prefix: [ENTRY], source: 'app' })
    const spawnSpec = cliSpawnSpec(how.command, [...how.prefix, 'auth', 'login'], {
      platform: 'win32',
      env: ENV,
      exists: has,
    })
    // .exe 直接起：中文路径就是一个参数，Node 按 UTF-16 交给 CreateProcess，不经 cmd 的引号规则
    expect(spawnSpec).toEqual({ command: NODE, args: [ENTRY, 'auth', 'login'] })
    // npm 也一样：node.exe + npm-cli.js，参数里的安装目录原样
    const npm = cliSpawnSpec(
      NODE,
      ['C:\\x\\npm-cli.js', 'install', '--prefix', `${TOOLS}\\shopify-cli`],
      {
        platform: 'win32',
        env: ENV,
        exists: has,
      },
    )
    expect(npm.windowsVerbatimArguments).toBeUndefined()
    expect(npm.args[3]).toBe(`${TOOLS}\\shopify-cli`)
  })

  it('没有私有安装：退回系统里那份 shopify.cmd，登录参数经 cmd.exe 加引号', () => {
    const how = cliInvocation(TOOLS, NODE, SPEC, () => false, read, 'win32')
    expect(how).toEqual({ command: 'shopify', prefix: [], source: 'system' })
    const spawnSpec = cliSpawnSpec(how.command, ['auth', 'login'], {
      platform: 'win32',
      env: ENV,
      exists,
    })
    expect(spawnSpec.windowsVerbatimArguments).toBe(true)
    expect(spawnSpec.args.at(-1)).toBe(
      '""C:\\Users\\张三\\AppData\\Roaming\\npm\\shopify.cmd" "auth" "login""',
    )
  })

  it('入口文件不在 / package.json 坏了：当没装', () => {
    expect(privateCliEntry(TOOLS, SPEC, (p) => p === PKG, read, 'win32')).toBeUndefined()
    expect(privateCliEntry(TOOLS, SPEC, has, () => '{', 'win32')).toBeUndefined()
  })
})
