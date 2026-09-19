/**
 * WP119（68）：配对码与插件令牌。
 *
 * 这一组守的是四条：6 位 / 5 分钟 / 一次性；扩展 id 只从 `Origin` 来；
 * 明文只在兑换那一次出现；撤销是写 `revoked_at` 不是删行。
 */
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createMemoryExtensionStore, extensionIdOfOrigin } from '../src/extension-store.js'

const WS = 'ws_1' as WorkspaceId
const PERSON = 'pr_1' as PersonId
const ORIGIN = 'chrome-extension://abcdefghijklmnop'

/** 可以往前拨的钟。 */
function fakeClock(start = '2026-09-19T10:00:00.000Z'): Clock & { advance(ms: number): void } {
  let at = Date.parse(start)
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => {
      at += ms
    },
  }
}

/** 固定随机源：测试里不掷骰子。 */
const steady = (): (() => number) => {
  let i = 0
  return () => {
    i += 1
    return (i % 10) / 10
  }
}

const storeOf = (clock: Clock) => createMemoryExtensionStore({ clock, random: steady() })

describe('extensionIdOfOrigin', () => {
  it('只认扩展的 Origin', () => {
    expect(extensionIdOfOrigin(ORIGIN)).toBe('abcdefghijklmnop')
    expect(extensionIdOfOrigin('moz-extension://abcdefgh-1234')).toBe('abcdefgh-1234')
  })

  it('网页的 Origin 一律不认——插件之外没有人能换令牌', () => {
    expect(extensionIdOfOrigin('https://www.youtube.com')).toBe(undefined)
    expect(extensionIdOfOrigin('http://127.0.0.1:4317')).toBe(undefined)
    expect(extensionIdOfOrigin(undefined)).toBe(undefined)
  })
})

describe('配对码', () => {
  it('是 6 位数字（前导零保留）', () => {
    const store = storeOf(fakeClock())
    const pairing = store.createPairing({ workspace_id: WS, person_id: PERSON })
    expect(pairing.code).toMatch(/^\d{6}$/)
  })

  it('一次性：换过一次就不能再换', () => {
    const store = storeOf(fakeClock())
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    expect(store.redeem({ code, origin: ORIGIN }).ok).toBe(true)
    const again = store.redeem({ code, origin: ORIGIN })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe('used')
  })

  it('5 分钟过期', () => {
    const clock = fakeClock()
    const store = storeOf(clock)
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    clock.advance(5 * 60 * 1000 + 1)
    const out = store.redeem({ code, origin: ORIGIN })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('expired')
  })

  it('再生成一次，上一码当场作废', () => {
    const store = storeOf(fakeClock())
    const first = store.createPairing({ workspace_id: WS, person_id: PERSON })
    store.createPairing({ workspace_id: WS, person_id: PERSON })
    const out = store.redeem({ code: first.code, origin: ORIGIN })
    expect(out.ok).toBe(false)
  })

  it('不是扩展发来的一律拒（扩展 id 只从 Origin 来，不从请求体来）', () => {
    const store = storeOf(fakeClock())
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const out = store.redeem({ code, origin: 'https://evil.example.com' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('bad_origin')
  })
})

describe('令牌', () => {
  it('明文只在兑换那一次出现——清单里没有这一格', () => {
    const store = storeOf(fakeClock())
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const issued = store.redeem({ code, origin: ORIGIN })
    expect(issued.ok).toBe(true)
    const listed = store.list(WS)
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(issued.ok ? issued.issued.token : 'x')
  })

  it('令牌 + Origin 双校验：搬到别的扩展里就不认', () => {
    const store = storeOf(fakeClock())
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const issued = store.redeem({ code, origin: ORIGIN })
    if (!issued.ok) throw new Error('unreachable')
    expect(store.authenticate(issued.issued.token, ORIGIN)).toBeDefined()
    expect(store.authenticate(issued.issued.token, 'chrome-extension://otherextension1')).toBe(
      undefined,
    )
    expect(store.authenticate(issued.issued.token, 'https://www.youtube.com')).toBe(undefined)
  })

  it('用过一次会记下最近使用时间（工作台要看得见）', () => {
    const clock = fakeClock()
    const store = storeOf(clock)
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const issued = store.redeem({ code, origin: ORIGIN })
    if (!issued.ok) throw new Error('unreachable')
    expect(store.list(WS)[0]?.last_used_at).toBe(undefined)
    clock.advance(1000)
    store.authenticate(issued.issued.token, ORIGIN)
    expect(store.list(WS)[0]?.last_used_at).toBe('2026-09-19T10:00:01.000Z')
  })

  it('撤销是写 revoked_at 不是删行——用户要看得见什么时候撤的', () => {
    const clock = fakeClock()
    const store = storeOf(clock)
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const issued = store.redeem({ code, origin: ORIGIN })
    if (!issued.ok) throw new Error('unreachable')
    const view = store.revoke(WS, issued.issued.token_id)
    expect(view?.revoked_at).toBe(clock.now())
    expect(store.list(WS)).toHaveLength(1)
    expect(store.authenticate(issued.issued.token, ORIGIN)).toBe(undefined)
  })

  it('别的工作区撤不掉这一把', () => {
    const store = storeOf(fakeClock())
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const issued = store.redeem({ code, origin: ORIGIN })
    if (!issued.ok) throw new Error('unreachable')
    expect(store.revoke('ws_other' as WorkspaceId, issued.issued.token_id)).toBe(undefined)
    expect(store.list('ws_other' as WorkspaceId)).toHaveLength(0)
  })

  it('scope 只有三个，没有第四个', () => {
    const store = storeOf(fakeClock())
    const { code } = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const issued = store.redeem({ code, origin: ORIGIN })
    if (!issued.ok) throw new Error('unreachable')
    expect(issued.issued.scopes).toEqual(['kol.observe', 'kol.capture', 'kol.read'])
  })
})
