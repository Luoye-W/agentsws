/**
 * WP345：插件随工坊安装与更新的服务端那一半（`src/extension-install.ts`）。
 * 文件夹与状态文件读得对、只认这个工作区的插件、重载后记事件、放弃了只记一次、打开文件夹 / 扩展页用对命令、
 * 起浏览器不带本机密钥。
 */
import type { ExtensionSession } from '@agentsws/api'
import type { PersonId, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createExtensionInstall,
  type ExtensionInstallOptions,
  extensionsPageFor,
  folderOpener,
  folderVersion,
  readSyncState,
  spawnDetached,
} from '../src/extension-install.js'

const WS = 'ws_a' as WorkspaceId
const DIR = '/ud/chrome-extension'

function session(token_id: string, workspace_id: WorkspaceId = WS): ExtensionSession {
  return {
    token_id,
    workspace_id,
    person_id: 'p_1' as PersonId,
    extension_id: 'mlbfinfiigagllemohnopbhfdghagijg',
    scopes: ['kol.observe'],
  }
}

function setup(over: Partial<ExtensionInstallOptions> = {}) {
  const files = new Map<string, string>([
    [`${DIR}/manifest.json`, JSON.stringify({ version: '0.2.0', version_name: '0.2.0-beta.8' })],
    [
      `${DIR}.json`,
      JSON.stringify({
        status: 'updated',
        at: '2026-10-15T08:00:00.000Z',
        bundled_version: '0.2.0-beta.8',
      }),
    ],
  ])
  const dirs = new Set([DIR, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])
  const launched: {
    command: string
    args: string[]
    env: Record<string, string>
    options?: { verbatim?: boolean }
  }[] = []
  const events: { ws: string; type: string; payload: Record<string, string> }[] = []
  const port = createExtensionInstall({
    dir: DIR,
    platform: 'darwin',
    env: { HOME: '/Users/a', PATH: '/bin', AGENTSWS_SECRETS_KEY: 'sekret' },
    readText: (p) => files.get(p),
    exists: (p) => dirs.has(p),
    launch: async (command, args, env, options) => {
      launched.push({ command, args, env, ...(options === undefined ? {} : { options }) })
      return true
    },
    browserEnv: (env) => ({ HOME: env.HOME ?? '', PATH: env.PATH ?? '' }),
    now: () => '2026-10-15T09:00:00.000Z',
    record: (ws, type, payload) => {
      events.push({ ws, type, payload })
    },
    ...over,
  })
  return { port, files, dirs, launched, events }
}

describe('读文件夹与状态', () => {
  it('版本：version_name 优先；读不到 / 坏的回 undefined', () => {
    const read = (text: string | undefined) => () => text
    expect(folderVersion(DIR, read(JSON.stringify({ version: '1.0.0', version_name: 'x1' })))).toBe(
      'x1',
    )
    expect(folderVersion(DIR, read(JSON.stringify({ version: '1.0.0' })))).toBe('1.0.0')
    expect(folderVersion(DIR, read(JSON.stringify({ version: '' })))).toBeUndefined()
    expect(folderVersion(DIR, read('{'))).toBeUndefined()
    expect(folderVersion(DIR, read(undefined))).toBeUndefined()
  })

  it('Windows 路径照样拼（反斜杠）', () => {
    const seen: string[] = []
    folderVersion('C:\\Users\\a\\chrome-extension', (p) => {
      seen.push(p)
      return undefined
    })
    expect(seen).toEqual(['C:\\Users\\a\\chrome-extension\\manifest.json'])
  })

  it('状态文件：认得的才收；error 照带', () => {
    const read = (o: unknown) => () => JSON.stringify(o)
    expect(readSyncState(DIR, read({ status: 'failed', at: 't', error: 'EBUSY' }))).toEqual({
      sync: { status: 'failed', at: 't', error: 'EBUSY' },
    })
    expect(readSyncState(DIR, read({ status: 'weird', at: 't' }))).toBeUndefined()
    expect(readSyncState(DIR, read({ status: 'updated' }))).toBeUndefined()
    expect(readSyncState(DIR, () => undefined)).toBeUndefined()
  })

  it('看：文件夹、两个版本、上次结果；能打开', () => {
    const { port } = setup()
    expect(port.view(WS)).toEqual({
      folder: DIR,
      folder_version: '0.2.0-beta.8',
      bundled_version: '0.2.0-beta.8',
      sync: { status: 'updated', at: '2026-10-15T08:00:00.000Z' },
      running: [],
      can_open: true,
    })
  })

  it('不是桌面版（没有文件夹）：只有空清单，不能打开', () => {
    expect(setup({ dir: undefined }).port.view(WS)).toEqual({ running: [], can_open: false })
    const gone = setup()
    gone.dirs.delete(DIR)
    expect(gone.port.view(WS)).toMatchObject({ can_open: false })
    expect(gone.port.view(WS).folder).toBeUndefined()
  })
})

describe('插件报版本', () => {
  it('回文件夹里那一版；记正在跑的版本，只给这个工作区看', async () => {
    const { port } = setup()
    expect(await port.report(session('tok_1'), { version: '0.2.0-beta.7' })).toEqual({
      folder_version: '0.2.0-beta.8',
    })
    await port.report(session('tok_2', 'ws_b' as WorkspaceId), { version: '0.2.0-beta.6' })
    expect((await port.view(WS)).running).toEqual([
      {
        token_id: 'tok_1',
        extension_id: 'mlbfinfiigagllemohnopbhfdghagijg',
        version: '0.2.0-beta.7',
        at: '2026-10-15T09:00:00.000Z',
      },
    ])
  })

  it('重载后报「从哪版换来」：记一条 extension.updated；同版本重载不记', async () => {
    const { port, events } = setup()
    await port.report(session('tok_1'), { version: '0.2.0-beta.8', reloaded_from: '0.2.0-beta.7' })
    await port.report(session('tok_1'), { version: '0.2.0-beta.8', reloaded_from: '0.2.0-beta.8' })
    expect(events).toEqual([
      {
        ws: WS,
        type: 'extension.updated',
        payload: {
          token_id: 'tok_1',
          extension_id: 'mlbfinfiigagllemohnopbhfdghagijg',
          from: '0.2.0-beta.7',
          to: '0.2.0-beta.8',
        },
      },
    ])
  })

  it('重载了还是旧版：记一次 update_failed，之后照常报还记着「卡在哪」；换了版本就清掉', async () => {
    const { port, events } = setup()
    await port.report(session('tok_1'), { version: '0.2.0-beta.7', gave_up: '0.2.0-beta.8' })
    await port.report(session('tok_1'), { version: '0.2.0-beta.7', gave_up: '0.2.0-beta.8' })
    await port.report(session('tok_1'), { version: '0.2.0-beta.7' })
    expect(events.map((e) => e.type)).toEqual(['extension.update_failed'])
    expect(events[0]?.payload).toMatchObject({ running: '0.2.0-beta.7', wanted: '0.2.0-beta.8' })
    expect((await port.view(WS)).running[0]?.stuck_on).toBe('0.2.0-beta.8')
    await port.report(session('tok_1'), { version: '0.2.0-beta.8' })
    expect((await port.view(WS)).running[0]?.stuck_on).toBeUndefined()
  })

  it('不是桌面版：回空（插件什么都不做）', async () => {
    const { port } = setup({ dir: undefined })
    expect(await port.report(session('tok_1'), { version: '1.0.0' })).toEqual({})
  })
})

describe('打开文件夹 / 扩展页', () => {
  it('命令按平台挑；Edge 开 edge://extensions', () => {
    // WP409：在上一级里选中这个文件夹（人看得见它、能拖进 Chrome 扩展页），不是进到它里面
    expect(folderOpener('darwin', '/a/chrome-extension')).toEqual([
      'open',
      ['-R', '/a/chrome-extension'],
    ])
    expect(
      folderOpener(
        'win32',
        'C:\\Users\\张 三\\AppData\\Roaming\\@agentsws\\desktop\\chrome-extension',
      ),
    ).toEqual([
      'explorer.exe',
      ['/select,"C:\\Users\\张 三\\AppData\\Roaming\\@agentsws\\desktop\\chrome-extension"'],
      { verbatim: true },
    ])
    expect(folderOpener('linux', '/a/b/chrome-extension/')).toEqual(['xdg-open', ['/a/b']])
    expect(folderOpener('linux', '/x')).toEqual(['xdg-open', ['/']])
    expect(extensionsPageFor('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')).toBe(
      'edge://extensions',
    )
    expect(extensionsPageFor('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe(
      'chrome://extensions',
    )
  })

  it('打开文件夹：起 open -R <文件夹>（选中它），环境变量是干净的那份', async () => {
    const { port, launched } = setup()
    expect(await port.open('folder')).toEqual({ opened: true })
    expect(launched).toEqual([
      { command: 'open', args: ['-R', DIR], env: { HOME: '/Users/a', PATH: '/bin' } },
    ])
  })

  it('WP409：Windows 上 explorer /select 原样拼命令行（verbatim 交给起进程的那一层）', async () => {
    const { port, launched, dirs } = setup({ dir: 'C:\\d\\chrome-extension', platform: 'win32' })
    dirs.add('C:\\d\\chrome-extension')
    expect(await port.open('folder')).toEqual({ opened: true })
    expect(launched[0]).toMatchObject({
      command: 'explorer.exe',
      args: ['/select,"C:\\d\\chrome-extension"'],
      options: { verbatim: true },
    })
  })

  it('打开扩展页：直接起 Chrome 带 chrome://extensions（已开着就交给开着的那个；Chrome 不认就是个新标签页，地址交回去给卡片复制），不带本机密钥', async () => {
    const { port, launched } = setup()
    expect(await port.open('chrome')).toEqual({ opened: true, address: 'chrome://extensions' })
    expect(launched[0]?.command).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )
    expect(launched[0]?.args).toEqual(['chrome://extensions'])
    expect(JSON.stringify(launched[0]?.env)).not.toContain('sekret')
  })

  it('没有文件夹 / 没找到 Chrome / 起不来：照实说一句', async () => {
    expect(await setup({ dir: undefined }).port.open('folder')).toMatchObject({
      opened: false,
      message: expect.stringMatching(/桌面版/),
    })
    const noChrome = setup()
    noChrome.dirs.delete('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(await noChrome.port.open('chrome')).toMatchObject({
      opened: false,
      message: expect.stringMatching(/chrome:\/\/extensions/),
    })
    const broken = setup({ launch: async () => false })
    expect(await broken.port.open('folder')).toMatchObject({
      opened: false,
      message: expect.stringContaining(DIR),
    })
    expect(await broken.port.open('chrome')).toMatchObject({ opened: false })
  })

  it('真的那个起进程：起得来回 true，命令不存在回 false', async () => {
    expect(await spawnDetached(process.execPath, ['-e', ''], {})).toBe(true)
    expect(await spawnDetached('/no/such/command-wp345', [], {})).toBe(false)
  })
})
