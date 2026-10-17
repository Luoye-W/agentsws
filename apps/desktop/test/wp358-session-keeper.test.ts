/**
 * WP358：一个人用桌面版，开过 12 小时就落到「进工作台 / 你的邮箱」登录页。
 *
 * 根因：主进程把会话密钥换来的 cookie 缓存一辈子，服务端那张只活 12 小时。
 * 这里钉住：到点重换、撞 401 立刻重换、同时要只换一次、作废后旧那趟不回填。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSessionKeeper, SESSION_REFRESH_MS } from '../src/session-keeper.js'

const HOUR = 60 * 60 * 1000

function harness() {
  let now = Date.parse('2026-10-15T03:10:00Z')
  let n = 0
  const installed: string[] = []
  const keeper = createSessionKeeper<string>({
    exchange: async () => {
      n += 1
      return `cookie_${n}`
    },
    install: async (s) => {
      installed.push(s)
    },
    nowMs: () => now,
  })
  return {
    keeper,
    installed,
    exchanges: () => n,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('WP358 桌面壳会话保鲜', () => {
  it('开了 27 小时（Windows 真机 10-15 → 10-16）：再要会话时换一张新的，不再给过期那张', async () => {
    const h = harness()
    expect(await h.keeper.get()).toBe('cookie_1')
    h.advance(27 * HOUR)
    expect(await h.keeper.get()).toBe('cookie_2')
    expect(h.installed).toEqual(['cookie_1', 'cookie_2'])
  })

  it('没到点就复用手上那张（不每次都去服务端签一张）', async () => {
    const h = harness()
    await h.keeper.get()
    h.advance(SESSION_REFRESH_MS - 1)
    expect(await h.keeper.get()).toBe('cookie_1')
    expect(h.exchanges()).toBe(1)
  })

  it('刷新阈值小于服务端会话寿命（12 小时）', () => {
    expect(SESSION_REFRESH_MS).toBeLessThan(12 * HOUR)
  })

  it('页面撞上 401 → renew 立刻重换并装进 cookie 罐', async () => {
    const h = harness()
    await h.keeper.get()
    expect(await h.keeper.renew()).toBe('cookie_2')
    expect(h.installed.at(-1)).toBe('cookie_2')
  })

  it('同时好几处要，只换一趟', async () => {
    const h = harness()
    const all = await Promise.all([h.keeper.get(), h.keeper.renew(), h.keeper.get()])
    expect(all).toEqual(['cookie_1', 'cookie_1', 'cookie_1'])
    expect(h.exchanges()).toBe(1)
  })

  it('换不到（服务进程还没起来）不缓存，下次再试', async () => {
    let fail = true
    const keeper = createSessionKeeper<string>({
      exchange: async () => (fail ? undefined : 'ok'),
      install: async () => {},
      nowMs: () => 0,
    })
    expect(await keeper.get()).toBeUndefined()
    fail = false
    expect(await keeper.get()).toBe('ok')
  })

  it('服务进程重启 forget 之后，换到一半的旧那趟不回填缓存', async () => {
    let release: (v: string) => void = () => {}
    let calls = 0
    const keeper = createSessionKeeper<string>({
      exchange: () => {
        calls += 1
        if (calls === 1)
          return new Promise<string>((r) => {
            release = r
          })
        return Promise.resolve('fresh')
      },
      install: async () => {},
      nowMs: () => 0,
    })
    const stale = keeper.get()
    keeper.forget()
    release('stale')
    await stale
    expect(await keeper.get()).toBe('fresh')
  })

  it('主进程用的是保鲜器，不再自己拿一个变量缓存一辈子', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain('createSessionKeeper')
    expect(main).not.toMatch(/let sessionCache\b/)
  })
})
