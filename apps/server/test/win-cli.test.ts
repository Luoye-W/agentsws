/**
 * WP225：Windows 上起 npm 装的命令（`.cmd` 壳）与读控制台程序的输出（OEM 代码页）。
 * 纯函数，mac 上也跑：文件是否存在由替身回答，平台按参数给。
 */
import { describe, expect, it } from 'vitest'
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
