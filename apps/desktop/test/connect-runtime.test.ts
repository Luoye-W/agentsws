import { describe, expect, it } from 'vitest'
import {
  classify,
  createConnectRuntime,
  DEFAULT_CONNECT_URL,
  type HardeningReportLike,
  NotImplementedError,
  notImplementedLauncher,
} from '../src/connect-runtime.js'
import { fakeClock } from './fakes.js'

const report = (patch: Partial<HardeningReportLike> = {}): HardeningReportLike => ({
  ok: true,
  reasons: [],
  checks: [{ name: 'health', ok: true, detail: 'HTTP 401（鉴权已开）' }],
  ...patch,
})

describe('classify', () => {
  it('加固过 = ready', () => {
    expect(classify(report())).toBe('ready')
  })

  it('探不到 = absent（没装 / 没起）', () => {
    expect(classify(report({ ok: false, reasons: ['runtime_unreachable'] }))).toBe('absent')
  })

  it('起着但鉴权 / 加密没开 = unhardened，08 §5 要求拒绝接入', () => {
    expect(
      classify(report({ ok: false, reasons: ['admin_auth_disabled', 'proxies_not_blocked'] })),
    ).toBe('unhardened')
  })
})

describe('notImplementedLauncher', () => {
  it('v1 只留接口，调用会明确报 not_implemented——不假装成功', async () => {
    for (const mode of ['docker', 'npm'] as const) {
      const launcher = notImplementedLauncher(mode)
      expect(launcher.mode).toBe(mode)
      await expect(launcher.start()).rejects.toBeInstanceOf(NotImplementedError)
      await expect(launcher.stop()).rejects.toThrowError(/未实现/)
    }
    const err = new NotImplementedError('x')
    expect(err.code).toBe('not_implemented')
    expect(err.name).toBe('NotImplementedError')
  })
})

describe('createConnectRuntime', () => {
  it('默认地址是本地 runtime', async () => {
    const runtime = createConnectRuntime({ probe: async () => report(), clock: fakeClock() })
    expect(runtime.last()).toBeUndefined()
    const status = await runtime.check()
    expect(status.baseUrl).toBe(DEFAULT_CONNECT_URL)
    expect(status.state).toBe('ready')
    expect(status.checkedAt).toBe('2026-09-09T00:00:00.000Z')
    expect(runtime.last()).toEqual(status)
  })

  it('探测函数拿到的是配置里的地址', async () => {
    const seen: string[] = []
    const runtime = createConnectRuntime({
      baseUrl: 'http://127.0.0.1:9999',
      clock: fakeClock(),
      probe: async (url) => {
        seen.push(url)
        return report()
      },
    })
    await runtime.check()
    expect(seen).toEqual(['http://127.0.0.1:9999'])
  })

  it('探测抛错当成"探不到"，不让壳跟着崩', async () => {
    const runtime = createConnectRuntime({
      clock: fakeClock(),
      probe: () => Promise.reject(new Error('boom')),
    })
    const status = await runtime.check()
    expect(status.state).toBe('absent')
    expect(status.checks[0]?.detail).toContain('boom')
  })

  it('返回的是快照副本，改不动缓存', async () => {
    const runtime = createConnectRuntime({
      clock: fakeClock(),
      probe: async () => report({ ok: false, reasons: ['encryption_disabled'] }),
    })
    const status = await runtime.check()
    expect(status.reasons).toEqual(['encryption_disabled'])
    expect(runtime.last()?.state).toBe('unhardened')
  })

  it('launcher 是预留位，给了就透出来', () => {
    expect(
      createConnectRuntime({ probe: async () => report(), clock: fakeClock() }).launcher,
    ).toBeUndefined()
    const launcher = notImplementedLauncher('npm')
    expect(
      createConnectRuntime({ probe: async () => report(), clock: fakeClock(), launcher }).launcher,
    ).toBe(launcher)
  })
})
