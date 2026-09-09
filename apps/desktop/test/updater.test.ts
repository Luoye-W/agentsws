import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../src/logging.js'
import { createUpdateGate, type UpdaterPort } from '../src/updater.js'

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
