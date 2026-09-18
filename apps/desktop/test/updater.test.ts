import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../src/logging.js'
import { buildTrayMenu, type TrayModelInput } from '../src/menu.js'
import {
  compareVersions,
  createReleaseChecker,
  createUpdateGate,
  isNewer,
  MAC_AUTOUPDATE_ENV,
  pickLatestBeta,
  RELEASES_PAGE,
  UPDATES_ENV,
  type UpdaterPort,
  updatePolicy,
} from '../src/updater.js'
import { fakeFetch, response } from './fakes.js'

function updater(patch: Partial<UpdaterPort> = {}): UpdaterPort & { installed: () => number } {
  let installs = 0
  return {
    checkForUpdates: () => Promise.resolve({ version: '0.2.0' }),
    downloadUpdate: () => Promise.resolve(),
    quitAndInstall: () => {
      installs += 1
    },
    installed: () => installs,
    ...patch,
  }
}

describe('createUpdateGate', () => {
  it('v1 默认关：没有更新源就什么都不做', async () => {
    const up = updater()
    const gate = createUpdateGate({ updater: up, smoke: async () => true, logger: silentLogger() })
    expect(await gate.run()).toMatchObject({ state: 'disabled', reason: '未配置更新源' })
    expect(up.installed()).toBe(0)
  })

  it('没有新版本就停在 none', async () => {
    const gate = createUpdateGate({
      updater: updater({ checkForUpdates: () => Promise.resolve(undefined) }),
      smoke: async () => true,
      logger: silentLogger(),
      enabled: true,
    })
    expect(await gate.run()).toMatchObject({ state: 'none' })
  })

  it('冒烟通过才切换（13 §5「更新前跑一次冒烟」）', async () => {
    const up = updater()
    const smoke = vi.fn(async () => true)
    const gate = createUpdateGate({ updater: up, smoke, logger: silentLogger(), enabled: true })
    expect(await gate.run()).toMatchObject({ state: 'installing', version: '0.2.0' })
    expect(smoke).toHaveBeenCalledOnce()
    expect(up.installed()).toBe(1)
  })

  it('冒烟不过就不切换，旧版本继续跑', async () => {
    const up = updater()
    const gate = createUpdateGate({
      updater: up,
      smoke: async () => false,
      logger: silentLogger(),
      enabled: true,
    })
    expect(await gate.run()).toMatchObject({ state: 'blocked', version: '0.2.0' })
    expect(up.installed()).toBe(0)
  })

  it('冒烟自己抛错也算不过', async () => {
    const up = updater()
    const gate = createUpdateGate({
      updater: up,
      smoke: () => Promise.reject(new Error('ECONNREFUSED')),
      logger: silentLogger(),
      enabled: true,
    })
    const outcome = await gate.run()
    expect(outcome.state).toBe('blocked')
    expect(outcome.reason).toContain('ECONNREFUSED')
    expect(up.installed()).toBe(0)
  })

  it('检查 / 下载失败都不切换', async () => {
    const failCheck = createUpdateGate({
      updater: updater({ checkForUpdates: () => Promise.reject(new Error('no feed')) }),
      smoke: async () => true,
      logger: silentLogger(),
      enabled: true,
    })
    expect(await failCheck.run()).toMatchObject({ state: 'error' })

    const up = updater({ downloadUpdate: () => Promise.reject(new Error('disk full')) })
    const failDownload = createUpdateGate({
      updater: up,
      smoke: async () => true,
      logger: silentLogger(),
      enabled: true,
    })
    const outcome = await failDownload.run()
    expect(outcome).toMatchObject({ state: 'error', version: '0.2.0' })
    expect(up.installed()).toBe(0)
  })
})

// ── WP111：两条路，由签名决定走哪条 ────────────────────────────────────

describe('updatePolicy', () => {
  const at = (platform: string, env: Record<string, string | undefined> = {}, packaged = true) =>
    updatePolicy({ platform, env, packaged })

  it('Windows：应用内自动更新（第一位内测用户用 Windows，这是主路径）', () => {
    expect(at('win32').mode).toBe('auto')
  })

  it('macOS 默认只提示：未签名过不了 Squirrel 的签名校验', () => {
    const policy = at('darwin')
    expect(policy.mode).toBe('notify')
    expect(policy.reason).toContain('未签名')
  })

  it('留了开关：将来签名做了，`AGENTSWS_MAC_AUTOUPDATE=1` 就切自动', () => {
    expect(at('darwin', { [MAC_AUTOUPDATE_ENV]: '1' }).mode).toBe('auto')
  })

  it('Linux 只提示：顺带发的一档，自动更新没在真机上验过', () => {
    expect(at('linux').mode).toBe('notify')
  })

  it('开发期不查；`=1` 可以在开发期强开（调试用）', () => {
    expect(at('win32', {}, false).mode).toBe('off')
    expect(at('win32', { [UPDATES_ENV]: '1' }, false).mode).toBe('auto')
  })

  it('`=0` 一律关掉 —— 用户说不查就不查', () => {
    expect(at('win32', { [UPDATES_ENV]: '0' }).mode).toBe('off')
    expect(at('darwin', { [UPDATES_ENV]: '0', [MAC_AUTOUPDATE_ENV]: '1' }).mode).toBe('off')
  })
})

describe('compareVersions / isNewer', () => {
  it('数字段逐个比', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.1', '0.1.0')).toBe(0)
  })

  it('预发布比同号正式版小（0.1.0-beta.1 < 0.1.0）', () => {
    expect(compareVersions('0.1.0-beta.1', '0.1.0')).toBe(-1)
    expect(compareVersions('0.1.0', '0.1.0-beta.9')).toBe(1)
  })

  it('两个预发布按点分段比，数字按数字比（beta.10 > beta.9）', () => {
    expect(compareVersions('0.1.0-beta.10', '0.1.0-beta.9')).toBe(1)
    expect(compareVersions('0.1.0-beta.2', '0.1.0-beta.2')).toBe(0)
    expect(compareVersions('0.1.0-alpha.1', '0.1.0-beta.1')).toBe(-1)
    expect(compareVersions('0.1.0-beta', '0.1.0-beta.1')).toBe(-1)
    expect(compareVersions('0.1.0-beta.1', '0.1.0-beta')).toBe(1)
  })

  it('前缀 v 与空白都忍得了（tag 是 `v0.1.0-beta.2`）', () => {
    expect(isNewer('0.1.0-beta.1', ' v0.1.0-beta.2 ')).toBe(true)
    expect(isNewer('0.1.0-beta.2', 'v0.1.0-beta.1')).toBe(false)
    expect(isNewer('0.1.0-beta.2', 'v0.1.0-beta.2')).toBe(false)
  })
})

describe('pickLatestBeta', () => {
  const releases = [
    { tag_name: 'v0.1.0-beta.1', html_url: 'https://x/1' },
    { tag_name: 'v0.1.0-beta.3', html_url: 'https://x/3' },
    { tag_name: 'v0.1.0-beta.2', html_url: 'https://x/2' },
  ]

  it('挑最新的那一个 beta，带上它自己的页面地址', () => {
    expect(pickLatestBeta(releases, '0.1.0-beta.1')).toEqual({
      version: '0.1.0-beta.3',
      url: 'https://x/3',
    })
  })

  it('已经是最新就没有（不要每次开机都弹一次"有新版本"）', () => {
    expect(pickLatestBeta(releases, '0.1.0-beta.3')).toBeUndefined()
    expect(pickLatestBeta(releases, '0.2.0')).toBeUndefined()
  })

  it('草稿不算；不是 beta 的 tag 不算（渠道就是 beta）', () => {
    expect(
      pickLatestBeta(
        [
          { tag_name: 'v0.9.0-beta.9', draft: true },
          { tag_name: 'v0.9.0' },
          { tag_name: 'nightly' },
        ],
        '0.1.0-beta.1',
      ),
    ).toBeUndefined()
  })

  it('回来的不是数组 / 字段缺了 → 当没有，不炸', () => {
    expect(pickLatestBeta({ message: 'rate limited' }, '0.1.0')).toBeUndefined()
    expect(pickLatestBeta([{}, null], '0.1.0')).toBeUndefined()
    expect(pickLatestBeta([{ tag_name: 'v0.2.0-beta.1' }], '0.1.0')).toEqual({
      version: '0.2.0-beta.1',
      url: RELEASES_PAGE,
    })
  })
})

describe('createReleaseChecker', () => {
  const list = JSON.stringify([{ tag_name: 'v0.1.0-beta.2', html_url: 'https://x/2' }])

  it('一次匿名 GET，打的是 releases 列表', async () => {
    const fetchImpl = fakeFetch(() => response(200, list))
    const checker = createReleaseChecker({ fetchImpl, currentVersion: '0.1.0-beta.1' })
    expect(await checker.checkForUpdates()).toEqual({
      version: '0.1.0-beta.2',
      url: 'https://x/2',
    })
    expect(fetchImpl.calls[0]).toBe('https://api.github.com/repos/Luoye-W/agentsws/releases')
  })

  it('GitHub 限流 / 网断 → 抛出去，由闸记一条 error（不假装"没有新版本"）', async () => {
    const checker = createReleaseChecker({
      fetchImpl: fakeFetch(() => response(403, 'rate limited')),
      currentVersion: '0.1.0-beta.1',
    })
    await expect(checker.checkForUpdates()).rejects.toThrow('HTTP 403')
  })

  it('这条路上**下载与安装都明确不做**（不是静默成功）', async () => {
    const checker = createReleaseChecker({
      fetchImpl: fakeFetch(() => response(200, list)),
      currentVersion: '0.1.0-beta.1',
    })
    await expect(checker.downloadUpdate()).rejects.toThrow('不做应用内下载')
    expect(checker.quitAndInstall()).toBeUndefined()
  })

  it('超时中断源接得上（真机上 GitHub 连不上时不能把启动挂住）', async () => {
    let aborted = 0
    const checker = createReleaseChecker({
      fetchImpl: fakeFetch(() => response(200, list)),
      currentVersion: '0.1.0-beta.1',
      abort: () => ({
        signal: new AbortController().signal,
        done: () => {
          aborted += 1
        },
      }),
    })
    await checker.checkForUpdates()
    expect(aborted).toBe(1)
  })
})

describe('UpdateGate 的 notify 档（mac / linux）', () => {
  it('查到新版本就告诉用户，**不下载、不切换**', async () => {
    const seen: string[] = []
    let downloaded = 0
    const gate = createUpdateGate({
      updater: updater({
        checkForUpdates: () => Promise.resolve({ version: '0.2.0-beta.1', url: 'https://x/2' }),
        downloadUpdate: () => {
          downloaded += 1
          return Promise.resolve()
        },
      }),
      smoke: async () => true,
      logger: silentLogger(),
      mode: 'notify',
      notify: (info) => seen.push(`${info.version} ${info.url ?? ''}`),
    })
    expect(await gate.run()).toMatchObject({ state: 'notified', version: '0.2.0-beta.1' })
    expect(seen).toEqual(['0.2.0-beta.1 https://x/2'])
    expect(downloaded).toBe(0)
  })

  it('没有新版本就什么都不说', async () => {
    const seen: string[] = []
    const gate = createUpdateGate({
      updater: updater({ checkForUpdates: () => Promise.resolve(undefined) }),
      smoke: async () => true,
      logger: silentLogger(),
      mode: 'notify',
      notify: (info) => seen.push(info.version),
    })
    expect(await gate.run()).toMatchObject({ state: 'none' })
    expect(seen).toEqual([])
  })

  it('没接 notify 回调也不炸；理由里给的是下载页', async () => {
    const gate = createUpdateGate({
      updater: updater({ checkForUpdates: () => Promise.resolve({ version: '0.2.0-beta.1' }) }),
      smoke: async () => true,
      logger: silentLogger(),
      mode: 'notify',
    })
    expect(await gate.run()).toMatchObject({ state: 'notified', reason: RELEASES_PAGE })
  })

  it('`mode: off` 与老的 `enabled: false` 是同一件事（旧调用点不必改）', async () => {
    const off = createUpdateGate({
      updater: updater(),
      smoke: async () => true,
      logger: silentLogger(),
      mode: 'off',
    })
    expect(await off.run()).toMatchObject({ state: 'disabled' })
  })

  it('`mode: auto` 走的还是老那条：冒烟不过不切换', async () => {
    const up = updater()
    const gate = createUpdateGate({
      updater: up,
      smoke: async () => false,
      logger: silentLogger(),
      mode: 'auto',
    })
    expect(await gate.run()).toMatchObject({ state: 'blocked', version: '0.2.0' })
    expect(up.installed()).toBe(0)
  })
})

describe('托盘：只提示那一档', () => {
  const base: TrayModelInput = {
    language: 'zh-CN',
    serverUrl: 'http://127.0.0.1:4317',
    version: '0.1.0-beta.1',
    server: { state: 'running' } as never,
    health: { ok: true } as never,
    paused: false,
    connect: undefined,
    launchAtLogin: false,
  }

  it('查到新版本才挂那一项；Windows 那一档不挂（它自己会更新）', () => {
    expect(buildTrayMenu(base).map((i) => i.id)).not.toContain('open-download-page')
    const withUpdate = buildTrayMenu({ ...base, updateAvailable: '0.1.0-beta.2' })
    const item = withUpdate.find((i) => i.id === 'open-download-page')
    expect(item?.label).toBe('有新版本 0.1.0-beta.2，去下载…')
    expect(item?.enabled).toBe(true)
  })

  it('空串当没有', () => {
    expect(buildTrayMenu({ ...base, updateAvailable: '' }).map((i) => i.id)).not.toContain(
      'open-download-page',
    )
  })
})
