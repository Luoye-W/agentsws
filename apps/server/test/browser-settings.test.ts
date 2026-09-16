/**
 * WP82（55 §3 末段）：浏览器设置。
 *
 * 五件事各钉一条：
 * - **缺省是「不开」**，而且坏文件也回到「不开」——安全的那一侧；
 * - **只有个人档允许 attach**；Docker / 托管档连 `PUT` 都拒（不是界面上灰一下而已）；
 * - `launch` **必须指一个可执行文件**（我们不下载浏览器，16 §3）；
 * - `forRun()` 是运行时真正拿到的那一份，档位变了立刻失效；
 * - 探测就是 `GET <endpoint>/json/version`，不给地址就把常见端口挨个试。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BROWSER_PROBE_PORTS,
  BrowserSettingsError,
  type CdpProbe,
  createBrowserSettings,
  validateEndpoint,
} from '../src/browser-settings.js'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-browser-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 假探测：`live` 里的地址通，别的不通。 */
const probeOf = (live: string[]): CdpProbe & { calls: string[] } => {
  const calls: string[] = []
  const fn = (async (endpoint: string) => {
    calls.push(endpoint)
    return live.includes(endpoint)
      ? { ok: true, endpoint, browser: 'Chrome/140.0.0.0' }
      : { ok: false, endpoint, detail: '连不上' }
  }) as CdpProbe & { calls: string[] }
  fn.calls = calls
  return fn
}

const local = (over: Partial<Parameters<typeof createBrowserSettings>[0]> = {}) =>
  createBrowserSettings({ runtimeMode: () => 'local', probe: probeOf([]), ...over })

describe('缺省与落盘', () => {
  it('没配过 = 不开浏览器（这是安全的那一侧）', () => {
    const s = local()
    expect(s.get()).toMatchObject({ mode: 'off', attach_allowed: true })
    expect(s.forRun()).toBeUndefined()
  })

  it('存得下、读得回；文件坏了回到「不开」而不是抛', () => {
    const dir = tempDir()
    local({ dir }).set({ mode: 'attach', endpoint: 'http://127.0.0.1:9333' })
    expect(readFileSync(join(dir, 'browser.json'), 'utf8')).toContain('9333')
    expect(local({ dir }).get()).toMatchObject({
      mode: 'attach',
      endpoint: 'http://127.0.0.1:9333',
    })

    // 文件坏掉（手改、断电写了一半）
    const broken = tempDir()
    writeFileSync(join(broken, 'browser.json'), '{ not json', 'utf8')
    expect(local({ dir: broken }).get().mode).toBe('off')
  })
})

describe('只有个人档允许 attach（55 §3 末段）', () => {
  it('Docker / 托管档：界面上灰掉，而且 PUT 也拒——不是只在前端挡一下', () => {
    for (const mode of ['docker', 'hosted'] as const) {
      const s = createBrowserSettings({ runtimeMode: () => mode, probe: probeOf([]) })
      const view = s.get()
      expect(view.attach_allowed, mode).toBe(false)
      expect(view.attach_blocked_reason, mode).toContain('不在你自己的电脑上')
      expect(() => s.set({ mode: 'attach', endpoint: 'http://127.0.0.1:9333' })).toThrow(
        BrowserSettingsError,
      )
      // 那一档照样能用「独立的 Chrome」
      expect(s.set({ mode: 'launch', executable_path: '/usr/bin/chromium' }).mode).toBe('launch')
    }
  })

  it('档位是现读的：本机档配好的 attach，库搬进 Docker 之后当场失效', () => {
    let mode: 'local' | 'docker' = 'local'
    const s = createBrowserSettings({ runtimeMode: () => mode, probe: probeOf([]) })
    s.set({ mode: 'attach', endpoint: 'http://127.0.0.1:9333' })
    expect(s.forRun()).toEqual({ mode: 'attach', endpoint: 'http://127.0.0.1:9333' })
    mode = 'docker'
    expect(s.forRun()).toBeUndefined()
  })
})

describe('两种方式各自的校验', () => {
  it('attach 的地址要像个地址（协议只认 http/ws）', () => {
    expect(validateEndpoint(' http://127.0.0.1:9222 ')).toBe('http://127.0.0.1:9222')
    expect(validateEndpoint('ws://127.0.0.1:9222/devtools/browser/x')).toContain('ws://')
    expect(() => validateEndpoint('')).toThrow(/不能为空/)
    expect(() => validateEndpoint('127.0.0.1:9222')).toThrow(/不是一个地址|http/)
    expect(() => validateEndpoint('file:///etc/passwd')).toThrow(/http/)
  })

  it('launch 必须指一个可执行文件——我们不替你下载浏览器（16 §3）', () => {
    const s = local()
    expect(() => s.set({ mode: 'launch' })).toThrow(/不替你下载浏览器/)
    const view = s.set({ mode: 'launch', executable_path: '/usr/bin/chromium' })
    expect(view).toMatchObject({ mode: 'launch', executable_path: '/usr/bin/chromium' })
    // headless 缺省是 true（与上游 provider 的默认一致）
    expect(s.forRun()).toEqual({
      mode: 'launch',
      headless: true,
      executable_path: '/usr/bin/chromium',
    })
  })

  it('改回「不开」就把地址一起忘掉', () => {
    const s = local()
    s.set({ mode: 'attach', endpoint: 'http://127.0.0.1:9333' })
    expect(s.set({ mode: 'off' })).toMatchObject({ mode: 'off' })
    expect(s.get().endpoint).toBeUndefined()
    expect(s.forRun()).toBeUndefined()
  })
})

describe('探测', () => {
  it('给了地址就探那一个', async () => {
    const probe = probeOf(['http://127.0.0.1:9222'])
    const s = local({ probe })
    expect(await s.probe('http://127.0.0.1:9222')).toMatchObject({
      ok: true,
      browser: expect.any(String),
    })
    expect(probe.calls).toEqual(['http://127.0.0.1:9222'])
  })

  it('不给地址就把常见端口挨个试，第一个通的就是它（不是扫端口段）', async () => {
    const hit = `http://127.0.0.1:${BROWSER_PROBE_PORTS[1]}`
    const probe = probeOf([hit])
    const result = await local({ probe }).probe()
    expect(result).toMatchObject({ ok: true, endpoint: hit })
    // 只试了那几个我们列出来的端口，而且通了就停
    expect(probe.calls).toHaveLength(2)
  })

  it('一个都不通就如实说，把最后一条的原因带上', async () => {
    const result = await local({ probe: probeOf([]) }).probe()
    expect(result.ok).toBe(false)
    expect(result.detail).toBeDefined()
  })
})
