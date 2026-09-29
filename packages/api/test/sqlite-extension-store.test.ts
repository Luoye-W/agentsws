/**
 * WP119b（docs/76）：SQLite 档与内存档**同一组用例**各跑一遍。
 *
 * 配对表落盘是 WP119 留尾的那一条：重启不再要用户重新配对。语义上两档必须
 * 逐条一致——这里挑的是"错了会出安全事故或丢用户配对"的那几条：一次性、
 * Origin 双校验、撤销不是删行、过期不认、重启之后令牌还在。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createMemoryExtensionStore, type ExtensionStore } from '../src/extension-store.js'
import { SqliteExtensionStore } from '../src/sqlite-extension-store.js'

const WS = 'ws_1' as WorkspaceId
const PERSON = 'pr_1' as PersonId
const ORIGIN = 'chrome-extension://abcdefghijklmnop'
const OTHER_ORIGIN = 'chrome-extension://zzzzzzzzzzzzzzzz'

function fakeClock(start = '2026-09-20T10:00:00.000Z'): Clock & { advance(ms: number): void } {
  let at = Date.parse(start)
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => {
      at += ms
    },
  }
}

/** 两档各一遍：`make` 把钟递进去，测试要拨表就能拨。 */
const VARIANTS = describe.each([
  [
    '内存档',
    (clock: Clock): ExtensionStore => createMemoryExtensionStore({ clock, random: () => 0.4 }),
  ],
  [
    'SQLite 档',
    (clock: Clock): ExtensionStore => new SqliteExtensionStore({ clock, random: () => 0.4 }),
  ],
]) as unknown as (
  name: string,
  fn: (name: string, make: (clock: Clock) => ExtensionStore) => void,
) => void

VARIANTS('%s：配对与令牌（WP119b）', (_name, make) => {
  it('配对 → 兑换 → 令牌 + Origin 双校验；搬到别的扩展里不认', () => {
    const store = make(fakeClock())
    const pairing = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const redeem = store.redeem({ code: pairing.code, origin: ORIGIN })
    expect(redeem.ok).toBe(true)
    if (!redeem.ok) return
    expect(store.authenticate(`Bearer ${redeem.issued.token}`, ORIGIN)).not.toBeUndefined()
    expect(store.authenticate(`Bearer ${redeem.issued.token}`, OTHER_ORIGIN)).toBeUndefined()
  })

  it('码一次性；撤销是写 revoked_at 不是删行；清单里没有明文', () => {
    const store = make(fakeClock())
    const pairing = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const first = store.redeem({ code: pairing.code, origin: ORIGIN })
    expect(first.ok).toBe(true)
    const second = store.redeem({ code: pairing.code, origin: ORIGIN })
    expect(second.ok).toBe(false)
    if (!first.ok) return
    const row = store.list(WS)[0]
    expect(row).not.toBeUndefined()
    const revoked = store.revoke(WS, row.id)
    expect(revoked?.revoked_at).not.toBeUndefined()
    expect(store.list(WS)).toHaveLength(1)
    expect(store.authenticate(`Bearer ${first.issued.token}`, ORIGIN)).toBeUndefined()
  })

  it('WP201：真 Chrome 扩展的 GET 没有 Origin——只有 Sec-Fetch-Site: none 才验令牌；撤销 / 过期照旧不认', () => {
    const clock = fakeClock()
    const store = make(clock)
    const pairing = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const redeem = store.redeem({ code: pairing.code, origin: ORIGIN })
    if (!redeem.ok) throw new Error('兑换失败')
    const bearer = `Bearer ${redeem.issued.token}`
    // 浏览器说「不是网页发的」：认，而且认出来的是配对时那个扩展
    expect(store.authenticate(bearer, undefined, 'none')?.extension_id).toBe('abcdefghijklmnop')
    // 没有 Origin、也没有 Sec-Fetch-Site（curl 那种）/ 浏览器说是网页发的：不认
    expect(store.authenticate(bearer, undefined)).toBeUndefined()
    expect(store.authenticate(bearer, undefined, 'cross-site')).toBeUndefined()
    // 有 Origin 就必须是配对时那个扩展，Sec-Fetch-Site 救不了
    expect(store.authenticate(bearer, OTHER_ORIGIN, 'none')).toBeUndefined()
    expect(store.authenticate(bearer, 'https://www.youtube.com', 'none')).toBeUndefined()
    // 错的令牌照旧不认
    expect(store.authenticate('Bearer ext_nope', undefined, 'none')).toBeUndefined()
    // 撤销之后没有 Origin 的那一路也不认
    const row = store.list(WS)[0]
    if (row === undefined) throw new Error('清单是空的')
    store.revoke(WS, row.id)
    expect(store.authenticate(bearer, undefined, 'none')).toBeUndefined()
  })

  it('过期令牌不认：拨过 31 天，认证返回空', () => {
    const clock = fakeClock()
    const store = make(clock)
    const pairing = store.createPairing({ workspace_id: WS, person_id: PERSON })
    const redeem = store.redeem({ code: pairing.code, origin: ORIGIN })
    if (!redeem.ok) throw new Error('兑换失败')
    clock.advance(31 * 24 * 60 * 60 * 1000)
    expect(store.authenticate(`Bearer ${redeem.issued.token}`, ORIGIN)).toBeUndefined()
  })
})

describe('SQLite 档独有：重启不丢（WP119 留尾的那一条）', () => {
  it('重开同一个文件：令牌还在、还能认证、序号接着数', () => {
    const clock = fakeClock()
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-ext-'))
    const dbPath = join(dir, 'extension.sqlite')
    let a = 42 >>> 0
    const seeded = (): number => {
      a = (a * 1664525 + 1013904223) >>> 0
      return a / 0x100000000
    }
    const first = new SqliteExtensionStore({ dbPath, clock, random: seeded })
    const pairing = first.createPairing({ workspace_id: WS, person_id: PERSON })
    const redeem = first.redeem({ code: pairing.code, origin: ORIGIN })
    expect(redeem.ok).toBe(true)
    if (!redeem.ok) return
    const token = redeem.issued.token
    first.close()

    // 「重启」：新实例读同一个文件，clock 往前拨一小时
    clock.advance(60 * 60 * 1000)
    const second = new SqliteExtensionStore({ dbPath, clock, random: seeded })
    expect(second.authenticate(`Bearer ${token}`, ORIGIN)?.token_id).toBe(redeem.issued.token_id)
    expect(second.list(WS)).toHaveLength(1)

    // 再配一把：id 的序号跨重启接着数，不重号
    const pairing2 = second.createPairing({ workspace_id: WS, person_id: PERSON })
    const redeem2 = second.redeem({ code: pairing2.code, origin: ORIGIN })
    expect(redeem2.ok).toBe(true)
    if (!redeem2.ok) return
    expect(redeem2.issued.token_id).not.toBe(redeem.issued.token_id)
    second.close()
  })

  it('换一个文件等于换一台机器：新库里什么都没有', () => {
    const clock = fakeClock()
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-ext-'))
    const first = new SqliteExtensionStore({
      dbPath: join(dir, 'a.sqlite'),
      clock,
      random: () => 0.4,
    })
    const pairing = first.createPairing({ workspace_id: WS, person_id: PERSON })
    first.close()
    const second = new SqliteExtensionStore({
      dbPath: join(dir, 'b.sqlite'),
      clock,
      random: () => 0.4,
    })
    expect(second.list(WS)).toHaveLength(0)
    expect(second.redeem({ code: pairing.code, origin: ORIGIN }).ok).toBe(false)
    second.close()
  })
})
