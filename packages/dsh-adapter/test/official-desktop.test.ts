/**
 * WP184（docs/79 §9）：认用户自己装的官方 DeepSeek Harness 桌面端。
 * 全用替身：不碰真的 `/Applications`、不查真的注册表、不起任何进程。
 */
import { describe, expect, it } from 'vitest'
import {
  detectOfficialDesktop,
  exeFromProtocolCommand,
  OFFICIAL_DESKTOP_REGISTRY_KEY,
  officialDesktopCandidates,
  officialDesktopLaunch,
  parseRegQuery,
  plistDeclaresScheme,
} from '../src/index.js'

const PLIST = `<?xml version="1.0"?><plist><dict>
<key>CFBundleName</key><string>DeepSeek Harness</string>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>DeepSeek Harness</string>
<key>CFBundleURLSchemes</key><array><string>dsh</string></array>
</dict></array></dict></plist>`

const WIN_EXE = 'C:\\Users\\a\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'

describe('官方桌面端：安装位置', () => {
  it('macOS 找 /Applications 与 ~/Applications；Windows 找按用户安装目录与 Program Files；别的系统不找', () => {
    expect(officialDesktopCandidates({ platform: 'darwin', home: '/Users/a', env: {} })).toEqual([
      '/Applications/DeepSeek Harness.app',
      '/Users/a/Applications/DeepSeek Harness.app',
    ])
    expect(
      officialDesktopCandidates({
        platform: 'win32',
        home: 'C:\\Users\\a',
        env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
      }),
    ).toEqual([WIN_EXE, 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'])
    expect(officialDesktopCandidates({ platform: 'linux', home: '/home/a', env: {} })).toEqual([])
  })

  it('Info.plist 里认 dsh 协议；reg query 的输出认默认值；协议命令里认 exe', () => {
    expect(plistDeclaresScheme(PLIST)).toBe(true)
    expect(plistDeclaresScheme(PLIST.replace('<string>dsh</string>', '<string>x</string>'))).toBe(
      false,
    )
    expect(plistDeclaresScheme('<plist/>')).toBe(false)
    const out = `\r\n${OFFICIAL_DESKTOP_REGISTRY_KEY}\r\n    (默认)    REG_SZ    "${WIN_EXE}" "%1"\r\n`
    expect(parseRegQuery(out)).toBe(`"${WIN_EXE}" "%1"`)
    expect(parseRegQuery('ERROR: not found')).toBeUndefined()
    expect(exeFromProtocolCommand(`"${WIN_EXE}" "%1"`)).toBe(WIN_EXE)
    expect(exeFromProtocolCommand('C:\\x\\a.exe %1')).toBe('C:\\x\\a.exe')
    expect(exeFromProtocolCommand('rundll32 foo')).toBeUndefined()
  })
})

describe('官方桌面端：检测', () => {
  const none = { exists: () => false, readText: () => undefined }

  it('macOS：装在 /Applications、plist 声明 dsh → 走协议；没声明 → 打开 .app；没装 → 没有', async () => {
    const app = '/Applications/DeepSeek Harness.app'
    const base = { platform: 'darwin', home: '/Users/a', env: {} }
    expect(
      await detectOfficialDesktop({
        ...base,
        exists: (p) => p === app,
        readText: (p) => (p === `${app}/Contents/Info.plist` ? PLIST : undefined),
      }),
    ).toEqual({ app, protocol: true })
    expect(
      await detectOfficialDesktop({ ...base, exists: (p) => p === app, readText: () => undefined }),
    ).toEqual({ app, protocol: false })
    expect(await detectOfficialDesktop({ ...base, ...none })).toBeUndefined()
  })

  it('Windows：注册表里 dsh:// 归 DeepSeek Harness.exe 才算协议在；别的程序抢了协议不认', async () => {
    const base = {
      platform: 'win32',
      home: 'C:\\Users\\a',
      env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
    }
    const reg = (cmd: string) => async (key: string) =>
      key === OFFICIAL_DESKTOP_REGISTRY_KEY ? `    (Default)    REG_SZ    ${cmd}` : undefined
    expect(
      await detectOfficialDesktop({
        ...base,
        exists: (p) => p === WIN_EXE,
        readText: () => undefined,
        queryRegistry: reg(`"${WIN_EXE}" "%1"`),
      }),
    ).toEqual({ app: WIN_EXE, protocol: true })
    // 别人抢了 dsh://：不认它，退回常见路径
    expect(
      await detectOfficialDesktop({
        ...base,
        exists: (p) => p === WIN_EXE || p === 'C:\\evil\\other.exe',
        readText: () => undefined,
        queryRegistry: reg('"C:\\evil\\other.exe" "%1"'),
      }),
    ).toEqual({ app: WIN_EXE, protocol: false })
    // 注册表查不到、路径也没有
    expect(
      await detectOfficialDesktop({
        ...base,
        ...none,
        queryRegistry: async () => {
          throw new Error('reg 不在')
        },
      }),
    ).toBeUndefined()
  })

  it('Linux 不找', async () => {
    expect(
      await detectOfficialDesktop({
        platform: 'linux',
        home: '/h',
        env: {},
        exists: () => true,
        readText: () => PLIST,
      }),
    ).toBeUndefined()
  })
})

describe('官方桌面端：启动命令', () => {
  it('macOS 用 open（协议优先）；Windows 直接起 exe', () => {
    const app = '/Applications/DeepSeek Harness.app'
    expect(officialDesktopLaunch({ app, protocol: true }, 'darwin')).toEqual({
      command: 'open',
      args: ['dsh://open'],
    })
    expect(officialDesktopLaunch({ app, protocol: false }, 'darwin')).toEqual({
      command: 'open',
      args: [app],
    })
    expect(officialDesktopLaunch({ app: WIN_EXE, protocol: true }, 'win32')).toEqual({
      command: WIN_EXE,
      args: [],
    })
  })
})
