/**
 * WP126 计费改造（09-19 Luoye 定，推翻 48 §5 / 49 / WP61 / WP116 里"浏览免费"那套）：
 *
 * - 官方数据接口没有免费动作了：浏览 / 搜索 / 类目基准按 `data.kol.lookup`（0.2/次），
 *   体检报告按 `data.kol.audit`（3/次）；reveal 价不变；`social.fetch` 价不变。
 * - **命中缓存与未命中收同样的钱**——库本身就是缓存，"命中"不是用户的功劳。
 * - **取数失败 / 超时 / 查无此人 / 搜到 0 条 → 预扣释放，不收钱**。
 * - 口径①：一次提交的搜索算一次——同一 (subject, 查询串) 10 分钟内翻页 / 重排
 *   不重复收（幂等窗口，键里不含 limit）。
 * - 我方成本照实进账本（这里只验计量事件落了 provider，成本口径在 metering 那边）。
 *
 * 全部替身，不联网。
 */
import { describe, expect, it } from 'vitest'
import { kolChargeFor } from '../src/charge-map.js'
import { SEARCH_IDEMPOTENCY_WINDOW_MS } from '../src/service.js'
import { type Harness, harness, observation } from './helpers.js'

const principal = {
  account_id: 'acc_1',
  org_id: 'org_1',
  workspace_id: 'ws_1',
  scopes: ['data'] as const,
  region: 'global' as const,
}

const KEY = '/v1/data/kol/creators/youtube/somecreator'

/** 库里放 n 个 creator（各不相同的 handle），让浏览有东西可回。 */
function seedCreators(h: Harness, n: number): void {
  for (let i = 0; i < n; i += 1)
    h.service.contributeAs(principal, [observation({ handle: `creator${i}` })])
}

describe('WP126 计费：浏览 / 搜索', () => {
  it('有结果就按 lookup 收一次；命中缓存与未命中同价（连续两次不同查询各收各的）', async () => {
    const h = harness({ credits: 100 })
    seedCreators(h, 3)
    const before = h.wallet.balance('org_1').available
    const first = await h.call('/v1/data/kol/creators?channel=youtube&q=creator0')
    expect(first.status).toBe(200)
    const second = await h.call('/v1/data/kol/creators?channel=youtube&q=creator1')
    expect(second.status).toBe(200)
    const perCall = (first.body.data as { credits: number }).credits
    expect(perCall).toBeGreaterThan(0)
    expect((second.body.data as { credits: number }).credits).toBe(perCall)
    expect(h.wallet.balance('org_1').available).toBe(before - perCall * 2)
  })

  it('口径①：同一 (subject, 查询串) 10 分钟内翻页 / 重排不重复收（limit 不进键）', async () => {
    const h = harness({ credits: 100 })
    seedCreators(h, 5)
    const before = h.wallet.balance('org_1').available
    const first = await h.call('/v1/data/kol/creators?channel=youtube&q=creator&limit=5')
    expect(first.status).toBe(200)
    // 翻页：limit 变了，查询串没变 → 窗口内不扣第二次
    const page2 = await h.call('/v1/data/kol/creators?channel=youtube&q=creator&limit=2')
    expect(page2.status).toBe(200)
    expect((page2.body.data as { credits: number }).credits).toBe(0)
    // 换一个查询串：新的一次，照收
    const other = await h.call('/v1/data/kol/creators?channel=youtube&q=creator0')
    const perCall = (other.body.data as { credits: number }).credits
    expect(perCall).toBeGreaterThan(0)
    // 另一个工作区：同一查询串，各算各的——窗口没罩住它，所以照常尝试扣钱；
    // 而 org_2 没有余额，扣钱那一跳会拒绝（这正是"没被窗口免单"的可验证据）
    expect(() =>
      h.service.browse(
        { ...principal, workspace_id: 'ws_2', org_id: 'org_2' },
        { channel: 'youtube', q: 'creator' },
      ),
    ).toThrow()
    expect(h.wallet.balance('org_1').available).toBe(before - perCall * 2)
  })

  it('口径①：窗口走完（>10 分钟）同一个查询再搜，照收新的一次', async () => {
    const h = harness({ credits: 100 })
    seedCreators(h, 2)
    const before = h.wallet.balance('org_1').available
    const first = await h.call('/v1/data/kol/creators?channel=youtube&q=creator')
    const perCall = (first.body.data as { credits: number }).credits
    h.clock.advance(SEARCH_IDEMPOTENCY_WINDOW_MS + 1_000)
    const again = await h.call('/v1/data/kol/creators?channel=youtube&q=creator')
    expect((again.body.data as { credits: number }).credits).toBe(perCall)
    expect(h.wallet.balance('org_1').available).toBe(before - perCall * 2)
  })

  it('口径②：搜到 0 条不收钱', async () => {
    const h = harness({ credits: 100 })
    const empty = await h.call('/v1/data/kol/creators?channel=youtube&q=nobody')
    expect(empty.status).toBe(200)
    expect((empty.body.data as { creators: unknown[]; credits: number }).creators).toHaveLength(0)
    expect((empty.body.data as { credits: number }).credits).toBe(0)
    expect(h.wallet.balance('org_1').available).toBe(100)
  })

  it('空查询不算一次搜索：不进幂等窗口，也不白扣（0 条那条管着它）', async () => {
    const h = harness({ credits: 100 })
    seedCreators(h, 2)
    const before = h.wallet.balance('org_1').available
    await h.call('/v1/data/kol/creators?channel=youtube')
    await h.call('/v1/data/kol/creators?channel=youtube')
    // 空查询没有幂等窗口，两次是两次
    expect(h.wallet.balance('org_1').available).toBe(before - 0.4)
  })
})

describe('WP126 计费：体检报告与查无此人', () => {
  it('audit 按 data.kol.audit 收；查无此人预扣释放不收钱', async () => {
    const h = harness({ credits: 100 })
    const missing = await h.call(`${KEY}/audit`)
    expect(missing.status).toBe(404)
    expect(h.wallet.balance('org_1').available).toBe(100)
    h.service.contributeAs(principal, [observation()])
    const before = h.wallet.balance('org_1').available
    const found = await h.call(`${KEY}/audit`)
    expect(found.status).toBe(200)
    const charged = h.wallet.balance('org_1').available
    expect(charged).toBeLessThan(before)
    const events = h.walletStore.events({ org_id: 'org_1' })
    const lastPaid = [...events].reverse().find((e) => e.credits > 0)
    expect(lastPaid?.capability).toBe('data.kol.audit')
  })

  it('deep-audit 查无此人同样不收钱', async () => {
    const h = harness({ credits: 100 })
    const missing = await h.call(`${KEY}/deep-audit`, { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(h.wallet.balance('org_1').available).toBe(100)
  })

  it('reveal 与 social.fetch 的价不变（reveal 查无此人/没联系方式不收钱，老规矩）', async () => {
    const h = harness({ credits: 100 })
    const missing = await h.call(`${KEY}/reveal`, { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(h.wallet.balance('org_1').available).toBe(100)
  })
})

describe('WP126 计费：入口预扣表（charge-map）', () => {
  it('GET 的三条读路由进了表：creators / benchmarks / creators/:c/:h/audit', () => {
    expect(kolChargeFor('GET', '/v1/data/kol/creators')?.capability).toBe('data.kol.lookup')
    expect(kolChargeFor('GET', '/v1/data/kol/benchmarks')?.capability).toBe('data.kol.lookup')
    expect(kolChargeFor('GET', `${KEY}/audit`)?.capability).toBe('data.kol.audit')
  })

  it('写入与插件那几条仍然不在表里', () => {
    for (const [method, path] of [
      ['GET', `${KEY}`],
      ['GET', `${KEY}/reveal`],
      ['POST', `${KEY}/observations`],
      ['POST', `${KEY}/contact`],
      ['POST', `${KEY}/disputes`],
      ['POST', '/v1/data/kol/plugins/pair'],
      ['POST', '/v1/data/kol/plugins/observations'],
      ['GET', '/v1/data/kol/plugins/pair'],
    ] as const)
      expect(kolChargeFor(method, path)).toBeUndefined()
  })

  it('POST 的三条老收费路由不变', () => {
    expect(kolChargeFor('POST', `${KEY}/reveal`)?.capability).toBe('data.kol.lookup')
    expect(kolChargeFor('POST', `${KEY}/deep-audit`)?.capability).toBe('data.kol.audit')
    expect(kolChargeFor('POST', `${KEY}/refresh`)?.capability).toBe('social.fetch')
  })
})
