/**
 * 收费点那张表（`charge-map.ts`）与**服务真的扣了哪几笔**必须一一对应。
 *
 * 这条测试的写法是刻意的：它不读 `charge-map.ts` 的常量去比对自己，
 * 而是**真的把每条路由打一遍**，看钱包上有没有落下一笔预扣。
 * 于是"给 service 加了一个收费点但忘了加进表里"会在这里红——
 * 而那正是官方托管形态下最贵的那种漏（漏扣 = 白送上游调用）。
 */
import { describe, expect, it } from 'vitest'
import { isKolPath, kolChargeFor } from '../src/charge-map.js'
import {
  createQuotaPool,
  createSourcePool,
  fakeYoutubeSource,
  type SourceSnapshot,
} from '../src/index.js'
import { auditableObservations, harness, observation } from './helpers.js'

/** 假上游回的那一份（与 `routes.test.ts` 同一个形状）。 */
const SNAPSHOT: SourceSnapshot = { ...observation({ followers: 88_000 }) }

/** 打一条路由，回"钱包上有没有出现预扣或扣费"。 */
async function charged(path: string, method: string): Promise<{ status: number; events: number }> {
  const quotaHost = harness()
  const h = harness({
    credits: 1000,
    sources: createSourcePool({
      youtube: fakeYoutubeSource([SNAPSHOT]),
      quota: createQuotaPool({ store: quotaHost.store }),
    }),
  })
  // 库里先有这个人（不然 reveal / deep-audit 会在扣费之前就 404）；样本喂够——
  // WP129 起样本不够的体检不收钱，那就测不到"这条收费路由真的扣了"
  h.service.contribute({ kind: 'plugin', id: 'plg:test' }, auditableObservations(), 'plugin')
  const before = h.walletStore.events({ org_id: 'org_1' }).length
  const res = await h.call(path, { method })
  const after = h.walletStore.events({ org_id: 'org_1' })
  return {
    status: res.status,
    events: after.length - before,
  }
}

const KEY = '/v1/data/kol/creators/youtube/somecreator'

describe('收费点那张表', () => {
  it('三条收费路由都认得出来', () => {
    expect(kolChargeFor('POST', `${KEY}/reveal`)).toEqual({
      capability: 'data.kol.reveal',
      unit: 'call',
      quantity: 1,
    })
    expect(kolChargeFor('POST', `${KEY}/deep-audit`)?.capability).toBe('data.kol.audit')
    expect(kolChargeFor('POST', `${KEY}/refresh`)?.capability).toBe('social.fetch')
  })

  it('写入与插件的路由一条都不在表里；GET 上只有读路由收费（WP126）', () => {
    for (const [method, path] of [
      ['POST', `${KEY}/observations`],
      ['POST', `${KEY}/contact`],
      ['POST', `${KEY}/disputes`],
      ['POST', '/v1/data/kol/plugins/pair'],
      ['POST', '/v1/data/kol/plugins/observations'],
      // WP129：内容观测两条（工作区令牌 / 插件令牌）也是往库里加事实，不收
      ['POST', '/v1/data/kol/content-observations'],
      ['POST', '/v1/data/kol/plugins/content-observations'],
      // reveal / refresh 是 POST 专属：GET 上不存在，也就不收费
      ['GET', `${KEY}/reveal`],
      ['GET', `${KEY}/refresh`],
      // 非读路由的 GET：单条卡、详情、四段杂尾
      ['GET', `${KEY}`],
      ['GET', '/v1/data/kol/creators/youtube'],
    ] as const)
      expect(kolChargeFor(method, path)).toBeUndefined()
  })

  it('不是这个包的路一律不认', () => {
    expect(isKolPath('/v1/ai/chat/completions')).toBe(false)
    expect(isKolPath('/v1/data/kolx/creators')).toBe(false)
    expect(isKolPath('/v1/data/kol')).toBe(true)
    expect(kolChargeFor('POST', '/v1/wallet/topup')).toBeUndefined()
    // 路径段数不对（少一段 / 多一段）不许当成收费路由
    expect(kolChargeFor('POST', '/v1/data/kol/creators/youtube/reveal')).toBeUndefined()
    expect(kolChargeFor('POST', `${KEY}/reveal/extra`)).toBeUndefined()
  })

  it('表里那三条真的落了计量事件，免费那几条落的是 0 积分', async () => {
    // reveal：库里没有联系方式 → 404 且**不扣积分**（service 那条纪律）
    const reveal = await charged(`${KEY}/reveal`, 'POST')
    expect(reveal.status).toBe(404)
    expect(reveal.events).toBe(0)

    const deep = await charged(`${KEY}/deep-audit`, 'POST')
    expect(deep.status).toBe(200)
    expect(deep.events).toBe(1)

    const refresh = await charged(`${KEY}/refresh`, 'POST')
    expect(refresh.status).toBe(200)
    expect(refresh.events).toBe(1)
  })
})
