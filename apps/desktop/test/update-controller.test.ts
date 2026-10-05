/**
 * WP218：一键更新状态机。替身更新源跑四条主路：有新版 / 无新版 / 下载失败 / 安装前确认，
 * 外加主源连不上退到 GitHub、notify 档（mac 未签名）只开下载页、定时查。
 */
import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../src/logging.js'
import {
  busyBeforeRestart,
  classifyUpdateError,
  createUpdateController,
  DEFAULT_FIRST_CHECK_MS,
  DEFAULT_INTERVAL_MS,
  publicStatus,
  type UpdateBackend,
  type UpdateControllerOptions,
  type UpdateStatus,
} from '../src/update-controller.js'
import { fakeTimers } from './fakes.js'

/** 替身更新源：`latest` 为 undefined = 没新版。 */
function backend(
  patch: Partial<UpdateBackend> & { latest?: string | undefined } = {},
): UpdateBackend & { installs: () => number; downloads: () => number } {
  let installs = 0
  let downloads = 0
  const latest = 'latest' in patch ? patch.latest : '0.2.0'
  return {
    check: () => Promise.resolve(latest === undefined ? undefined : { version: latest }),
    download: async (onProgress) => {
      downloads += 1
      onProgress(10)
      onProgress(10.2) // 四舍五入后没变：不该多发一次
      onProgress(55.6)
      onProgress(140) // 夹到 100
    },
    install: () => {
      installs += 1
    },
    installs: () => installs,
    downloads: () => downloads,
    ...patch,
  }
}

function controller(patch: Partial<UpdateControllerOptions> = {}) {
  const timers = fakeTimers()
  const opened: string[] = []
  const options: UpdateControllerOptions = {
    mode: 'auto',
    primary: backend(),
    smoke: async () => true,
    confirmRestart: async () => true,
    openDownloadPage: (url) => {
      opened.push(url)
    },
    downloadPage: 'https://agentsws.com/download/',
    logger: silentLogger(),
    timers,
    ...patch,
  }
  const c = createUpdateController(options)
  const seen: UpdateStatus[] = []
  c.subscribe((s) => {
    seen.push(s)
  })
  return { c, timers, opened, seen, options }
}

describe('有新版 → 下载 → 重启并更新', () => {
  it('查到新版本：出现「有新版本」按钮（available）', async () => {
    const { c } = controller()
    expect(c.status()).toEqual({ state: 'idle' })
    expect(await c.check()).toEqual({
      state: 'available',
      version: '0.2.0',
      mode: 'auto',
      source: 'primary',
    })
  })

  it('点了在后台下载，进度一路报上来，下完变 ready', async () => {
    const primary = backend()
    const { c, seen } = controller({ primary })
    await c.check()
    expect(await c.download()).toEqual({ state: 'ready', version: '0.2.0', source: 'primary' })
    const percents = seen.filter((s) => s.state === 'downloading').map((s) => s.percent)
    expect(percents).toEqual([0, 10, 56, 100])
    expect(primary.downloads()).toBe(1)
  })

  it('同时点两次「更新」只下一份', async () => {
    const primary = backend()
    const { c } = controller({ primary })
    await c.check()
    await Promise.all([c.download(), c.download()])
    expect(primary.downloads()).toBe(1)
  })

  it('下好了点「重启并更新」：问过、自检过，才装', async () => {
    const primary = backend()
    const confirm = vi.fn(async () => true)
    const smoke = vi.fn(async () => true)
    const { c } = controller({ primary, confirmRestart: confirm, smoke })
    await c.check()
    await c.download()
    expect(await c.install()).toBe('installing')
    expect(c.status()).toEqual({ state: 'installing', version: '0.2.0' })
    expect(confirm).toHaveBeenCalledOnce()
    expect(smoke).toHaveBeenCalledOnce()
    expect(primary.installs()).toBe(1)
  })

  it('还没下好就点安装：不装', async () => {
    const { c } = controller()
    expect(await c.install()).toBe('not-ready')
    await c.check()
    expect(await c.install()).toBe('not-ready')
  })

  it('下载中 / 下好之后再查：不把按钮换掉', async () => {
    let checks = 0
    const primary = backend({
      check: async () => {
        checks += 1
        return { version: '0.2.0' }
      },
    })
    const { c } = controller({ primary })
    await c.check()
    await c.download()
    await c.check()
    expect(checks).toBe(1)
    expect(c.status().state).toBe('ready')
  })

  it('没在 available 时点「更新」什么都不做', async () => {
    const primary = backend()
    const { c } = controller({ primary })
    expect(await c.download()).toEqual({ state: 'idle' })
    expect(primary.downloads()).toBe(0)
  })
})

describe('无新版', () => {
  it('查完还是 idle，按钮不出现', async () => {
    const { c } = controller({ primary: backend({ latest: undefined }) })
    expect(await c.check()).toEqual({ state: 'idle' })
  })

  it('off 档一次都不查', async () => {
    const check = vi.fn(async () => ({ version: '9.9.9' }))
    const { c, timers } = controller({ mode: 'off', primary: backend({ check }) })
    c.start()
    expect(timers.pending()).toBe(0)
    expect(await c.check()).toEqual({ state: 'idle' })
    expect(check).not.toHaveBeenCalled()
  })

  it('并发的两次查只打一次源', async () => {
    const check = vi.fn(async () => undefined)
    const { c } = controller({ primary: backend({ check }) })
    await Promise.all([c.check(), c.check()])
    expect(check).toHaveBeenCalledOnce()
  })
})

describe('下载失败', () => {
  it('给人话分类，点「重试」再下一次就好了', async () => {
    let fails = 1
    const primary = backend({
      download: async () => {
        if (fails-- > 0) throw Object.assign(new Error('getaddrinfo ENOTFOUND dl.agentsws.com'), {})
      },
    })
    const { c } = controller({ primary })
    await c.check()
    expect(await c.download()).toMatchObject({
      state: 'error',
      stage: 'download',
      code: 'network',
      version: '0.2.0',
    })
    expect(await c.download()).toEqual({ state: 'ready', version: '0.2.0', source: 'primary' })
  })

  it('错误态里点「重启并更新」不装', async () => {
    const primary = backend({ download: () => Promise.reject(new Error('boom')) })
    const { c } = controller({ primary })
    await c.check()
    await c.download()
    expect(await c.install()).toBe('not-ready')
    expect(primary.installs()).toBe(0)
  })
})

describe('安装前确认', () => {
  it('有任务在跑、用户点「再等等」：不装，按钮还是「重启并更新」', async () => {
    const primary = backend()
    const smoke = vi.fn(async () => true)
    const { c } = controller({ primary, confirmRestart: async () => false, smoke })
    await c.check()
    await c.download()
    expect(await c.install()).toBe('cancelled')
    expect(c.status().state).toBe('ready')
    expect(smoke).not.toHaveBeenCalled()
    expect(primary.installs()).toBe(0)
  })

  it('自检没过：不装、旧版本继续跑，给「重试」', async () => {
    let healthy = false
    const primary = backend()
    const { c } = controller({ primary, smoke: async () => healthy })
    await c.check()
    await c.download()
    expect(await c.install()).toBe('blocked')
    expect(c.status()).toMatchObject({ state: 'error', stage: 'install', code: 'smoke' })
    expect(primary.installs()).toBe(0)
    healthy = true
    expect(await c.install()).toBe('installing')
    expect(primary.installs()).toBe(1)
  })

  it('自检抛错同样不装', async () => {
    const { c } = controller({ smoke: () => Promise.reject(new Error('ECONNREFUSED')) })
    await c.check()
    await c.download()
    expect(await c.install()).toBe('blocked')
    expect(c.status()).toMatchObject({ state: 'error', code: 'smoke' })
  })

  it('安装程序起不来：给 install 错误', async () => {
    const primary = backend({
      install: () => {
        throw new Error('spawn EPERM')
      },
    })
    const { c } = controller({ primary })
    await c.check()
    await c.download()
    expect(await c.install()).toBe('blocked')
    expect(c.status()).toMatchObject({ state: 'error', stage: 'install', code: 'install' })
  })
})

describe('主源连不上退到 GitHub', () => {
  const down = (): UpdateBackend =>
    backend({ check: () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')) })

  it('主源连不上 → 退一次 GitHub；下载、安装都走 GitHub', async () => {
    const github = backend({ latest: '0.3.0' })
    const { c } = controller({ primary: down(), fallback: () => github })
    expect(await c.check()).toMatchObject({
      state: 'available',
      version: '0.3.0',
      source: 'github',
    })
    expect(await c.download()).toMatchObject({ state: 'ready', source: 'github' })
    await c.install()
    expect(github.installs()).toBe(1)
  })

  it('GitHub 下载失败后重试还走 GitHub', async () => {
    let fails = 1
    const github = backend({
      latest: '0.3.0',
      download: async () => {
        if (fails-- > 0) throw new Error('ETIMEDOUT')
      },
    })
    const { c } = controller({ primary: down(), fallback: () => github })
    await c.check()
    await c.download()
    expect(await c.download()).toMatchObject({ state: 'ready', source: 'github' })
  })

  it('开关关着（没给 fallback）：不退，状态不变', async () => {
    const { c } = controller({ primary: down() })
    expect(await c.check()).toEqual({ state: 'idle' })
  })

  it('主源回 404（源在、只是没这版）：不退', async () => {
    const fallback = vi.fn(() => backend())
    const primary = backend({
      check: () =>
        Promise.reject(
          Object.assign(new Error('x'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }),
        ),
    })
    const { c } = controller({ primary, fallback })
    await c.check()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('GitHub 也失败：状态不变', async () => {
    const { c } = controller({
      primary: down(),
      fallback: () => backend({ check: () => Promise.reject(new Error('ECONNRESET')) }),
    })
    expect(await c.check()).toEqual({ state: 'idle' })
  })
})

describe('notify 档（mac 未签名）', () => {
  it('查到新版本 → 按钮说「去下载」，点了开下载页，不在应用里下', async () => {
    const primary = backend()
    const { c, opened } = controller({ mode: 'notify', primary })
    expect(await c.check()).toMatchObject({ state: 'available', mode: 'notify' })
    await c.download()
    expect(opened).toEqual(['https://agentsws.com/download/'])
    expect(primary.downloads()).toBe(0)
  })

  it('源给了具体页面就开那一页', async () => {
    const primary = backend({
      check: async () => ({ version: '0.2.0', url: 'https://github.com/x/y/releases/tag/v0.2.0' }),
    })
    const { c, opened } = controller({ mode: 'notify', primary })
    expect(await c.check()).toMatchObject({ url: 'https://github.com/x/y/releases/tag/v0.2.0' })
    await c.download()
    expect(opened).toEqual(['https://github.com/x/y/releases/tag/v0.2.0'])
  })
})

describe('定时查', () => {
  it('启动后先等一会儿，之后每 4 小时一次；stop 之后不再排', async () => {
    const check = vi.fn(async () => undefined)
    const { c, timers } = controller({ primary: backend({ check }) })
    c.start()
    c.start() // 重复 start 不叠定时器
    expect(timers.pending()).toBe(1)
    expect(timers.lastDelay()).toBe(DEFAULT_FIRST_CHECK_MS)
    timers.runNext()
    await vi.waitFor(() => {
      expect(timers.pending()).toBe(1)
    })
    expect(check).toHaveBeenCalledOnce()
    expect(timers.lastDelay()).toBe(DEFAULT_INTERVAL_MS)
    c.stop()
    expect(timers.pending()).toBe(0)
    c.stop()
  })

  it('stop 发生在一次查的中途：查完不再排下一次', async () => {
    let release: () => void = () => undefined
    const check = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            resolve(undefined)
          }
        }),
    )
    const { c, timers } = controller({ primary: backend({ check }) })
    c.start()
    timers.runNext()
    c.stop()
    release()
    await c.check()
    expect(timers.pending()).toBe(0)
  })
})

describe('订阅', () => {
  it('取消订阅之后不再收到；订阅者抛错不影响别人', async () => {
    const { c } = controller()
    const got: string[] = []
    c.subscribe(() => {
      throw new Error('坏订阅者')
    })
    const off = c.subscribe((s) => {
      got.push(s.state)
    })
    await c.check()
    off()
    await c.download()
    expect(got).toEqual(['available'])
  })
})

describe('classifyUpdateError', () => {
  it.each([
    [new Error('ENOSPC: no space left on device'), 'disk'],
    [new Error('sha512 checksum mismatch, expected x'), 'checksum'],
    [Object.assign(new Error('x'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), 'not_found'],
    [new Error('HttpError: 404 Not Found'), 'not_found'],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), 'network'],
    [new Error('connect ETIMEDOUT 1.2.3.4:443'), 'network'],
    [new Error('something else'), 'unknown'],
    ['plain string', 'unknown'],
    [null, 'unknown'],
  ])('%s → %s', (err, code) => {
    expect(classifyUpdateError(err)).toBe(code)
  })
})

describe('publicStatus', () => {
  it('错误原文不进页面，其余原样', () => {
    expect(
      publicStatus({
        state: 'error',
        stage: 'download',
        code: 'network',
        version: '0.2.0',
        detail: 'C:\\Users\\张三\\AppData\\x',
      }),
    ).toEqual({ state: 'error', stage: 'download', code: 'network', version: '0.2.0' })
    expect(publicStatus({ state: 'idle' })).toEqual({ state: 'idle' })
  })
})

describe('WP225：重启并更新前要不要问', () => {
  it('官方场景、AI 正在操作电脑、岗位 AI 正在干活，有一样就问；都没有不问', () => {
    const idle = { officialScenes: false, computerUse: false, aiRuns: 0 }
    expect(busyBeforeRestart(idle)).toBe(false)
    expect(busyBeforeRestart({ ...idle, aiRuns: 1 })).toBe(true)
    expect(busyBeforeRestart({ ...idle, officialScenes: true })).toBe(true)
    expect(busyBeforeRestart({ ...idle, computerUse: true })).toBe(true)
  })

  it('岗位 AI 那一项问不到：按没有算（不能因为问不到就永远装不上）', () => {
    expect(
      busyBeforeRestart({ officialScenes: false, computerUse: false, aiRuns: undefined }),
    ).toBe(false)
  })
})
