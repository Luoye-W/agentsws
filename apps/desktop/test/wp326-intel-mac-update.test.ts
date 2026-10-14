/**
 * WP326（决策 731）：Mac 只出 Apple 芯片版之后，装着旧 Intel 版的电脑查更新——
 * 看到的应当是「没有适合你的更新」（不提示、不报错），而不是「有新版」点进去下不到，或者报错。
 *
 * 也把 electron-updater 6.8.9 自己的行为钉住（自动档要签了名才开，但行为要写进报告）：
 * 它「查」的时候不看芯片，只在「下」的时候按芯片筛文件——Intel 上筛完是空的，报 ERR_UPDATER_NO_FILES_PROVIDED。
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { fileUrlsFromUpdateInfo, macUpdateFits } from '../src/update-feed.js'
import {
  createFeedChecker,
  DOWNLOAD_PAGE,
  isMacPackage,
  pickLatestRelease,
} from '../src/updater.js'
import { fakeFetch, response } from './fakes.js'

const V = '0.3.0-beta.1'
/** WP326 之后发版收拢出来的 latest-mac.yml：只有 Apple 芯片的 zip 与 dmg。 */
const armOnly = `version: ${V}
files:
  - url: Agents-Workshop-${V}-arm64-mac.zip
    sha512: a==
    size: 100
  - url: Agents-Workshop-${V}-arm64.dmg
    sha512: b==
    size: 120
path: Agents-Workshop-${V}-arm64-mac.zip
sha512: a==
releaseDate: '2026-10-14T00:00:00.000Z'
`
/** WP326 之前那种（两台 mac 合并）。 */
const both = armOnly.replace(
  'path:',
  `  - url: Agents-Workshop-${V}-x64-mac.zip\n    sha512: c==\n    size: 110\npath:`,
)

describe('latest-mac.yml 里有没有这台 Mac 能装的包', () => {
  it('读出 files 下每一项的 url', () => {
    expect(fileUrlsFromUpdateInfo(armOnly)).toEqual([
      `Agents-Workshop-${V}-arm64-mac.zip`,
      `Agents-Workshop-${V}-arm64.dmg`,
    ])
    expect(fileUrlsFromUpdateInfo('version: 1.0.0\n')).toEqual([])
  })

  it('Intel：全是 arm64 = 没有；有一个不是 arm64 = 有。Apple 芯片什么都算有。读不出 = 按有算', () => {
    expect(macUpdateFits(fileUrlsFromUpdateInfo(armOnly), 'x64')).toBe(false)
    expect(macUpdateFits(fileUrlsFromUpdateInfo(both), 'x64')).toBe(true)
    expect(macUpdateFits(fileUrlsFromUpdateInfo(armOnly), 'arm64')).toBe(true)
    expect(macUpdateFits([], 'x64')).toBe(true)
  })
})

describe('notify 档（mac 未签名，默认）', () => {
  const feed = {
    provider: 'generic' as const,
    url: 'https://dl.agentsws.com/beta',
    channel: 'beta' as const,
  }
  const check = (body: string, platform: string, arch?: string) =>
    createFeedChecker({
      fetchImpl: fakeFetch(() => response(200, body)),
      currentVersion: '0.2.0-beta.9',
      feed,
      platform,
      ...(arch === undefined ? {} : { arch }),
    }).check()

  it('Intel Mac 遇到只有 Apple 芯片包的新版：没有适合它的更新（不提示、不报错）', async () => {
    await expect(check(armOnly, 'darwin', 'x64')).resolves.toBeUndefined()
  })

  it('Apple 芯片（含 Rosetta 下跑着 Intel 版的）照常提示，送去下载页', async () => {
    await expect(check(armOnly, 'darwin', 'arm64')).resolves.toEqual({
      version: V,
      url: DOWNLOAD_PAGE,
    })
  })

  it('还带着 Intel 包的旧式清单、不给芯片、不是 mac：与 WP326 之前一样只比版本', async () => {
    await expect(check(both, 'darwin', 'x64')).resolves.toMatchObject({ version: V })
    await expect(check(armOnly, 'darwin')).resolves.toMatchObject({ version: V })
    await expect(check(armOnly, 'linux', 'x64')).resolves.toMatchObject({ version: V })
  })

  it('GitHub 备用源：Intel 跳过只有 Apple 芯片 mac 包的发布，退回到还有 Intel 包的那一版', async () => {
    const releases = [
      {
        tag_name: `v${V}`,
        html_url: 'https://github.com/x/y/releases/new',
        assets: [
          { name: `Agents-Workshop-Setup-${V}-x64.exe` },
          { name: `Agents-Workshop-${V}-arm64.dmg` },
          { name: `Agents-Workshop-${V}-arm64-mac.zip` },
        ],
      },
      {
        tag_name: 'v0.2.0-beta.10',
        html_url: 'https://github.com/x/y/releases/old',
        assets: [
          { name: 'Agents-Workshop-0.2.0-beta.10-arm64.dmg' },
          { name: 'Agents-Workshop-0.2.0-beta.10-x64.dmg' },
        ],
      },
    ]
    const intel = createFeedChecker({
      fetchImpl: fakeFetch(() => response(200, JSON.stringify(releases))),
      currentVersion: '0.2.0-beta.9',
      feed: { provider: 'github', owner: 'x', repo: 'y', channel: 'beta' },
      platform: 'darwin',
      arch: 'x64',
    })
    await expect(intel.check()).resolves.toEqual({
      version: '0.2.0-beta.10',
      url: 'https://github.com/x/y/releases/old',
    })
    // 不给筛子 = 旧行为；exe 不算 mac 包
    expect(pickLatestRelease(releases, '0.2.0-beta.9', 'beta')?.version).toBe(V)
    expect(isMacPackage(`Agents-Workshop-Setup-${V}-x64.exe`)).toBe(false)
    expect(isMacPackage(`Agents-Workshop-${V}-arm64-mac.zip`)).toBe(true)
  })
})

describe('electron-updater 6.8.9 自己的行为（自动档，签了名才开）', () => {
  const require_ = createRequire(import.meta.url)
  const { MacUpdater } = require_('electron-updater/out/MacUpdater') as {
    MacUpdater: { filterFilesForArch(files: unknown[], isArm64Mac: boolean): unknown[] }
  }
  const { findFile } = require_('electron-updater/out/providers/Provider') as {
    findFile(files: unknown[], ext: string, not: string[]): unknown
  }
  const resolved = fileUrlsFromUpdateInfo(armOnly).map((u) => ({
    url: new URL(`https://dl.agentsws.com/beta/${u}`),
    info: { url: u },
  }))

  it('Intel 上把 arm64 的文件全筛掉，下载那一步报 ERR_UPDATER_NO_FILES_PROVIDED', () => {
    const forIntel = MacUpdater.filterFilesForArch(resolved, false)
    expect(forIntel).toEqual([])
    expect(() => findFile(forIntel, 'zip', ['pkg', 'dmg'])).toThrow(
      expect.objectContaining({ code: 'ERR_UPDATER_NO_FILES_PROVIDED' }),
    )
    expect(MacUpdater.filterFilesForArch(resolved, true)).toHaveLength(2)
  })
})
