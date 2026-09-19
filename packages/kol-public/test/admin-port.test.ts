/**
 * 后台那一页的口（`admin-port.ts`）。Compose 形态那一份就是直接查库。
 *
 * 最要紧的一条断言在最后：**移除先记 opt-out 再删行**，所以移除之后再搬一趟
 * 也搬不回来。倒过来写的实现会在"移除 → 再导入 → 又在库里"这一步红。
 */
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { localKolAdminPort, SqliteKolStore } from '../src/index.js'
import { nodeKolSecrets } from '../src/node-crypto.js'
import { TEST_EMAIL_KEY, testClock } from './helpers.js'

function port() {
  const clock = testClock()
  const store = new SqliteKolStore(new Database(':memory:'))
  const deps = {
    store,
    secrets: nodeKolSecrets({ env: { AGENTSWS_KOL_EMAIL_KEY: TEST_EMAIL_KEY } }),
    now: () => clock.now(),
  }
  return { ...deps, clock, api: localKolAdminPort(deps) }
}

const creator = (handle: string, channel = 'youtube') => ({
  kind: 'creator',
  channel,
  handle,
  name: `频道 ${handle}`,
  followers: 10_000,
})

describe('后台那一页的口', () => {
  it('总量、按平台、近 7 / 30 天新增', async () => {
    const p = port()
    await p.api.import([
      creator('alpha'),
      creator('beta'),
      creator('gamma', 'tiktok'),
      {
        kind: 'contact',
        channel: 'youtube',
        handle: 'alpha',
        email: 'a@example.com',
      },
    ])
    const stats = await p.api.stats()
    expect(stats.creators).toBe(3)
    expect(stats.contacts).toBe(1)
    expect(stats.imported).toBe(3)
    expect(stats.new_7d).toBe(3)
    expect(stats.new_30d).toBe(3)
    expect(stats.removed).toBe(0)
    expect(stats.by_channel).toEqual(
      expect.arrayContaining([
        { channel: 'youtube', creators: 2, contacts: 1 },
        { channel: 'tiktok', creators: 1, contacts: 0 },
      ]),
    )
  })

  it('搜索：按名字 / 渠道 / 有没有联系方式，带总数分页', async () => {
    const p = port()
    await p.api.import([
      creator('alpha'),
      creator('beta'),
      creator('gamma', 'tiktok'),
      { kind: 'contact', channel: 'youtube', handle: 'alpha', email: 'a@example.com' },
    ])
    expect((await p.api.search({ limit: 10, offset: 0 })).total).toBe(3)
    expect((await p.api.search({ q: 'alph', limit: 10, offset: 0 })).rows).toHaveLength(1)
    expect((await p.api.search({ channel: 'tiktok', limit: 10, offset: 0 })).total).toBe(1)
    expect((await p.api.search({ has_contact: true, limit: 10, offset: 0 })).total).toBe(1)
    const page = await p.api.search({ limit: 2, offset: 2 })
    expect(page.total).toBe(3)
    expect(page.rows).toHaveLength(1)
  })

  it('移除：删掉全部行，而且搬家再推一趟也搬不回来', async () => {
    const p = port()
    await p.api.import([
      creator('alpha'),
      { kind: 'contact', channel: 'youtube', handle: 'alpha', email: 'a@example.com' },
    ])
    const out = await p.api.remove({
      channel: 'youtube',
      handle: 'alpha',
      reason: '本人来信要求移除',
      removed_by: 'acc_admin',
    })
    expect(out.removed).toBeGreaterThan(0)
    expect(p.store.creator('youtube', 'alpha')).toBeUndefined()
    expect((await p.api.stats()).removed).toBe(1)

    const again = await p.api.import([creator('alpha')])
    expect(again.skipped).toBe(1)
    expect(p.store.creator('youtube', 'alpha')).toBeUndefined()
  })
})
