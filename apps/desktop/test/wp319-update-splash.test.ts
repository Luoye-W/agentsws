/**
 * WP319 ②：点「重启并更新」之后，安装程序那几分钟里桌面上要有东西看得见。
 *
 * - 装之前写「正在更新」单、起一个不在安装目录里的小窗（只 Windows）；起不来不挡更新；
 * - 新版一启动收掉单（小窗跟着关）、记一行用了多久；
 * - 小窗脚本：中文原样、单引号转义、单子没了 / 超时就关。
 */
import { describe, expect, it } from 'vitest'
import { silentLogger } from '../src/logging.js'
import { memoryFileStore } from '../src/node-files.js'
import {
  beginUpdate,
  finishPendingUpdate,
  SPLASH_TIMEOUT_SECONDS,
  splashScript,
  splashText,
  UPDATE_PENDING_FILE,
} from '../src/update-splash.js'

const USER_DATA = 'C:\\Users\\a\\AppData\\Roaming\\@agentsws\\desktop'
const PENDING = `${USER_DATA}\\${UPDATE_PENDING_FILE}`
const T = new Date('2026-10-14T08:00:00.000Z')

describe('WP319 ② 「正在更新」小窗', () => {
  it('装之前：写单子、把脚本放临时目录、脱离父进程起 PowerShell', () => {
    const files = memoryFileStore()
    const scripts: { path: string; text: string }[] = []
    const spawned: { command: string; args: readonly string[] }[] = []
    const out = beginUpdate({
      files,
      userData: USER_DATA,
      tempDir: 'C:\\Temp',
      from: '0.2.0-beta.5',
      to: '0.2.0-beta.6',
      language: 'zh-CN',
      now: () => T,
      logger: silentLogger(),
      platform: 'win32',
      launcher: {
        writeScript: (path, text) => scripts.push({ path, text }),
        spawnDetached: (command, args) => spawned.push({ command, args }),
      },
    })
    expect(out).toEqual({ pendingFile: PENDING, splash: true })
    expect(JSON.parse(files.readText(PENDING) ?? '')).toEqual({
      from: '0.2.0-beta.5',
      to: '0.2.0-beta.6',
      started_at: T.toISOString(),
    })
    expect(scripts[0]?.path).toBe('C:\\Temp\\agentsws-update-0.2.0-beta.6.ps1')
    expect(scripts[0]?.text).toContain("'正在更新到 0.2.0-beta.6'")
    expect(scripts[0]?.text).toContain(`$pending = '${PENDING}'`)
    // 不在安装目录里：系统自带的 PowerShell，脚本在临时目录
    expect(spawned).toEqual([
      {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          'C:\\Temp\\agentsws-update-0.2.0-beta.6.ps1',
        ],
      },
    ])
  })

  it('起不来不挡更新；不是 Windows 只写单子', () => {
    const files = memoryFileStore()
    const broken = beginUpdate({
      files,
      userData: USER_DATA,
      tempDir: 'C:\\Temp',
      from: '1',
      to: '2',
      language: undefined,
      now: () => T,
      logger: silentLogger(),
      platform: 'win32',
      launcher: {
        writeScript: () => {
          throw new Error('EACCES')
        },
        spawnDetached: () => undefined,
      },
    })
    expect(broken.splash).toBe(false)
    expect(files.exists(PENDING)).toBe(true)

    let spawnedOnMac = false
    const mac = beginUpdate({
      files: memoryFileStore(),
      userData: '/Users/a/Library/Application Support/@agentsws/desktop',
      tempDir: '/tmp',
      from: '1',
      to: '2',
      language: 'zh-CN',
      now: () => T,
      logger: silentLogger(),
      platform: 'darwin',
      launcher: {
        writeScript: () => undefined,
        spawnDetached: () => {
          spawnedOnMac = true
        },
      },
    })
    expect(mac.splash).toBe(false)
    expect(spawnedOnMac).toBe(false)
  })

  it('新版一启动：收掉单子（小窗看到就关）、回用了几秒；没有单 / 坏单不抛', () => {
    const files = memoryFileStore({
      [PENDING]: JSON.stringify({ from: '1', to: '2', started_at: '2026-10-14T07:59:51.000Z' }),
    })
    const base = {
      files,
      userData: USER_DATA,
      version: '2',
      now: () => T,
      logger: silentLogger(),
      platform: 'win32' as const,
    }
    expect(finishPendingUpdate(base)).toBe(9)
    expect(files.exists(PENDING)).toBe(false)
    expect(finishPendingUpdate(base)).toBeUndefined()
    files.writeText(PENDING, '{坏的')
    expect(finishPendingUpdate(base)).toBeUndefined()
    expect(files.exists(PENDING)).toBe(false)
  })

  it('小窗脚本：单子没了或超时就关；单引号转义；英文界面说英文', () => {
    const script = splashScript({
      pendingFile: "C:\\Users\\O'Neil\\x.json",
      text: splashText('en', '1.0.0'),
    })
    expect(script).toContain("$pending = 'C:\\Users\\O''Neil\\x.json'")
    expect(script).toContain(`$timeout = ${SPLASH_TIMEOUT_SECONDS}`)
    expect(script).toContain('Test-Path -LiteralPath $pending')
    expect(script).toContain("'Updating to 1.0.0'")
    expect(script).toContain('$form.TopMost = $true')
    // Windows 换行（PowerShell 5.1 读 CRLF 最稳）
    expect(script.includes('\r\n')).toBe(true)
    expect(splashText('zh-CN', '1.0.0').hint).toBe('装好会自动打开')
  })
})
